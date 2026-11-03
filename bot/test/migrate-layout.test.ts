import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Transcript } from "../src/types.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-layout-"));
process.env.DATA_DIR = dataDir;
process.env.CAMPAIGN_DIR = path.join(dataDir, "campaign");

const readJson = <T>(file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const write = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};
const timeline = (id: string, startedAt: string, endedAt: string | null) => ({
  sessionId: id, guildId: "g", channelId: "c", startedAt, endedAt, sampleRate: 16000, channels: 1,
  participants: [{ discordId: "1", displayName: "Alice", character: "Thorin", actorId: null, isGm: false }],
  segments: [{ discordId: "1", startMs: 1000, endMs: 3000, file: "audio/1/000001000.wav" }],
});
const line = (t: number, text: string) => ({ t, end: t + 2, discordId: "1", speaker: "Alice", character: "Thorin", isGm: false, text });
const transcript = (id: string, lines: ReturnType<typeof line>[]): Transcript => ({ sessionId: id, model: "whisper", language: "en", createdAt: "2026-11-01T00:00:00Z", lines });

let store: import("../src/db.js").Store;
let plan: typeof import("../src/migrate-layout.js").planLayout;
let apply: typeof import("../src/migrate-layout.js").applyLayout;
let sessionPaths: typeof import("../src/paths.js").sessionPaths;
const legacy = (id: string) => path.join(dataDir, "sessions", id);

beforeAll(async () => {
  const { Store } = await import("../src/db.js");
  ({ planLayout: plan, applyLayout: apply } = await import("../src/migrate-layout.js"));
  ({ sessionPaths } = await import("../src/paths.js"));
  store = new Store(path.join(dataDir, "scribbot.db"));
  // Rows as the bot wrote them before campaigns: no dir, numbered per server.
  const row = (id: string, number: number, startedAt: string, extra: Record<string, unknown> = {}) => {
    store.db
      .prepare("INSERT INTO sessions (id, guild_id, channel_id, number, status, started_at, error, deleted_at) VALUES (?, 'g', 'c', ?, 'complete', ?, ?, ?)")
      .run(id, number, startedAt, (extra.error as string) ?? null, (extra.deleted_at as string) ?? null);
  };
  row("a-empty", 1, "2026-10-31T23:00:00.000Z"); // no folder on disk
  row("a-game", 12, "2026-11-01T01:41:00.000Z");
  row("a-cont", 13, "2026-11-01T02:43:00.000Z", { error: "Merged into session 12 (a-game)." });
  row("a-solo", 14, "2026-11-01T06:04:00.000Z");
  row("a-trash", 9, "2026-11-01T01:27:00.000Z", { deleted_at: "2026-11-01T07:00:00.000Z" });

  // Session 12 after an old merge: the merged versions in place, its own as *.premerge-13.
  const g = legacy("a-game");
  write(path.join(g, "timeline.json.premerge-13"), timeline("a-game", "2026-11-01T01:41:00.000Z", null));
  write(path.join(g, "transcript.json.premerge-13"), transcript("a-game", [line(1, "We go in.")]));
  write(path.join(g, "transcript.md.premerge-13"), "# A alone\n");
  write(path.join(g, "timeline.json"), { merged: true });
  write(path.join(g, "transcript.json"), transcript("a-game", [line(1, "We go in."), line(3720, "merged copy")]));
  write(path.join(g, "transcript.md"), "# merged\n");
  write(path.join(g, "chatlog.json"), { world: "erat", system: null, messages: [], combats: [] });
  write(path.join(g, "summary.md"), "# The Sparrow\n");
  write(path.join(g, "story", "summary.story.md"), "# The Sparrow\n\n## High level summary\n\nDone.\n");
  write(path.join(g, "story", "lines.json"), { sessions: [{ id: "a-game" }, { id: "a-cont" }] });
  write(path.join(g, "audio", "1", "000001000.wav"), "A");
  write(path.join(g, "audio", "1", "m13-000001000.wav"), "copied from B by the old merge");
  // Session 13: its own recording, transcribed, with its own story copy.
  const c = legacy("a-cont");
  write(path.join(c, "timeline.json"), timeline("a-cont", "2026-11-01T02:43:00.000Z", "2026-11-01T05:46:00.000Z"));
  write(path.join(c, "transcript.json"), transcript("a-cont", [line(5, "Where were we?")]));
  write(path.join(c, "chatlog.json"), { world: "erat", system: null, messages: [], combats: [] });
  write(path.join(c, "story", "summary.story.md"), "# copy\n");
  write(path.join(c, "audio", "1", "000001000.wav"), "B");
  const s = legacy("a-solo");
  write(path.join(s, "timeline.json"), timeline("a-solo", "2026-11-01T06:04:00.000Z", "2026-11-01T06:17:00.000Z"));
  write(path.join(s, "transcript.json"), transcript("a-solo", [line(2, "Hello")]));
  write(path.join(dataDir, "trash", "a-trash", "timeline.json"), timeline("a-trash", "2026-11-01T01:27:00.000Z", null));
  write(path.join(dataDir, "trash", "a-trash", "summary.md"), "# trashed\n");
  // Not a session: left alone.
  write(path.join(dataDir, "sessions", "fixture-tts", "timeline.json"), {});
});

describe("layout migration", () => {
  it("plans without changing anything", () => {
    const before = fs.readdirSync(path.join(dataDir, "sessions")).sort();
    const p = plan(store);
    expect(p.campaigns.map((c) => c.folder)).toEqual(["erat"]);
    expect(p.games.map((g) => [g.oldNumber, g.number, g.merged.map((m) => m.number)])).toEqual([[1, 1, []], [9, 9, []], [12, 12, [13]], [14, 14, []]]);
    expect(p.games.find((g) => g.id === "a-game")!.notes.join(" ")).toMatch(/premerge/);
    expect(fs.readdirSync(path.join(dataDir, "sessions")).sort()).toEqual(before);
    expect(store.listCampaigns()).toEqual([]); // not even the _unassigned campaign
  });

  it("moves every game, restores pre-merge files and rebuilds the game's transcript", () => {
    const r = apply(store);
    expect(r.errors).toEqual([]);
    expect(r.moved).toBe(4);
    expect(fs.existsSync(path.join(r.backupDir, "sessions", "a-game", "transcript.json.premerge-13"))).toBe(true);
    expect(fs.existsSync(path.join(r.backupDir, "scribbot.db"))).toBe(true);
    expect(fs.readdirSync(path.join(dataDir, "sessions"))).toEqual(["fixture-tts"]);

    const game = path.join(dataDir, "campaigns", "erat", "sessions", "a-game");
    expect(sessionPaths("a-game").dir).toBe(game);
    // Session 12's recording holds its own files from before the merge; the copied clip is gone.
    const rec = path.join(game, "recordings", "a-game");
    expect(readJson<Transcript>(path.join(rec, "transcript.json")).lines.map((l) => l.text)).toEqual(["We go in."]);
    expect(fs.readFileSync(path.join(rec, "transcript.md"), "utf8")).toBe("# A alone\n");
    expect(fs.readdirSync(path.join(rec, "audio", "1"))).toEqual(["000001000.wav"]);
    expect(fs.readdirSync(game).filter((f) => f.includes("premerge"))).toEqual([]);
    // Session 13's recording sits next to it, with its own story copy kept aside.
    const cont = path.join(game, "recordings", "a-cont");
    expect(sessionPaths("a-cont").recording).toBe(cont);
    expect(fs.readFileSync(path.join(cont, "from-session-013", "story", "summary.story.md"), "utf8")).toBe("# copy\n");
    expect(store.getSession("a-cont")).toMatchObject({ merged_into_id: "a-game", number: 13 });
    // The game's files: write-ups at the root, transcript rebuilt with the gap marker.
    expect(fs.readFileSync(path.join(game, "summary.md"), "utf8")).toBe("# The Sparrow\n");
    expect(fs.existsSync(path.join(game, "story", "summary.story.md"))).toBe(true);
    const tr = readJson<Transcript>(path.join(game, "transcript.json"));
    expect(tr.lines.map((l) => l.text)).toEqual(["We go in.", expect.stringMatching(/recording resumed .*session 13 merged in/), "Where were we?"]);

    expect(sessionPaths("a-solo").dir).toBe(path.join(dataDir, "campaigns", "erat", "sessions", "a-solo"));
    expect(readJson<Transcript>(sessionPaths("a-solo").transcriptJson).lines).toHaveLength(1);
    // In the trash: restructured in place, and restoring puts it in its campaign folder.
    expect(fs.existsSync(path.join(dataDir, "trash", "a-trash", "recordings", "a-trash", "timeline.json"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "trash", "a-trash", "summary.md"))).toBe(true);
    expect(sessionPaths("a-trash").dir).toBe(path.join(dataDir, "campaigns", "erat", "sessions", "a-trash"));
    expect(store.getSession("a-empty")!.dir).toBe("campaigns/erat/sessions/a-empty/recordings/a-empty");
  });

  it("finds the story from either recording and has nothing left to do", async () => {
    const { findStoryFile } = await import("../src/story.js");
    expect(findStoryFile("a-cont")?.folderId).toBe("a-game");
    expect(plan(store).games).toEqual([]);
    // New recordings continue the campaign's numbering.
    const next = store.createSession({ id: "new", guildId: "g", channelId: "c", textChannelId: null, startedAt: "2026-11-08T01:00:00.000Z" });
    expect(next).toMatchObject({ number: 15, dir: "campaigns/erat/sessions/new/recordings/new" });
  });
});
