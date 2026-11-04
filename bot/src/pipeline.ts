import fs from "node:fs";
import { campaignFolderOfPath, sttKeywords } from "./campaign.js";
import type { SessionRow, Store } from "./db.js";
import { bus } from "./events.js";
import { composeSession } from "./layout.js";
import { sessionPaths, sessionRecordings } from "./paths.js";
import { summarizeSession } from "./summarize/summarize.js";
import type { SummaryFile } from "./summarize/schema.js";
import { readTimeline } from "./timeline.js";
import { config } from "./config.js";
import { unusableReason } from "./merge.js";
import { transcribe, transcribeClip } from "./worker-client.js";

export interface PipelineHooks {
  notify?: (text: string) => Promise<unknown> | void;
  onSummary?: (file: SummaryFile) => Promise<unknown> | void;
  /** Runs before summarizing, e.g. to wait for the Foundry chat log of a session just stopped. */
  beforeSummary?: () => Promise<unknown>;
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
 * Why `processSession` would refuse this session right now, or null. The one statement of these
 * rules: the pipeline enforces them, and the commands check them first to answer before starting.
 */
export function processBlocker(session: SessionRow | undefined, opts: { retranscribe?: boolean } = {}): string | null {
  if (!session) return "No such session.";
  const unusable = unusableReason(session);
  if (unusable) return unusable;
  if (running.has(session.id)) return `Session ${session.number} is already being processed.`;
  if (opts.retranscribe && session.audio_purged) {
    return `Session ${session.number}'s audio was already deleted, so it can't be re-transcribed.`;
  }
  return null;
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
  const session = store.getSession(sessionId);
  const blocker = processBlocker(session, opts);
  if (blocker || !session) throw new Error(blocker ?? "No such session.");
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
    // A game is one or more recordings (a merged continuation keeps its own folder); each is
    // transcribed by the worker in its own folder, then the game's files are built from them.
    const recordings = sessionRecordings(sessionId)
      .map((rid) => ({ rid, p: sessionPaths(rid) }))
      .filter(({ p }) => fs.existsSync(p.timeline) || fs.existsSync(p.segmentsJournal));
    const todo = recordings.filter(({ p }) => opts.retranscribe || !fs.existsSync(p.recordingTranscript));
    if (todo.length) {
      const timelines = todo.map(({ p }) => readTimeline(p.recording));
      const total = timelines.reduce((n, t) => n + t.segments.length, 0);
      if (!total) throw new Error("No speech was recorded in this session");
      setStatus("transcribing");
      const started = Date.now();
      const deleteAudio = config.deleteAudioAfterTranscribe;
      progress.set(sessionId, 0);
      let toldTable = false;
      let done = 0;
      for (const [i, { p }] of todo.entries()) {
        const timeline = timelines[i]!;
        if (!timeline.segments.length) continue;
        const names = timeline.participants.flatMap((x) => (x.character ? [x.character] : []));
        await transcribe(p.recording, sttKeywords(names, campaignFolderOfPath(p.recording)), {
          deleteAudio,
          clipCount: timeline.segments.length,
          onWaiting: (msg) => {
            log(`[pipeline] session ${session.number}: ${msg}`);
            if (!toldTable) {
              toldTable = true;
              void notify(
                `⏳ Session ${session.number}: ${msg}. Retrying for a few minutes; nothing is lost if it doesn't come back.`,
              );
            }
          },
          onProgress: (f) => {
            const overall = (done + f * timeline.segments.length) / total;
            progress.set(sessionId, overall);
            log(`[pipeline] session ${session.number}: transcribing ${Math.round(overall * 100)}%`);
          },
        });
        done += timeline.segments.length;
        if (deleteAudio) {
          // Every clip's text is in the recording's transcript.json; only empty folders are left.
          fs.rmSync(p.audio, { recursive: true, force: true });
        }
      }
      progress.delete(sessionId);
      if (deleteAudio) store.markAudioPurged(sessionId);
      composeSession(store, sessionId);
      const secs = Math.round((Date.now() - started) / 1000);
      const took = secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`;
      await notify(`📝 Session ${session.number} transcribed (${total} clips in ${took}).`);
    } else if (!fs.existsSync(paths.transcriptJson)) {
      if (!recordings.length) throw new Error("No speech was recorded in this session");
      composeSession(store, sessionId);
    }

    if (opts.skipSummary) {
      setStatus("complete");
      await notify(
        `📄 Session ${session.number}'s transcript is saved on the host at \`${paths.transcriptMd}\` ` +
          `(Markdown any LLM can read; \`transcript.json\` beside it has the same lines as data). ` +
          `No summary was written. Run \`/scrib summarize\` if you want one.`,
      );
      return null;
    }

    await opts.beforeSummary?.();
    setStatus("summarizing");
    const file = await summarizeSession(store, sessionId, { log });
    store.markSummarized(sessionId);
    bus.emitEvent({ type: "session.status", sessionId, status: "complete" });
    bus.emitEvent({ type: "summary.ready", sessionId, number: session.number, title: file.summary.title });
    store.markSent(sessionId, "summary");
    await opts.onSummary?.(file);
    return file;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const number = store.getSession(sessionId)?.number ?? "?";
    log(`[pipeline] session ${number} (${sessionId}) failed: ${err instanceof Error ? err.stack : err}`);
    setStatus("failed", message);
    const transcribed = fs.existsSync(sessionPaths(sessionId).transcriptJson);
    const resume = transcribed && !opts.retranscribe ? `/scrib summarize session:${number}` : `/scrib process session:${number}`;
    await notify(
      `⚠️ Processing session ${number} failed: ${message}\n` +
        `${transcribed ? "The transcript is saved." : "Every recorded clip is kept on disk."} ` +
        `Fix the problem, then run \`${resume}\` to resume.`,
    );
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
export function makeLiveTranscriber(recordingDir: string, log: (msg: string) => void = console.log) {
  let warned = false;
  const campaign = campaignFolderOfPath(recordingDir);
  return (file: string, characterNames: string[]) => {
    transcribeClip(recordingDir, file, sttKeywords(characterNames, campaign), config.deleteAudioAfterTranscribe).catch((err) => {
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
    for (const rid of sessionRecordings(s.id)) fs.rmSync(sessionPaths(rid).audio, { recursive: true, force: true });
    store.markAudioPurged(s.id);
    log(`[retention] purged audio for session ${s.number} (${s.id})`);
  }
}
