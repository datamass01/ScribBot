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
  // Freeform API settings: parsed here so a mistake fails the summary (and Test summaries) with a
  // clear message instead of stopping the bot. The CLI providers don't use them.
  const api = async () => {
    const { parseHeaders, parseRequestOptions } = await import("./api-options.js");
    return { headers: parseHeaders(config.llm.headers), requestOptions: parseRequestOptions(config.llm.requestOptions) };
  };
  switch (provider) {
    case "anthropic": {
      const { AnthropicProvider } = await import("./anthropic.js");
      return new AnthropicProvider({ model, apiKey: config.llm.anthropicApiKey, baseURL: config.llm.anthropicBaseUrl, ...(await api()) });
    }
    case "xai": {
      const { OpenAICompatibleProvider } = await import("./openai-compatible.js");
      const extra = await api();
      const { authHeader } = await import("./api-options.js");
      if (!config.llm.xaiApiKey && !authHeader(extra.headers)) throw new LLMError("XAI_API_KEY is not set");
      return new OpenAICompatibleProvider({
        name: "xai",
        baseURL: config.llm.xaiBaseUrl || "https://api.x.ai/v1",
        apiKey: config.llm.xaiApiKey || "not-needed",
        model: model ?? "grok-4",
        ...extra,
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
        ...(await api()),
      });
    }
    case "gemini":
    case "vertex-ai": {
      const { GeminiProvider } = await import("./gemini.js");
      const extra = await api();
      const { authHeader } = await import("./api-options.js");
      const vertex = provider === "vertex-ai";
      if (!vertex && !config.llm.geminiApiKey && !authHeader(extra.headers)) throw new LLMError("GEMINI_API_KEY is not set");
      if (vertex && !config.llm.googleCloudProject && !config.llm.geminiApiKey) throw new LLMError("GOOGLE_CLOUD_PROJECT is not set");
      return new GeminiProvider({
        vertex,
        model,
        // Vertex AI takes a key only in express mode; with a project set, its credentials are used.
        apiKey: vertex ? (config.llm.googleCloudProject ? undefined : config.llm.geminiApiKey) : config.llm.geminiApiKey,
        project: config.llm.googleCloudProject,
        location: config.llm.googleCloudLocation,
        keyFile: config.llm.googleCredentials,
        baseURL: vertex ? config.llm.vertexBaseUrl : config.llm.geminiBaseUrl,
        ...extra,
      });
    }
    case "azure-openai": {
      const { AzureOpenAI } = await import("openai");
      const { OpenAICompatibleProvider } = await import("./openai-compatible.js");
      const extra = await api();
      if (!config.llm.azureEndpoint) throw new LLMError("AZURE_OPENAI_ENDPOINT is not set");
      if (!model) throw new LLMError("LLM_MODEL must be set to the Azure OpenAI deployment name");
      // An Authorization header (a Microsoft Entra ID token) stands in for the key.
      const bearer = Object.entries(extra.headers).find(([h]) => h.toLowerCase() === "authorization")?.[1];
      const headers = Object.fromEntries(Object.entries(extra.headers).filter(([h]) => h.toLowerCase() !== "authorization"));
      if (!config.llm.azureApiKey && !bearer && !Object.keys(headers).some((h) => h.toLowerCase() === "api-key")) {
        throw new LLMError("AZURE_OPENAI_API_KEY is not set");
      }
      const client = new AzureOpenAI({
        // As the SDK builds it from `endpoint`, but passed as baseURL: given only an endpoint, the SDK
        // would also read OPENAI_BASE_URL (openai-compatible's setting) and refuse the pair.
        baseURL: `${config.llm.azureEndpoint.replace(/\/+$/, "")}/openai`,
        apiVersion: config.llm.azureApiVersion || "2024-10-21",
        deployment: model,
        ...(config.llm.azureApiKey
          ? { apiKey: config.llm.azureApiKey }
          : bearer
            ? { azureADTokenProvider: async () => bearer.replace(/^Bearer\s+/i, "") }
            : { apiKey: "from-headers" }),
        ...(Object.keys(headers).length ? { defaultHeaders: headers } : {}),
      });
      return new OpenAICompatibleProvider({ name: "azure-openai", apiKey: "", model, client, requestOptions: extra.requestOptions });
    }
    case "bedrock": {
      const { BedrockProvider } = await import("./bedrock.js");
      if (!model) throw new LLMError("LLM_MODEL must be set to a Bedrock model id or inference profile");
      return new BedrockProvider({
        model,
        region: config.llm.awsRegion,
        profile: config.llm.awsProfile,
        bearerToken: config.llm.awsBedrockToken,
        endpoint: config.llm.bedrockEndpoint,
        ...(await api()),
      });
    }
    case "codex":
    case "antigravity":
    case "claude-code":
    case "grok-cli": {
      const { CliAgentProvider } = await import("./cli-agent.js");
      return new CliAgentProvider(provider, { model, command: config.llm.cliPath });
    }
  }
}
