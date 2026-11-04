import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { withoutReserved } from "./api-options.js";
import { API_DEFAULT_MODELS } from "./defaults.js";
import { LLMError, type JsonRequest, type LLMProvider } from "./provider.js";

export interface AnthropicOptions {
  model?: string;
  /** Blank: the SDK's own sources (ANTHROPIC_API_KEY in the environment, an `ant auth login` profile). */
  apiKey?: string;
  /** Blank: ANTHROPIC_BASE_URL from the environment, else https://api.anthropic.com. */
  baseURL?: string;
  headers?: Record<string, string>;
  /** Extra Messages API body fields (LLM_REQUEST_OPTIONS); they override ScribBot's defaults. */
  requestOptions?: Record<string, unknown>;
}

/** Body fields ScribBot must set itself. */
const RESERVED = ["model", "system", "messages", "stream"] as const;

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;
  private extra: Record<string, unknown>;

  constructor(opts: AnthropicOptions = {}) {
    this.model = opts.model ?? API_DEFAULT_MODELS.anthropic;
    // With no key set, the SDK falls back to other credential sources (e.g. `ant auth login`).
    this.client = new Anthropic({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.headers && Object.keys(opts.headers).length ? { defaultHeaders: opts.headers } : {}),
      // Explicit, so a large max_tokens in LLM_REQUEST_OPTIONS isn't refused for "may take longer
      // than 10 minutes"; the same limit as a CLI summary pass.
      timeout: 20 * 60_000,
    });
    this.extra = withoutReserved(opts.requestOptions ?? {}, RESERVED, "anthropic");
  }

  async generateJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<z.infer<S>> {
    const { output_config: extraOutput, ...extra } = this.extra;
    const params = {
      max_tokens: req.maxTokens ?? 16000,
      // If a safety classifier declines (unlikely, but RPG violence can trip one),
      // let the API retry on its recommended fallback model instead of failing.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      ...extra,
      model: this.model,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      output_config: {
        effort: req.effort ?? "medium",
        ...(extraOutput && typeof extraOutput === "object" ? extraOutput : {}),
        format: betaZodOutputFormat(req.schema),
      },
    };
    let response;
    try {
      // The extra fields are the user's to get right; the API rejects ones it doesn't know.
      response = await this.client.beta.messages.parse(params as Parameters<typeof this.client.beta.messages.parse>[0]);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new LLMError("Anthropic rejected the API key: check ANTHROPIC_API_KEY");
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new LLMError("Anthropic rate limit hit after retries; try /scrib summarize again shortly");
      }
      throw err;
    }

    if (response.stop_reason === "refusal") {
      throw new LLMError(`Model declined the request (${response.stop_details?.category ?? "no category"})`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new LLMError(`Output hit max_tokens (${String(params.max_tokens)}) for ${req.schemaName}`);
    }
    if (response.parsed_output == null) {
      throw new LLMError(`Model returned no parseable ${req.schemaName}`);
    }
    return response.parsed_output as z.infer<S>;
  }
}
