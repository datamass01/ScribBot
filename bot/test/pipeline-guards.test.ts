// processBlocker() is the one statement of when the pipeline refuses a session; processSession
// enforces it and the commands (Discord and the Console) check it first.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-guards-"));

let pipeline: typeof import("../src/pipeline.js");
let Store: typeof import("../src/db.js").Store;

beforeAll(async () => {
  pipeline = await import("../src/pipeline.js");
  ({ Store } = await import("../src/db.js"));
});

function storeWith(id = "s1") {
  const store = new Store(":memory:");
  store.createSession({ id, guildId: "g", channelId: "c", textChannelId: null, startedAt: "2026-01-01T00:00:00.000Z" });
  store.setSessionStatus(id, "complete");
  return store;
}

describe("processBlocker", () => {
  it("allows a finished session", () => {
    const store = storeWith();
    expect(pipeline.processBlocker(store.getSession("s1"))).toBeNull();
  });

  it("refuses an unknown, trashed or audio-less re-transcription", () => {
    const store = storeWith();
    expect(pipeline.processBlocker(undefined)).toBe("No such session.");
    store.markAudioPurged("s1");
    expect(pipeline.processBlocker(store.getSession("s1"))).toBeNull();
    expect(pipeline.processBlocker(store.getSession("s1"), { retranscribe: true })).toMatch(/audio was already deleted/);
    store.markDeleted("s1", true);
    expect(pipeline.processBlocker(store.getSession("s1"))).toMatch(/in the trash/);
  });

  it("is enforced by processSession, which fails cleanly for an unknown id", async () => {
    const store = storeWith();
    await expect(pipeline.processSession(store, "nope")).rejects.toThrow("No such session.");
    store.markDeleted("s1", true);
    await expect(pipeline.processSession(store, "s1")).rejects.toThrow(/in the trash/);
    // Refused before it starts: nothing was marked as running or failed.
    expect(pipeline.isProcessing("s1")).toBe(false);
    expect(store.getSession("s1")?.status).toBe("complete");
  });
});
