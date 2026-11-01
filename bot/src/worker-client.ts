import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";

export interface WorkerJob {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  progress: number;
  error: string | null;
}

/** The worker answered with an HTTP error (as opposed to not answering at all). */
export class WorkerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.workerUrl}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (err) {
    throw new Error(`Transcription worker unreachable at ${config.workerUrl} (is it running?): ${(err as Error).message}`);
  }
  if (!res.ok) throw new WorkerHttpError(`Worker ${method} ${path} failed: ${res.status} ${await res.text()}`, res.status);
  return (await res.json()) as T;
}

export interface WorkerHealth {
  ok: boolean;
  model: string;
  device: string;
  language: string;
  queued?: number;
  liveClips?: { done: number; failed: number };
  paused?: boolean;
  loadError?: string | null;
  recovered?: { sessions: number; clips: number };
  stats?: { clips: number; clipsPerMin?: number; avgSeconds?: number };
}

/** Minutes the worker needs to clear its queue at its recent rate, or null if unknown. */
export function backlogMinutes(h: Pick<WorkerHealth, "queued" | "stats">): number | null {
  const queued = h.queued ?? 0;
  if (!queued) return 0;
  const rate = h.stats?.clipsPerMin ?? (h.stats?.avgSeconds ? 60 / h.stats.avgSeconds : 0);
  return rate > 0 ? queued / rate : null;
}

export const workerHealth = (timeoutMs?: number) => call<WorkerHealth>("GET", "/health", undefined, timeoutMs);

/** Queue one finished clip for live transcription. Fire-and-forget: missed clips are redone at the end. */
export async function transcribeClip(sessionDir: string, file: string, keywords: string[], deleteAudio: boolean) {
  await call<{ queued: boolean }>("POST", "/clips/transcribe", { sessionDir, file, keywords, deleteAudio });
}

export interface TranscribeOptions {
  deleteAudio: boolean;
  onProgress?: (fraction: number) => void;
  /** Called (at most every 30 s) while the worker is unreachable or restarting. */
  onWaiting?: (message: string) => void;
  /** Clips in the session; sets the overall deadline (10 min + 5 s per clip). */
  clipCount?: number;
  /** Give up after the worker has been unreachable this long in a row. Default 5 min. */
  retryForMs?: number;
  /** Poll interval. Default 1 s. */
  pollMs?: number;
  /** Waits between failed calls (the last repeats). Default 1, 2, 5, 10, 15, then 30 s. */
  retryDelaysMs?: number[];
}

/** Back off 1, 2, 5, 10, 15 s, then every 30 s, between failed calls. */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000];

/**
 * Build transcript.json for a session (reusing clips already transcribed live) and wait for it
 * to be written. Survives a worker restart (02 S6, 05 C4): unreachable polls are retried for
 * `retryForMs`, and a job the restarted worker doesn't know (404) is submitted again, which is
 * cheap because every finished clip is cached on disk.
 */
export async function transcribe(sessionDir: string, keywords: string[], opts: TranscribeOptions): Promise<void> {
  const { onProgress } = opts;
  const retryForMs = opts.retryForMs ?? 5 * 60_000;
  const pollMs = opts.pollMs ?? 1000;
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const deadline = Date.now() + 10 * 60_000 + (opts.clipCount ?? 0) * 5_000;
  let failingSince: number | null = null;
  let failures = 0;
  let lastWaitNote = 0;
  let lastReported = -1;
  let id: string | null = null;

  const failed = (err: unknown) => {
    const now = Date.now();
    failingSince ??= now;
    failures++;
    if (now - failingSince > retryForMs) {
      throw new Error(
        `${(err as Error).message} (gave up after ${Math.round(retryForMs / 60_000)} min of retries; ` +
          "every clip is kept on disk, so running the session again finishes it)",
      );
    }
    if (now - lastWaitNote >= 30_000) {
      lastWaitNote = now;
      opts.onWaiting?.(`waiting for the worker: ${(err as Error).message}`);
    }
    return delays[Math.min(failures - 1, delays.length - 1)]!;
  };
  const ok = () => {
    failingSince = null;
    failures = 0;
  };

  for (;;) {
    if (Date.now() > deadline) throw new Error("Transcription timed out: the worker made no progress before the deadline");
    if (!id) {
      try {
        ({ id } = await call<{ id: string }>("POST", "/jobs/transcribe", { sessionDir, keywords, deleteAudio: opts.deleteAudio }, 30_000));
        ok();
      } catch (err) {
        if (err instanceof WorkerHttpError && err.status < 500 && err.status !== 429) throw err; // a real refusal
        await sleep(failed(err));
        continue;
      }
    }
    await sleep(pollMs);
    let job: WorkerJob;
    try {
      job = await call<WorkerJob>("GET", `/jobs/${id}`, undefined, 30_000);
      ok();
    } catch (err) {
      if (err instanceof WorkerHttpError && err.status === 404) {
        // The worker restarted and forgot the job; its clips are cached, so resubmitting is cheap.
        opts.onWaiting?.("the worker restarted; resubmitting the transcription job");
        id = null;
        continue;
      }
      await sleep(failed(err));
      continue;
    }
    if (job.status === "done") return;
    if (job.status === "failed") throw new Error(`Transcription failed: ${job.error}`);
    const pct = Math.floor(job.progress * 10);
    if (onProgress && pct !== lastReported) {
      lastReported = pct;
      onProgress(job.progress);
    }
  }
}
