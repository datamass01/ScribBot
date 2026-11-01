// With AUTO_SUMMARIZE off (the default), sessions end at a saved transcript, so missing
// credentials aren't a warning. An empty LLM_MODEL still is (docs/assessment/02 S14): it can only
// be a mistake. Separate file because config is read once per test file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-status-"));
process.env.API_TOKEN = "secret-token";
process.env.WORKER_URL = "http://127.0.0.1:9";
process.env.AUTO_SUMMARIZE = "";
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_MODEL = "";
process.env.OPENAI_BASE_URL = "";

describe("status with automatic summaries off", () => {
  it("reports manual mode, warns about the empty model but not the missing credentials", async () => {
    const { Store } = await import("../src/db.js");
    const { buildStatus } = await import("../src/api/status.js");
    const status = await buildStatus(new Store(":memory:"), {}, { sockets: 0, lastRosterAt: null, lastRosterWorld: null, lastChatlogAt: null });
    expect(status.llm).toMatchObject({ autoSummarize: false, credentials: null, model: null });
    expect(status.warnings.some((w) => /credentials/.test(w))).toBe(false);
    expect(status.warnings.filter((w) => /LLM_MODEL is empty/.test(w))).toHaveLength(1);
    const { llmConfigProblem } = await import("../src/api/status.js");
    expect(await llmConfigProblem()).toMatch(/LLM_MODEL is empty/);
  });
});
