import fs from "node:fs";
import { sttKeywords } from "./campaign.js";
import type { Store } from "./db.js";
import { bus } from "./events.js";
import { sessionPaths } from "./paths.js";
import { summarizeSession } from "./summarize/summarize.js";
import type { SummaryFile } from "./summarize/schema.js";
import { TimelineSchema } from "./types.js";
import { config } from "./config.js";
import { transcribe, transcribeClip } from "./worker-client.js";

export interface PipelineHooks {
  notify?: (text: string) => Promise<unknown> | void;
  onSummary?: (file: SummaryFile) => Promise<unknown> | void;
  log?: (msg: string) => void;
}

const running = new Set<string>();
/** Transcription progress (0..1) of sessions currently being transcribed. */
const progress = new Map<string, number>();

export function isProcessing(sessionId: string) {
  return running.has(sessionId);
}

export function processingProgress(sessionId: string) {
  return progress.get(sessionId) ?? null;
}

/**
 * Transcribe (unless transcript.json already exists) and summarize a finished
 * session. Every step writes its output to disk, so a failed run can be resumed.
 */
export async function processSession(
  store: Store,
  sessionId: string,
  opts: PipelineHooks & { retranscribe?: boolean; skipSummary?: boolean } = {},
) {
  if (running.has(sessionId)) throw new Error("This session is already being processed");
  running.add(sessionId);
  const log = opts.log ?? console.log;
  const notify = async (text: string) => {
    try {
      await opts.notify?.(text);
    } catch (err) {
      log(`[pipeline] notify failed: ${err}`);
    }
  };
  const setStatus = (status: Parameters<Store["setSessionStatus"]>[1], error: string | null = null) => {
    store.setSessionStatus(sessionId, status, error);
    bus.emitEvent({ type: "session.status", sessionId, status, error });
  };

  try {
    const paths = sessionPaths(sessionId);
    const session = store.getSession(sessionId)!;

    if (opts.retranscribe && session.audio_purged) {
      throw new Error("This session's audio was already deleted, so it can't be re-transcribed");
    }
    if (opts.retranscribe || !fs.existsSync(paths.transcriptJson)) {
      const timeline = TimelineSchema.parse(JSON.parse(fs.readFileSync(paths.timeline, "utf8")));
      if (!timeline.segments.length) throw new Error("No speech was recorded in this session");
      setStatus("transcribing");
      const names = timeline.participants.flatMap((p) => (p.character ? [p.character] : []));
      const started = Date.now();
      const deleteAudio = config.deleteAudioAfterTranscribe;
      progress.set(sessionId, 0);
      await transcribe(paths.dir, sttKeywords(names), {
        deleteAudio,
        onProgress: (f) => {
          progress.set(sessionId, f);
          log(`[pipeline] session ${session.number}: transcribing ${Math.round(f * 100)}%`);
        },
      });
      progress.delete(sessionId);
      if (deleteAudio) {
        // Every clip's text is in transcript.json; only empty folders are left.
        fs.rmSync(paths.audio, { recursive: true, force: true });
        store.markAudioPurged(sessionId);
      }
      const secs = Math.round((Date.now() - started) / 1000);
      const took = secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`;
      await notify(`📝 Session ${session.number} transcribed (${timeline.segments.length} clips in ${took}).`);
    }

    if (opts.skipSummary) {
      setStatus("complete");
      return null;
    }

    setStatus("summarizing");
    const file = await summarizeSession(store, sessionId, { log });
    store.markSummarized(sessionId);
    bus.emitEvent({ type: "session.status", sessionId, status: "complete" });
    bus.emitEvent({ type: "summary.ready", sessionId, number: session.number, title: file.summary.title });
    await opts.onSummary?.(file);
    return file;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[pipeline] ${sessionId} failed: ${err instanceof Error ? err.stack : err}`);
    setStatus("failed", message);
    await notify(`⚠️ Processing failed: ${message}\nFix the problem, then run \`/scrib process\` to resume.`);
    throw err;
  } finally {
    running.delete(sessionId);
    progress.delete(sessionId);
  }
}

/**
 * Hand a just-finished clip to the worker while the session is still running.
 * Failures are only logged: the end-of-session job picks up anything missed.
 */
export function makeLiveTranscriber(sessionDir: string, log: (msg: string) => void = console.log) {
  let warned = false;
  return (file: string, characterNames: string[]) => {
    transcribeClip(sessionDir, file, sttKeywords(characterNames), config.deleteAudioAfterTranscribe).catch((err) => {
      if (!warned) log(`[live] could not reach the worker; clips will be transcribed at /scrib stop: ${err.message}`);
      warned = true;
    });
  };
}

/** Delete raw audio for sessions summarized more than `days` ago. */
export function purgeExpiredAudio(store: Store, days: number, log: (msg: string) => void = console.log) {
  if (days <= 0) return;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  for (const s of store.sessionsWithExpiredAudio(cutoff)) {
    fs.rmSync(sessionPaths(s.id).audio, { recursive: true, force: true });
    store.markAudioPurged(s.id);
    log(`[retention] purged audio for session ${s.number} (${s.id})`);
  }
}
