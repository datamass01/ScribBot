import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listModels, parseModelList } from "../src/summarize/models.js";

// Output as the real CLIs print it (codex-cli 0.166, agy 1.4.2, grok 1.0.70), trimmed.
const CODEX = JSON.stringify({
  models: [
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "Frontier intelligence.", visibility: "list", priority: 2 },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 43 },
    { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", description: "Latest workhorse model.", visibility: "list", priority: 1 },
  ],
});
const AGY = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\r\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n";
const GROK = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n";

describe("model lists from the CLIs", () => {
  it("reads Codex's catalog: listed models only, in its order", () => {
    expect(parseModelList("codex", CODEX)).toEqual([
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", note: "Latest workhorse model." },
      { id: "gpt-6-astra", label: "GPT-6-Astra", note: "Frontier intelligence." },
    ]);
  });

  it("reads agy's tab-separated list", () => {
    expect(parseModelList("antigravity", AGY)).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
    ]);
  });

  it("reads grok's list and its default", () => {
    expect(parseModelList("grok-cli", GROK)).toEqual([
      { id: "grok-4.7", isDefault: true },
      { id: "grok-4.7-build-fast", isDefault: false },
      { id: "grok-4.6", isDefault: false },
    ]);
  });
});

describe("listModels", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "scribbot-models-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("runs the CLI (a .js file here, started with node) and parses what it prints", async () => {
    const fake = path.join(dir, "grok.mjs");
    writeFileSync(fake, `process.stdout.write(${JSON.stringify(GROK)});`);
    const list = await listModels("grok-cli", { cliPath: fake });
    expect(list).toMatchObject({ provider: "grok-cli", source: "cli", command: `${fake} models` });
    expect(list.models.map((m) => m.id)).toEqual(["grok-4.7", "grok-4.7-build-fast", "grok-4.6"]);
    expect(list.error).toBeUndefined();
  });

  it("says why when the CLI fails, and still gives the notes", async () => {
    const fake = path.join(dir, "agy.mjs");
    writeFileSync(fake, `console.error("not signed in"); process.exit(2);`);
    const list = await listModels("antigravity", { cliPath: fake });
    expect(list.error).toMatch(/exited with code 2: not signed in/);
    expect(list.notes.length).toBeGreaterThan(0);
  });

  it("says when the CLI isn't installed", async () => {
    const list = await listModels("codex", { cliPath: path.join(dir, "missing.exe") });
    expect(list.error).toMatch(/not found/);
  });

  it("has fixed lists for Claude Code and the API providers", async () => {
    expect((await listModels("claude-code")).models.map((m) => m.id)).toContain("fable");
    expect((await listModels("anthropic")).models.find((m) => m.isDefault)?.id).toBe("claude-opus-5-5");
    await expect(listModels("nope")).rejects.toThrow(/unknown provider/);
  });
});
