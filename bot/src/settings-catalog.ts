import { defaultModel } from "./summarize/defaults.js";

/**
 * Every .env variable, described for the Console's Configuration tab (docs/console-design.md §4.4).
 * `npm run schemas` writes it to shared/schemas/settings.json, which the Console reads; it never
 * hard-codes a variable. Tests keep it in step with the bot's EnvSchema (config.ts), the worker's
 * Settings (worker/scribworker/config.py) and .env.example.
 */

export type SettingType = "string" | "secret" | "int" | "number" | "bool" | "enum" | "url" | "path";
export type Process = "bot" | "worker" | "console";

export interface Setting {
  key: string;
  group: string;
  label: string;
  help: string;
  type: SettingType;
  /** What a blank value means, as written in .env ("" when blank means "not set"). */
  default: string;
  /** Shown next to a blank field, e.g. "blank = claude-opus-5-5". */
  blankMeans?: string;
  /** For an enum: its choices. `kind` sorts them under `kindPicker`; `defaultModel` (LLM_PROVIDER) is what a blank LLM_MODEL means, null when it's required. */
  options?: { value: string; label: string; kind?: string; defaultModel?: string | null }[];
  /**
   * A dropdown the Console shows before this enum, choosing which kind of option it lists (e.g. API
   * or CLI providers). It isn't a setting of its own: the kind follows from the value, so nothing
   * extra is written to .env.
   */
  kindPicker?: { label: string; help: string; kinds: { value: string; label: string }[] };
  min?: number;
  max?: number;
  /** Processes that read it at startup: a change needs them restarted. */
  readBy: Process[];
  /**
   * The bot re-reads it from .env for each summary (summaryConfig() in bot/src/config.ts), so a
   * change takes effect on the next summary or test without restarting the bot.
   */
  live?: boolean;
  /** In the collapsed "Advanced" part of its group. */
  advanced?: boolean;
  /** Tuned for speed or accuracy; the form offers "Reset to default" and shows the default. */
  tuned?: boolean;
  /** Only relevant when another setting has one of these values. */
  showIf?: { key: string; values: string[] };
  /** Shown (and confirmed on save) when the value is known to cost speed, accuracy or safety. */
  warnings?: { when: { eq?: string; gt?: number; lt?: number }; text: string }[];
}

export const GROUPS = ["Discord", "Foundry", "Transcription", "Summaries", "Storage and retention", "Network", "Recovery and logs"] as const;

const BOT: Process[] = ["bot"];
const WORKER: Process[] = ["worker"];
const BOTH: Process[] = ["bot", "worker"];
const ALL: Process[] = ["bot", "worker", "console"];
const WHISPER = { key: "STT_ENGINE", values: ["whisper"] };
const yesNo = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];

export const SETTINGS: Setting[] = [
  // ---------------------------------------------------------------- Discord
  { key: "DISCORD_TOKEN", group: "Discord", label: "Bot token", type: "secret", default: "", readBy: BOT,
    help: "From the Discord developer portal (Bot → Reset Token). Needed to log in." },
  { key: "DISCORD_CLIENT_ID", group: "Discord", label: "Application ID", type: "string", default: "", readBy: BOT,
    help: "The application's ID (General Information). Needed to register the /scrib commands." },
  { key: "DISCORD_GUILD_ID", group: "Discord", label: "Server ID for commands", type: "string", default: "", readBy: BOT,
    blankMeans: "register globally (takes up to an hour)",
    help: "Register the /scrib commands to this one server, where they appear at once." },

  // ---------------------------------------------------------------- Foundry
  { key: "API_TOKEN", group: "Foundry", label: "API token", type: "secret", default: "change-me", readBy: ["bot", "console"],
    help: "Shared secret between the bot, the Foundry module and the Console. Paste the same value into the module's settings " +
      "(the headless client sets it there by itself).",
    warnings: [{ when: { eq: "change-me" }, text: "Still the example value. Generate a real secret." }] },
  { key: "FOUNDRY_ORIGINS", group: "Foundry", label: "Foundry address(es)", type: "string", default: "http://localhost:30000", readBy: BOT,
    help: "Comma-separated web origins allowed to call the bot: your Foundry URL, e.g. https://foundry.example.com." },
  { key: "FOUNDRY_HEADLESS", group: "Foundry", label: "Headless Foundry client", type: "enum", default: "session", readBy: BOT,
    options: [
      { value: "off", label: "Off: a person's browser is the bridge" },
      { value: "session", label: "Session: join while recording and to import" },
      { value: "always", label: "Always: stay joined while the bot runs" },
    ],
    help: "Have the bot join Foundry itself in a headless browser, as the module's Bridge user, so nobody has to keep a browser open." },
  { key: "FOUNDRY_URL", group: "Foundry", label: "Foundry URL", type: "url", default: "", readBy: BOT,
    blankMeans: "the first Foundry address", showIf: { key: "FOUNDRY_HEADLESS", values: ["session", "always"] },
    help: "Foundry's base URL for the headless client while no campaign is being played. A campaign's address is set in the Console's Campaign tab, and a campaign without one joins nothing. It must also be in the Foundry addresses above." },
  { key: "FOUNDRY_USER", group: "Foundry", label: "Foundry user", type: "string", default: "ScribBot", readBy: BOT,
    showIf: { key: "FOUNDRY_HEADLESS", values: ["session", "always"] },
    help: "The Foundry player the headless client logs in as, unless the campaign being played sets its own (Campaign tab). Set it as the module's Bridge user." },
  { key: "FOUNDRY_PASSWORD", group: "Foundry", label: "Foundry password", type: "secret", default: "", readBy: BOT,
    showIf: { key: "FOUNDRY_HEADLESS", values: ["session", "always"] },
    help: "That user's password, unless the campaign being played sets its own (Campaign tab)." },
  { key: "FOUNDRY_BROWSER", group: "Foundry", label: "Browser", type: "string", default: "", readBy: BOT, advanced: true,
    blankMeans: "msedge on Windows", showIf: { key: "FOUNDRY_HEADLESS", values: ["session", "always"] },
    help: "msedge, chrome, chromium, or a path to a Chromium-based browser." },
  { key: "FOUNDRY_BOT_URL", group: "Foundry", label: "Bot URL as the browser sees it", type: "url", default: "", readBy: BOT, advanced: true,
    blankMeans: "http://127.0.0.1:API_PORT", showIf: { key: "FOUNDRY_HEADLESS", values: ["session", "always"] },
    help: "The bot's API address written into the module's settings in the headless browser." },
  { key: "FOUNDRY_CHATLOG_WAIT_SECONDS", group: "Foundry", label: "Wait for the chat log (seconds)", type: "number", default: "120", min: 0,
    readBy: BOT, advanced: true, showIf: { key: "FOUNDRY_HEADLESS", values: ["session", "always"] },
    help: "After a recording stops, how long the summary waits for Foundry's chat log before going without it." },
  { key: "FOUNDRY_ANNOUNCE", group: "Foundry", label: "Announce in Foundry chat", type: "bool", default: "true", readBy: BOT,
    options: yesNo, showIf: { key: "FOUNDRY_HEADLESS", values: ["session", "always"] },
    help: "Post in Foundry's chat when ScribBot joins (and why) and before it leaves." },

  // ---------------------------------------------------------------- Transcription
  { key: "STT_ENGINE", group: "Transcription", label: "Speech-to-text engine", type: "enum", default: "whistle", readBy: WORKER,
    options: [
      { value: "whistle", label: "Whistle: 17 MB, CPU" },
      { value: "whisper", label: "Whisper: much more accurate, best on an NVIDIA GPU" },
    ],
    help: 'Whisper needs the optional install: in worker/, .venv\\Scripts\\pip install -e ".[whisper,cuda]" (or ".[whisper]" for CPU only).' },
  { key: "STT_LANGUAGE", group: "Transcription", label: "Language", type: "enum", default: "", readBy: WORKER,
    blankMeans: "detect per clip",
    options: [
      { value: "en", label: "English" }, { value: "de", label: "German" }, { value: "fr", label: "French" },
      { value: "es", label: "Spanish" }, { value: "it", label: "Italian" }, { value: "nl", label: "Dutch" },
      { value: "pl", label: "Polish" }, { value: "", label: "Detect per clip" },
    ],
    help: "The language spoken at the table." },
  { key: "WHISPER_MODEL", group: "Transcription", label: "Whisper model", type: "string", default: "large-v3", readBy: WORKER, showIf: WHISPER,
    help: "Downloaded on first use (large-v3 is about 3 GB)." },
  { key: "WHISPER_DEVICE", group: "Transcription", label: "Whisper device", type: "enum", default: "cuda", readBy: WORKER, showIf: WHISPER,
    options: [
      { value: "cuda", label: "NVIDIA GPU (CUDA)" },
      { value: "cpu", label: "CPU" },
    ],
    help: "Where Whisper runs.",
    warnings: [{ when: { eq: "cpu" }, text: "Whisper on the CPU is several times slower than on a GPU; long sessions may fall behind." }] },
  { key: "WHISPER_COMPUTE_TYPE", group: "Transcription", label: "Precision", type: "string", default: "", readBy: WORKER, advanced: true, showIf: WHISPER,
    blankMeans: "float16 on CUDA, int8 on CPU", help: "CTranslate2 compute type override." },
  { key: "WHISPER_BEAM_SIZE", group: "Transcription", label: "Beam size", type: "int", default: "5", min: 1, max: 10, readBy: WORKER,
    advanced: true, tuned: true, showIf: WHISPER,
    help: "Beam search width for short clips (1 = greedy, fastest).",
    warnings: [{ when: { gt: 5 }, text: "Wider beams are slower on every clip for little gain on short speech." }] },
  { key: "WHISPER_MAX_HOTWORDS", group: "Transcription", label: "Hotwords per clip", type: "int", default: "30", min: 0, max: 150, readBy: WORKER,
    advanced: true, tuned: true, showIf: WHISPER,
    help: "Names sent with each clip (party, then glossary, then Foundry actors; 0 = none).",
    warnings: [{ when: { gt: 30 }, text: "Long hotword lists make Whisper write names instead of speech, and decoding slows down." }] },
  { key: "WHISPER_HOTWORDS_MIN_SECONDS", group: "Transcription", label: "No hotwords below (seconds)", type: "number", default: "1.5", min: 0,
    readBy: WORKER, advanced: true, tuned: true, showIf: WHISPER,
    help: "Clips shorter than this get no hotwords: on near-silence Whisper writes the list back out.",
    warnings: [{ when: { lt: 1.5 }, text: "Short, quiet clips will more often come back as a list of names." }] },
  { key: "WHISPER_VAD", group: "Transcription", label: "Skip silent clips (VAD)", type: "bool", default: "true", options: yesNo, readBy: WORKER,
    advanced: true, tuned: true, showIf: WHISPER,
    help: "Check each clip for speech on the CPU (Silero VAD) first; clips without speech never reach the model.",
    warnings: [{ when: { eq: "false" }, text: "Every clip, silence included, goes to the model. Silent clips took 19–56 s each before this check." }] },
  { key: "WHISPER_VAD_THRESHOLD", group: "Transcription", label: "VAD threshold", type: "number", default: "0.5", min: 0, max: 1, readBy: WORKER,
    advanced: true, tuned: true, showIf: WHISPER, help: "Speech probability (0–1) a clip needs to be transcribed." },
  { key: "WHISPER_FILLER_MAX_SECONDS", group: "Transcription", label: "Drop filler clips shorter than (seconds)", type: "number", default: "2.0",
    min: 0, readBy: WORKER, advanced: true, tuned: true, showIf: WHISPER,
    help: 'A clip that is only "thank you", "you", "bye"… is dropped when shorter than this and decoded with low confidence (0 = keep them all).',
    warnings: [{ when: { eq: "0" }, text: "Whisper's stock silence phrases will end up in transcripts." }] },
  { key: "WHISPER_FILLER_MAX_PROBABILITY", group: "Transcription", label: "Filler confidence cut-off", type: "number", default: "0.7",
    min: 0, max: 1, readBy: WORKER, advanced: true, tuned: true, showIf: WHISPER,
    help: "…and when its mean word confidence is below this." },
  { key: "WHISTLE_WEIGHTS", group: "Transcription", label: "Whistle weights file", type: "path", default: "", readBy: WORKER, advanced: true,
    blankMeans: "downloaded from Hugging Face", showIf: { key: "STT_ENGINE", values: ["whistle"] },
    help: "Path to a local or fine-tuned whistle.cact." },
  { key: "WORKER_RECOVER_HOURS", group: "Transcription", label: "Re-queue clips on start (hours)", type: "number", default: "12", min: 0,
    readBy: WORKER, advanced: true,
    help: "On start, re-queue clips from sessions touched in the last N hours that have audio but no text (0 = off)." },
  { key: "WORKER_RELOAD_AFTER_FAILURES", group: "Transcription", label: "Reload the model after errors", type: "int", default: "5", min: 0,
    readBy: WORKER, advanced: true,
    help: "After this many model errors in a row, reload the model; if that fails the worker restarts (0 = never)." },
  { key: "WORKER_SLOW_CLIP_SECONDS", group: "Transcription", label: "Log slow clips after (seconds)", type: "number", default: "60", min: 0,
    readBy: WORKER, advanced: true, help: "Log a clip that has been transcribing longer than this (0 = never)." },

  // ---------------------------------------------------------------- Summaries
  { key: "LLM_PROVIDER", group: "Summaries", live: true, label: "Provider", type: "enum", default: "anthropic", readBy: ["bot", "console"],
    kindPicker: {
      label: "Summaries via",
      help: "API: an API key, or a local server such as Ollama. CLI: a coding-agent CLI on this computer, signed in with your own Claude, ChatGPT, Google or Grok account; no API key.",
      kinds: [
        { value: "api", label: "API" },
        { value: "cli", label: "CLI (signed-in account)" },
      ],
    },
    options: [
      { value: "anthropic", label: "Anthropic Claude", kind: "api" },
      { value: "xai", label: "xAI Grok", kind: "api" },
      { value: "openai-compatible", label: "OpenAI-compatible (OpenAI, Mistral, DeepSeek, Groq, OpenRouter, Ollama, LM Studio…)", kind: "api" },
      { value: "gemini", label: "Google Gemini API", kind: "api" },
      { value: "vertex-ai", label: "Google Vertex AI (Gemini on Google Cloud)", kind: "api" },
      { value: "azure-openai", label: "Azure OpenAI", kind: "api" },
      { value: "bedrock", label: "Amazon Bedrock (Claude, Nova, Llama, Mistral… on AWS)", kind: "api" },
      { value: "claude-code", label: "Claude Code (Claude sign-in)", kind: "cli" },
      { value: "codex", label: "OpenAI Codex (ChatGPT sign-in)", kind: "cli" },
      { value: "antigravity", label: "Google Antigravity (Gemini, Google sign-in)", kind: "cli" },
      { value: "grok-cli", label: "xAI Grok CLI (Grok sign-in)", kind: "cli" },
    ].map((o) => ({ ...o, defaultModel: defaultModel(o.value) })),
    help: "Who writes the summaries. Only transcript text and campaign notes are sent." },
  { key: "LLM_MODEL", group: "Summaries", live: true, label: "Model", type: "string", default: "", readBy: ["bot", "console"],
    blankMeans: "the provider's default",
    help: "Any model id the provider accepts. Required for OpenAI-compatible, Bedrock (a model id or inference profile) and Azure OpenAI (your deployment name). 'Which models?' below lists the ids the selected provider accepts." },
  { key: "ANTHROPIC_API_KEY", group: "Summaries", live: true, label: "Anthropic API key", type: "secret", default: "", readBy: ["bot", "console"],
    showIf: { key: "LLM_PROVIDER", values: ["anthropic"] },
    help: "Leave blank to use an `ant auth login` profile instead." },
  { key: "ANTHROPIC_BASE_URL", group: "Summaries", live: true, label: "Base URL", type: "url", default: "", readBy: ["bot", "console"],
    blankMeans: "https://api.anthropic.com", showIf: { key: "LLM_PROVIDER", values: ["anthropic"] },
    help: "Any endpoint speaking the Anthropic Messages API: a gateway, proxy or regional endpoint. The SDK adds /v1/messages." },
  { key: "XAI_API_KEY", group: "Summaries", live: true, label: "xAI API key", type: "secret", default: "", readBy: ["bot", "console"],
    showIf: { key: "LLM_PROVIDER", values: ["xai"] }, help: "" },
  { key: "XAI_BASE_URL", group: "Summaries", live: true, label: "Base URL", type: "url", default: "", readBy: ["bot", "console"],
    blankMeans: "https://api.x.ai/v1", showIf: { key: "LLM_PROVIDER", values: ["xai"] },
    help: "A regional xAI endpoint or a gateway in front of it (OpenAI Chat Completions format)." },
  { key: "OPENAI_BASE_URL", group: "Summaries", live: true, label: "Base URL", type: "url", default: "", readBy: ["bot", "console"],
    blankMeans: "https://api.openai.com/v1", showIf: { key: "LLM_PROVIDER", values: ["openai-compatible"] },
    help: "Any server speaking OpenAI Chat Completions, up to the /v1 part: http://localhost:11434/v1 (Ollama), http://localhost:1234/v1 (LM Studio), https://openrouter.ai/api/v1, an Azure OpenAI or vLLM endpoint." },
  { key: "OPENAI_API_KEY", group: "Summaries", live: true, label: "API key", type: "secret", default: "", readBy: ["bot", "console"],
    showIf: { key: "LLM_PROVIDER", values: ["openai-compatible"] }, help: "Sent as 'Authorization: Bearer <key>'. Not needed for most local servers." },
  { key: "GEMINI_API_KEY", group: "Summaries", live: true, label: "Gemini API key", type: "secret", default: "", readBy: ["bot", "console"],
    showIf: { key: "LLM_PROVIDER", values: ["gemini", "vertex-ai"] },
    help: "From Google AI Studio. For Vertex AI, only for express mode: leave it blank when a Google Cloud project is set." },
  { key: "GOOGLE_GEMINI_BASE_URL", group: "Summaries", live: true, label: "Base URL", type: "url", default: "", readBy: ["bot", "console"],
    blankMeans: "https://generativelanguage.googleapis.com", showIf: { key: "LLM_PROVIDER", values: ["gemini"] },
    help: "A gateway or proxy speaking the Gemini API." },
  { key: "GOOGLE_CLOUD_PROJECT", group: "Summaries", live: true, label: "Google Cloud project", type: "string", default: "", readBy: ["bot", "console"],
    showIf: { key: "LLM_PROVIDER", values: ["vertex-ai"] }, help: "The project id with the Vertex AI API enabled." },
  { key: "GOOGLE_CLOUD_LOCATION", group: "Summaries", live: true, label: "Location", type: "string", default: "", readBy: ["bot", "console"],
    blankMeans: "global", showIf: { key: "LLM_PROVIDER", values: ["vertex-ai"] }, help: "A Vertex AI region such as us-central1 or europe-west4, or global." },
  { key: "GOOGLE_APPLICATION_CREDENTIALS", group: "Summaries", live: true, label: "Service account key file", type: "path", default: "",
    readBy: ["bot", "console"], blankMeans: "application default credentials", showIf: { key: "LLM_PROVIDER", values: ["vertex-ai"] },
    help: "A service account's JSON key. Blank: the credentials from `gcloud auth application-default login`, or the machine's own on Google Cloud." },
  { key: "GOOGLE_VERTEX_BASE_URL", group: "Summaries", live: true, label: "Base URL", type: "url", default: "", readBy: ["bot", "console"],
    blankMeans: "the location's Vertex AI endpoint", showIf: { key: "LLM_PROVIDER", values: ["vertex-ai"] },
    help: "A Private Service Connect endpoint or a gateway in front of Vertex AI." },
  { key: "AZURE_OPENAI_ENDPOINT", group: "Summaries", live: true, label: "Endpoint", type: "url", default: "", readBy: ["bot", "console"],
    showIf: { key: "LLM_PROVIDER", values: ["azure-openai"] }, help: "Your resource's endpoint, e.g. https://my-resource.openai.azure.com. Set Model to the deployment name." },
  { key: "AZURE_OPENAI_API_KEY", group: "Summaries", live: true, label: "Azure OpenAI key", type: "secret", default: "", readBy: ["bot", "console"],
    showIf: { key: "LLM_PROVIDER", values: ["azure-openai"] },
    help: "Key 1 or 2 from the resource. For Microsoft Entra ID instead, leave it blank and put 'Authorization: Bearer <token>' in Extra headers." },
  { key: "OPENAI_API_VERSION", group: "Summaries", live: true, label: "API version", type: "string", default: "", readBy: ["bot", "console"],
    blankMeans: "2024-10-21", showIf: { key: "LLM_PROVIDER", values: ["azure-openai"] },
    help: "The Azure OpenAI api-version. Structured output needs 2024-08-01-preview or later." },
  { key: "AWS_REGION", group: "Summaries", live: true, label: "AWS region", type: "string", default: "", readBy: ["bot", "console"],
    blankMeans: "the AWS profile's region", showIf: { key: "LLM_PROVIDER", values: ["bedrock"] }, help: "e.g. us-east-1, eu-central-1. The model must be enabled there." },
  { key: "AWS_PROFILE", group: "Summaries", live: true, label: "AWS profile", type: "string", default: "", readBy: ["bot", "console"],
    blankMeans: "the default credential chain", showIf: { key: "LLM_PROVIDER", values: ["bedrock"] },
    help: "A profile from ~/.aws/config (access keys, SSO via `aws sso login`, or a role). Blank: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment, the default profile, or the machine's role." },
  { key: "AWS_BEARER_TOKEN_BEDROCK", group: "Summaries", live: true, label: "Bedrock API key", type: "secret", default: "", readBy: ["bot", "console"],
    showIf: { key: "LLM_PROVIDER", values: ["bedrock"] }, help: "A Bedrock API key, used instead of AWS credentials when set." },
  { key: "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", group: "Summaries", live: true, label: "Endpoint", type: "url", default: "", readBy: ["bot", "console"],
    blankMeans: "the region's Bedrock Runtime endpoint", showIf: { key: "LLM_PROVIDER", values: ["bedrock"] },
    help: "A VPC interface endpoint, a FIPS endpoint or a gateway." },
  { key: "LLM_HEADERS", group: "Summaries", live: true, label: "Extra headers", type: "string", default: "", readBy: ["bot", "console"],
    showIf: { key: "LLM_PROVIDER", values: ["anthropic", "xai", "openai-compatible", "gemini", "vertex-ai", "azure-openai", "bedrock"] },
    help: "Sent with every request, as 'Name: value' pairs separated by ';', or a JSON object. e.g. 'HTTP-Referer: https://example.org; X-Title: ScribBot' for OpenRouter, 'api-key: <key>' for Azure OpenAI, or a gateway's own auth header. A header named here replaces the one ScribBot would send." },
  { key: "LLM_REQUEST_OPTIONS", group: "Summaries", live: true, label: "Extra request options", type: "string", default: "", readBy: ["bot", "console"],
    showIf: { key: "LLM_PROVIDER", values: ["anthropic", "xai", "openai-compatible", "gemini", "vertex-ai", "azure-openai", "bedrock"] },
    help: "A JSON object merged into every request, using the provider's own field names (Gemini: GenerateContentConfig fields such as thinkingConfig or safetySettings; Bedrock: Converse fields such as inferenceConfig, additionalModelRequestFields or guardrailConfig). e.g. {\"temperature\": 0.3}, {\"max_tokens\": 32000}, {\"max_completion_tokens\": 32000, \"reasoning_effort\": \"high\"} for OpenAI reasoning models, or {\"provider\": {\"order\": [\"anthropic\"]}} for OpenRouter. They override ScribBot's defaults; model, messages and the output format stay ScribBot's." },
  { key: "LLM_CLI_PATH", group: "Summaries", live: true, label: "CLI path", type: "path", default: "", readBy: ["bot", "console"],
    blankMeans: "codex, agy, claude or grok on PATH",
    showIf: { key: "LLM_PROVIDER", values: ["codex", "antigravity", "claude-code", "grok-cli"] },
    help: "Sign in with the CLI first (`codex login`, `grok login`, or start `agy` or `claude` once). It runs once per summary pass, so summaries are slower than through an API." },
  { key: "SUMMARY_CHUNK_MINUTES", group: "Summaries", live: true, label: "Minutes per chunk", type: "number", default: "25", min: 1, readBy: ["bot", "console"],
    advanced: true, help: "Minutes of transcript per extraction pass." },
  { key: "AUTO_SUMMARIZE", group: "Summaries", live: true, label: "Summarize automatically", type: "bool", default: "false", options: yesNo,
    readBy: ["bot", "console"],
    help: "Send every transcript to the LLM when it's done. Off: sessions end at a saved transcript until someone asks for a summary." },

  // ---------------------------------------------------------------- Storage and retention
  { key: "DATA_DIR", group: "Storage and retention", label: "Data folder", type: "path", default: "./data", readBy: ALL, advanced: true,
    help: "Recordings, transcripts, summaries, logs and the database. Relative paths start at the repo root." },
  { key: "CAMPAIGN_DIR", group: "Storage and retention", label: "Campaign folder", type: "path", default: "./campaign", readBy: ALL, advanced: true,
    help: "glossary.md and context.md: names and lore for speech-to-text and the summarizer. Each campaign's own are in <campaign folder>/ inside it (the Console's Campaign tab); the ones at the top are shared." },
  { key: "DELETE_AUDIO_AFTER_TRANSCRIBE", group: "Storage and retention", label: "Delete audio once transcribed", type: "bool", default: "true",
    options: yesNo, readBy: ALL,
    help: "Each clip is transcribed as soon as the speaker pauses and its audio deleted. Saves disk, but sessions can't be re-transcribed later." },
  { key: "AUDIO_RETENTION_DAYS", group: "Storage and retention", label: "Keep audio (days)", type: "number", default: "14", min: 0,
    readBy: ["bot", "console"], showIf: { key: "DELETE_AUDIO_AFTER_TRANSCRIBE", values: ["false"] },
    help: "When audio is kept: delete it this many days after a session is summarized (0 = forever)." },
  { key: "TRASH_RETENTION_DAYS", group: "Storage and retention", label: "Empty the trash after (days)", type: "number", default: "14", min: 0,
    readBy: BOT, help: "Sessions moved to the trash wait in data/trash this many days, then are deleted permanently (0 = until emptied by hand)." },
  { key: "TRASH_CONFIRM", group: "Storage and retention", label: "Confirm before moving a session to the trash", type: "bool", default: "true", options: yesNo,
    readBy: ["console"], help: "Show how long a session will be kept in the trash before it moves there. \"Don't show this again\" in that dialog sets this to No." },

  // ---------------------------------------------------------------- Network
  { key: "API_HOST", group: "Network", label: "Bot API address", type: "string", default: "127.0.0.1", readBy: ["bot", "console"], advanced: true,
    help: "Keep 127.0.0.1 unless the bot sits behind an HTTPS proxy.",
    warnings: [{ when: { eq: "0.0.0.0" }, text: "The bot's API would answer the whole network." }] },
  { key: "API_PORT", group: "Network", label: "Bot API port", type: "int", default: "7420", min: 1, max: 65535, readBy: ["bot", "console"], advanced: true,
    help: "The Foundry module and the Console reach the bot here." },
  { key: "WORKER_URL", group: "Network", label: "Worker URL", type: "url", default: "http://127.0.0.1:7421", readBy: ALL, advanced: true,
    help: "The transcription worker listens on this address." },
  { key: "CONSOLE_PORT", group: "Network", label: "Console port", type: "int", default: "7422", min: 1, max: 65535, readBy: ["console"], advanced: true,
    help: "This page (always on 127.0.0.1). The old MONITOR_PORT is still read when this is blank." },
  { key: "MONITOR_LOG_DIR", group: "Network", label: "Console log copy folder", type: "path", default: "", readBy: ["console"], advanced: true,
    blankMeans: "<data folder>/logs",
    help: "Where the Console keeps daily copies of the bot's log (scribbot-YYYY-MM-DD.log), so the lines before a crash survive it." },

  // ---------------------------------------------------------------- Recovery and logs
  { key: "RESUME_WINDOW_MINUTES", group: "Recovery and logs", label: "Resume recording after a restart (minutes)", type: "number", default: "30",
    min: 0, readBy: BOT,
    help: "After a crash or restart, rejoin a session that was recording less than this long ago (0 = never)." },
  { key: "BACKLOG_WARN_MINUTES", group: "Recovery and logs", label: "Warn when transcription is behind (minutes)", type: "number", default: "10",
    min: 0, readBy: BOT, help: "Post one warning in the text channel when the worker falls this far behind (0 = never)." },
  { key: "LOG_RETENTION_DAYS", group: "Recovery and logs", label: "Keep log files (days)", type: "number", default: "14", min: 0, readBy: BOTH,
    help: "Daily bot and worker log files in data/logs (0 = no log files)." },
];

/** Variables that used to exist and are still read as a fallback; the form doesn't show them. */
export const LEGACY_KEYS = ["MONITOR_PORT"];
