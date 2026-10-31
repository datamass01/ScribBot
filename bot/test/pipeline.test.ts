import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { JsonRequest, LLMProvider } from "../src/summarize/provider.js";
import type { ChunkNotes, Summary } from "../src/summarize/schema.js";

// Point DATA_DIR at a temp folder before the config module is first imported.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-data-"));
process.env.DATA_DIR = dataDir;
process.env.CAMPAIGN_DIR = path.join(dataDir, "campaign");
process.env.SUMMARY_CHUNK_MINUTES = "1";

const notes: ChunkNotes = {
  scenes: [{ startT: "00:00:05", title: "The Bridge", location: "Old Bridge", summary: "A goblin blocks the bridge." }],
  events: [],
  combats: [],
  quotes: [],
  npcs: [{ name: "Grubnak", description: "Goblin chief" }],
  loot: [],
  openThreads: [],
};

const summary: Summary = {
  title: "Blood on the Bridge",
  recap: "Thorin threatened Grubnak.",
  scenes: [{ title: "The Bridge", location: "Old Bridge", summary: "A goblin blocks the bridge." }],
  combats: [],
  quotes: [
    { t: "00:00:12", character: "Thorin", text: "Stand aside, little one, or taste my axe!", context: "At the bridge" },
    { t: "00:00:20", character: "Thorin", text: "I am the rightful king under the mountain!", context: "invented" },
  ],
  characterHighlights: [{ character: "Thorin", highlights: ["Threatened a goblin"] }],
  npcs: [{ name: "Grubnak", description: "Goblin chief" }],
  loot: [],
  hooks: ["Who does Grubnak serve?"],
};

class FakeProvider implements LLMProvider {
  readonly name = "fake";
  readonly model = "fake-1";
  requests: JsonRequest<z.ZodType>[] = [];
  async generateJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<z.infer<S>> {
    this.requests.push(req);
    return (req.schemaName === "chunk_notes" ? notes : summary) as z.infer<S>;
  }
}

describe("summarizeSession", () => {
  let mod: typeof import("../src/summarize/summarize.js");
  let Store: typeof import("../src/db.js").Store;
  let sessionPaths: typeof import("../src/paths.js").sessionPaths;

  beforeAll(async () => {
    mod = await import("../src/summarize/summarize.js");
    ({ Store } = await import("../src/db.js"));
    ({ sessionPaths } = await import("../src/paths.js"));
    fs.mkdirSync(path.join(dataDir, "campaign"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "campaign", "glossary.md"), "- Grubnak: goblin chief of the Old Bridge\n");
  });

  it("chunks, merges, verifies quotes and writes summary files", async () => {
    const store = new Store(":memory:");
    const startedAt = "2026-01-01T18:00:00.000Z";
    const s = store.createSession({ id: "sess", guildId: "g", channelId: "c", textChannelId: null, startedAt });
    const p = sessionPaths(s.id);
    fs.mkdirSync(p.dir, { recursive: true });
    const participants = [
      { discordId: "1", displayName: "Alice", character: "Thorin", actorId: null, isGm: false },
      { discordId: "2", displayName: "Bob", character: null, actorId: null, isGm: true },
    ];
    fs.writeFileSync(
      p.timeline,
      JSON.stringify({ sessionId: s.id, guildId: "g", channelId: "c", startedAt, endedAt: null, sampleRate: 48000, channels: 1, participants, segments: [] }),
    );
    const line = (t: number, id: string, text: string) => {
      const who = participants.find((x) => x.discordId === id)!;
      return { t, end: t + 2, discordId: id, speaker: who.displayName, character: who.character, isGm: who.isGm, text };
    };
    fs.writeFileSync(
      p.transcriptJson,
      JSON.stringify({
        sessionId: s.id, model: "large-v3", language: "en", createdAt: startedAt,
        lines: [
          line(5, "2", "A goblin steps onto the bridge."),
          line(12, "1", "Stand aside, little one, or taste my axe!"),
          line(95, "2", "Roll initiative."),
        ],
      }),
    );
    fs.writeFileSync(
      p.chatlog,
      JSON.stringify({
        messages: [{ id: "m", timestamp: Date.parse(startedAt) + 100_000, alias: "Thorin", isRoll: true, flavor: "Initiative", rolls: [{ formula: "1d20+2", total: 15 }] }],
        combats: [],
      }),
    );

    const provider = new FakeProvider();
    const file = await mod.summarizeSession(store, s.id, { provider, log: () => {} });

    // Two chunks at 1 minute each, then one merge.
    expect(provider.requests.map((r) => r.schemaName)).toEqual(["chunk_notes", "chunk_notes", "session_summary"]);
    const first = provider.requests[0]!.prompt;
    expect(first).toContain("[00:00:12] Thorin (Alice): Stand aside");
    expect(first).toContain("- Alice: plays Thorin");
    expect(first).toContain("Grubnak: goblin chief");
    expect(provider.requests[1]!.prompt).toContain("[FOUNDRY ROLL] Thorin: Initiative (1d20+2 = 15)");

    expect(file.summary.quotes.map((q) => q.text)).toEqual(["Stand aside, little one, or taste my axe!"]);
    expect(file.droppedQuotes).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(p.summary, "utf8")).summary.title).toBe("Blood on the Bridge");
    expect(fs.readFileSync(p.summaryMd, "utf8")).toContain("# Session 1: Blood on the Bridge");
  });
});
