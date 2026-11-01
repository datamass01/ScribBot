/** What to do on startup with sessions the last process left mid-flight (docs/assessment/02 S3, S8). */
import fs from "node:fs";
import type { SessionRow } from "./db.js";
import { mergedInto } from "./merge.js";
import type { sessionPaths } from "./paths.js";

/** Error text a clean shutdown leaves on a session it stopped mid-recording. */
export const SHUTDOWN_NOTE = "Recording stopped when the bot shut down; it is processed on the next start.";

type Paths = Pick<ReturnType<typeof sessionPaths>, "timeline" | "segmentsJournal">;

/** When the session last wrote anything: the newest of its timeline files, else its start. */
export function lastActivityMs(s: Pick<SessionRow, "started_at">, paths: Paths) {
  let last = Date.parse(s.started_at);
  for (const f of [paths.timeline, paths.segmentsJournal]) {
    try {
      last = Math.max(last, fs.statSync(f).mtimeMs);
    } catch {
      // not written yet
    }
  }
  return last;
}

export interface RestartPlan {
  /** Still `recording` and recently active: rejoin the channel and continue. */
  resume: SessionRow[];
  /** Interrupted and not resumable: mark failed, and tell the table. */
  interrupted: SessionRow[];
  /** Stopped cleanly by a shutdown: run the pipeline now. */
  process: SessionRow[];
}

export function planRestart(
  sessions: SessionRow[],
  opts: { now: number; resumeWindowMs: number; paths: (id: string) => Paths },
): RestartPlan {
  const plan: RestartPlan = { resume: [], interrupted: [], process: [] };
  for (const s of sessions) {
    if (s.status === "recording") {
      const idle = opts.now - lastActivityMs(s, opts.paths(s.id));
      (opts.resumeWindowMs > 0 && idle <= opts.resumeWindowMs ? plan.resume : plan.interrupted).push(s);
    } else if (s.status === "transcribing" || s.status === "summarizing") {
      plan.interrupted.push(s);
    } else if (s.status === "failed" && s.error === SHUTDOWN_NOTE) {
      plan.process.push(s);
    }
  }
  return plan;
}

/**
 * `/scrib process` with no session (05 C5): the latest failed session, else the latest one that
 * isn't recording. Merged-away sessions are skipped.
 */
export function defaultSessionToProcess(sessions: SessionRow[], guildId: string) {
  const mine = sessions
    .filter((s) => s.guild_id === guildId && s.status !== "recording" && mergedInto(s) == null)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
  return mine.find((s) => s.status === "failed") ?? mine[0];
}
