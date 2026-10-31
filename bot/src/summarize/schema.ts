import { z } from "zod";

// Timestamps are "HH:MM:SS" from session start: easier for the model than float seconds.
const Timestamp = z.string().describe('Time from session start, "HH:MM:SS"');

const Quote = z.object({
  t: Timestamp,
  character: z.string().describe("Character name (not the player's name). NPC name if the GM voiced it."),
  text: z.string().describe("Verbatim in-character words, copied from the transcript. Filler words may be dropped."),
  context: z.string().describe("One short sentence: what was happening when this was said."),
});

const Npc = z.object({
  name: z.string(),
  description: z.string().describe("Who they are and what they did this session."),
});

const Loot = z.object({
  item: z.string(),
  recipient: z.string().nullable().describe("Character who took it, or null if unclear."),
});

/** Pass 1: notes extracted from one chunk of the session. */
export const ChunkNotesSchema = z.object({
  scenes: z.array(
    z.object({
      startT: Timestamp,
      title: z.string(),
      location: z.string().nullable(),
      summary: z.string().describe("What happened in the scene, 2-5 sentences, past tense."),
    }),
  ),
  events: z.array(
    z.object({
      t: Timestamp,
      kind: z.enum(["action", "dialogue", "combat", "discovery", "decision", "loot", "travel", "rest", "other"]),
      actors: z.array(z.string()).describe("Character/NPC names involved."),
      description: z.string(),
    }),
  ),
  combats: z.array(
    z.object({
      startT: Timestamp,
      endT: Timestamp.nullable().describe("null if the fight continues past this chunk."),
      location: z.string().nullable(),
      participants: z.array(z.string()).describe("Player characters who fought."),
      enemies: z.array(z.string()),
      keyMoments: z.array(z.string()).describe("Big hits, crits, clutch saves, downs, clever tactics."),
      outcome: z.string().nullable().describe("null if unresolved in this chunk."),
    }),
  ),
  quotes: z.array(Quote).describe("Memorable IN-CHARACTER lines only. Never table talk."),
  npcs: z.array(Npc),
  loot: z.array(Loot),
  openThreads: z.array(z.string()).describe("Unresolved mysteries, promises, plans, and plot hooks."),
});
export type ChunkNotes = z.infer<typeof ChunkNotesSchema>;

/** Pass 2: the final session summary that is imported into Foundry. */
export const SummarySchema = z.object({
  title: z.string().describe("An evocative episode title, 3-8 words."),
  recap: z.string().describe("Narrative recap in Markdown, 3-6 paragraphs, past tense, character names, no player names."),
  scenes: z.array(
    z.object({
      title: z.string(),
      location: z.string().nullable(),
      summary: z.string(),
    }),
  ),
  combats: z.array(
    z.object({
      name: z.string().describe('Short label, e.g. "Ambush at the Old Mill".'),
      location: z.string().nullable(),
      participants: z.array(z.string()),
      enemies: z.array(z.string()),
      rounds: z.number().nullable().describe("Number of combat rounds if known from the Foundry combat log, else null."),
      keyMoments: z.array(z.string()),
      outcome: z.string(),
    }),
  ),
  quotes: z.array(Quote).describe("The best 5-15 in-character quotes of the session."),
  characterHighlights: z.array(
    z.object({
      character: z.string(),
      highlights: z.array(z.string()).describe("1-4 notable things this character did."),
    }),
  ),
  npcs: z.array(Npc),
  loot: z.array(Loot),
  hooks: z.array(z.string()).describe("Open threads and hooks for next session."),
});
export type Summary = z.infer<typeof SummarySchema>;

/** What is written to summary.json: the model's summary plus bookkeeping. */
export interface SummaryFile {
  sessionId: string;
  sessionNumber: number;
  startedAt: string;
  endedAt: string | null;
  provider: string;
  model: string;
  createdAt: string;
  participants: { discordId: string; displayName: string; character: string | null; actorId: string | null; isGm: boolean }[];
  summary: Summary & { quotes: (Summary["quotes"][number] & { seconds: number; verified: boolean })[] };
  droppedQuotes: Summary["quotes"];
}
