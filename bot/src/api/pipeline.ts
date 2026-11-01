/**
 * The "Transcription pipeline" block of /status (docs/assessment/05 C1): queue depth, rate and
 * trend, per-session conversion with quality, alerts, and whether it's safe to shut down.
 * Ported from the monitor's Monitor.pipeline(), so the bot's dashboard is the one page to watch.
 *
 * Never opens timeline.json for a session the bot is recording (02 S1/S11): live counts come
 * from the recorder. Everything else is read from the session folders, memoized by mtime.
 */
import fs from "node:fs";
import path from "node:path";
import { sttKeywords } from "../campaign.js";
import { config } from "../config.js";
import type { SessionStatus } from "../db.js";
import { readTimeline } from "../timeline.js";

const CACHE_NAME = "transcript.partial.jsonl"; // the worker's per-clip results
const RATE_WINDOW_MS = 300_000; // throughput and queue trend over the last 5 minutes
const MIN_RATE_SPAN_MS = 20_000; // ...once at least this much history exists
const STALL_AFTER_MS = 120_000; // queue not empty and nothing converted for this long
const FAILED_RECENT_MS = 12 * 3600_000; // a failed session whose worker cache changed this recently
const SILENT_AFTER_MS = 180_000; // recording, but no new clip for this long
const BEHIND_TREND_PER_MIN = 1.0;
const NOISE_PROBABILITY = 0.35; // the worker's MIN_MEAN_PROBABILITY
const STOCK_HALLUCINATIONS = new Set([
  "thank you", "thank you for watching", "thanks for watching", "the end", "you",
  "please subscribe", "subtitles by the amara.org community", "bye",
]);

export interface ClipText {
  file: string;
  text: string;
  noise: boolean;
}

const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}_']+/gu) ?? []);

/** The worker's per-clip cache, one entry per clip (a retried clip counts once). */
export function parseCache(text: string): ClipText[] {
  const clips = new Map<string, ClipText>();
  for (const raw of text.split("\n")) {
    let entry: { file?: string; segments?: { text?: string; probability?: number }[] };
    try {
      entry = JSON.parse(raw);
    } catch {
      continue; // blank or torn last line
    }
    if (!entry || typeof entry.file !== "string") continue;
    const segs = entry.segments ?? [];
    const kept = segs.filter((s) => {
      const t = String(s.text ?? "").trim();
      return t && /[\p{L}\p{N}]/u.test(t) && Number(s.probability ?? 1) >= NOISE_PROBABILITY;
    });
    const joined = segs.map((s) => String(s.text ?? "").trim()).join(" ").trim();
    clips.set(entry.file, { file: entry.file, text: joined, noise: !kept.length });
  }
  return [...clips.values()];
}

/** Stock silence phrases, or text made (almost) only of hotwords: Whisper echoing its prompt. */
export function isHallucination(text: string, hotwordWords: Set<string>) {
  const w = words(text);
  if (!w.length) return false;
  if (STOCK_HALLUCINATIONS.has(w.join(" "))) return true;
  if (!hotwordWords.size) return false;
  return w.filter((x) => hotwordWords.has(x)).length / w.length >= 0.8;
}

export function quality(clips: ClipText[], hotwordWords: Set<string>) {
  if (!clips.length) return null;
  const noise = clips.filter((c) => c.noise).length;
  const suspect = clips.filter((c) => isHallucination(c.text, hotwordWords)).length;
  const counts = new Map<string, number>();
  for (const c of clips) {
    if (!c.text) continue;
    const key = words(c.text).join(" ");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const topRepeats = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .filter(([, n]) => n >= 3)
    .map(([text, count]) => ({ text, count }));
  return {
    clips: clips.length,
    noise,
    noisePct: Math.round((noise / clips.length) * 100),
    hallucinations: suspect,
    hallucinationPct: Math.round((suspect / clips.length) * 100),
    topRepeats,
  };
}

const dur = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : m ? `${m} min` : `${s} s`;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface PipelineSession {
  id: string;
  number: number;
  status: SessionStatus;
  processing: boolean;
  progress: number | null;
  clips: number | null;
  hasTranscript: boolean;
}

export interface PipelineRecording {
  sessionId: string;
  number: number;
  clips: number;
  speakers: { character: string | null }[];
}

export interface PipelineWorker {
  reachable: boolean;
  queued?: number;
  paused?: boolean;
  pausedReason?: string | null;
  liveClips?: { done: number; failed: number };
  recovered?: { sessions: number; clips: number };
  stats?: unknown;
}

type Phase = "recording" | "finishing" | "transcribed" | "summarizing" | "failed";

export interface Conversion {
  sessionId: string;
  number: number;
  status: SessionStatus;
  phase: Phase;
  clips: number;
  converted: number;
  pending: number;
  fraction: number;
  progress: number | null;
  quality: ReturnType<typeof quality>;
}

export interface Alert {
  key: string;
  level: "warn" | "err";
  text: string;
}

const ACTIVE = new Set<SessionStatus>(["recording", "transcribing", "summarizing"]);

/** Keeps the samples the rate and trend need between /status calls. */
export class PipelineTracker {
  private samples: { t: number; counts: Map<string, number>; queued: number | null; done: number; failed: number }[] = [];
  private progressSeen: { total: number; at: number } | null = null;
  private clipSeen = new Map<string, { clips: number; at: number }>();
  private memo = new Map<string, { key: string; value: unknown }>();

  constructor(
    private sessionsDir = config.sessionsDir,
    private clock: () => number = Date.now,
    private keywords: (party: string[]) => string[] = sttKeywords,
  ) {}

  /** `parse(text)` of a file, re-run only when it changes. Missing → null; unreadable → last value. */
  private read<T>(file: string, parse: (text: string) => T): T | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      this.memo.delete(file);
      return null;
    }
    const key = `${st.mtimeMs}:${st.size}`;
    const m = this.memo.get(file);
    if (m?.key === key) return m.value as T;
    try {
      const value = parse(fs.readFileSync(file, "utf8"));
      this.memo.set(file, { key, value });
      return value;
    } catch {
      return (m?.value as T) ?? null; // caught mid-write
    }
  }

  private recentFailed(s: PipelineSession) {
    if (s.status !== "failed" || s.hasTranscript) return false;
    try {
      return this.clock() - fs.statSync(path.join(this.sessionsDir, s.id, CACHE_NAME)).mtimeMs < FAILED_RECENT_MS;
    } catch {
      return false;
    }
  }

  build(input: { sessions: PipelineSession[]; recordings: PipelineRecording[]; worker: PipelineWorker }) {
    const { worker } = input;
    const recordings = new Map(input.recordings.map((r) => [r.sessionId, r]));
    const sessions = input.sessions.filter(
      (s) => recordings.has(s.id) || ACTIVE.has(s.status) || s.processing || this.recentFailed(s),
    );
    const party = input.recordings.flatMap((r) => r.speakers.flatMap((p) => (p.character ? [p.character] : [])));
    let names: string[] = [];
    try {
      names = this.keywords(party);
    } catch {
      // campaign files unreadable: no hotword check
    }
    const hotwordWords = new Set(names.flatMap(words));
    const conversions = sessions.map((s) => this.conversion(s, recordings.get(s.id), hotwordWords));
    const queued = worker.reachable ? (worker.queued ?? null) : null;
    const queue = this.measure(conversions, queued, worker);
    const alerts = this.alerts(input.recordings, conversions, queue);
    return {
      queue,
      conversions,
      hotwords: { count: names.length },
      alerts,
      shutdown: this.shutdown(worker, input.recordings, conversions, queue),
    };
  }

  private conversion(s: PipelineSession, recording: PipelineRecording | undefined, hotwordWords: Set<string>): Conversion {
    const folder = path.join(this.sessionsDir, s.id);
    let recorded = recording?.clips ?? s.clips ?? 0;
    if (!recording) {
      const fromDisk = this.read(path.join(folder, "timeline.json"), () => readTimeline(folder).segments.length);
      recorded = Math.max(recorded, fromDisk ?? 0);
    }
    const clips = this.read(path.join(folder, CACHE_NAME), parseCache);
    // The worker deletes its cache once transcript.json holds everything.
    const converted = clips ? clips.length : s.hasTranscript ? recorded : 0;
    recorded = Math.max(recorded, converted);
    const phase: Phase =
      s.status === "failed"
        ? "failed"
        : recording
          ? "recording"
          : s.status === "summarizing"
            ? "summarizing"
            : s.hasTranscript && !clips
              ? "transcribed"
              : "finishing";
    return {
      sessionId: s.id,
      number: s.number,
      status: s.status,
      phase,
      clips: recorded,
      converted,
      pending: recorded - converted,
      fraction: recorded ? Math.round((converted / recorded) * 10_000) / 10_000 : s.hasTranscript ? 1 : 0,
      progress: s.progress,
      quality: quality(clips ?? [], hotwordWords),
    };
  }

  private measure(conversions: Conversion[], queued: number | null, worker: PipelineWorker) {
    const now = this.clock();
    const counts = new Map(conversions.map((c) => [c.sessionId, c.converted]));
    const done = worker.liveClips?.done ?? 0;
    const failed = worker.liveClips?.failed ?? 0;
    this.samples.push({ t: now, counts, queued, done, failed });
    while (this.samples.length && now - this.samples[0]!.t > RATE_WINDOW_MS) this.samples.shift();
    const first = this.samples[0]!;
    const span = now - first.t;
    let rate: number | null = null;
    let trend: number | null = null;
    const failedRecently = failed >= first.failed ? failed - first.failed : failed; // worker restarted
    if (span >= MIN_RATE_SPAN_MS) {
      let bySession = 0;
      for (const [id, n] of counts) {
        const before = first.counts.get(id);
        if (before !== undefined) bySession += Math.max(0, n - before);
      }
      const byWorker = done >= first.done ? done + failed - first.done - first.failed : 0;
      rate = Math.round((Math.max(bySession, byWorker) / span) * 600_000) / 10;
      if (queued != null && first.queued != null) trend = Math.round(((queued - first.queued) / span) * 600_000) / 10;
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0) + done + failed;
    if (!this.progressSeen || total !== this.progressSeen.total) this.progressSeen = { total, at: now };
    const idleMs = now - this.progressSeen.at;
    const pending = conversions.reduce((a, c) => a + c.pending, 0);
    const paused = Boolean(worker.paused);
    return {
      paused,
      pausedReason: worker.pausedReason ?? null,
      worker: worker.stats ?? null,
      recovered: worker.recovered ?? null,
      depth: queued,
      pendingClips: pending,
      ratePerMin: rate,
      trendPerMin: trend,
      etaSec: rate && pending ? Math.round((pending / rate) * 60) : pending ? null : 0,
      windowSec: Math.round(span / 1000),
      liveFailedRecently: failedRecently,
      noProgressSec: Math.round(idleMs / 1000),
      stalled: Boolean(queued) && !paused && idleMs >= STALL_AFTER_MS,
    };
  }

  private alerts(recordings: PipelineRecording[], conversions: Conversion[], queue: ReturnType<PipelineTracker["measure"]>) {
    const out: Alert[] = [];
    const now = this.clock();
    const add = (key: string, level: Alert["level"], text: string) => out.push({ key, level, text });

    const live = new Set<string>();
    for (const r of recordings) {
      live.add(r.sessionId);
      const seen = this.clipSeen.get(r.sessionId);
      if (!seen || seen.clips !== r.clips) this.clipSeen.set(r.sessionId, { clips: r.clips, at: now });
      else if (r.speakers.length && now - seen.at >= SILENT_AFTER_MS) {
        add(`silent-${r.sessionId}`, "warn", `Session ${r.number}: no new audio for ${dur((now - seen.at) / 1000)}. ` +
          "If people are talking, check that the bot is still in the voice channel.");
      }
    }
    for (const id of this.clipSeen.keys()) if (!live.has(id)) this.clipSeen.delete(id);

    if (queue.paused) {
      const why = queue.pausedReason ? ` (${queue.pausedReason})` : "";
      add("paused", "warn", `Transcription is paused${why} with ${plural(queue.depth ?? 0, "clip")} queued. ` +
        "Resume it: Invoke-RestMethod -Method Post http://127.0.0.1:7421/resume -ContentType application/json -Body '{}'");
    }
    if (queue.stalled) {
      add("stalled", "err", `The transcription worker has ${plural(queue.depth ?? 0, "clip")} queued but hasn't converted ` +
        `anything for ${dur(queue.noProgressSec)}. Check its window or data\\logs\\worker-*.log for errors.`);
    } else if (recordings.length && queue.trendPerMin != null && queue.trendPerMin > BEHIND_TREND_PER_MIN && queue.windowSec >= 60) {
      const eta = queue.etaSec ? ` At the current rate the transcript will be ready about ${dur(queue.etaSec)} after /scrib stop.` : "";
      add("behind", "warn", `Transcription is falling behind: ${plural(queue.pendingClips, "clip")} waiting, ` +
        `growing by ${queue.trendPerMin}/min.${eta}`);
    }
    if (queue.liveFailedRecently) {
      add("live-failed", "warn", `${plural(queue.liveFailedRecently, "live clip")} failed to transcribe in the last ` +
        `${dur(queue.windowSec)}. They're retried at /scrib stop; the worker's log has the error.`);
    }
    for (const c of conversions) {
      if (c.phase !== "failed") continue;
      const done = `${c.converted} of ${plural(c.clips, "clip")} converted`;
      add(`failed-${c.sessionId}`, "warn", queue.depth
        ? `Session ${c.number} is marked failed, but the worker is still converting its clips from disk (${done}). ` +
          `When the worker queue is empty, run /scrib process session:${c.number}.`
        : `Session ${c.number} failed (${done}). Run /scrib process session:${c.number} to finish it.`);
    }
    for (const c of conversions) {
      const q = c.quality;
      if (q && q.clips >= 30 && q.hallucinationPct >= 15) {
        add(`quality-${c.sessionId}`, "warn", `Session ${c.number}: ${q.hallucinationPct}% of converted clips look like ` +
          "hallucinations (e.g. names from the hotword list instead of speech). See docs/assessment/01-performance-and-cpu-offload.md (R1).");
      }
    }
    return out;
  }

  private shutdown(worker: PipelineWorker, recordings: PipelineRecording[], conversions: Conversion[], queue: ReturnType<PipelineTracker["measure"]>) {
    if (recordings.length) {
      return {
        state: "no" as const,
        title: "Don't shut down: recording in progress",
        reasons: recordings.map((r) => `Session ${r.number} is recording. Run /scrib stop in Discord first.`),
      };
    }
    const reasons: string[] = [];
    const notes: string[] = [];
    for (const c of conversions) {
      if (c.phase === "finishing") {
        const pct = c.progress ?? c.fraction;
        reasons.push(`Session ${c.number} is being transcribed (${Math.round(pct * 100)}%, ${plural(c.pending, "clip")} left).`);
      } else if (c.phase === "summarizing" || (c.phase === "transcribed" && c.status !== "complete")) {
        reasons.push(`Session ${c.number} is being summarized.`);
      } else if (c.phase === "failed") {
        notes.push(`Session ${c.number} failed; run /scrib process session:${c.number} to finish it.`);
      }
    }
    if (reasons.length && !worker.reachable) reasons.push("The worker is unreachable, so this can't finish until it's running again.");
    if (queue.depth) {
      const eta = queue.etaSec ? `, about ${dur(queue.etaSec)} at the current rate` : "";
      const held = queue.paused ? " It is paused, so they won't finish until it's resumed." : "";
      reasons.push(`${plural(queue.depth, "clip")} still waiting in the worker${eta}.${held} ` +
        "Stopping the worker now drops the queue; it re-queues the clips from disk when it starts again.");
    }
    if (reasons.length) return { state: "wait" as const, title: "Wait: still transcribing", reasons: [...reasons, ...notes] };
    return {
      state: "safe" as const,
      title: "Safe to shut down",
      reasons: ["Nothing is recording, transcribing or summarizing, and the worker queue is empty.", ...notes],
    };
  }
}
