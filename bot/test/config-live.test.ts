import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SUMMARY_KEYS, summaryReader, type SummaryConfig } from "../src/config.js";
import { SETTINGS } from "../src/settings-catalog.js";

const dir = mkdtempSync(path.join(tmpdir(), "scribbot-live-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const initial: SummaryConfig = {
  // Every other key is unset (undefined).
  llm: { provider: "anthropic", chunkMinutes: 25 } as SummaryConfig["llm"],
  autoSummarize: false,
  reviewBeforeFoundry: true,
};

let n = 0;
/** Writes .env and moves its mtime on, so a rewrite within the same millisecond still counts as a change. */
function writeEnv(file: string, text: string) {
  writeFileSync(file, text);
  const t = new Date(Date.now() + ++n * 1000);
  utimesSync(file, t, t);
}

function setup(text: string, realEnv: string[] = []) {
  const file = path.join(dir, `env-${++n}`);
  writeFileSync(file, text);
  return { file, read: summaryReader(file, new Set(realEnv), initial) };
}

describe("live summary settings", () => {
  it("picks up a new provider, model and CLI path when .env changes, without a restart", () => {
    const { file, read } = setup("LLM_PROVIDER=anthropic\n");
    expect(read()).toBe(initial); // unchanged file: nothing re-read
    vi.spyOn(console, "log").mockImplementation(() => {});
    writeEnv(file, "LLM_PROVIDER=grok-cli\nLLM_MODEL=grok-4.7\nLLM_CLI_PATH=C:/tools/grok.exe\nAUTO_SUMMARIZE=true\nSUMMARY_CHUNK_MINUTES=10\n");
    const now = read();
    expect(now.llm).toMatchObject({ provider: "grok-cli", model: "grok-4.7", cliPath: "C:/tools/grok.exe", chunkMinutes: 10 });
    expect(now.autoSummarize).toBe(true);
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/\[config\] summaries now use grok-cli \/ grok-4.7/));
    expect(read()).toBe(now); // cached until the file changes again
  });

  it("lets a variable from the real environment win over .env, as at startup", () => {
    process.env.LLM_MODEL = "from-the-environment";
    try {
      const { file, read } = setup("", ["LLM_MODEL"]);
      writeEnv(file, "LLM_PROVIDER=codex\nLLM_MODEL=from-env-file\n");
      expect(read().llm).toMatchObject({ provider: "codex", model: "from-the-environment" });
    } finally {
      delete process.env.LLM_MODEL;
    }
  });

  it("keeps the settings in use when .env has an invalid one, and says which", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { file, read } = setup("");
    writeEnv(file, "LLM_PROVIDER=not-a-provider\n");
    expect(read()).toBe(initial);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid summary settings \(LLM_PROVIDER\)/));
    read();
    expect(warn).toHaveBeenCalledTimes(1); // once per change, not on every read
  });

  it("keeps the settings in use when .env disappears", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { file, read } = setup("LLM_PROVIDER=codex\n");
    rmSync(file);
    expect(read()).toBe(initial);
  });

  it("is exactly the settings the catalog marks live", () => {
    expect(SETTINGS.filter((s) => s.live).map((s) => s.key).sort()).toEqual([...SUMMARY_KEYS].sort());
  });
});
