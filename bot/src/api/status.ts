import fs from "node:fs";
import { config } from "../config.js";
import type { SessionRow, Store } from "../db.js";
import { sessionPaths } from "../paths.js";
import { isProcessing, processingProgress } from "../pipeline.js";
import { mergedInto } from "../merge.js";
import { resolveParticipant } from "../participants.js";
import { readTimeline } from "../timeline.js";
import { workerHealth } from "../worker-client.js";
import { PipelineTracker } from "./pipeline.js";

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

const DEFAULT_MODELS: Record<string, string | null> = {
  anthropic: "claude-opus-5-5",
  xai: "grok-4",
  "openai-compatible": null,
};

type ProfileLoader = () => Promise<{ authentication?: { type?: string } } | null>;

const loadAnthropicProfile: ProfileLoader = async () => {
  const { loadConfig } = await import("@anthropic-ai/sdk/core/credentials");
  return loadConfig();
};

/**
 * Mirrors the Anthropic SDK's fallback order when no key is passed explicitly:
 * ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile.
 * Returns a label for the credential source (never the secret), or null when the SDK would find nothing.
 */
export async function resolveAnthropicCredentials(
  env: { apiKey?: string; authToken?: string },
  loadProfile: ProfileLoader = loadAnthropicProfile,
): Promise<{ credentials: string | null; error: string | null }> {
  if (env.apiKey) return { credentials: "api key", error: null };
  if (env.authToken) return { credentials: "auth token", error: null };
  try {
    const profile = await loadProfile();
    if (profile) return { credentials: `ant profile (${profile.authentication?.type ?? "unknown"})`, error: null };
  } catch (err) {
    // e.g. ANTHROPIC_PROFILE names a profile that doesn't exist.
    return { credentials: null, error: err instanceof Error ? err.message : String(err) };
  }
  return { credentials: null, error: null };
}

async function llmStatus() {
  const { provider, model } = config.llm;
  let credentials: string | null;
  let credentialsError: string | null = null;
  if (provider === "anthropic") {
    ({ credentials, error: credentialsError } = await resolveAnthropicCredentials({
      apiKey: config.llm.anthropicApiKey,
      authToken: process.env.ANTHROPIC_AUTH_TOKEN || undefined,
    }));
  } else if (provider === "xai") {
    credentials = config.llm.xaiApiKey ? "api key" : null;
  } else {
    credentials = config.llm.openaiBaseUrl ? `base url ${config.llm.openaiBaseUrl}` : null;
  }
  return {
    provider,
    model: model ?? DEFAULT_MODELS[provider] ?? null,
    credentials,
    credentialsError,
    chunkMinutes: config.llm.chunkMinutes,
    autoSummarize: config.autoSummarize,
  };
}

/**
 * Why a summary would fail right now, or null (02 S14). Checked before `/scrib summarize`
 * starts, and shown on /status whether or not AUTO_SUMMARIZE is on.
 */
export async function llmConfigProblem(): Promise<string | null> {
  const llm = await llmStatus();
  if (!llm.model) return `Summaries will fail: LLM_MODEL is empty, and the ${llm.provider} provider needs one. Set it in .env.`;
  if (!llm.credentials) {
    const why = llm.credentialsError ? ` (${llm.credentialsError})` : "";
    return `Summaries will fail: no credentials for LLM provider '${llm.provider}'${why}. ${CREDENTIAL_HINTS[llm.provider] ?? ""}`.trim();
  }
  return null;
}

const CREDENTIAL_HINTS: Record<string, string> = {
  anthropic: "Set ANTHROPIC_API_KEY in .env or run `ant auth login`.",
  xai: "Set XAI_API_KEY in .env.",
  "openai-compatible": "Set OPENAI_BASE_URL in .env.",
};

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
      const timeline = readTimeline(paths.dir);
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
  };
}

/**
 * How many of the most recent session's speakers resolve to a character or the GM, by
 * `/scrib map` or the Foundry flag (05 C10). Live recordings count first.
 */
function speakerMapping(store: Store, rows: SessionRow[], recordings: RecordingStatus[]) {
  let sessionNumber: number | null = null;
  let guildId: string | null = null;
  let people: { discordId: string; displayName: string }[] = [];
  const r = recordings[0];
  if (r) {
    sessionNumber = r.number;
    guildId = rows.find((s) => s.id === r.sessionId)?.guild_id ?? null;
    people = r.speakers;
  } else {
    for (const s of rows) {
      try {
        people = readTimeline(sessionPaths(s.id).dir).participants;
      } catch {
        continue;
      }
      if (people.length) {
        sessionNumber = s.number;
        guildId = s.guild_id;
        break;
      }
    }
  }
  const mappings = guildId ? store.getMappings(guildId) : [];
  const roster = store.getRoster();
  const resolved = people.map((p) => resolveParticipant(p.discordId, p.displayName, mappings, roster));
  const unmapped = resolved.filter((p) => !p.isGm && !p.character).map((p) => p.displayName);
  return { session: sessionNumber, total: resolved.length, mapped: resolved.length - unmapped.length, unmapped };
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
  // An empty model is always a mistake (02 S14). Missing credentials only matter once summaries are
  // wanted automatically; /scrib summarize checks them itself before starting.
  if (!llm.model) {
    warnings.push(`Summaries will fail: LLM_MODEL is empty, and the ${llm.provider} provider needs one. Set it in .env.`);
  } else if (llm.autoSummarize && !llm.credentials) {
    const why = llm.credentialsError ? ` (${llm.credentialsError})` : "";
    warnings.push(
      `No credentials configured for LLM provider '${llm.provider}'${why}. ${CREDENTIAL_HINTS[llm.provider] ?? ""} Summaries will fail until this is fixed.`.trim(),
    );
  }
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
  const disk = diskStatus();
  if (disk.freeBytes !== null && disk.freeBytes < 1024 ** 3) warnings.push("Less than 1 GB free in the data directory.");

  const pipeline = pipelineTracker.build({ sessions, recordings, worker });

  return {
    now: new Date().toISOString(),
    process: { startedAt, uptimeSec: Math.round(process.uptime()), rssBytes: process.memoryUsage().rss, node: process.version },
    discord,
    recordings,
    worker,
    llm,
    foundry: {
      ...foundry,
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
