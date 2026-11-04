import { describe, expect, it } from "vitest";
import { API_DEFAULT_MODELS } from "../src/summarize/defaults.js";
import { llmProblem, type LlmStatus } from "../src/summarize/readiness.js";

const ok: LlmStatus = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  credentials: "api key",
  credentialsError: null,
  optionsError: null,
  chunkMinutes: 0,
  autoSummarize: true,
};

describe("llmProblem", () => {
  it("is null when a summary could run", () => {
    expect(llmProblem(ok)).toBeNull();
  });

  it("names the empty model first, then broken API options, then missing credentials", () => {
    expect(llmProblem({ ...ok, provider: "bedrock", model: null, credentials: null })).toMatch(/LLM_MODEL is empty, and the bedrock provider/);
    expect(llmProblem({ ...ok, optionsError: "LLM_HEADERS is not valid JSON", credentials: null })).toBe(
      "Summaries will fail: LLM_HEADERS is not valid JSON.",
    );
    const missing = llmProblem({ ...ok, credentials: null, credentialsError: "profile x not found" });
    expect(missing).toMatch(/no credentials for LLM provider 'anthropic' \(profile x not found\)/);
    expect(missing).toMatch(/ant auth login/);
  });
});

describe("API_DEFAULT_MODELS", () => {
  it("is what a provider uses when LLM_MODEL is blank", async () => {
    const { AnthropicProvider } = await import("../src/summarize/anthropic.js");
    const { GeminiProvider } = await import("../src/summarize/gemini.js");
    expect(new AnthropicProvider({ apiKey: "k" }).model).toBe(API_DEFAULT_MODELS.anthropic);
    expect(new GeminiProvider({ vertex: false, apiKey: "k" }).model).toBe(API_DEFAULT_MODELS.gemini);
    expect(new GeminiProvider({ vertex: true, project: "p", location: "us-central1" }).model).toBe(API_DEFAULT_MODELS["vertex-ai"]);
  });
});
