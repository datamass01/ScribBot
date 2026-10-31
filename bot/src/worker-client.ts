import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config.js";

export interface WorkerJob {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  progress: number;
  error: string | null;
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
  if (!res.ok) throw new Error(`Worker ${method} ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export interface WorkerHealth {
  ok: boolean;
  model: string;
  device: string;
  language: string;
  queued?: number;
  liveClips?: { done: number; failed: number };
}

export const workerHealth = (timeoutMs?: number) => call<WorkerHealth>("GET", "/health", undefined, timeoutMs);

/** Queue one finished clip for live transcription. Fire-and-forget: missed clips are redone at the end. */
export async function transcribeClip(sessionDir: string, file: string, keywords: string[], deleteAudio: boolean) {
  await call<{ queued: boolean }>("POST", "/clips/transcribe", { sessionDir, file, keywords, deleteAudio });
}

/**
 * Build transcript.json for a session (reusing clips already transcribed live)
 * and wait for it to be written.
 */
export async function transcribe(
  sessionDir: string,
  keywords: string[],
  opts: { deleteAudio: boolean; onProgress?: (fraction: number) => void },
): Promise<void> {
  const { onProgress } = opts;
  const { id } = await call<{ id: string }>("POST", "/jobs/transcribe", { sessionDir, keywords, deleteAudio: opts.deleteAudio });
  let lastReported = -1;
  for (;;) {
    await sleep(1000);
    const job = await call<WorkerJob>("GET", `/jobs/${id}`);
    if (job.status === "done") return;
    if (job.status === "failed") throw new Error(`Transcription failed: ${job.error}`);
    const pct = Math.floor(job.progress * 10);
    if (onProgress && pct !== lastReported) {
      lastReported = pct;
      onProgress(job.progress);
    }
  }
}
