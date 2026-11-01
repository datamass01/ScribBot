import { EventEmitter } from "node:events";
import type { SessionStatus } from "./db.js";
import type { RosterLink } from "./links.js";

/** In-process bus between the pipeline and the Foundry WebSocket. */
export type BotEvent =
  | { type: "session.started"; sessionId: string; number: number; startedAt: string }
  | { type: "session.stopped"; sessionId: string; number: number; startedAt: string; endedAt: string }
  | { type: "session.status"; sessionId: string; status: SessionStatus; error?: string | null }
  | { type: "summary.ready"; sessionId: string; number: number; title: string }
  /** The module uploaded a session's chat and combat log (the headless client waits for it). */
  | { type: "chatlog.received"; sessionId: string }
  | { type: "roster.request" }
  /** Store these Discord IDs as the Foundry users' "Discord ID" flag (05 C11). GM-only in Foundry. */
  | { type: "roster.link"; links: RosterLink[] };

class Bus extends EventEmitter {
  emitEvent(e: BotEvent) {
    this.emit("event", e);
  }
  onEvent(fn: (e: BotEvent) => void) {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}

export const bus = new Bus();
