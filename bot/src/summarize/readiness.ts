import fs from "node:fs";
import { config } from "../config.js";
import { authHeader, parseHeaders, parseRequestOptions } from "./api-options.js";
import { isCliProvider, resolveCli } from "./cli-agent.js";
import { defaultModel } from "./defaults.js";

/**
 * Whether summaries can run with the current settings: the model a run would use, where its
 * credentials come from (a label, never the secret) and what's wrong if anything. Read by /status,
 * and checked before `/scrib summarize` (or the Console's Summarize) starts (02 S14).
 */

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

export async function llmStatus() {
  const { provider, model } = config.llm;
  let credentials: string | null;
  let credentialsError: string | null = null;
  // LLM_HEADERS may carry the credentials instead (a gateway's own auth header). Name only, never the value.
  let headerAuth: string | null = null;
  let optionsError: string | null = null;
  if (!isCliProvider(provider)) {
    try {
      const h = authHeader(parseHeaders(config.llm.headers));
      headerAuth = h ? `${h} header` : null;
      parseRequestOptions(config.llm.requestOptions);
    } catch (err) {
      optionsError = err instanceof Error ? err.message : String(err);
    }
  }
  if (provider === "anthropic") {
    ({ credentials, error: credentialsError } = await resolveAnthropicCredentials({
      apiKey: config.llm.anthropicApiKey,
      authToken: process.env.ANTHROPIC_AUTH_TOKEN || undefined,
    }));
    if (!credentials && headerAuth) ({ credentials, error: credentialsError } = { credentials: headerAuth, error: null });
  } else if (provider === "xai") {
    credentials = config.llm.xaiApiKey ? "api key" : headerAuth;
  } else if (provider === "gemini") {
    credentials = config.llm.geminiApiKey ? "api key" : headerAuth;
  } else if (provider === "vertex-ai") {
    if (config.llm.googleCloudProject) {
      credentials = config.llm.googleCredentials ? "service account file" : "application default credentials";
      credentialsError = config.llm.googleCredentials && !fs.existsSync(config.llm.googleCredentials)
        ? `GOOGLE_APPLICATION_CREDENTIALS: ${config.llm.googleCredentials} not found` : null;
      if (credentialsError) credentials = null;
    } else {
      credentials = config.llm.geminiApiKey ? "api key (express mode)" : null;
    }
  } else if (provider === "azure-openai") {
    credentials = !config.llm.azureEndpoint ? null : config.llm.azureApiKey ? "api key" : headerAuth;
    if (!config.llm.azureEndpoint) credentialsError = "AZURE_OPENAI_ENDPOINT is not set";
  } else if (provider === "bedrock") {
    // The AWS chain (environment, profile, SSO, instance role) is only resolved on a real call.
    credentials = config.llm.awsBedrockToken
      ? "bedrock api key"
      : `aws credential chain${config.llm.awsProfile ? ` (profile ${config.llm.awsProfile})` : ""}`;
  } else if (isCliProvider(provider)) {
    // The CLI's own sign-in (a ChatGPT or Google account); only its presence can be checked here.
    // Same lookup as a summary run: found, and startable without a shell.
    const cli = resolveCli(provider, config.llm.cliPath);
    credentials = cli.launch ? `${provider} cli login` : null;
    credentialsError = cli.error ?? null;
  } else {
    credentials = config.llm.openaiBaseUrl ? `base url ${config.llm.openaiBaseUrl}` : null;
  }
  return {
    provider,
    model: model ?? defaultModel(provider),
    credentials,
    credentialsError,
    optionsError,
    chunkMinutes: config.llm.chunkMinutes,
    autoSummarize: config.autoSummarize,
  };
}

export type LlmStatus = Awaited<ReturnType<typeof llmStatus>>;

/** Why a summary would fail with these settings, or null. */
export function llmProblem(llm: LlmStatus): string | null {
  if (!llm.model) return `Summaries will fail: LLM_MODEL is empty, and the ${llm.provider} provider needs one. Set it in .env.`;
  if (llm.optionsError) return `Summaries will fail: ${llm.optionsError}.`;
  if (!llm.credentials) {
    const why = llm.credentialsError ? ` (${llm.credentialsError})` : "";
    return `Summaries will fail: no credentials for LLM provider '${llm.provider}'${why}. ${CREDENTIAL_HINTS[llm.provider] ?? ""}`.trim();
  }
  return null;
}

/** Why a summary would fail right now, or null (02 S14). */
export async function llmConfigProblem(): Promise<string | null> {
  return llmProblem(await llmStatus());
}

const CREDENTIAL_HINTS: Record<string, string> = {
  anthropic: "Set ANTHROPIC_API_KEY in .env, run `ant auth login`, or put an auth header in LLM_HEADERS.",
  xai: "Set XAI_API_KEY in .env, or put an auth header in LLM_HEADERS.",
  "openai-compatible": "Set OPENAI_BASE_URL in .env.",
  gemini: "Set GEMINI_API_KEY in .env, or put an auth header in LLM_HEADERS.",
  "vertex-ai": "Set GOOGLE_CLOUD_PROJECT (and run `gcloud auth application-default login` or set GOOGLE_APPLICATION_CREDENTIALS), or GEMINI_API_KEY for express mode.",
  "azure-openai": "Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .env, or an Entra ID Authorization header in LLM_HEADERS.",
  bedrock: "Set AWS_BEARER_TOKEN_BEDROCK or AWS_PROFILE, or sign in with the AWS CLI.",
  codex: "Install the Codex CLI and run `codex login`, or set LLM_CLI_PATH.",
  antigravity: "Install the Antigravity CLI (agy) and sign in, or set LLM_CLI_PATH.",
  "claude-code": "Install Claude Code and sign in (run `claude` once), or set LLM_CLI_PATH.",
  "grok-cli": "Install the Grok CLI and run `grok login`, or set LLM_CLI_PATH.",
};
