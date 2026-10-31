import type { SummaryFile } from "./schema.js";
import { fmtTime } from "./format.js";

/** Human-readable Markdown version of summary.json. */
export function renderSummaryMarkdown(f: SummaryFile) {
  const s = f.summary;
  const out: string[] = [];
  out.push(`# Session ${f.sessionNumber}: ${s.title}`, "");
  out.push(`*${new Date(f.startedAt).toDateString()}*`, "");
  out.push("## Recap", "", s.recap, "");

  if (s.scenes.length) {
    out.push("## Scenes", "");
    for (const sc of s.scenes) {
      out.push(`### ${sc.title}${sc.location ? ` (${sc.location})` : ""}`, "", sc.summary, "");
    }
  }
  if (s.combats.length) {
    out.push("## Combats", "");
    for (const c of s.combats) {
      out.push(`### ${c.name}${c.location ? ` (${c.location})` : ""}`, "");
      out.push(`**Party:** ${c.participants.join(", ")}  `);
      out.push(`**Enemies:** ${c.enemies.join(", ")}  `);
      if (c.rounds != null) out.push(`**Rounds:** ${c.rounds}  `);
      out.push("");
      for (const m of c.keyMoments) out.push(`- ${m}`);
      out.push("", `**Outcome:** ${c.outcome}`, "");
    }
  }
  if (s.quotes.length) {
    out.push("## Quotes", "");
    for (const q of s.quotes) {
      out.push(`> "${q.text}"`, `> — **${q.character}** [${fmtTime(q.seconds)}], ${q.context}`, "");
    }
  }
  if (s.characterHighlights.length) {
    out.push("## Character Highlights", "");
    for (const c of s.characterHighlights) {
      out.push(`**${c.character}**`, ...c.highlights.map((h) => `- ${h}`), "");
    }
  }
  if (s.npcs.length) {
    out.push("## NPCs", "", ...s.npcs.map((n) => `- **${n.name}**: ${n.description}`), "");
  }
  if (s.loot.length) {
    out.push("## Loot", "", ...s.loot.map((l) => `- ${l.item}${l.recipient ? ` → ${l.recipient}` : ""}`), "");
  }
  if (s.hooks.length) {
    out.push("## Open Threads", "", ...s.hooks.map((h) => `- ${h}`), "");
  }
  return out.join("\n");
}
