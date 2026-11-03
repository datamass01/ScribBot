// createProvider() for Azure OpenAI as the bot runs it: .env is loaded into process.env, so
// OPENAI_BASE_URL (openai-compatible's setting, filled in by .env.example) is there too, and the
// openai SDK's AzureOpenAI would refuse an endpoint next to it. Separate file because config is
// read once per test file.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "c", object: "chat.completion", created: 0, model: "gpt",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"ok": true}' } }],
    }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
afterAll(() => new Promise<void>((r) => server.close(() => r())));

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-azure-"));
process.env.API_TOKEN = "secret-token";
process.env.LLM_PROVIDER = "azure-openai";
process.env.LLM_MODEL = "my-deploy";
process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
process.env.AZURE_OPENAI_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
process.env.AZURE_OPENAI_API_KEY = "az-key";
process.env.OPENAI_API_VERSION = "";
process.env.LLM_HEADERS = "";
process.env.LLM_REQUEST_OPTIONS = "";

describe("Azure OpenAI from the settings", () => {
  it("reaches the deployment despite OPENAI_BASE_URL being set", async () => {
    const { createProvider } = await import("../src/summarize/provider.js");
    const p = await createProvider();
    expect(p.name).toBe("azure-openai");
    expect(await p.generateJson({ system: "s", prompt: "p", schema: z.object({ ok: z.boolean() }), schemaName: "a" })).toEqual({ ok: true });
    expect(seen[0]!.url).toBe("/openai/deployments/my-deploy/chat/completions?api-version=2024-10-21");
    expect(seen[0]!.headers["api-key"]).toBe("az-key");
  });

  it("reports the source, never the key", async () => {
    const { llmConfigProblem } = await import("../src/api/status.js");
    expect(await llmConfigProblem()).toBeNull();
  });
});
