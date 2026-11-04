import fs from "node:fs";
import { writeFileAtomic } from "../fsutil.js";
import { campaignFolderOfPath, loadCampaign } from "../campaign.js";
import type { Store } from "../db.js";
import { sessionTimeline } from "../layout.js";
import { sessionPaths } from "../paths.js";
import { ChatLogSchema, TimelineSchema, TranscriptSchema, type ChatLog, type TranscriptLine } from "../types.js";
import { buildEventStream, chunkStream, fmtTime, renderStream, stripHtml } from "./format.js";
import { chunkPrompt, mergePrompt, revisePrompt, SYSTEM_PROMPT } from "./prompts.js";
import { createProvider, type LLMProvider } from "./provider.js";
import { verifyQuotes, type VerifiedQuote } from "./quotes.js";
import { renderSummaryMarkdown } from "./render.js";
import { ChunkNotesSchema, SummarySchema, type ChunkNotes, type Summary, type SummaryFile } from "./schema.js";
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

  // The game's timeline: every recording of it (a merged continuation too), from the first start.
  const timeline = sessionTimeline(store, sessionId);
  const transcript = TranscriptSchema.parse(readJson(paths.transcriptJson));
  let chatlog: ChatLog | null = null;
  if (fs.existsSync(paths.chatlog)) chatlog = ChatLogSchema.parse(readJson(paths.chatlog));

  const startMs = Date.parse(timeline.startedAt);
  const stream = buildEventStream(transcript, chatlog, startMs, timeline.participants);
  const chunks = chunkStream(stream, config.llm.chunkMinutes);
  if (!chunks.length) throw new Error("The transcript is empty: nothing to summarize");

  const provider = opts.provider ?? (await createProvider());
  const { context, glossary } = loadCampaign(campaignFolderOfPath(paths.dir));
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
  const { kept, dropped } = verifyQuotes(summary.quotes, quoteSources(transcript, chatlog, startMs));
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
  writeSummaryFile(sessionId, file);
  log(`[summarize] ${sessionId}: "${summary.title}" (${fmtTime(durationSec)})`);
  return file;
}

/** What a quote may be checked against: the transcript, plus in-character chat typed in Foundry. */
export function quoteSources(transcript: { lines: TranscriptLine[] }, chatlog: ChatLog | null, startMs: number): TranscriptLine[] {
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
  return sources;
}

/** The transcript and chat log a session's quotes are checked against. */
export function sessionQuoteSources(store: Store, sessionId: string) {
  const paths = sessionPaths(sessionId);
  const timeline = sessionTimeline(store, sessionId);
  const transcript = TranscriptSchema.parse(readJson(paths.transcriptJson));
  const chatlog = fs.existsSync(paths.chatlog) ? ChatLogSchema.parse(readJson(paths.chatlog)) : null;
  return { timeline, sources: quoteSources(transcript, chatlog, Date.parse(timeline.startedAt)) };
}

/** summary.json and summary.md, written so the bridge client and the Console never read half a file. */
export function writeSummaryFile(sessionId: string, file: SummaryFile) {
  const paths = sessionPaths(sessionId);
  writeFileAtomic(paths.summary, JSON.stringify(file, null, 2));
  writeFileAtomic(paths.summaryMd, renderSummaryMarkdown(file));
}

export function readSummaryFile(sessionId: string): SummaryFile {
  return readJson(sessionPaths(sessionId).summary) as SummaryFile;
}

/** The summary as the model sees it: without the bookkeeping added to each quote. */
export const bareSummary = (s: SummaryFile["summary"]): Summary => ({
  ...s,
  quotes: s.quotes.map(({ t, character, text, context }) => ({ t, character, text, context })),
});

const quoteKey = (q: { character: string; text: string }) => `${q.character}\u0000${q.text.trim()}`;

/**
 * Review: asks the LLM to correct the current summary as `feedback` says, from the chunk notes it
 * was written from (notes.json) and the summary as it stands, hand edits included. Quotes are
 * checked again; one the summary already had (a person may have edited it) is kept as it was.
 * Replaces summary.json, adding the request to `revisions`.
 */
export async function reviseSummary(
  store: Store,
  sessionId: string,
  feedback: string,
  opts: { provider?: LLMProvider; log?: (msg: string) => void } = {},
): Promise<SummaryFile> {
  const log = opts.log ?? console.log;
  const session = store.getSession(sessionId);
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  if (!feedback.trim()) throw new Error("Say what to correct.");
  const paths = sessionPaths(sessionId);
  if (!fs.existsSync(paths.summary)) throw new Error(`Session ${session.number} has no summary to revise.`);
  const current = readSummaryFile(sessionId);
  const notes = fs.existsSync(paths.notes) ? (readJson(paths.notes) as ChunkNotes[]) : null;
  const { timeline, sources } = sessionQuoteSources(store, sessionId);
  const { context, glossary } = loadCampaign(campaignFolderOfPath(paths.dir));
  const provider = opts.provider ?? (await createProvider());
  const revisions = current.revisions ?? [];
  log(`[summarize] ${sessionId}: revising the summary via ${provider.name}/${provider.model}`);

  const revised = await provider.generateJson({
    system: SYSTEM_PROMPT,
    prompt: revisePrompt({
      participants: timeline.participants,
      context,
      glossary,
      notes,
      current: bareSummary(current.summary),
      feedback,
      earlierFeedback: revisions.map((r) => r.feedback),
      sessionNumber: session.number,
    }),
    schema: SummarySchema,
    schemaName: "session_summary",
    effort: "high",
  });

  const before = new Map<string, VerifiedQuote>((current.summary.quotes as VerifiedQuote[]).map((q) => [quoteKey(q), q]));
  const unchanged = revised.quotes.filter((q) => before.has(quoteKey(q)));
  const { kept, dropped } = verifyQuotes(revised.quotes.filter((q) => !before.has(quoteKey(q))), sources);
  if (dropped.length) log(`[summarize] dropped ${dropped.length} new quote(s) not found in the transcript`);
  const quotes: VerifiedQuote[] = [...unchanged.map((q) => ({ ...before.get(quoteKey(q))!, context: q.context, t: q.t })), ...kept];

  const file: SummaryFile = {
    ...current,
    provider: provider.name,
    model: provider.model,
    createdAt: new Date().toISOString(),
    summary: { ...revised, quotes: quotes.sort((a, b) => a.seconds - b.seconds) },
    droppedQuotes: [...current.droppedQuotes, ...dropped],
    revisions: [...revisions, { at: new Date().toISOString(), feedback: feedback.trim(), provider: provider.name, model: provider.model }],
  };
  writeSummaryFile(sessionId, file);
  log(`[summarize] ${sessionId}: revised "${revised.title}"`);
  return file;
}
