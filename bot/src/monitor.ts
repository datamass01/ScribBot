import { format } from "node:util";
import { bus } from "./events.js";
import type { DailyLog } from "./logfile.js";

/** In-memory activity feed for the monitor dashboard: recent console output plus bus events. */
export interface LogEntry {
  seq: number;
  t: string;
  level: "info" | "warn" | "error" | "event";
  msg: string;
}

const MAX_ENTRIES = 500;
const entries: LogEntry[] = [];
let seq = 0;

export function record(level: LogEntry["level"], msg: string) {
  entries.push({ seq: ++seq, t: new Date().toISOString(), level, msg });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/** Entries newer than `after`, oldest first. */
export function logsSince(after = 0, limit = MAX_ENTRIES) {
  const out = entries.filter((e) => e.seq > after);
  return out.slice(-limit);
}

let installed = false;
let logFile: DailyLog | null = null;

/** Write a line straight to the log file (e.g. from an exit hook, where nothing async can run). */
export function writeLogFile(level: LogEntry["level"], msg: string) {
  logFile?.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`);
}

/**
 * Mirror console.log/warn/error and bus events into the feed, and into `file` when given
 * (02 S9). Output still reaches the terminal.
 */
export function installLogCapture(file?: DailyLog) {
  if (installed) return;
  installed = true;
  logFile = file ?? null;
  const wrap = (method: "log" | "info" | "warn" | "error", level: LogEntry["level"]) => {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      const msg = format(...args);
      record(level, msg);
      writeLogFile(level, msg);
    };
  };
  wrap("log", "info");
  wrap("info", "info");
  wrap("warn", "warn");
  wrap("error", "error");
  bus.onEvent((e) => {
    if (e.type === "roster.request") return;
    const { type, ...rest } = e;
    const msg = `${type} ${JSON.stringify(rest)}`;
    record("event", msg);
    writeLogFile("event", msg);
  });
}
