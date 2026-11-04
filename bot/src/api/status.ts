import fs from "node:fs";
import { config } from "../config.js";
import { ALL_CAMPAIGNS, UNASSIGNED_FOLDER, campaignName, type SessionRow, type Store } from "../db.js";
import { sessionPaths } from "../paths.js";
import { findStoryFile } from "../story.js";
import { isProcessing, processingProgress } from "../pipeline.js";
import { mergedInto } from "../merge.js";
import { resolveParticipant } from "../participants.js";
import { readTimeline } from "../timeline.js";
import { workerHealth } from "../worker-client.js";
import { allowedOrigins } from "./origins.js";
import { PipelineTracker } from "./pipeline.js";
import { llmProblem, llmStatus } from "../summarize/readiness.js";
import type { HeadlessStatus } from "../foundry/client.js";

export interface DiscordStatus {
  ready: boolean;
  tag: string | null;
  pingMs: number | null;
  guilds: number;
  readySince: string | null;
}

export interface RecordingStatus {
  sessionId: string;
  number: number;
  guild: string;
  channel: string;
  startedAt: string;
  clips: number;
  /** Voice connection: "reconnecting" or "lost" means nothing is being recorded right now (02 S4). */
  connection?: "connected" | "reconnecting" | "lost";
  speakingNow: string[];
  speakers: { discordId: string; displayName: string; character: string | null; isGm: boolean }[];
}

/** Live state the API can't read from the database: supplied by index.ts. */
export interface MonitorSources {
  discord?: () => DiscordStatus;
  recordings?: () => RecordingStatus[];
  /** The headless Foundry client (FOUNDRY_HEADLESS), when the bot runs one. */
  foundryHeadless?: () => HeadlessStatus;
}

/** Foundry module activity, tracked by the API routes. */
export interface FoundryActivity {
  sockets: number;
  lastRosterAt: string | null;
  lastRosterWorld: string | null;
  lastChatlogAt: string | null;
}

const startedAt = new Date().toISOString();
/** Rate and trend need samples across /status calls. */
const pipelineTracker = new PipelineTracker();

async function workerStatus() {
  const t0 = Date.now();
  try {
    const health = await workerHealth(2000);
    return { reachable: true, latencyMs: Date.now() - t0, url: config.workerUrl, ...health, error: null };
  } catch (err) {
    return { reachable: false, latencyMs: null, url: config.workerUrl, error: (err as Error).message };
  }
}

function diskStatus() {
  try {
    const s = fs.statfsSync(config.dataDir);
    return { path: config.dataDir, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return { path: config.dataDir, freeBytes: null, totalBytes: null };
  }
}

function sessionStatus(s: SessionRow, live: RecordingStatus | undefined) {
  const paths = sessionPaths(s.id);
  let clips: number | null = live?.clips ?? null;
  let speakers: number | null = live?.speakers.length ?? null;
  // Never open timeline.json while the bot is recording into it (02 S1/S11): use the live counts.
  if (!live) {
    try {
      const timeline = readTimeline(paths.recording);
      clips = timeline.segments.length;
      speakers = timeline.participants.length;
    } catch {
      // no timeline yet, or unreadable: shown as unknown
    }
  }
  return {
    id: s.id,
    number: s.number,
    status: s.status,
    error: s.error,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    summarizedAt: s.summarized_at,
    audioPurged: Boolean(s.audio_purged),
    mergedInto: mergedInto(s),
    processing: isProcessing(s.id),
    progress: processingProgress(s.id),
    clips,
    speakers,
    hasTranscript: fs.existsSync(paths.transcriptJson),
    hasChatlog: fs.existsSync(paths.chatlog),
    hasSummary: fs.existsSync(paths.summary),
    hasStory: findStoryFile(s.id) !== null,
  };
}

/**
 * How many of the most recent session's speakers resolve to a character or the GM, by
 * `/scrib map` or the Foundry flag (05 C10). Live recordings count first.
 */
function speakerMapping(store: Store, rows: SessionRow[], recordings: RecordingStatus[]) {
  let sessionNumber: number | null = null;
  let guildId: string | null = null;
  let campaignId: number = ALL_CAMPAIGNS;
  let people: { discordId: string; displayName: string }[] = [];
  const r = recordings[0];
  if (r) {
    sessionNumber = r.number;
    const row = rows.find((s) => s.id === r.sessionId);
    guildId = row?.guild_id ?? null;
    campaignId = row?.campaign_id ?? ALL_CAMPAIGNS;
    people = r.speakers;
  } else {
    for (const s of rows) {
      try {
        people = readTimeline(sessionPaths(s.id).recording).participants;
      } catch {
        continue;
      }
      if (people.length) {
        sessionNumber = s.number;
        guildId = s.guild_id;
        campaignId = s.campaign_id ?? ALL_CAMPAIGNS;
        break;
      }
    }
  }
  const mappings = guildId ? store.getMappings(guildId, campaignId) : [];
  const roster = store.getRoster();
  const resolved = people.map((p) => resolveParticipant(p.discordId, p.displayName, mappings, roster));
  const unmapped = resolved.filter((p) => !p.isGm && !p.character).map((p) => p.displayName);
  return { session: sessionNumber, total: resolved.length, mapped: resolved.length - unmapped.length, unmapped };
}

function safeOrigin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export async function buildStatus(store: Store, sources: MonitorSources, foundry: FoundryActivity) {
  const worker = await workerStatus();
  const discord = sources.discord?.() ?? null;
  const recordings = sources.recordings?.() ?? [];
  const llm = await llmStatus();
  const roster = store.getRoster();
  const live = new Map(recordings.map((r) => [r.sessionId, r]));
  const rows = store.listSessions(20);
  const sessions = rows.map((s) => sessionStatus(s, live.get(s.id)));
  const speakers = speakerMapping(store, rows, recordings);

  const warnings: string[] = [];
  if (config.api.token === "change-me") warnings.push("API_TOKEN is still 'change-me'. Set a real secret in .env.");
  if (discord && !discord.ready) warnings.push("Discord client is not connected.");
  if (worker.reachable && "loadError" in worker && worker.loadError) {
    warnings.push(`The worker's speech-to-text model failed to load: ${worker.loadError}`);
  }
  if (!worker.reachable) {
    warnings.push(
      recordings.length
        ? "Transcription worker is unreachable. Clips will wait on disk until it is back."
        : "Transcription worker is unreachable.",
    );
  }
  // An empty model is always a mistake (02 S14). Anything else (credentials, LLM_HEADERS) only matters
  // once summaries are wanted automatically; /scrib summarize checks it itself before starting.
  const llmIssue = llmProblem(llm);
  if (llmIssue && (!llm.model || llm.autoSummarize)) warnings.push(llmIssue);
  if (recordings.length && foundry.sockets === 0) {
    warnings.push("Recording, but no Foundry module is connected. The chat and combat log won't be captured.");
  }
  for (const r of recordings) {
    if (r.connection === "reconnecting") warnings.push(`Session ${r.number}: voice connection lost, rejoining. Nothing is being recorded right now.`);
    if (r.connection === "lost") {
      warnings.push(`Session ${r.number}: couldn't rejoin the voice channel. Nothing is being recorded; still retrying every minute.`);
    }
    const unmapped = r.speakers.filter((p) => !p.isGm && !p.character).map((p) => p.displayName);
    if (unmapped.length) warnings.push(`Session ${r.number}: unmapped speakers: ${unmapped.join(", ")} (use /scrib map).`);
  }
  const failed = sessions.filter((s) => s.status === "failed" && !s.processing);
  if (failed.length) {
    const cmds = failed.slice(0, 3).map((s) => `/scrib process session:${s.number}`).join(", ");
    warnings.push(`${failed.length} session(s) failed. Run ${cmds}${failed.length > 3 ? ", …" : ""} to resume.`);
  }
  const headless = sources.foundryHeadless?.() ?? null;
  if (headless && headless.mode !== "off") {
    if (headless.state === "retrying" && headless.error) {
      warnings.push(`ScribBot couldn't join Foundry as ${headless.user}: ${headless.error}`);
    }
    if (!headless.url) {
      warnings.push(
        `${headless.campaign ?? "The campaign being played"} has no Foundry address, so ScribBot doesn't join Foundry for it. Set one in the Console's Campaign tab.`,
      );
    }
    const origin = headless.url ? safeOrigin(headless.url) : null;
    if (origin && !allowedOrigins(store).has(origin)) {
      warnings.push(`FOUNDRY_ORIGINS doesn't include ${origin}, so the headless Foundry client can't reach the bot's API.`);
    }
    if (headless.url && !headless.passwordSet) {
      const where = headless.campaign ? `in the Campaign tab (${headless.campaign}) or FOUNDRY_PASSWORD in .env` : "in .env (FOUNDRY_PASSWORD) or the Campaign tab";
      warnings.push(`No Foundry password is set. Give the ${headless.user} Foundry user a password and set it ${where}.`);
    }
    if (headless.state === "connected" && headless.expectedWorld && headless.world && headless.world !== headless.expectedWorld) {
      warnings.push(
        `${headless.campaign ?? "The campaign being played"} expects Foundry world ${headless.expectedWorld}, but ${headless.url} is running ${headless.world}. ` +
          "Journals of this campaign wait until its world is joined.",
      );
    }
    if (headless.pendingImports.length) {
      warnings.push(`${headless.pendingImports.length} summary(ies) are waiting for a GM to be online in Foundry to be imported.`);
    }
  }
  const disk = diskStatus();
  if (disk.freeBytes !== null && disk.freeBytes < 1024 ** 3) warnings.push("Less than 1 GB free in the data directory.");

  const pipeline = pipelineTracker.build({ sessions, recordings, worker });
  const playing = store.defaultCampaign({ create: false });

  return {
    now: new Date().toISOString(),
    process: { startedAt, uptimeSec: Math.round(process.uptime()), rssBytes: process.memoryUsage().rss, node: process.version },
    discord,
    recordings,
    worker,
    llm,
    /** The campaign being played: where new recordings go and whose Foundry server is joined. `chosen`: picked in the Campaign tab. */
    campaign: playing
      ? { id: playing.id, name: campaignName(playing), world: playing.world_id, chosen: Boolean(playing.selected_at), unassigned: playing.folder === UNASSIGNED_FOLDER }
      : null,
    foundry: {
      ...foundry,
      headless,
      rosterUsers: roster.length,
      /** Foundry users with the module's "Discord ID" flag set. Not the whole story: see `speakers`. */
      rosterLinked: roster.filter((r) => r.discord_id).length,
      /** Recent speakers who resolve to a character or the GM by any route (05 C10). */
      speakers,
    },
    config: {
      deleteAudioAfterTranscribe: config.deleteAudioAfterTranscribe,
      audioRetentionDays: config.audioRetentionDays,
    },
    disk,
    sessions,
    /** Queue, conversion, alerts and shutdown advice for the dashboard's pipeline panel (05 C1). */
    pipeline,
    warnings,
  };
}
