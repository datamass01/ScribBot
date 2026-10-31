import { format } from "node:util";
import { bus } from "./events.js";

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

/** Mirror console.log/warn/error and bus events into the feed. Output still reaches the terminal. */
export function installLogCapture() {
  if (installed) return;
  installed = true;
  const wrap = (method: "log" | "info" | "warn" | "error", level: LogEntry["level"]) => {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      record(level, format(...args));
    };
  };
  wrap("log", "info");
  wrap("info", "info");
  wrap("warn", "warn");
  wrap("error", "error");
  bus.onEvent((e) => {
    if (e.type === "roster.request") return;
    const { type, ...rest } = e;
    record("event", `${type} ${JSON.stringify(rest)}`);
  });
}
