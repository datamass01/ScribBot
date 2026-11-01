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
let Store: typeof import("../src/db.js").Store;
let sessionPaths: typeof import("../src/paths.js").sessionPaths;
let processSession: typeof import("../src/pipeline.js").processSession;

beforeAll(async () => {
  merge = await import("../src/merge.js");
  ({ Store } = await import("../src/db.js"));
  ({ sessionPaths } = await import("../src/paths.js"));
  ({ processSession } = await import("../src/pipeline.js"));
});

let store: InstanceType<typeof Store>;
let n = 0;

/** A copy of the fixture as a new session starting at `startedAt`, optionally without audio. */
function makeSession(startedAt: string, opts: { audio?: boolean; endedAt?: string | null; chat?: ChatLog; extra?: boolean } = {}) {
  const id = `s${++n}-${Date.parse(startedAt)}`;
  const p = sessionPaths(id);
  fs.mkdirSync(p.dir, { recursive: true });
  if (opts.audio ?? true) fs.cpSync(path.join(fixture, "audio"), p.audio, { recursive: true });
  const tl = readJson<Timeline>(path.join(fixture, "timeline.json"));
  tl.sessionId = id;
  tl.startedAt = startedAt;
  tl.endedAt = opts.endedAt === undefined ? new Date(Date.parse(startedAt) + 60_000).toISOString() : opts.endedAt;
  if (opts.extra) tl.participants.push({ discordId: "4", displayName: "Dave", character: "Grubnak", actorId: null, isGm: false });
  fs.writeFileSync(p.timeline, JSON.stringify(tl));
  const tr = readJson<Transcript>(path.join(fixture, "transcript.json"));
  tr.sessionId = id;
  fs.writeFileSync(p.transcriptJson, JSON.stringify(tr));
  fs.writeFileSync(p.transcriptMd, "# original\n");
  if (opts.chat) fs.writeFileSync(p.chatlog, JSON.stringify(opts.chat));
  const row = store.createSession({ id, guildId: "g", channelId: "c", textChannelId: null, startedAt });
  store.setSessionStatus(id, "complete");
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
  store = new Store(":memory:");
});

describe("mergeSessions", () => {
  it("shifts B onto A's clock, marks the gap and unions everything", () => {
    const t0 = Date.parse("2026-10-31T18:00:00.000Z");
    const a = makeSession("2026-10-31T18:00:00.000Z", {
      endedAt: null, // crashed: A's end comes from its last clip
      chat: { world: "w", system: null, exportedAt: t0, messages: [msg("m1", t0 + 5000), msg("m2", t0 + 50_000)], combats: [combat("c1", 2)] },
    });
    const b = makeSession("2026-10-31T18:10:00.000Z", {
      extra: true,
      chat: { world: "w", system: null, exportedAt: t0 + 900_000, messages: [msg("m2", t0 + 50_000), msg("m3", t0 + 610_000)], combats: [combat("c1", 5), combat("c2", 1)] },
    });

    const r = merge.mergeSessions(store, a.row.id, b.row.id);
    expect(r.offsetSec).toBe(600);
    const lastClipSec = Math.max(...a.tl.segments.map((s) => s.endMs)) / 1000;
    expect(r.gapSec).toBeCloseTo(600 - lastClipSec, 3);
    expect(r.linesAdded).toBe(b.tr.lines.length);

    const tr = readJson<Transcript>(a.p.transcriptJson);
    expect(tr.lines).toHaveLength(a.tr.lines.length + b.tr.lines.length + 1);
    const ts = tr.lines.map((l) => l.t);
    expect(ts).toEqual([...ts].sort((x, y) => x - y));
    const markerIdx = tr.lines.findIndex((l) => l.discordId === merge.MERGE_MARKER_ID);
    expect(markerIdx).toBe(a.tr.lines.length);
    expect(tr.lines[markerIdx]!.t).toBe(600);
    expect(tr.lines[markerIdx]!.text).toMatch(/recording resumed after 9 min gap/);
    expect(tr.lines[markerIdx + 1]!.t).toBeCloseTo(b.tr.lines[0]!.t + 600, 2);
    expect(tr.lines.at(-1)!.text).toBe(b.tr.lines.at(-1)!.text);

    const tl = readJson<Timeline>(a.p.timeline);
    expect(tl.participants.map((p) => p.discordId)).toEqual(["1", "2", "3", "4"]);
    expect(tl.endedAt).toBe(b.tl.endedAt);
    expect(tl.segments).toHaveLength(a.tl.segments.length * 2);
    const copied = tl.segments.filter((s) => s.file.includes(`/m${b.row.number}-`));
    expect(copied).toHaveLength(b.tl.segments.length);
    expect(copied[0]!.startMs).toBe(b.tl.segments.toSorted((x, y) => x.startMs - y.startMs)[0]!.startMs + 600_000);
    for (const s of tl.segments) expect(fs.existsSync(path.join(a.p.dir, s.file))).toBe(true);
    expect(r.audioCopied).toBe(b.tl.segments.length);

    const chat = readJson<ChatLog>(a.p.chatlog);
    expect(chat.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(chat.combats.map((c) => [c.id, c.round])).toEqual([["c1", 5], ["c2", 1]]);
    expect(r.chatAdded).toBe(1);
    expect(r.combatsAdded).toBe(1);

    const md = fs.readFileSync(a.p.transcriptMd, "utf8");
    expect(md).toMatch(/^# Session transcript, 2026-10-31/);
    expect(md).toContain("**[00:10:00] ScribBot:** — recording resumed");
    expect(md).toContain("| Alice | Thorin |");
    expect(md).not.toContain("| ScribBot |");

    const suffix = `.premerge-${b.row.number}`;
    for (const f of [a.p.timeline, a.p.transcriptJson, a.p.transcriptMd, a.p.chatlog]) {
      expect(fs.existsSync(f + suffix)).toBe(true);
    }
    expect(fs.readFileSync(a.p.transcriptMd + suffix, "utf8")).toBe("# original\n");
    expect(readJson<Transcript>(a.p.transcriptJson + suffix).lines).toHaveLength(a.tr.lines.length);
    // B's own folder is untouched.
    expect(readJson<Transcript>(b.p.transcriptJson).lines).toEqual(b.tr.lines);

    const rowA = store.getSession(a.row.id)!;
    const rowB = store.getSession(b.row.id)!;
    expect(rowA.ended_at).toBe(b.tl.endedAt);
    expect(rowA.status).toBe("complete");
    expect(rowB.status).toBe("complete");
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
    expect(store.getSession(b.row.id)!.status).toBe("complete");
  });

  it("merges a third part into the same target", () => {
    const a = makeSession("2026-10-31T18:00:00.000Z");
    const b = makeSession("2026-10-31T18:05:00.000Z");
    const c = makeSession("2026-10-31T18:10:00.000Z");
    merge.mergeSessions(store, a.row.id, b.row.id);
    merge.mergeSessions(store, a.row.id, c.row.id);
    const tr = readJson<Transcript>(a.p.transcriptJson);
    expect(tr.lines.filter((l) => l.discordId === merge.MERGE_MARKER_ID).map((l) => l.t)).toEqual([300, 600]);
    expect(tr.lines).toHaveLength(a.tr.lines.length * 3 + 2);
  });

  it("merges transcripts only, with a warning, when B's audio is gone", () => {
    const a = makeSession("2026-10-31T18:00:00.000Z");
    const b = makeSession("2026-10-31T18:05:00.000Z", { audio: false });
    const r = merge.mergeSessions(store, a.row.id, b.row.id);
    expect(r.audioCopied).toBe(0);
    expect(r.warnings.join(" ")).toMatch(/Re-transcribing session \d+ would drop/);
    expect(readJson<Timeline>(a.p.timeline).segments).toHaveLength(a.tl.segments.length);
    expect(readJson<Transcript>(a.p.transcriptJson).lines).toHaveLength(a.tr.lines.length * 2 + 1);
  });

  it("refuses busy, untranscribed, reversed or identical sessions without changing anything", () => {
    const a = makeSession("2026-10-31T18:00:00.000Z");
    const b = makeSession("2026-10-31T18:05:00.000Z");
    const before = fs.readFileSync(a.p.transcriptJson, "utf8");

    expect(() => merge.mergeSessions(store, a.row.id, a.row.id)).toThrow(/itself/);
    expect(() => merge.mergeSessions(store, b.row.id, a.row.id)).toThrow(/other way round/);
    expect(() => merge.mergeSessions(store, a.row.id, b.row.id, { isBusy: (id) => id === b.row.id })).toThrow(/being processed/);
    store.setSessionStatus(b.row.id, "recording");
    expect(() => merge.mergeSessions(store, a.row.id, b.row.id)).toThrow(/still recording/);
    store.setSessionStatus(b.row.id, "failed", "Interrupted while recording (bot restarted).");
    fs.rmSync(b.p.transcriptJson);
    expect(() => merge.mergeSessions(store, a.row.id, b.row.id)).toThrow(/isn't transcribed yet/);

    expect(fs.readFileSync(a.p.transcriptJson, "utf8")).toBe(before);
    expect(fs.readdirSync(a.p.dir).filter((f) => f.includes("premerge"))).toEqual([]);
  });
});

describe("formatGap", () => {
  it("formats seconds, minutes and hours", () => {
    expect(merge.formatGap(12.4)).toBe("12 s");
    expect(merge.formatGap(540)).toBe("9 min");
    expect(merge.formatGap(3900)).toBe("1 h 05 min");
  });
});
