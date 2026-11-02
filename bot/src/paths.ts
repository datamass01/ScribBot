import path from "node:path";
import { config } from "./config.js";

/**
 * Where a session's files are (docs/design.md §6.1).
 *
 *   DATA_DIR/campaigns/<world>/sessions/<NNN>/             the game: transcript, chat log, summary, story
 *   DATA_DIR/campaigns/<world>/sessions/<NNN>/recordings/<id>/   one Discord recording: timeline, audio,
 *                                                            the worker's cache, its own transcript and chat log
 *
 * A session row in the database is one recording; a merged recording's folder moves into the
 * game it continues. The database records each recording's folder (`sessions.dir`), so paths are
 * looked up there. Sessions from before the layout migration have no `dir` and resolve to the
 * old flat DATA_DIR/sessions/<id>/, where the recording and the game are the same folder.
 */
export interface SessionLookup {
  /** The recording's folder relative to DATA_DIR, or null (old layout, or unknown). */
  dir(id: string): string | null;
  /** The recording and any merged into it, oldest first. */
  recordings(id: string): string[];
  /** The game a recording belongs to: the session it was merged into, else itself. */
  primary(id: string): string;
}

let lookup: SessionLookup | null = null;

/** Called by the Store; tests without one get the old flat layout. */
export function setSessionLookup(l: SessionLookup | null) {
  lookup = l;
}

export function recordingDir(sessionId: string) {
  const rel = lookup?.dir(sessionId);
  return rel ? path.join(config.dataDir, ...rel.split("/")) : path.join(config.sessionsDir, sessionId);
}

/** The game a recording belongs to (itself unless it was merged into another session). */
export function primarySession(sessionId: string) {
  return lookup?.primary(sessionId) ?? sessionId;
}

/** The recording ids of a game (itself first when nothing was merged into it). */
export function sessionRecordings(sessionId: string): string[] {
  const ids = lookup?.recordings(sessionId) ?? [];
  return ids.length ? ids : [sessionId];
}

export function sessionPaths(sessionId: string) {
  const recording = recordingDir(sessionId);
  // In the campaign layout the game's folder is two levels up (…/<NNN>/recordings/<id>).
  const dir = path.basename(path.dirname(recording)) === "recordings" ? path.dirname(path.dirname(recording)) : recording;
  return {
    /** The game's folder: the files people open. Same as `recording` in the old flat layout. */
    dir,
    /** This recording's folder: what the recorder and the worker write. */
    recording,
    audio: path.join(recording, "audio"),
    timeline: path.join(recording, "timeline.json"),
    /** One JSON segment per line, appended per clip; timeline.json is a periodic snapshot (02 S10). */
    segmentsJournal: path.join(recording, "timeline.segments.jsonl"),
    /** The worker's transcript of this recording alone. */
    recordingTranscript: path.join(recording, "transcript.json"),
    /** The chat log Foundry uploaded for this recording's time window. */
    recordingChatlog: path.join(recording, "chatlog.json"),
    /** Character and NPC details as Foundry reported them during this recording. */
    recordingActors: path.join(recording, "actors.json"),
    // The game's files, built from its recordings (layout.ts composeSession).
    transcriptJson: path.join(dir, "transcript.json"),
    transcriptMd: path.join(dir, "transcript.md"),
    chatlog: path.join(dir, "chatlog.json"),
    /** Character and NPC details from Foundry as they stood this session. */
    actors: path.join(dir, "actors.json"),
    notes: path.join(dir, "notes.json"),
    summary: path.join(dir, "summary.json"),
    summaryMd: path.join(dir, "summary.md"),
  };
}

export const foundryActorsFile = () => path.join(config.dataDir, "foundry-actors.json");
