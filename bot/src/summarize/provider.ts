import type { z } from "zod";
import { config } from "../config.js";

export interface JsonRequest<S extends z.ZodType> {
  system: string;
  prompt: string;
  schema: S;
  /** Short identifier, used as the schema name for providers that need one. */
  schemaName: string;
  /** Hint for how hard the model should think; providers map it as best they can. */
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generateJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<z.infer<S>>;
}

export class LLMError extends Error {}

export async function createProvider(): Promise<LLMProvider> {
  const { provider, model } = config.llm;
  switch (provider) {
    case "anthropic": {
      const { AnthropicProvider } = await import("./anthropic.js");
      return new AnthropicProvider(model);
    }
    case "xai": {
      const { OpenAICompatibleProvider } = await import("./openai-compatible.js");
      if (!config.llm.xaiApiKey) throw new LLMError("XAI_API_KEY is not set");
      return new OpenAICompatibleProvider({
        name: "xai",
        baseURL: "https://api.x.ai/v1",
        apiKey: config.llm.xaiApiKey,
        model: model ?? "grok-4",
      });
    }
    case "openai-compatible": {
      const { OpenAICompatibleProvider } = await import("./openai-compatible.js");
      if (!model) throw new LLMError("LLM_MODEL must be set for the openai-compatible provider");
      return new OpenAICompatibleProvider({
        name: "openai-compatible",
        baseURL: config.llm.openaiBaseUrl,
        apiKey: config.llm.openaiApiKey || "not-needed",
        model,
      });
    }
  }
}
