/**
 * The campaign folder layout (docs/design.md §6.1): building a game's files from its recordings,
 * and moving games between campaigns. Folder moves here are only ever done for a game that is
 * neither recording nor being processed; callers check that first.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { recordingRel, sessionFolderName, type SessionRow, type Store } from "./db.js";
import { renameWithRetry, writeFileAtomic } from "./fsutil.js";
import { MERGE_MARKER_ID, formatGap, renderTranscriptMarkdown } from "./merge.js";
import { sessionPaths, sessionRecordings } from "./paths.js";
import { readTimeline } from "./timeline.js";
import {
  ChatLogSchema,
  TranscriptSchema,
  type ChatLog,
  type Participant,
  type Segment,
  type Timeline,
  type Transcript,
  type TranscriptLine,
} from "./types.js";

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));

/** The game a recording belongs to: itself, or the session it was merged into. */
export function primaryId(store: Store, id: string) {
  return store.getSession(id)?.merged_into_id ?? id;
}

/** True when the session still uses the old flat DATA_DIR/sessions/<id>/ folder. */
export function isLegacy(id: string) {
  const p = sessionPaths(id);
  return p.dir === p.recording;
}

interface Part {
  id: string;
  row: SessionRow | undefined;
  folder: string;
  timeline: Timeline;
  startMs: number;
  endMs: number;
}

/** A recording's end: endedAt, or (after a crash) its last clip or line. */
function endMs(timeline: Timeline, transcript: Transcript | null) {
  if (timeline.endedAt) return Date.parse(timeline.endedAt);
  const start = Date.parse(timeline.startedAt);
  const lastClip = Math.max(0, ...timeline.segments.map((s) => s.endMs));
  const lastLine = Math.max(0, ...(transcript?.lines ?? []).map((l) => l.end * 1000));
  return start + Math.max(lastClip, lastLine);
}

/** The game's recordings that have a timeline, oldest first. */
function parts(store: Store, id: string): Part[] {
  const out: Part[] = [];
  for (const rid of sessionRecordings(primaryId(store, id))) {
    const folder = sessionPaths(rid).recording;
    let timeline: Timeline;
    try {
      timeline = readTimeline(folder);
    } catch {
      continue; // no timeline: nothing was recorded
    }
    const file = sessionPaths(rid).recordingTranscript;
    const transcript = fs.existsSync(file) ? TranscriptSchema.parse(readJson(file)) : null;
    out.push({ id: rid, row: store.getSession(rid), folder, timeline, startMs: Date.parse(timeline.startedAt), endMs: endMs(timeline, transcript) });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * The game's timeline: the first recording's start, the last one's end, every participant, and
 * every clip with times from the game's start and paths relative to the game's folder.
 */
export function sessionTimeline(store: Store, id: string): Timeline {
  const all = parts(store, id);
  if (!all.length) return readTimeline(sessionPaths(id).recording); // throws the usual "no timeline" error
  const first = all[0]!;
  const root = sessionPaths(primaryId(store, id)).dir;
  const participants: Participant[] = [];
  const seen = new Set<string>();
  const segments: Segment[] = [];
  for (const p of all) {
    for (const person of p.timeline.participants) {
      if (!seen.has(person.discordId)) {
        seen.add(person.discordId);
        participants.push(person);
      }
    }
    const offset = p.startMs - first.startMs;
    const prefix = path.relative(root, p.folder).split(path.sep).join("/");
    for (const s of p.timeline.segments) {
      segments.push({ ...s, startMs: s.startMs + offset, endMs: s.endMs + offset, file: prefix ? `${prefix}/${s.file}` : s.file });
    }
  }
  const last = all[all.length - 1]!;
  return {
    ...first.timeline,
    sessionId: primaryId(store, id),
    endedAt: last.timeline.endedAt ?? (all.length > 1 ? new Date(last.endMs).toISOString() : null),
    participants,
    segments: segments.sort((a, b) => a.startMs - b.startMs),
  };
}

/** Chat logs of several recordings as one: messages and combats once each, by id, in time order. */
export function combineChatlogs(logs: ChatLog[]): ChatLog | null {
  if (!logs.length) return null;
  const messages = new Map<string, ChatLog["messages"][number]>();
  const combats = new Map<string, ChatLog["combats"][number]>();
  for (const log of logs) {
    for (const m of log.messages) if (!messages.has(m.id)) messages.set(m.id, m);
    // A combat spanning a break shows up in both exports; the later copy is the more complete one.
    for (const c of log.combats) combats.set(c.id, c);
  }
  const exportedAt = Math.max(0, ...logs.map((l) => l.exportedAt ?? 0));
  return {
    world: logs.find((l) => l.world)?.world ?? null,
    system: logs.find((l) => l.system)?.system ?? null,
    ...(exportedAt ? { exportedAt } : {}),
    messages: [...messages.values()].sort((a, b) => a.timestamp - b.timestamp),
    combats: [...combats.values()],
  };
}

export interface ComposeResult {
  recordings: number;
  /** Lines in the game's transcript, or null when a recording isn't transcribed yet. */
  lines: number | null;
  chatMessages: number;
  combats: number;
}

/**
 * Writes the game's transcript.json/.md, chatlog.json and actors.json from its recordings.
 * Safe to run any time: the recordings are never changed, and every file is replaced atomically.
 * In the old flat layout the worker already writes the game's files, so there is nothing to do.
 */
export function composeSession(store: Store, id: string): ComposeResult {
  const primary = primaryId(store, id);
  const root = sessionPaths(primary);
  const ids = sessionRecordings(primary);
  if (ids.length === 1 && root.recording === root.dir) {
    return { recordings: 1, lines: null, chatMessages: 0, combats: 0 };
  }
  fs.mkdirSync(root.dir, { recursive: true });

  // ---------- transcript ----------
  const all = parts(store, primary);
  let lines: number | null = null;
  const transcripts = all.map((p) => {
    const file = sessionPaths(p.id).recordingTranscript;
    return fs.existsSync(file) ? TranscriptSchema.parse(readJson(file)) : null;
  });
  if (all.length && transcripts.every((t) => t)) {
    const t0 = all[0]!.startMs;
    const out: TranscriptLine[] = [];
    all.forEach((p, i) => {
      const offset = (p.startMs - t0) / 1000;
      const shift = (x: number) => Math.round((x + offset) * 100) / 100;
      if (i > 0) {
        const gap = Math.max(0, (p.startMs - all[i - 1]!.endMs) / 1000);
        const who = p.row && p.row.number !== store.getSession(primary)?.number ? ` (session ${p.row.number} merged in)` : "";
        out.push({ t: shift(0), end: shift(0), discordId: MERGE_MARKER_ID, speaker: "ScribBot", character: null, isGm: false,
          text: `— recording resumed after ${formatGap(gap)} gap${who} —` });
      }
      for (const l of transcripts[i]!.lines) out.push({ ...l, t: shift(l.t), end: shift(l.end) });
    });
    const models = [...new Set(transcripts.map((t) => t!.model))];
    const transcript: Transcript = {
      sessionId: primary,
      model: models.join(" + "),
      language: transcripts.find((t) => t!.language)?.language ?? null,
      createdAt: new Date().toISOString(),
      lines: out,
    };
    const timeline = sessionTimeline(store, primary);
    writeFileAtomic(root.transcriptJson, JSON.stringify(transcript, null, 2));
    writeFileAtomic(root.transcriptMd, renderTranscriptMarkdown(transcript, `Session transcript, ${timeline.startedAt.slice(0, 10)}`, timeline));
    lines = out.length;
  }

  // ---------- chat log and actors ----------
  const logs = ids
    .map((rid) => sessionPaths(rid).recordingChatlog)
    .filter((f) => fs.existsSync(f))
    .map((f) => ChatLogSchema.parse(readJson(f)));
  const chatlog = combineChatlogs(logs);
  if (chatlog) writeFileAtomic(root.chatlog, JSON.stringify(chatlog, null, 2));
  const actors = [...ids].reverse().map((rid) => sessionPaths(rid).recordingActors).find((f) => fs.existsSync(f));
  if (actors) writeFileAtomic(root.actors, fs.readFileSync(actors, "utf8"));

  return { recordings: ids.length, lines, chatMessages: chatlog?.messages.length ?? 0, combats: chatlog?.combats.length ?? 0 };
}

/** Moves a folder, creating the parent; refuses to overwrite. Windows sharing errors are retried. */
export function moveFolder(from: string, to: string) {
  if (fs.existsSync(to)) throw new Error(`${to} already exists.`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    renameWithRetry(from, to);
  } catch (err) {
    throw new Error(`Couldn't move ${from} to ${to} (${(err as Error).message}). Something may have a file in it open, such as the worker or an editor.`);
  }
}

/** Removes a folder only if nothing is left in it (and empty parents up to `stop`). */
export function removeIfEmpty(dir: string, stop: string) {
  let d = dir;
  while (d.startsWith(stop) && d !== stop) {
    try {
      if (fs.readdirSync(d).length) return;
      fs.rmdirSync(d);
    } catch {
      return;
    }
    d = path.dirname(d);
  }
}

/**
 * Moves a game (all its recordings) into another campaign, numbered there. Its folder becomes
 * campaigns/<campaign>/sessions/<NNN>. Throws, changing nothing, when the target folder exists.
 */
export function moveToCampaign(store: Store, id: string, campaignId: number) {
  const primary = primaryId(store, id);
  const row = store.getSession(primary);
  const campaign = store.getCampaign(campaignId);
  if (!row) throw new Error("No such session.");
  if (!campaign) throw new Error("No such campaign.");
  if (row.campaign_id === campaignId) return row;
  const number = store.nextNumber(campaignId, row.guild_id);
  const from = sessionPaths(primary).dir;
  const to = path.join(config.dataDir, "campaigns", campaign.folder, "sessions", sessionFolderName(number));
  if (fs.existsSync(from)) moveFolder(from, to);
  store.db.transaction(() => {
    for (const rid of sessionRecordings(primary)) {
      const r = store.getSession(rid)!;
      store.setSessionPlace(rid, { dir: recordingRel(campaign.folder, number, rid), campaignId, number: rid === primary ? number : r.number });
    }
  })();
  removeIfEmpty(path.dirname(from), path.join(config.dataDir, "campaigns"));
  console.log(`[layout] session ${row.number} moved to campaign ${campaign.folder} as session ${number}`);
  return store.getSession(primary)!;
}
