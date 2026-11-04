import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { authHeader, parseHeaders, parseRequestOptions } from "../src/summarize/api-options.js";
import { AnthropicProvider } from "../src/summarize/anthropic.js";
import { OpenAICompatibleProvider } from "../src/summarize/openai-compatible.js";

describe("LLM_HEADERS", () => {
  it("reads Name: value pairs separated by ; or new lines", () => {
    expect(parseHeaders("HTTP-Referer: https://example.org/a:b; X-Title: ScribBot\napi-key: k1")).toEqual({
      "HTTP-Referer": "https://example.org/a:b",
      "X-Title": "ScribBot",
      "api-key": "k1",
    });
  });

  it("reads a JSON object", () => {
    expect(parseHeaders('{"Authorization": "Bearer t", "X-Num": 3}')).toEqual({ Authorization: "Bearer t", "X-Num": "3" });
  });

  it("is empty when blank", () => {
    expect(parseHeaders(undefined)).toEqual({});
    expect(parseHeaders("  ")).toEqual({});
  });

  it("rejects malformed input without quoting the values", () => {
    expect(() => parseHeaders("x-api-key sk-secret")).toThrow(/entry 1 isn't "Name: value"/);
    expect(() => parseHeaders("x-api-key sk-secret")).not.toThrow(/sk-secret/);
    expect(() => parseHeaders('{"x-api-key": sk-secret}')).toThrow(/isn't valid JSON/);
    expect(() => parseHeaders('{"x-api-key": sk-secret}')).not.toThrow(/sk-secret/);
    expect(() => parseHeaders("Bad Name: v")).toThrow(/isn't a valid header name/);
    expect(() => parseHeaders('{"A": {"b": 1}}')).toThrow(/must be text/);
    expect(() => parseHeaders("[1]")).toThrow();
  });

  it("finds the auth header by name", () => {
    expect(authHeader({ "X-Title": "a", "x-API-key": "k" })).toBe("x-API-key");
    expect(authHeader({ Authorization: "Bearer t" })).toBe("Authorization");
    expect(authHeader({ "X-Title": "a" })).toBeNull();
  });
});

describe("LLM_REQUEST_OPTIONS", () => {
  it("takes a JSON object", () => {
    expect(parseRequestOptions('{"temperature": 0.3, "provider": {"order": ["x"]}}')).toEqual({ temperature: 0.3, provider: { order: ["x"] } });
    expect(parseRequestOptions("")).toEqual({});
  });

  it("rejects anything else", () => {
    expect(() => parseRequestOptions("temperature=0.3")).toThrow(/isn't valid JSON/);
    expect(() => parseRequestOptions("[1]")).toThrow(/must be a JSON object/);
    expect(() => parseRequestOptions("null")).toThrow(/must be a JSON object/);
  });
});

// ---------------------------------------------------------------- what the SDKs actually send

const Answer = z.object({ ok: z.boolean() });
const seen: { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/messages")) {
        res.end(JSON.stringify({
          id: "msg_1", type: "message", role: "assistant", model: body.model,
          content: [{ type: "text", text: '{"ok": true}' }],
          stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        }));
      } else {
        res.end(JSON.stringify({
          id: "c1", object: "chat.completion", created: 0, model: body.model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"ok": true}', refusal: null } }],
        }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const req = { system: "s", prompt: "p", schema: Answer, schemaName: "answer", maxTokens: 100 };

describe("OpenAI-compatible with freeform settings", () => {
  it("sends the base URL, extra headers and extra body fields; ScribBot's own fields win", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = new OpenAICompatibleProvider({
      name: "openai-compatible", baseURL: `${base}/proxy/v1`, apiKey: "k", model: "m1",
      headers: { "X-Title": "ScribBot", "api-key": "azure-key" },
      requestOptions: { temperature: 0.3, max_completion_tokens: 5000, model: "ignored", provider: { order: ["a"] } },
    });
    expect(await p.generateJson(req)).toEqual({ ok: true });
    const last = seen.at(-1)!;
    expect(last.url).toBe("/proxy/v1/chat/completions");
    expect(last.headers["x-title"]).toBe("ScribBot");
    expect(last.headers["api-key"]).toBe("azure-key");
    expect(last.body).toMatchObject({ model: "m1", temperature: 0.3, max_completion_tokens: 5000, provider: { order: ["a"] } });
    expect(last.body).not.toHaveProperty("max_tokens");
    expect((last.body.response_format as { type: string }).type).toBe("json_schema");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ignoring model/));
  });

  it("lets a header replace the bearer token", async () => {
    const p = new OpenAICompatibleProvider({
      name: "xai", baseURL: base, apiKey: "not-needed", model: "m", headers: { Authorization: "Bearer gateway" },
    });
    await p.generateJson(req);
    expect(seen.at(-1)!.headers.authorization).toBe("Bearer gateway");
    expect(seen.at(-1)!.body.max_tokens).toBe(100);
  });
});

describe("Anthropic with freeform settings", () => {
  it("sends the base URL, extra headers and extra body fields", async () => {
    const p = new AnthropicProvider({
      model: "claude-x", apiKey: "k", baseURL: `${base}/gw`, headers: { "X-Gateway": "g" },
      requestOptions: { temperature: 0.2, max_tokens: 32000, output_config: { effort: "high" } },
    });
    expect(await p.generateJson({ ...req, effort: "low" })).toEqual({ ok: true });
    const last = seen.at(-1)!;
    expect(last.url).toMatch(/^\/gw\/v1\/messages/);
    expect(last.headers["x-gateway"]).toBe("g");
    expect(last.headers.authorization).toBe("Bearer k");
    expect(last.body).toMatchObject({ model: "claude-x", temperature: 0.2, max_tokens: 32000 });
    const out = last.body.output_config as { effort: string; format: { type: string } };
    expect(out.effort).toBe("high");
    expect(out.format.type).toBe("json_schema");
  });

  it("works with only an auth header, no key or profile", async () => {
    const p = new AnthropicProvider({ model: "claude-x", baseURL: base, headers: { Authorization: "Bearer gw-token" } });
    await p.generateJson(req);
    expect(seen.at(-1)!.headers.authorization).toBe("Bearer gw-token");
  });
});
