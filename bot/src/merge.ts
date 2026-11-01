/**
 * Merge an interrupted game's continuation session (B) into the session it continues (A),
 * so one evening of play gets one transcript and one summary (docs/assessment/02 S15).
 *
 * Used by `npm run merge` (bot/scripts/merge-sessions.ts) and `/scrib merge`.
 */
import fs from "node:fs";
import path from "node:path";
import type { SessionRow, Store } from "./db.js";
import { writeFileAtomic } from "./fsutil.js";
import { sessionPaths } from "./paths.js";
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

/** discordId of the marker line inserted where the recording resumed. */
export const MERGE_MARKER_ID = "scribbot";
const MERGED_PREFIX = "Merged into session ";

/** The session number B was merged into, or null if it wasn't merged. */
export function mergedInto(session: Pick<SessionRow, "error">): number | null {
  const m = session.error?.startsWith(MERGED_PREFIX) ? /^Merged into session (\d+)/.exec(session.error) : null;
  return m ? Number(m[1]) : null;
}

export interface MergeResult {
  target: SessionRow;
  source: SessionRow;
  /** Seconds between A's start and B's start; B's times are shifted by this. */
  offsetSec: number;
  /** Seconds between the end of A's recording and the start of B's. */
  gapSec: number;
  linesAdded: number;
  chatAdded: number;
  combatsAdded: number;
  /** B's clips copied into A, so a re-transcription of A keeps B's lines. */
  audioCopied: number;
  /** Paths of the `.premerge-<n>` backups written. */
  backups: string[];
  warnings: string[];
}

const BUSY = new Set(["recording", "transcribing", "summarizing"]);

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const writeAtomic = (file: string, text: string) => writeFileAtomic(file, text);

/** "12 min", "45 s", "1 h 05 min". */
export function formatGap(sec: number) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

/** When A's recording actually ended: endedAt, or (after a crash) its last clip or line. */
function recordingEndMs(timeline: Timeline, transcript: Transcript | null) {
  if (timeline.endedAt) return Date.parse(timeline.endedAt);
  const start = Date.parse(timeline.startedAt);
  const lastClip = Math.max(0, ...timeline.segments.map((s) => s.endMs));
  const lastLine = Math.max(0, ...(transcript?.lines ?? []).map((l) => l.end * 1000));
  return start + Math.max(lastClip, lastLine);
}

/** Where B's clip lands inside A's folder: `audio/<speaker>/m<B number>-<name>.wav`. */
function mergedClipPath(file: string, sourceNumber: number) {
  const parts = file.split("/");
  const name = parts.pop()!;
  return [...parts, `m${sourceNumber}-${name}`].join("/");
}

/**
 * Merge session `sourceId` (B, the continuation) into `targetId` (A). B's folder is left
 * untouched; A's files are backed up first and rewritten atomically. Throws, changing nothing,
 * if the merge isn't possible.
 */
export function mergeSessions(
  store: Store,
  targetId: string,
  sourceId: string,
  opts: { isBusy?: (sessionId: string) => boolean } = {},
): MergeResult {
  const a = store.getSession(targetId);
  const b = store.getSession(sourceId);
  if (!a) throw new Error(`Unknown session ${targetId}`);
  if (!b) throw new Error(`Unknown session ${sourceId}`);
  if (a.id === b.id) throw new Error("Can't merge a session into itself.");
  if (a.guild_id !== b.guild_id) throw new Error("Those sessions belong to different servers.");
  for (const s of [a, b]) {
    if (BUSY.has(s.status) || opts.isBusy?.(s.id)) {
      throw new Error(`Session ${s.number} is ${s.status === "recording" ? "still recording" : "being processed"}; wait for it to finish.`);
    }
    const into = mergedInto(s);
    if (into != null) throw new Error(`Session ${s.number} was already merged into session ${into}.`);
  }

  const pa = sessionPaths(a.id);
  const pb = sessionPaths(b.id);
  for (const [s, p] of [[a, pa], [b, pb]] as const) {
    if (!fs.existsSync(p.timeline)) throw new Error(`Session ${s.number} has no timeline.json.`);
    if (!fs.existsSync(p.transcriptJson)) {
      throw new Error(`Session ${s.number} isn't transcribed yet. Transcribe it first (\`/scrib process session:${s.number}\`).`);
    }
  }

  const tlA = readTimeline(pa.dir);
  const tlB = readTimeline(pb.dir);
  const trA = TranscriptSchema.parse(readJson(pa.transcriptJson));
  const trB = TranscriptSchema.parse(readJson(pb.transcriptJson));
  const chatA = fs.existsSync(pa.chatlog) ? ChatLogSchema.parse(readJson(pa.chatlog)) : null;
  const chatB = fs.existsSync(pb.chatlog) ? ChatLogSchema.parse(readJson(pb.chatlog)) : null;

  const startA = Date.parse(tlA.startedAt);
  const startB = Date.parse(tlB.startedAt);
  if (!(startB >= startA)) {
    throw new Error(`Session ${b.number} started before session ${a.number}; merge them the other way round.`);
  }
  const offsetMs = startB - startA;
  const offsetSec = offsetMs / 1000;
  const endA = recordingEndMs(tlA, trA);
  const gapSec = Math.max(0, (startB - endA) / 1000);
  const warnings: string[] = [];

  // ---------- transcript ----------
  const shift = (x: number) => Math.round((x + offsetSec) * 100) / 100;
  const marker: TranscriptLine = {
    t: shift(0),
    end: shift(0),
    discordId: MERGE_MARKER_ID,
    speaker: "ScribBot",
    character: null,
    isGm: false,
    text: `— recording resumed after ${formatGap(gapSec)} gap (session ${b.number} merged in) —`,
  };
  const linesB = trB.lines.map((l) => ({ ...l, t: shift(l.t), end: shift(l.end) }));
  const lines = [...trA.lines, marker, ...linesB].sort((x, y) => x.t - y.t || (x === marker ? -1 : y === marker ? 1 : 0));
  const transcript: Transcript = {
    ...trA,
    model: trA.model === trB.model ? trA.model : `${trA.model} + ${trB.model}`,
    language: trA.language ?? trB.language,
    createdAt: new Date().toISOString(),
    lines,
  };

  // ---------- timeline + audio ----------
  const participants: Participant[] = [...tlA.participants];
  const known = new Set(participants.map((p) => p.discordId));
  for (const p of tlB.participants) if (!known.has(p.discordId)) participants.push(p);
  const endedB = tlB.endedAt ?? b.ended_at ?? new Date(recordingEndMs(tlB, trB)).toISOString();

  const copies: { from: string; to: string }[] = [];
  let segments: Segment[] = tlA.segments;
  const missing = tlB.segments.filter((s) => !fs.existsSync(path.join(pb.dir, s.file))).length;
  if (a.audio_purged) {
    warnings.push(`Session ${a.number}'s audio is already deleted, so B's clips weren't copied; it can't be re-transcribed.`);
  } else if (!tlB.segments.length) {
    // nothing to copy
  } else if (missing) {
    warnings.push(
      `${missing} of session ${b.number}'s ${tlB.segments.length} clips have no audio left, so its clips weren't added ` +
        `to session ${a.number}'s timeline. Re-transcribing session ${a.number} would drop session ${b.number}'s lines.`,
    );
  } else {
    const shifted = tlB.segments.map((s) => {
      const file = mergedClipPath(s.file, b.number);
      copies.push({ from: path.join(pb.dir, s.file), to: path.join(pa.dir, file) });
      return { ...s, startMs: s.startMs + offsetMs, endMs: s.endMs + offsetMs, file };
    });
    const clash = copies.find((c) => fs.existsSync(c.to));
    if (clash) throw new Error(`Session ${a.number} already has ${clash.to}; was this merge started before?`);
    segments = [...tlA.segments, ...shifted].sort((x, y) => x.startMs - y.startMs);
  }
  const timeline: Timeline = { ...tlA, endedAt: endedB, participants, segments };

  // ---------- chat log ----------
  let chatlog: ChatLog | null = null;
  let chatAdded = 0;
  let combatsAdded = 0;
  if (chatA || chatB) {
    const base = chatA ?? { world: null, messages: [], combats: [] };
    const msgIds = new Set(base.messages.map((m) => m.id));
    const newMsgs = (chatB?.messages ?? []).filter((m) => !msgIds.has(m.id));
    const combatIds = new Set(base.combats.map((c) => c.id));
    const newCombats = (chatB?.combats ?? []).filter((c) => !combatIds.has(c.id));
    // A combat spanning the break shows up in both exports; keep the later (more complete) copy.
    const laterCombat = new Map((chatB?.combats ?? []).map((c) => [c.id, c]));
    chatAdded = newMsgs.length;
    combatsAdded = newCombats.length;
    const exportedAt = Math.max(chatA?.exportedAt ?? 0, chatB?.exportedAt ?? 0);
    chatlog = {
      world: base.world ?? chatB?.world ?? null,
      ...(exportedAt ? { exportedAt } : {}),
      messages: [...base.messages, ...newMsgs].sort((x, y) => x.timestamp - y.timestamp),
      combats: [...base.combats.map((c) => laterCombat.get(c.id) ?? c), ...newCombats],
    };
  }

  // ---------- write: backups, audio, files, then the database ----------
  const suffix = `.premerge-${b.number}`;
  const backups: string[] = [];
  for (const file of [pa.timeline, pa.transcriptJson, pa.transcriptMd, pa.chatlog]) {
    if (!fs.existsSync(file)) continue;
    const backup = file + suffix;
    if (fs.existsSync(backup)) throw new Error(`Backup ${backup} already exists; was this merge started before?`);
    backups.push(backup);
  }
  for (const backup of backups) fs.copyFileSync(backup.slice(0, -suffix.length), backup);
  for (const c of copies) {
    fs.mkdirSync(path.dirname(c.to), { recursive: true });
    fs.copyFileSync(c.from, c.to, fs.constants.COPYFILE_EXCL);
  }
  writeAtomic(pa.timeline, JSON.stringify(timeline, null, 2));
  writeAtomic(pa.transcriptJson, JSON.stringify(transcript, null, 2));
  writeAtomic(pa.transcriptMd, renderTranscriptMarkdown(transcript, `Session transcript, ${tlA.startedAt.slice(0, 10)}`, timeline));
  if (chatlog) writeAtomic(pa.chatlog, JSON.stringify(chatlog, null, 2));

  store.db.transaction(() => {
    store.endSession(a.id, endedB);
    store.setSessionStatus(a.id, "complete", null);
    store.setSessionStatus(b.id, "complete", `${MERGED_PREFIX}${a.number} (${a.id}).`);
  })();

  return {
    target: store.getSession(a.id)!,
    source: store.getSession(b.id)!,
    offsetSec,
    gapSec,
    linesAdded: linesB.length,
    chatAdded,
    combatsAdded,
    audioCopied: copies.length,
    backups,
    warnings,
  };
}

// ---------- transcript.md (mirrors render_markdown in worker/scribworker/transcribe.py) ----------

const fmt = (seconds: number) => {
  const s = Math.floor(Math.max(0, seconds));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
const mdCell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const label = (l: TranscriptLine) =>
  l.isGm ? `GM (${l.speaker})` : l.character ? `${l.character} (${l.speaker})` : l.speaker;
const duration = (seconds: number) => {
  const m = Math.floor(Math.max(0, seconds) / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
};

export function renderTranscriptMarkdown(transcript: Transcript, title: string, timeline?: Timeline) {
  const out = [`# ${title}`, "", "## About this transcript", ""];
  let when = "";
  if (timeline) {
    when = `, started ${timeline.startedAt.slice(0, 16).replace("T", " ")} UTC`;
    if (timeline.endedAt) {
      const secs = (Date.parse(timeline.endedAt) - Date.parse(timeline.startedAt)) / 1000;
      if (Number.isFinite(secs)) when += `, ${duration(secs)} long`;
    }
  }
  const language = transcript.language ? `, language \`${transcript.language}\`` : "";
  const merged = transcript.lines.some((l) => l.discordId === MERGE_MARKER_ID);
  out.push(
    `- A tabletop role-playing game session recorded on Discord voice chat${when}.`,
    `- Transcribed automatically by a speech-to-text model (\`${transcript.model}\`${language}). ` +
      "Expect misheard words, especially fantasy names, and some missing or merged lines.",
    "- Each line reads `[HH:MM:SS] Character (Player): what they said`, timed from the start of the session. " +
      "Speakers without a mapped character appear by their Discord name.",
    "- The GM's lines include narration and the voices of non-player characters.",
    ...(merged
      ? ["- The recording was interrupted and resumed; a ScribBot line marks each gap. Speech during a gap wasn't recorded."]
      : []),
    "",
  );

  const speakers = new Map<string, TranscriptLine>();
  for (const l of transcript.lines) if (l.discordId !== MERGE_MARKER_ID && !speakers.has(l.discordId)) speakers.set(l.discordId, l);
  if (speakers.size) {
    out.push("## Speakers", "", "| Player | Plays |", "|---|---|");
    for (const l of speakers.values()) {
      const plays = l.isGm ? "GM (narration and NPCs)" : (l.character ?? "no character mapped");
      out.push(`| ${mdCell(l.speaker)} | ${mdCell(plays)} |`);
    }
    out.push("");
  }

  out.push("## Transcript", "");
  if (!transcript.lines.length) out.push("*(No speech was transcribed.)*", "");
  let prevId: string | null = null;
  let prevEnd = -1e9;
  let para: string[] = [];
  let header = "";
  const flush = () => {
    if (para.length) out.push(`${header} ${para.join(" ")}`, "");
  };
  for (const l of transcript.lines) {
    if (l.discordId === prevId && l.t - prevEnd < 4 && l.discordId !== MERGE_MARKER_ID) {
      para.push(l.text);
    } else {
      flush();
      header = `**[${fmt(l.t)}] ${label(l)}:**`;
      para = [l.text];
    }
    prevId = l.discordId;
    prevEnd = l.end;
  }
  flush();
  return out.join("\n");
}
