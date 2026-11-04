// Freeform connection settings for the API providers (anthropic, xai, openai-compatible, gemini,
// vertex-ai, azure-openai, bedrock): extra HTTP
// headers (LLM_HEADERS) and extra request-body fields (LLM_REQUEST_OPTIONS). They pass straight to
// the provider's SDK, so anything its API accepts can be set without a ScribBot change: a gateway's
// auth header, OpenRouter's routing, temperature, reasoning effort, a larger max_tokens.

import { LLMError } from "./provider.js";

/** RFC 9110 token: what a header name may contain. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * LLM_HEADERS as a header map. Either a JSON object of strings (`{"X-Title":"ScribBot"}`) or
 * `Name: value` pairs separated by `;` or new lines (`HTTP-Referer: https://example.org; X-Title: ScribBot`).
 * Throws LLMError naming the problem.
 */
export function parseHeaders(raw: string | undefined): Record<string, string> {
  const text = raw?.trim();
  if (!text) return {};
  let entries: [string, unknown][];
  if (text.startsWith("{")) {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      // Not the parser's message: it quotes the text, and a header may hold a key.
      throw new LLMError("LLM_HEADERS starts with { but isn't valid JSON");
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new LLMError("LLM_HEADERS must be a JSON object");
    entries = Object.entries(obj);
  } else {
    entries = text
      .split(/[;\n]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part, i) => {
        const colon = part.indexOf(":");
        if (colon <= 0) throw new LLMError(`LLM_HEADERS: entry ${i + 1} isn't "Name: value"`);
        return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
      });
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name)) throw new LLMError(`LLM_HEADERS: "${name}" isn't a valid header name`);
    if (typeof value !== "string" && typeof value !== "number") throw new LLMError(`LLM_HEADERS: the value of ${name} must be text`);
    const v = String(value);
    if (/[\r\n\0]/.test(v)) throw new LLMError(`LLM_HEADERS: the value of ${name} can't contain line breaks`);
    headers[name] = v;
  }
  return headers;
}

/** The header carrying credentials, if `headers` has one (its name only). */
export function authHeader(headers: Record<string, string>): string | null {
  return Object.keys(headers).find((h) => ["authorization", "x-api-key", "api-key"].includes(h.toLowerCase())) ?? null;
}

/** LLM_REQUEST_OPTIONS as an object of extra request-body fields. Throws LLMError naming the problem. */
export function parseRequestOptions(raw: string | undefined): Record<string, unknown> {
  const text = raw?.trim();
  if (!text) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new LLMError(`LLM_REQUEST_OPTIONS isn't valid JSON: ${(err as Error).message.slice(0, 200)}`);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new LLMError("LLM_REQUEST_OPTIONS must be a JSON object");
  return obj as Record<string, unknown>;
}

/**
 * `options` without the fields ScribBot has to set itself (the model, the messages and the output
 * schema), so a typo in LLM_REQUEST_OPTIONS can't silently break every summary. Says which it dropped.
 */
export function withoutReserved(options: Record<string, unknown>, reserved: readonly string[], provider: string): Record<string, unknown> {
  const kept = { ...options };
  const dropped = reserved.filter((k) => k in kept);
  for (const k of dropped) delete kept[k];
  if (dropped.length) {
    console.warn(`[summarize] LLM_REQUEST_OPTIONS: ignoring ${dropped.join(", ")} (ScribBot sets ${dropped.length === 1 ? "it" : "them"} for ${provider})`);
  }
  return kept;
}
