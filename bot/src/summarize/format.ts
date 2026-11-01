import type { ChatLog, Participant, Transcript } from "../types.js";
import { speakerLabel } from "../participants.js";

export interface StreamEntry {
  /** Seconds from session start. */
  t: number;
  line: string;
}

export function fmtTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Inverse of fmtTime; tolerant of "MM:SS" and junk (returns null). */
export function parseTime(stamp: string): number | null {
  const parts = stamp.trim().split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function stripHtml(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/**
 * Merge spoken lines and Foundry chat/combat events into one chronological,
 * plain-text stream. This is what the model actually reads.
 */
export function buildEventStream(
  transcript: Transcript,
  chatlog: ChatLog | null,
  sessionStartMs: number,
  participants: Participant[],
): StreamEntry[] {
  const byId = new Map(participants.map((p) => [p.discordId, p]));
  const entries: StreamEntry[] = transcript.lines.map((l) => {
    const p = byId.get(l.discordId) ?? { displayName: l.speaker, character: l.character, isGm: l.isGm };
    return { t: l.t, line: `${speakerLabel(p)}: ${l.text.trim()}` };
  });

  if (chatlog) {
    const rel = (ms: number) => (ms - sessionStartMs) / 1000;

    for (const m of chatlog.messages) {
      if (m.whisper) continue; // GM secrets and private notes stay private
      if (m.content.includes("scribbot-announce")) continue; // ScribBot's own join/leave notices
      const who = m.alias ?? m.userName ?? "Unknown";
      const t = rel(m.timestamp);
      if (m.isRoll || m.rolls.length) {
        const label = stripHtml(m.flavor ?? "") || stripHtml(m.content).slice(0, 120);
        const rolls = m.rolls.map((r) => `${r.flavor ? `${r.flavor}: ` : ""}${r.formula} = ${r.total ?? "?"}`).join("; ");
        entries.push({ t, line: `[FOUNDRY ROLL] ${who}: ${label}${rolls ? ` (${rolls})` : ""}` });
      } else {
        const text = stripHtml(m.content);
        if (!text) continue;
        const kind = m.inCharacter ? "IC" : "OOC";
        entries.push({ t, line: `[FOUNDRY CHAT ${kind}] ${who}: ${text.slice(0, 600)}` });
      }
    }

    for (const c of chatlog.combats) {
      const name = c.name ?? c.scene ?? "Combat";
      const visible = c.combatants.filter((x) => !x.hidden);
      if (c.startedAt != null) {
        const pcs = visible.filter((x) => !x.isNPC).map((x) => x.name);
        const npcs = visible.filter((x) => x.isNPC).map((x) => x.name);
        entries.push({
          t: rel(c.startedAt),
          line: `[FOUNDRY COMBAT START] ${name}. Party: ${pcs.join(", ") || "?"}. Opponents: ${npcs.join(", ") || "?"}.`,
        });
      }
      if (c.endedAt != null) {
        const defeated = visible.filter((x) => x.defeated).map((x) => x.name);
        entries.push({
          t: rel(c.endedAt),
          line: `[FOUNDRY COMBAT END] ${name} after ${c.round} round(s). Defeated: ${defeated.join(", ") || "none"}.`,
        });
      }
    }
  }

  return entries.sort((a, b) => a.t - b.t);
}

export function renderStream(entries: StreamEntry[]) {
  return entries.map((e) => `[${fmtTime(e.t)}] ${e.line}`).join("\n");
}

/** Split into consecutive windows of roughly `minutes` each, never splitting an entry. */
export function chunkStream(entries: StreamEntry[], minutes: number): StreamEntry[][] {
  if (!entries.length) return [];
  const span = minutes * 60;
  const chunks: StreamEntry[][] = [];
  let current: StreamEntry[] = [];
  let chunkStart = entries[0]!.t;
  for (const e of entries) {
    if (e.t - chunkStart >= span && current.length) {
      chunks.push(current);
      current = [];
      chunkStart = e.t;
    }
    current.push(e);
  }
  if (current.length) chunks.push(current);
  return chunks;
}
