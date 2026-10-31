import type { Participant } from "../types.js";
import type { ChunkNotes } from "./schema.js";

export const SYSTEM_PROMPT = `You are the chronicler for a tabletop roleplaying campaign. You turn raw session transcripts into accurate, vivid records the players will read and keep in their game's journal.

How the transcript works:
- Each line is "[HH:MM:SS] Speaker: text". Player speakers are labelled "Character (Player)". The game master is labelled "GM (Player)".
- The GM narrates the world and voices every NPC and monster. Work out from context which NPC the GM is speaking as.
- Speech was transcribed automatically by a small speech-to-text model. Expect misheard words, especially fantasy names. Use the campaign glossary and context to correct names, and never treat a transcription error as a plot point.
- Lines marked [FOUNDRY ...] come from the virtual tabletop: dice rolls, chat messages, and combat tracker start and end events. They are reliable facts about mechanics and outcomes; use them to anchor combats, checks and results.

Players constantly switch between speaking in character (as their character, in the fiction) and out of character (table talk, rules questions, jokes about real life, snacks, scheduling). You must tell them apart:
- Only in-character speech and actions belong in the story. Leave out table talk unless it records a decision the party made in the fiction.
- "I attack the goblin" or "I search the chest" is a character action declared by the player, so record it as the character doing it.
- Quotes must be in-character lines copied verbatim from the transcript. Never invent, paraphrase or merge quotes. If nothing memorable was said in character, return fewer quotes.

Always refer to player characters by their character names, never by player names. Be faithful: if the transcript is unclear about what happened, say less rather than guessing.`;

export function participantsBlock(participants: Participant[]) {
  if (!participants.length) return "(unknown)";
  return participants
    .map((p) =>
      p.isGm
        ? `- ${p.displayName}: the GM (narrator and all NPCs)`
        : `- ${p.displayName}: plays ${p.character ?? "an unmapped character (refer to them by player name)"}`,
    )
    .join("\n");
}

function campaignBlock(context: string, glossary: string) {
  const parts = [];
  if (context.trim()) parts.push(`<campaign_context>\n${context.trim()}\n</campaign_context>`);
  if (glossary.trim()) parts.push(`<glossary>\n${glossary.trim()}\n</glossary>`);
  return parts.join("\n\n");
}

export function chunkPrompt(opts: {
  participants: Participant[];
  context: string;
  glossary: string;
  chunkIndex: number;
  chunkCount: number;
  stream: string;
}) {
  return `${campaignBlock(opts.context, opts.glossary)}

<participants>
${participantsBlock(opts.participants)}
</participants>

This is part ${opts.chunkIndex + 1} of ${opts.chunkCount} of the session transcript.

<transcript>
${opts.stream}
</transcript>

Extract structured notes from this part only. Notes from all parts will be merged into one session summary later, so:
- Use the transcript's own timestamps.
- If a scene or combat continues past the end of this part, still record it, and set endT and outcome to null for an unfinished combat.
- Capture every meaningful in-character action, decision, discovery, NPC, item gained, and open thread.
- For quotes, pick memorable or funny in-character lines and copy them exactly as transcribed.`;
}

export function mergePrompt(opts: {
  participants: Participant[];
  context: string;
  glossary: string;
  notes: ChunkNotes[];
  combatRounds: { name: string; rounds: number }[];
  sessionNumber: number;
  durationLabel: string;
}) {
  const rounds = opts.combatRounds.length
    ? `\n<foundry_combat_rounds>\n${opts.combatRounds.map((c) => `- ${c.name}: ${c.rounds} round(s)`).join("\n")}\n</foundry_combat_rounds>\n`
    : "";
  return `${campaignBlock(opts.context, opts.glossary)}

<participants>
${participantsBlock(opts.participants)}
</participants>
${rounds}
Below are notes extracted, in order, from consecutive parts of session ${opts.sessionNumber} (about ${opts.durationLabel} of play).

<notes>
${JSON.stringify(opts.notes, null, 1)}
</notes>

Write the final summary of this session:
- Merge scenes and combats that were split across parts (an unfinished combat in one part continues in the next).
- The recap should read like a chapter of the campaign's story: what the party set out to do, what happened, how it ended.
- Choose the 5-15 best quotes from the notes. Keep each quote's text and timestamp exactly as given.
- characterHighlights must have one entry for every player character who took part.
- Deduplicate NPCs and loot.`;
}
