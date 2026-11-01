import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

loadEnv({ path: path.join(REPO_ROOT, ".env"), quiet: true });

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const EnvSchema = z.object({
  DISCORD_TOKEN: optionalString,
  DISCORD_CLIENT_ID: optionalString,
  DISCORD_GUILD_ID: optionalString,

  DATA_DIR: z.string().default("./data"),
  CAMPAIGN_DIR: z.string().default("./campaign"),

  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().default(7420),
  API_TOKEN: z.string().default("change-me"),
  FOUNDRY_ORIGINS: z.string().default("http://localhost:30000"),

  // Headless Foundry client (bot/src/foundry/): off | session (joins while recording, and to
  // import a summary) | always (stays joined while the bot runs).
  FOUNDRY_HEADLESS: z.preprocess(
    (v) => (typeof v === "string" ? (/^(true|1|yes|on)$/i.test(v.trim()) ? "session" : /^(false|0|no|off|)$/i.test(v.trim()) ? "off" : v.trim().toLowerCase()) : v),
    z.enum(["off", "session", "always"]).default("off"),
  ),
  FOUNDRY_URL: optionalString,
  FOUNDRY_USER: z.string().default("ScribBot"),
  FOUNDRY_PASSWORD: z.string().default(""),
  FOUNDRY_BROWSER: optionalString,
  FOUNDRY_BOT_URL: optionalString,
  FOUNDRY_CHATLOG_WAIT_SECONDS: z.coerce.number().min(0).default(120),
  // Post in Foundry's chat when the headless client joins (and why) and before it leaves.
  FOUNDRY_ANNOUNCE: z.preprocess(
    (v) => (typeof v === "string" ? !/^(false|0|no|off)$/i.test(v.trim()) : v),
    z.boolean().default(true),
  ),

  WORKER_URL: z.string().default("http://127.0.0.1:7421"),

  LLM_PROVIDER: z.enum(["anthropic", "xai", "openai-compatible"]).default("anthropic"),
  LLM_MODEL: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  XAI_API_KEY: optionalString,
  OPENAI_BASE_URL: optionalString,
  OPENAI_API_KEY: optionalString,
  SUMMARY_CHUNK_MINUTES: z.coerce.number().positive().default(25),
  // Off by default: sessions stop at a saved transcript, and nothing is sent to an LLM until
  // someone runs /scrib summarize.
  AUTO_SUMMARIZE: z.preprocess(
    (v) => (typeof v === "string" ? /^(true|1|yes|on)$/i.test(v.trim()) : v),
    z.boolean().default(false),
  ),

  DELETE_AUDIO_AFTER_TRANSCRIBE: z.preprocess(
    (v) => (typeof v === "string" ? !/^(false|0|no|off)$/i.test(v.trim()) : v),
    z.boolean().default(true),
  ),
  AUDIO_RETENTION_DAYS: z.coerce.number().min(0).default(14),

  // After a crash or restart, rejoin the voice channel of a session that was recording less than
  // this many minutes ago and keep recording it (0 = never resume).
  RESUME_WINDOW_MINUTES: z.coerce.number().min(0).default(30),
  // Warn in the text channel once when the worker is this many minutes behind (0 = never).
  BACKLOG_WARN_MINUTES: z.coerce.number().min(0).default(10),
  // Daily bot log files in DATA_DIR/logs, kept this many days (0 = no log files).
  LOG_RETENTION_DAYS: z.coerce.number().min(0).default(14),
});

const env = EnvSchema.parse(process.env);

const origins = env.FOUNDRY_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
/** The URL a browser on this machine uses to reach the bot's API. */
const loopbackHost = ["0.0.0.0", "::", "localhost", ""].includes(env.API_HOST) ? "127.0.0.1" : env.API_HOST;

const resolveFromRoot = (p: string) => (path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p));

export const config = {
  discord: {
    token: env.DISCORD_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    guildId: env.DISCORD_GUILD_ID,
  },
  dataDir: resolveFromRoot(env.DATA_DIR),
  sessionsDir: path.join(resolveFromRoot(env.DATA_DIR), "sessions"),
  campaignDir: resolveFromRoot(env.CAMPAIGN_DIR),
  api: {
    host: env.API_HOST,
    port: env.API_PORT,
    token: env.API_TOKEN,
    origins,
  },
  /** The headless Foundry client that joins the world as the bridge user (docs/design.md §3.2). */
  foundry: {
    headless: env.FOUNDRY_HEADLESS,
    url: (env.FOUNDRY_URL ?? origins[0] ?? "http://localhost:30000").replace(/\/+$/, ""),
    user: env.FOUNDRY_USER,
    password: env.FOUNDRY_PASSWORD,
    /** msedge | chrome | chromium, or a path to a Chromium-based browser executable. */
    browser: env.FOUNDRY_BROWSER ?? (process.platform === "win32" ? "msedge" : "chromium"),
    botUrl: (env.FOUNDRY_BOT_URL ?? `http://${loopbackHost.includes(":") ? `[${loopbackHost}]` : loopbackHost}:${env.API_PORT}`).replace(/\/+$/, ""),
    chatlogWaitMs: env.FOUNDRY_CHATLOG_WAIT_SECONDS * 1000,
    announce: env.FOUNDRY_ANNOUNCE,
  },
  workerUrl: env.WORKER_URL.replace(/\/$/, ""),
  llm: {
    provider: env.LLM_PROVIDER,
    model: env.LLM_MODEL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    xaiApiKey: env.XAI_API_KEY,
    openaiBaseUrl: env.OPENAI_BASE_URL,
    openaiApiKey: env.OPENAI_API_KEY,
    chunkMinutes: env.SUMMARY_CHUNK_MINUTES,
  },
  /** Summarize automatically after transcription. Off: only `/scrib summarize` sends a transcript to the LLM. */
  autoSummarize: env.AUTO_SUMMARIZE,
  /** Transcribe each clip as it is recorded, then delete the WAV once its text is saved. */
  deleteAudioAfterTranscribe: env.DELETE_AUDIO_AFTER_TRANSCRIBE,
  audioRetentionDays: env.AUDIO_RETENTION_DAYS,
  resumeWindowMinutes: env.RESUME_WINDOW_MINUTES,
  backlogWarnMinutes: env.BACKLOG_WARN_MINUTES,
  logDir: path.join(resolveFromRoot(env.DATA_DIR), "logs"),
  logRetentionDays: env.LOG_RETENTION_DAYS,
};

export type Config = typeof config;

export function requireDiscordConfig() {
  const { token, clientId } = config.discord;
  if (!token || !clientId) {
    throw new Error("DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in .env");
  }
  return { token, clientId, guildId: config.discord.guildId };
}
