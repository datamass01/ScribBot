import fs from "node:fs";
import { loadCampaign } from "../campaign.js";
import type { Store } from "../db.js";
import { sessionPaths } from "../paths.js";
import { ChatLogSchema, TimelineSchema, TranscriptSchema, type ChatLog, type TranscriptLine } from "../types.js";
import { buildEventStream, chunkStream, fmtTime, renderStream, stripHtml } from "./format.js";
import { chunkPrompt, mergePrompt, SYSTEM_PROMPT } from "./prompts.js";
import { createProvider, type LLMProvider } from "./provider.js";
import { verifyQuotes } from "./quotes.js";
import { renderSummaryMarkdown } from "./render.js";
import { ChunkNotesSchema, SummarySchema, type ChunkNotes, type SummaryFile } from "./schema.js";
import { config } from "../config.js";

const CHUNK_CONCURRENCY = 3;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

export async function summarizeSession(
  store: Store,
  sessionId: string,
  opts: { provider?: LLMProvider; log?: (msg: string) => void } = {},
): Promise<SummaryFile> {
  const log = opts.log ?? console.log;
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  const paths = sessionPaths(sessionId);

  const timeline = TimelineSchema.parse(readJson(paths.timeline));
  const transcript = TranscriptSchema.parse(readJson(paths.transcriptJson));
  let chatlog: ChatLog | null = null;
  if (fs.existsSync(paths.chatlog)) chatlog = ChatLogSchema.parse(readJson(paths.chatlog));

  const startMs = Date.parse(timeline.startedAt);
  const stream = buildEventStream(transcript, chatlog, startMs, timeline.participants);
  const chunks = chunkStream(stream, config.llm.chunkMinutes);
  if (!chunks.length) throw new Error("The transcript is empty: nothing to summarize");

  const provider = opts.provider ?? (await createProvider());
  const { context, glossary } = loadCampaign();
  log(`[summarize] ${sessionId}: ${stream.length} entries in ${chunks.length} chunk(s) via ${provider.name}/${provider.model}`);

  // Pass 1: structured notes per chunk.
  const notes: ChunkNotes[] = await mapLimit(chunks, CHUNK_CONCURRENCY, async (chunk, i) => {
    const result = await provider.generateJson({
      system: SYSTEM_PROMPT,
      prompt: chunkPrompt({
        participants: timeline.participants,
        context,
        glossary,
        chunkIndex: i,
        chunkCount: chunks.length,
        stream: renderStream(chunk),
      }),
      schema: ChunkNotesSchema,
      schemaName: "chunk_notes",
      effort: "medium",
    });
    log(`[summarize] chunk ${i + 1}/${chunks.length} done`);
    return result;
  });
  fs.writeFileSync(paths.notes, JSON.stringify(notes, null, 2));

  // Pass 2: merge into the final summary.
  const durationSec = stream.at(-1)!.t - stream[0]!.t;
  const combatRounds = (chatlog?.combats ?? [])
    .filter((c) => c.round > 0)
    .map((c) => ({ name: c.name ?? c.scene ?? "Combat", rounds: c.round }));
  const summary = await provider.generateJson({
    system: SYSTEM_PROMPT,
    prompt: mergePrompt({
      participants: timeline.participants,
      context,
      glossary,
      notes,
      combatRounds,
      sessionNumber: session.number,
      durationLabel: `${Math.round(durationSec / 60)} minutes`,
    }),
    schema: SummarySchema,
    schemaName: "session_summary",
    effort: "high",
  });

  // Quotes must exist in what was actually said (or typed in character in Foundry).
  const sources: TranscriptLine[] = [...transcript.lines];
  for (const m of chatlog?.messages ?? []) {
    if (m.inCharacter && !m.isRoll && !m.whisper) {
      sources.push({
        t: (m.timestamp - startMs) / 1000,
        end: (m.timestamp - startMs) / 1000,
        discordId: `foundry:${m.alias ?? "?"}`,
        speaker: m.alias ?? "?",
        character: m.alias,
        isGm: false,
        text: stripHtml(m.content),
      });
    }
  }
  const { kept, dropped } = verifyQuotes(summary.quotes, sources);
  if (dropped.length) log(`[summarize] dropped ${dropped.length} quote(s) not found in the transcript`);

  const file: SummaryFile = {
    sessionId,
    sessionNumber: session.number,
    startedAt: timeline.startedAt,
    endedAt: timeline.endedAt,
    provider: provider.name,
    model: provider.model,
    createdAt: new Date().toISOString(),
    participants: timeline.participants,
    summary: { ...summary, quotes: kept.sort((a, b) => a.seconds - b.seconds) },
    droppedQuotes: dropped,
  };
  fs.writeFileSync(paths.summary, JSON.stringify(file, null, 2));
  fs.writeFileSync(paths.summaryMd, renderSummaryMarkdown(file));
  log(`[summarize] ${sessionId}: "${summary.title}" (${fmtTime(durationSec)})`);
  return file;
}
