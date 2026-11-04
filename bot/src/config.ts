import { config as loadEnv, parse as parseEnv } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const ENV_FILE = path.join(REPO_ROOT, ".env");
// Set in the real environment before .env was loaded: these win over .env, now and on every re-read.
const realEnvKeys = new Set(Object.keys(process.env));
loadEnv({ path: ENV_FILE, quiet: true });

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
  // Blank means the default, as for every setting; true/false are accepted as session/off.
  FOUNDRY_HEADLESS: z.preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      const s = v.trim().toLowerCase();
      if (!s) return undefined;
      return /^(true|1|yes|on)$/.test(s) ? "session" : /^(false|0|no|off)$/.test(s) ? "off" : s;
    },
    z.enum(["off", "session", "always"]).default("session"),
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

  LLM_PROVIDER: z
    .enum([
      "anthropic", "xai", "openai-compatible", "gemini", "vertex-ai", "azure-openai", "bedrock",
      "codex", "antigravity", "claude-code", "grok-cli",
    ])
    .default("anthropic"),
  LLM_MODEL: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_BASE_URL: optionalString,
  XAI_API_KEY: optionalString,
  XAI_BASE_URL: optionalString,
  OPENAI_BASE_URL: optionalString,
  OPENAI_API_KEY: optionalString,
  // Google Gemini API and Vertex AI, under the names Google's SDK reads.
  GEMINI_API_KEY: optionalString,
  GOOGLE_GEMINI_BASE_URL: optionalString,
  GOOGLE_CLOUD_PROJECT: optionalString,
  GOOGLE_CLOUD_LOCATION: optionalString,
  GOOGLE_APPLICATION_CREDENTIALS: optionalString,
  GOOGLE_VERTEX_BASE_URL: optionalString,
  // Azure OpenAI, under the names the openai SDK's AzureOpenAI reads. LLM_MODEL is the deployment.
  AZURE_OPENAI_ENDPOINT: optionalString,
  AZURE_OPENAI_API_KEY: optionalString,
  OPENAI_API_VERSION: optionalString,
  // Amazon Bedrock, under the AWS SDK's names. Blank: the AWS default credential chain.
  AWS_REGION: optionalString,
  AWS_PROFILE: optionalString,
  AWS_BEARER_TOKEN_BEDROCK: optionalString,
  AWS_ENDPOINT_URL_BEDROCK_RUNTIME: optionalString,
  // API providers only, passed through as written (bot/src/summarize/api-options.ts): extra HTTP
  // headers, and extra request-body fields as a JSON object. Checked when a summary starts.
  LLM_HEADERS: optionalString,
  LLM_REQUEST_OPTIONS: optionalString,
  // codex / antigravity / claude-code / grok-cli: the CLI to run when it isn't on PATH as
  // `codex` / `agy` / `claude` / `grok`.
  LLM_CLI_PATH: optionalString,
  SUMMARY_CHUNK_MINUTES: z.coerce.number().positive().default(25),
  // Off by default: sessions stop at a saved transcript, and nothing is sent to an LLM until
  // someone runs /scrib summarize.
  AUTO_SUMMARIZE: z.preprocess(
    (v) => (typeof v === "string" ? /^(true|1|yes|on)$/i.test(v.trim()) : v),
    z.boolean().default(false),
  ),
  // On by default: a summary or story goes to Foundry only after someone has reviewed and approved it.
  REVIEW_BEFORE_FOUNDRY: z.preprocess(
    (v) => (typeof v === "string" ? !/^(false|0|no|off)$/i.test(v.trim()) : v),
    z.boolean().default(true),
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
  // Sessions trashed from the Console wait in DATA_DIR/trash this many days (0 = until emptied by hand).
  TRASH_RETENTION_DAYS: z.coerce.number().min(0).default(14),
});

/** The env schema, exported for the settings catalog test (bot/src/settings-catalog.ts). */
export { EnvSchema };

const env = EnvSchema.parse(process.env);

// ---------------------------------------------------------------- live summary settings
//
// Summaries build their provider fresh for every run (and the CLI providers start a new process per
// request), so nothing needs a restart to pick up a new provider, model, key or CLI path. These keys
// are re-read from .env whenever the file changes (its mtime and size), with the same precedence as at
// startup: a variable set in the real environment wins. The settings catalog marks them `live`.

/** The .env keys the bot re-reads for each summary instead of only at startup. */
export const SUMMARY_KEYS = [
  "LLM_PROVIDER",
  "LLM_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "XAI_API_KEY",
  "XAI_BASE_URL",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_VERTEX_BASE_URL",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_API_VERSION",
  "AWS_REGION",
  "AWS_PROFILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
  "LLM_HEADERS",
  "LLM_REQUEST_OPTIONS",
  "LLM_CLI_PATH",
  "SUMMARY_CHUNK_MINUTES",
  "AUTO_SUMMARIZE",
  "REVIEW_BEFORE_FOUNDRY",
] as const;

const SummaryEnvSchema = EnvSchema.pick(Object.fromEntries(SUMMARY_KEYS.map((k) => [k, true])) as { [K in (typeof SUMMARY_KEYS)[number]]: true });

function buildSummaryConfig(e: z.infer<typeof SummaryEnvSchema>) {
  return {
    llm: {
      provider: e.LLM_PROVIDER,
      model: e.LLM_MODEL,
      anthropicApiKey: e.ANTHROPIC_API_KEY,
      anthropicBaseUrl: e.ANTHROPIC_BASE_URL,
      xaiApiKey: e.XAI_API_KEY,
      xaiBaseUrl: e.XAI_BASE_URL,
      openaiBaseUrl: e.OPENAI_BASE_URL,
      openaiApiKey: e.OPENAI_API_KEY,
      geminiApiKey: e.GEMINI_API_KEY,
      geminiBaseUrl: e.GOOGLE_GEMINI_BASE_URL,
      googleCloudProject: e.GOOGLE_CLOUD_PROJECT,
      googleCloudLocation: e.GOOGLE_CLOUD_LOCATION,
      googleCredentials: e.GOOGLE_APPLICATION_CREDENTIALS,
      vertexBaseUrl: e.GOOGLE_VERTEX_BASE_URL,
      azureEndpoint: e.AZURE_OPENAI_ENDPOINT,
      azureApiKey: e.AZURE_OPENAI_API_KEY,
      azureApiVersion: e.OPENAI_API_VERSION,
      awsRegion: e.AWS_REGION,
      awsProfile: e.AWS_PROFILE,
      awsBedrockToken: e.AWS_BEARER_TOKEN_BEDROCK,
      bedrockEndpoint: e.AWS_ENDPOINT_URL_BEDROCK_RUNTIME,
      headers: e.LLM_HEADERS,
      requestOptions: e.LLM_REQUEST_OPTIONS,
      cliPath: e.LLM_CLI_PATH,
      chunkMinutes: e.SUMMARY_CHUNK_MINUTES,
    },
    autoSummarize: e.AUTO_SUMMARIZE,
    reviewBeforeFoundry: e.REVIEW_BEFORE_FOUNDRY,
  };
}

export type SummaryConfig = ReturnType<typeof buildSummaryConfig>;

/**
 * A function returning the summary settings as `file` says now. Cheap when the file hasn't changed
 * (one stat). Keys in `realEnv` come from process.env instead, as dotenv does at startup. If the new
 * values don't validate, or the file can't be read, the last good ones stay in use and it's logged
 * once. Exported for tests; the bot uses summaryConfig().
 */
export function summaryReader(file: string, realEnv: ReadonlySet<string>, initial: SummaryConfig): () => SummaryConfig {
  const stampOf = () => {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "missing";
    }
  };
  let state = { stamp: stampOf(), value: initial };
  return () => {
    const stamp = stampOf();
    if (stamp === state.stamp) return state.value;
    let fromFile: Record<string, string>;
    try {
      fromFile = parseEnv(fs.readFileSync(file));
    } catch (err) {
      console.warn(`[config] couldn't re-read .env (${err instanceof Error ? err.message : String(err)}); keeping the summary settings in use`);
      state = { stamp, value: state.value };
      return state.value;
    }
    const merged = Object.fromEntries(SUMMARY_KEYS.map((k) => [k, realEnv.has(k) ? process.env[k] : fromFile[k]]));
    const parsed = SummaryEnvSchema.safeParse(merged);
    if (!parsed.success) {
      const keys = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ");
      console.warn(`[config] .env has invalid summary settings (${keys}); keeping the ones in use`);
      state = { stamp, value: state.value };
      return state.value;
    }
    const value = buildSummaryConfig(parsed.data);
    const before = state.value.llm;
    if (before.provider !== value.llm.provider || before.model !== value.llm.model) {
      console.log(`[config] summaries now use ${value.llm.provider}${value.llm.model ? ` / ${value.llm.model}` : ""} (from .env)`);
    }
    state = { stamp, value };
    return value;
  };
}

/** The summary settings as .env says now: config.llm and config.autoSummarize read through this. */
export const summaryConfig = summaryReader(ENV_FILE, realEnvKeys, buildSummaryConfig(env));

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
  /** Deleted sessions (soft delete from the Console), one folder per session id. */
  trashDir: path.join(resolveFromRoot(env.DATA_DIR), "trash"),
  trashRetentionDays: env.TRASH_RETENTION_DAYS,
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
  /** The summarizer. Re-read from .env when it changes, so a new provider or model needs no restart. */
  get llm() {
    return summaryConfig().llm;
  },
  /** Summarize automatically after transcription. Off: only `/scrib summarize` sends a transcript to the LLM. Live, like llm. */
  get autoSummarize() {
    return summaryConfig().autoSummarize;
  },
  /** A summary or story goes to Foundry only once someone has approved it (bot/src/review.ts). Live, like llm. */
  get reviewBeforeFoundry() {
    return summaryConfig().reviewBeforeFoundry;
  },
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
