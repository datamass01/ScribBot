/**
 * Merge an interrupted game's continuation session (B) into the session it continues (A),
 * so one evening of play gets one transcript and one summary (docs/assessment/02 S15).
 *
 * Used by `npm run merge` (bot/scripts/merge-sessions.ts), `/scrib merge` and the Console.
 */
import fs from "node:fs";
import path from "node:path";
import type { SessionRow, Store } from "./db.js";
import { recordingRel, sessionFolderName } from "./db.js";
import { renameWithRetry } from "./fsutil.js";
import { composeSession, isLegacy, moveFolder, removeIfEmpty, sessionTimeline } from "./layout.js";
import { sessionPaths, sessionRecordings } from "./paths.js";
import type { Timeline, Transcript, TranscriptLine } from "./types.js";

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
  /** Seconds between the end of A's recording and the start of B's. */
  gapSec: number;
  linesAdded: number;
  chatAdded: number;
  combatsAdded: number;
  /** Where B's own summary, notes and story went (nothing is deleted), or null. */
  archive: string | null;
  warnings: string[];
}

const BUSY = new Set(["recording", "transcribing", "summarizing"]);

/** "12 min", "45 s", "1 h 05 min". */
export function formatGap(sec: number) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

const count = (file: string, key: "lines" | "messages" | "combats") => {
  try {
    return (JSON.parse(fs.readFileSync(file, "utf8"))[key] ?? []).length as number;
  } catch {
    return 0;
  }
};

/**
 * Merge session `sourceId` (B, the continuation) into `targetId` (A): B's recording folders move
 * into A's recordings/, then A's transcript, chat log and actors are rebuilt from all its
 * recordings (layout.ts composeSession). B's own summary, notes and story are kept, moved
 * next to its recording. Throws, changing nothing, if the merge isn't possible.
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
  if (a.campaign_id !== b.campaign_id) throw new Error("Those sessions belong to different campaigns.");
  for (const s of [a, b]) {
    if (BUSY.has(s.status) || opts.isBusy?.(s.id)) {
      throw new Error(`Session ${s.number} is ${s.status === "recording" ? "still recording" : "being processed"}; wait for it to finish.`);
    }
    const into = mergedInto(s);
    if (into != null) throw new Error(`Session ${s.number} was already merged into session ${into}.`);
    if (isLegacy(s.id)) {
      throw new Error(
        `Session ${s.number} is still in the old folder layout. Move sessions to the campaign layout first ` +
          "(Console → Sessions → Update folder layout, or npm run migrate-layout).",
      );
    }
    for (const rid of sessionRecordings(s.id)) {
      const p = sessionPaths(rid);
      if (fs.existsSync(p.timeline) && !fs.existsSync(p.recordingTranscript)) {
        throw new Error(`Session ${s.number} isn't transcribed yet. Transcribe it first (\`/scrib process session:${s.number}\`).`);
      }
    }
  }
  const tlA = sessionTimeline(store, a.id);
  const tlB = sessionTimeline(store, b.id);
  const startA = Date.parse(tlA.startedAt);
  const startB = Date.parse(tlB.startedAt);
  if (!(startB >= startA)) throw new Error(`Session ${b.number} started before session ${a.number}; merge them the other way round.`);
  const endA = tlA.endedAt ? Date.parse(tlA.endedAt) : startA + Math.max(0, ...tlA.segments.map((x) => x.endMs));
  const gapSec = Math.max(0, (startB - endA) / 1000);

  const pa = sessionPaths(a.id);
  const pb = sessionPaths(b.id);
  const campaign = store.getCampaign(a.campaign_id!)!;
  const before = { lines: count(pa.transcriptJson, "lines"), chat: count(pa.chatlog, "messages"), combats: count(pa.chatlog, "combats") };
  const warnings: string[] = [];

  // ---------- move B's recordings into A, recording the move in the database as each lands ----------
  const moved = sessionRecordings(b.id);
  for (const rid of moved) {
    const from = sessionPaths(rid).recording;
    const to = path.join(pa.dir, "recordings", rid);
    if (fs.existsSync(from)) moveFolder(from, to);
    store.db.transaction(() => {
      store.setSessionPlace(rid, { dir: recordingRel(campaign.folder, a.number, rid), campaignId: campaign.id });
      store.setMergedInto(rid, a.id);
    })();
  }

  // ---------- B's own write-ups go next to its recording; its rebuilt files are dropped ----------
  let archive: string | null = null;
  const keep = ["summary.json", "summary.md", "notes.json", "story"].filter((f) => fs.existsSync(path.join(pb.dir, f)));
  if (keep.length) {
    archive = path.join(pa.dir, "recordings", b.id, `from-session-${sessionFolderName(b.number)}`);
    fs.mkdirSync(archive, { recursive: true });
    for (const f of keep) {
      try {
        renameWithRetry(path.join(pb.dir, f), path.join(archive, f));
      } catch (err) {
        warnings.push(`Couldn't move session ${b.number}'s ${f} (${(err as Error).message}); it is still in ${pb.dir}.`);
      }
    }
  }
  for (const f of [pb.transcriptJson, pb.transcriptMd, pb.chatlog, pb.actors]) fs.rmSync(f, { force: true });
  removeIfEmpty(path.join(pb.dir, "recordings"), pb.dir);
  removeIfEmpty(pb.dir, path.dirname(pb.dir));

  store.db.transaction(() => {
    store.endSession(a.id, tlB.endedAt ?? b.ended_at ?? new Date().toISOString());
    store.setSessionStatus(a.id, "complete", null);
    store.setSessionStatus(b.id, "complete", `${MERGED_PREFIX}${a.number} (${a.id}).`);
  })();
  const composed = composeSession(store, a.id);

  return {
    target: store.getSession(a.id)!,
    source: store.getSession(b.id)!,
    gapSec,
    linesAdded: Math.max(0, (composed.lines ?? before.lines) - before.lines - (moved.length ? 1 : 0)),
    chatAdded: Math.max(0, composed.chatMessages - before.chat),
    combatsAdded: Math.max(0, composed.combats - before.combats),
    archive,
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
