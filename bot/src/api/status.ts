import fs from "node:fs";
import { config } from "../config.js";
import type { SessionRow, Store } from "../db.js";
import { sessionPaths } from "../paths.js";
import { isProcessing, processingProgress } from "../pipeline.js";
import { TimelineSchema } from "../types.js";
import { workerHealth } from "../worker-client.js";

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
  };
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

function sessionStatus(s: SessionRow) {
  const paths = sessionPaths(s.id);
  let clips: number | null = null;
  let speakers: number | null = null;
  try {
    const timeline = TimelineSchema.parse(JSON.parse(fs.readFileSync(paths.timeline, "utf8")));
    clips = timeline.segments.length;
    speakers = timeline.participants.length;
  } catch {
    // no timeline yet, or unreadable: shown as unknown
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
    processing: isProcessing(s.id),
    progress: processingProgress(s.id),
    clips,
    speakers,
    hasTranscript: fs.existsSync(paths.transcriptJson),
    hasChatlog: fs.existsSync(paths.chatlog),
    hasSummary: fs.existsSync(paths.summary),
  };
}

export async function buildStatus(store: Store, sources: MonitorSources, foundry: FoundryActivity) {
  const worker = await workerStatus();
  const discord = sources.discord?.() ?? null;
  const recordings = sources.recordings?.() ?? [];
  const llm = await llmStatus();
  const roster = store.getRoster();
  const sessions = store.listSessions(20).map(sessionStatus);

  const warnings: string[] = [];
  if (config.api.token === "change-me") warnings.push("API_TOKEN is still 'change-me'. Set a real secret in .env.");
  if (discord && !discord.ready) warnings.push("Discord client is not connected.");
  if (!worker.reachable) {
    warnings.push(
      recordings.length
        ? "Transcription worker is unreachable. Clips will wait on disk until it is back."
        : "Transcription worker is unreachable.",
    );
  }
  if (!llm.credentials) {
    const why = llm.credentialsError ? ` (${llm.credentialsError})` : "";
    warnings.push(
      `No credentials configured for LLM provider '${llm.provider}'${why}. ${CREDENTIAL_HINTS[llm.provider] ?? ""} Summaries will fail until this is fixed.`.trim(),
    );
  }
  if (!llm.model) warnings.push("LLM_MODEL must be set for the openai-compatible provider.");
  if (recordings.length && foundry.sockets === 0) {
    warnings.push("Recording, but no Foundry module is connected. The chat and combat log won't be captured.");
  }
  for (const r of recordings) {
    const unmapped = r.speakers.filter((p) => !p.isGm && !p.character).map((p) => p.displayName);
    if (unmapped.length) warnings.push(`Session ${r.number}: unmapped speakers: ${unmapped.join(", ")} (use /scrib map).`);
  }
  const failed = sessions.filter((s) => s.status === "failed" && !s.processing);
  if (failed.length) warnings.push(`${failed.length} session(s) failed. Run /scrib process to resume.`);
  const disk = diskStatus();
  if (disk.freeBytes !== null && disk.freeBytes < 1024 ** 3) warnings.push("Less than 1 GB free in the data directory.");

  return {
    now: new Date().toISOString(),
    process: { startedAt, uptimeSec: Math.round(process.uptime()), rssBytes: process.memoryUsage().rss, node: process.version },
    discord,
    recordings,
    worker,
    llm,
    foundry: { ...foundry, rosterUsers: roster.length, rosterLinked: roster.filter((r) => r.discord_id).length },
    config: {
      deleteAudioAfterTranscribe: config.deleteAudioAfterTranscribe,
      audioRetentionDays: config.audioRetentionDays,
    },
    disk,
    sessions,
    warnings,
  };
}
