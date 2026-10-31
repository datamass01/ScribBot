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

  WORKER_URL: z.string().default("http://127.0.0.1:7421"),

  LLM_PROVIDER: z.enum(["anthropic", "xai", "openai-compatible"]).default("anthropic"),
  LLM_MODEL: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  XAI_API_KEY: optionalString,
  OPENAI_BASE_URL: optionalString,
  OPENAI_API_KEY: optionalString,
  SUMMARY_CHUNK_MINUTES: z.coerce.number().positive().default(25),

  DELETE_AUDIO_AFTER_TRANSCRIBE: z.preprocess(
    (v) => (typeof v === "string" ? !/^(false|0|no|off)$/i.test(v.trim()) : v),
    z.boolean().default(true),
  ),
  AUDIO_RETENTION_DAYS: z.coerce.number().min(0).default(14),
});

const env = EnvSchema.parse(process.env);

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
    origins: env.FOUNDRY_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
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
  /** Transcribe each clip as it is recorded, then delete the WAV once its text is saved. */
  deleteAudioAfterTranscribe: env.DELETE_AUDIO_AFTER_TRANSCRIBE,
  audioRetentionDays: env.AUDIO_RETENTION_DAYS,
};

export type Config = typeof config;

export function requireDiscordConfig() {
  const { token, clientId } = config.discord;
  if (!token || !clientId) {
    throw new Error("DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in .env");
  }
  return { token, clientId, guildId: config.discord.guildId };
}
