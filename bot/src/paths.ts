import path from "node:path";
import { config } from "./config.js";

export function sessionPaths(sessionId: string) {
  const dir = path.join(config.sessionsDir, sessionId);
  return {
    dir,
    audio: path.join(dir, "audio"),
    timeline: path.join(dir, "timeline.json"),
    /** One JSON segment per line, appended per clip; timeline.json is a periodic snapshot (02 S10). */
    segmentsJournal: path.join(dir, "timeline.segments.jsonl"),
    transcriptJson: path.join(dir, "transcript.json"),
    transcriptMd: path.join(dir, "transcript.md"),
    chatlog: path.join(dir, "chatlog.json"),
    /** Character and NPC details from Foundry as they stood during this session. */
    actors: path.join(dir, "actors.json"),
    notes: path.join(dir, "notes.json"),
    summary: path.join(dir, "summary.json"),
    summaryMd: path.join(dir, "summary.md"),
  };
}

export const foundryActorsFile = () => path.join(config.dataDir, "foundry-actors.json");
