/**
 * The model each summary provider uses when LLM_MODEL is blank. The one place this is written down:
 * the providers, /status, the model list and (through the settings catalog, shared/schemas/settings.json)
 * the Console read it. Dependency-free on purpose, so reading a default never loads a provider's SDK.
 */

/** API providers; null means the provider needs LLM_MODEL. */
export const API_DEFAULT_MODELS = {
  anthropic: "claude-opus-5-5",
  xai: "grok-4",
  gemini: "gemini-3.8-flash",
  "vertex-ai": "gemini-3.8-flash",
  "openai-compatible": null,
  "azure-openai": null,
  bedrock: null,
} as const satisfies Record<string, string | null>;

/** CLI providers: mostly the CLI's own setting, so these are labels rather than model ids. */
export const CLI_DEFAULT_MODELS = {
  codex: "codex default",
  antigravity: "gemini-3.8-flash",
  "claude-code": "Claude Code default",
  "grok-cli": "Grok CLI default",
} as const;

/** What a blank LLM_MODEL means for `provider`, or null when the provider needs one. */
export function defaultModel(provider: string): string | null {
  const all: Record<string, string | null> = { ...API_DEFAULT_MODELS, ...CLI_DEFAULT_MODELS };
  return all[provider] ?? null;
}
