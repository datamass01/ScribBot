import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatLog, Timeline, Transcript } from "../src/types.js";

// Point DATA_DIR at a temp folder before the config module is first imported.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-merge-"));
process.env.DATA_DIR = dataDir;
process.env.CAMPAIGN_DIR = path.join(dataDir, "campaign");

const fixture = path.resolve(import.meta.dirname, "../../data/sessions/fixture-tts");
const readJson = <T>(file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as T;

type Mod = typeof import("../src/merge.js");
let merge: Mod;
let layout: typeof import("../src/layout.js");
let Store: typeof import("../src/db.js").Store;
let sessionPaths: typeof import("../src/paths.js").sessionPaths;
let processSession: typeof import("../src/pipeline.js").processSession;

beforeAll(async () => {
  merge = await import("../src/merge.js");
  layout = await import("../src/layout.js");
  ({ Store } = await import("../src/db.js"));
  ({ sessionPaths } = await import("../src/paths.js"));
  ({ processSession } = await import("../src/pipeline.js"));
});

let store: InstanceType<typeof Store>;
let n = 0;

/** A copy of the fixture as a new, transcribed recording starting at `startedAt`, filed in the campaign layout. */
function makeSession(startedAt: string, opts: { audio?: boolean; endedAt?: string | null; chat?: ChatLog; extra?: boolean } = {}) {
  const id = `s${++n}-${Date.parse(startedAt)}`;
  const row = store.createSession({ id, guildId: "g", channelId: "c", textChannelId: null, startedAt });
  store.setSessionStatus(id, "complete");
  const p = sessionPaths(id);
  fs.mkdirSync(p.recording, { recursive: true });
  if (opts.audio ?? true) fs.cpSync(path.join(fixture, "audio"), p.audio, { recursive: true });
  const tl = readJson<Timeline>(path.join(fixture, "timeline.json"));
  tl.sessionId = id;
  tl.startedAt = startedAt;
  tl.endedAt = opts.endedAt === undefined ? new Date(Date.parse(startedAt) + 60_000).toISOString() : opts.endedAt;
  if (opts.extra) tl.participants.push({ discordId: "4", displayName: "Dave", character: "Grubnak", actorId: null, isGm: false });
  fs.writeFileSync(p.timeline, JSON.stringify(tl));
  const tr = readJson<Transcript>(path.join(fixture, "transcript.json"));
  tr.sessionId = id;
  fs.writeFileSync(p.recordingTranscript, JSON.stringify(tr));
  if (opts.chat) fs.writeFileSync(p.recordingChatlog, JSON.stringify(opts.chat));
  layout.composeSession(store, id);
  return { row, p, tl, tr };
}

const msg = (id: string, timestamp: number) => ({
  id, timestamp, alias: "Thorin", actorId: null, userName: "Alice", inCharacter: true,
  isRoll: false, whisper: false, flavor: null, content: `message ${id}`, rolls: [],
});
const combat = (id: string, round: number) => ({
  id, name: "Bridge fight", scene: null, round, startedAt: null, endedAt: null, combatants: [],
});

beforeEach(() => {
  // A fresh database numbers from 1 again, so start from empty campaign folders too.
  fs.rmSync(path.join(dataDir, "campaigns"), { recursive: true, force: true });
  store = new Store(":memory:");
  store.touchWorld("erat", "Erat");
});

describe("composeSession", () => {
  it("files a recording under its game and builds the game's files from it", () => {
    const a = makeSession("2026-10-31T18:00:00.000Z");
    expect(a.p.dir).toBe(path.join(dataDir, "campaigns", "erat", "sessions", a.row.id));
    expect(a.p.recording).toBe(path.join(a.p.dir, "recordings", a.row.id));
    expect(readJson<Transcript>(a.p.transcriptJson).lines).toEqual(a.tr.lines);
    expect(fs.readFileSync(a.p.transcriptMd, "utf8")).toMatch(/^# Session transcript, 2026-10-31/);
  });
});

describe("mergeSessions", () => {
  it("moves B's recording into A, rebuilds A's files on A's clock and keeps everything", () => {
    const t0 = Date.parse("2026-10-31T18:00:00.000Z");
    const a = makeSession("2026-10-31T18:00:00.000Z", {
      endedAt: null, // crashed: A's end comes from its last clip
      chat: { world: "w", system: null, exportedAt: t0, messages: [msg("m1", t0 + 5000), msg("m2", t0 + 50_000)], combats: [combat("c1", 2)] },
    });
    const b = makeSession("2026-10-31T18:10:00.000Z", {
      extra: true,
      chat: { world: "w", system: null, exportedAt: t0 + 900_000, messages: [msg("m2", t0 + 50_000), msg("m3", t0 + 610_000)], combats: [combat("c1", 5), combat("c2", 1)] },
    });
    fs.writeFileSync(b.p.summaryMd, "# B's own summary\n");
    const oldB = b.p.dir;

    const r = merge.mergeSessions(store, a.row.id, b.row.id);
    const lastClipSec = Math.max(...a.tl.segments.map((s) => s.endMs)) / 1000;
    expect(r.gapSec).toBeCloseTo(600 - lastClipSec, 3);
    expect(r.linesAdded).toBe(b.tr.lines.length);

    // B's recording now lives in A's folder, untouched; B's old game folder is gone.
    const pb = sessionPaths(b.row.id);
    expect(pb.recording).toBe(path.join(a.p.dir, "recordings", b.row.id));
    expect(pb.dir).toBe(a.p.dir);
    expect(readJson<Transcript>(pb.recordingTranscript).lines).toEqual(b.tr.lines);
    expect(fs.existsSync(path.join(pb.audio))).toBe(true);
    expect(fs.existsSync(oldB)).toBe(false);
    expect(r.archive).toBe(path.join(pb.recording, `from-session-${String(b.row.number).padStart(3, "0")}`));
    expect(fs.readFileSync(path.join(r.archive!, "summary.md"), "utf8")).toBe("# B's own summary\n");
    expect(fs.readdirSync(a.p.dir).filter((f) => f.includes("premerge"))).toEqual([]);

    const tr = readJson<Transcript>(a.p.transcriptJson);
    expect(tr.lines).toHaveLength(a.tr.lines.length + b.tr.lines.length + 1);
    const ts = tr.lines.map((l) => l.t);
    expect(ts).toEqual([...ts].sort((x, y) => x - y));
    const markerIdx = tr.lines.findIndex((l) => l.discordId === merge.MERGE_MARKER_ID);
    expect(markerIdx).toBe(a.tr.lines.length);
    expect(tr.lines[markerIdx]!.t).toBe(600);
    expect(tr.lines[markerIdx]!.text).toMatch(/recording resumed after 9 min gap \(session \d+ merged in\)/);
    expect(tr.lines[markerIdx + 1]!.t).toBeCloseTo(b.tr.lines[0]!.t + 600, 2);

    const tl = layout.sessionTimeline(store, a.row.id);
    expect(tl.participants.map((p) => p.discordId)).toEqual(["1", "2", "3", "4"]);
    expect(tl.endedAt).toBe(b.tl.endedAt);
    expect(tl.segments).toHaveLength(a.tl.segments.length + b.tl.segments.length);
    for (const s of tl.segments) expect(fs.existsSync(path.join(a.p.dir, s.file))).toBe(true);

    const chat = readJson<ChatLog>(a.p.chatlog);
    expect(chat.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(chat.combats.map((c) => [c.id, c.round])).toEqual([["c1", 5], ["c2", 1]]);
    expect(r.chatAdded).toBe(1);
    expect(r.combatsAdded).toBe(1);

    const md = fs.readFileSync(a.p.transcriptMd, "utf8");
    expect(md).toContain("**[00:10:00] ScribBot:** — recording resumed");
    expect(md).toContain("| Alice | Thorin |");

    const rowA = store.getSession(a.row.id)!;
    const rowB = store.getSession(b.row.id)!;
    expect(rowA.ended_at).toBe(b.tl.endedAt);
    expect(rowB.merged_into_id).toBe(a.row.id);
    expect(merge.mergedInto(rowB)).toBe(a.row.number);
    expect(merge.mergedInto(rowA)).toBeNull();
  });

  it("refuses to run twice, and the pipeline refuses the merged-away session", async () => {
    const a = makeSession("2026-10-31T18:00:00.000Z");
    const b = makeSession("2026-10-31T18:05:00.000Z");
    merge.mergeSessions(store, a.row.id, b.row.id);
    const before = fs.readFileSync(a.p.transcriptJson, "utf8");
    expect(() => merge.mergeSessions(store, a.row.id, b.row.id)).toThrow(/already merged into session/);
    expect(() => merge.mergeSessions(store, b.row.id, a.row.id)).toThrow(/already merged into session/);
    expect(fs.readFileSync(a.p.transcriptJson, "utf8")).toBe(before);
    await expect(processSession(store, b.row.id, { skipSummary: true })).rejects.toThrow(/merged into session/);
  });

  it("merges a third part into the same game", () => {
    const a = makeSession("2026-10-31T18:00:00.000Z");
    const b = makeSession("2026-10-31T18:05:00.000Z");
    const c = makeSession("2026-10-31T18:10:00.000Z");
    merge.mergeSessions(store, a.row.id, b.row.id);
    merge.mergeSessions(store, a.row.id, c.row.id);
    const tr = readJson<Transcript>(a.p.transcriptJson);
    expect(tr.lines.filter((l) => l.discordId === merge.MERGE_MARKER_ID).map((l) => l.t)).toEqual([300, 600]);
    expect(tr.lines).toHaveLength(a.tr.lines.length * 3 + 2);
    expect(fs.readdirSync(path.join(a.p.dir, "recordings")).sort()).toEqual([a.row.id, b.row.id, c.row.id].sort());
  });

  it("refuses busy, untranscribed, reversed, identical or old-layout sessions without changing anything", () => {
    const a = makeSession("2026-10-31T18:00:00.000Z");
    const b = makeSession("2026-10-31T18:05:00.000Z");
    const before = fs.readFileSync(a.p.transcriptJson, "utf8");

    expect(() => merge.mergeSessions(store, a.row.id, a.row.id)).toThrow(/itself/);
    expect(() => merge.mergeSessions(store, b.row.id, a.row.id)).toThrow(/other way round/);
    expect(() => merge.mergeSessions(store, a.row.id, b.row.id, { isBusy: (id) => id === b.row.id })).toThrow(/being processed/);
    store.setSessionStatus(b.row.id, "recording");
    expect(() => merge.mergeSessions(store, a.row.id, b.row.id)).toThrow(/still recording/);
    store.setSessionStatus(b.row.id, "failed", "Interrupted while recording (bot restarted).");
    fs.rmSync(b.p.recordingTranscript);
    expect(() => merge.mergeSessions(store, a.row.id, b.row.id)).toThrow(/isn't transcribed yet/);
    const other = store.touchWorld("tomb", null, false);
    const c = store.createSession({ id: "other", guildId: "g", channelId: "c", textChannelId: null, startedAt: "2026-10-31T19:00:00.000Z", campaignId: other.id });
    store.setSessionStatus(c.id, "complete");
    expect(() => merge.mergeSessions(store, a.row.id, c.id)).toThrow(/different campaigns/);
    store.db.prepare("UPDATE sessions SET dir = NULL WHERE id = ?").run(c.id);
    store.db.prepare("UPDATE sessions SET campaign_id = ? WHERE id = ?").run(a.row.campaign_id, c.id);
    expect(() => merge.mergeSessions(store, a.row.id, c.id)).toThrow(/old folder layout/);

    expect(fs.readFileSync(a.p.transcriptJson, "utf8")).toBe(before);
    expect(fs.existsSync(b.p.recording)).toBe(true);
  });
});

describe("moveToCampaign", () => {
  it("moves a game with its recordings and numbers it in the new campaign", () => {
    const a = makeSession("2026-10-31T18:00:00.000Z");
    const b = makeSession("2026-10-31T18:05:00.000Z");
    merge.mergeSessions(store, a.row.id, b.row.id);
    const tomb = store.touchWorld("tomb", null, false);
    const moved = layout.moveToCampaign(store, a.row.id, tomb.id);
    expect(moved.number).toBe(1);
    const p = sessionPaths(a.row.id);
    expect(p.dir).toBe(path.join(dataDir, "campaigns", "tomb", "sessions", a.row.id));
    expect(sessionPaths(b.row.id).recording).toBe(path.join(p.dir, "recordings", b.row.id));
    expect(fs.existsSync(sessionPaths(b.row.id).recordingTranscript)).toBe(true);
    expect(readJson<Transcript>(p.transcriptJson).lines).toHaveLength(a.tr.lines.length * 2 + 1);
  });
});

describe("formatGap", () => {
  it("formats seconds, minutes and hours", () => {
    expect(merge.formatGap(12.4)).toBe("12 s");
    expect(merge.formatGap(540)).toBe("9 min");
    expect(merge.formatGap(3900)).toBe("1 h 05 min");
  });
});
