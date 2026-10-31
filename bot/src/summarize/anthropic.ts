import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { config } from "../config.js";
import { LLMError, type JsonRequest, type LLMProvider } from "./provider.js";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;

  constructor(model?: string) {
    this.model = model ?? "claude-opus-5-5";
    // With no key set, the SDK falls back to other credential sources (e.g. `ant auth login`).
    this.client = new Anthropic(config.llm.anthropicApiKey ? { apiKey: config.llm.anthropicApiKey } : {});
  }

  async generateJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<z.infer<S>> {
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens ?? 16000,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        output_config: { effort: req.effort ?? "medium", format: betaZodOutputFormat(req.schema) },
        // If a safety classifier declines (unlikely, but RPG violence can trip one),
        // let the API retry on its recommended fallback model instead of failing.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
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
      throw new LLMError(`Output hit max_tokens (${req.maxTokens ?? 16000}) for ${req.schemaName}`);
    }
    if (response.parsed_output == null) {
      throw new LLMError(`Model returned no parseable ${req.schemaName}`);
    }
    return response.parsed_output as z.infer<S>;
  }
}
