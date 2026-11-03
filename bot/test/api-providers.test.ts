import http from "node:http";
import type { AddressInfo } from "node:net";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { AzureOpenAI } from "openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BedrockProvider } from "../src/summarize/bedrock.js";
import { GeminiProvider } from "../src/summarize/gemini.js";
import { listModels } from "../src/summarize/models.js";
import { OpenAICompatibleProvider } from "../src/summarize/openai-compatible.js";

// Each provider against a local server that records what its SDK sent and answers like the real API.

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };
const seen: Seen[] = [];
let reply: (s: Seen) => { status?: number; headers?: Record<string, string>; body: unknown } = () => ({ body: {} });
let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const s = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} };
      seen.push(s);
      const r = reply(s);
      res.writeHead(r.status ?? 200, { "content-type": "application/json", ...r.headers });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen.length = 0;
});

const Answer = z.object({ ok: z.boolean(), n: z.number() });
const req = { system: "sys", prompt: "hello", schema: Answer, schemaName: "answer", maxTokens: 100 };

describe("Google Gemini", () => {
  const geminiReply = () => ({
    body: { candidates: [{ content: { role: "model", parts: [{ text: '{"ok": true, "n": 3}' }] }, finishReason: "STOP" }] },
  });

  it("calls generateContent with the JSON schema, the key, extra headers and config fields", async () => {
    reply = geminiReply;
    const p = new GeminiProvider({
      vertex: false, model: "gemini-x", apiKey: "g-key", baseURL: base, headers: { "X-Gw": "1" },
      requestOptions: { temperature: 0.4, thinkingConfig: { thinkingLevel: "high" }, responseMimeType: "text/plain" },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await p.generateJson(req)).toEqual({ ok: true, n: 3 });
    const s = seen[0]!;
    expect(s.url).toMatch(/\/models\/gemini-x:generateContent$/);
    expect(s.headers["x-goog-api-key"]).toBe("g-key");
    expect(s.headers["x-gw"]).toBe("1");
    const cfg = s.body.generationConfig as Record<string, unknown>;
    expect(cfg).toMatchObject({ temperature: 0.4, maxOutputTokens: 100, responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "high" } });
    expect((cfg.responseJsonSchema as { properties: object }).properties).toHaveProperty("n");
    expect(cfg.responseJsonSchema).not.toHaveProperty("$schema");
    expect(JSON.stringify(s.body.systemInstruction)).toContain("sys");
  });

  it("uses Vertex AI in express mode with a key", async () => {
    reply = geminiReply;
    const p = new GeminiProvider({ vertex: true, model: "gemini-x", apiKey: "v-key", baseURL: base });
    expect(await p.generateJson(req)).toEqual({ ok: true, n: 3 });
    expect(seen[0]!.url).toMatch(/publishers\/google\/models\/gemini-x:generateContent/);
  });

  it("says when the output was cut off or blocked", async () => {
    const p = new GeminiProvider({ vertex: false, model: "m", apiKey: "k", baseURL: base });
    reply = () => ({ body: { candidates: [{ content: { parts: [{ text: '{"ok":' }] }, finishReason: "MAX_TOKENS" }] } });
    await expect(p.generateJson(req)).rejects.toThrow(/maxOutputTokens/);
    reply = () => ({ body: { promptFeedback: { blockReason: "SAFETY" } } });
    await expect(p.generateJson(req)).rejects.toThrow(/blocked the prompt \(SAFETY\)/);
  });
});

describe("Azure OpenAI", () => {
  it("calls the deployment with the api-version and the api-key header", async () => {
    reply = () => ({
      body: { id: "c", object: "chat.completion", created: 0, model: "gpt", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"ok": false, "n": 1}' } }] },
    });
    // As createProvider() builds it; OPENAI_BASE_URL set for openai-compatible must not get in the way.
    process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
    const client = new AzureOpenAI({ baseURL: `${base}/openai`, apiKey: "az-key", apiVersion: "2024-10-21", deployment: "my-deploy" });
    delete process.env.OPENAI_BASE_URL;
    const p = new OpenAICompatibleProvider({ name: "azure-openai", apiKey: "", model: "my-deploy", client, requestOptions: { temperature: 0 } });
    expect(await p.generateJson(req)).toEqual({ ok: false, n: 1 });
    const s = seen[0]!;
    expect(s.url).toBe("/openai/deployments/my-deploy/chat/completions?api-version=2024-10-21");
    expect(s.headers["api-key"]).toBe("az-key");
    expect(s.body).toMatchObject({ temperature: 0, response_format: { type: "json_schema" } });
  });
});

describe("Amazon Bedrock", () => {
  const bedrock = (extra: Partial<ConstructorParameters<typeof BedrockProvider>[0]> = {}) =>
    new BedrockProvider({
      model: "us.anthropic.claude-x", region: "us-east-1", endpoint: base, bearerToken: "br-key",
      requestHandler: new NodeHttpHandler(), ...extra,
    });
  const converseReply = (content: unknown[], stopReason = "end_turn") => ({
    body: { output: { message: { role: "assistant", content } }, stopReason, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 } },
  });

  it("calls Converse with native structured output, the API key, headers and request fields", async () => {
    reply = () => converseReply([{ text: '{"ok": true, "n": 7}' }]);
    const p = bedrock({
      headers: { "X-Gw": "2" },
      requestOptions: { inferenceConfig: { temperature: 0.1 }, additionalModelRequestFields: { top_k: 5 }, modelId: "nope" },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await p.generateJson(req)).toEqual({ ok: true, n: 7 });
    const s = seen[0]!;
    expect(decodeURIComponent(s.url)).toBe("/model/us.anthropic.claude-x/converse");
    expect(s.headers.authorization).toBe("Bearer br-key");
    expect(s.headers["x-gw"]).toBe("2");
    expect(s.body).toMatchObject({
      system: [{ text: "sys" }],
      inferenceConfig: { maxTokens: 100, temperature: 0.1 },
      additionalModelRequestFields: { top_k: 5 },
      outputConfig: { textFormat: { type: "json_schema" } },
    });
    const schema = JSON.parse(((s.body.outputConfig as any).textFormat.structure.jsonSchema.schema) as string);
    expect(schema.properties).toHaveProperty("ok");
  });

  it("falls back to a forced tool call for models without structured output, and remembers", async () => {
    reply = (s) =>
      s.body.outputConfig
        ? { status: 400, headers: { "x-amzn-errortype": "ValidationException" }, body: { message: "This model doesn't support outputConfig.textFormat" } }
        : converseReply([{ toolUse: { toolUseId: "t1", name: "answer", input: { ok: true, n: 9 } } }], "tool_use");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = bedrock();
    expect(await p.generateJson(req)).toEqual({ ok: true, n: 9 });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body).toMatchObject({ toolConfig: { toolChoice: { tool: { name: "answer" } } } });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/forced tool call/));
    await p.generateJson(req);
    expect(seen).toHaveLength(3); // straight to the tool the second time
  });

  it("says when the output was cut off", async () => {
    reply = () => converseReply([{ text: '{"ok":' }], "max_tokens");
    await expect(bedrock().generateJson(req)).rejects.toThrow(/maxTokens/);
  });
});

describe("model help for the new providers", () => {
  it("has notes for each, and a default only where the API has one", async () => {
    expect((await listModels("gemini")).models.find((m) => m.isDefault)?.id).toBe("gemini-3.8-flash");
    expect((await listModels("vertex-ai")).models.find((m) => m.isDefault)?.id).toBe("gemini-3.8-flash");
    expect((await listModels("azure-openai")).notes.join(" ")).toMatch(/deployment name/);
    expect((await listModels("bedrock")).notes.join(" ")).toMatch(/inference profile/);
  });
});
