// Fixes from docs/assessment/02 (S1, S3, S6, S8, S9, S10) and 05 (C5, C6).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../src/db.js";
import type { Segment, Timeline } from "../src/types.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-resilience-"));
process.env.DATA_DIR = dataDir;
process.env.CAMPAIGN_DIR = path.join(dataDir, "campaign");
process.env.WORKER_URL = "http://worker.test";

let fsutil: typeof import("../src/fsutil.js");
let timeline: typeof import("../src/timeline.js");
let recovery: typeof import("../src/recovery.js");
let workerClient: typeof import("../src/worker-client.js");
let SessionRecorder: typeof import("../src/recorder.js").SessionRecorder;
let sessionPaths: typeof import("../src/paths.js").sessionPaths;
let DailyLog: typeof import("../src/logfile.js").DailyLog;

beforeAll(async () => {
  fsutil = await import("../src/fsutil.js");
  timeline = await import("../src/timeline.js");
  recovery = await import("../src/recovery.js");
  workerClient = await import("../src/worker-client.js");
  ({ SessionRecorder } = await import("../src/recorder.js"));
  ({ sessionPaths } = await import("../src/paths.js"));
  ({ DailyLog } = await import("../src/logfile.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const eperm = () => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });

describe("renameWithRetry (S1)", () => {
  it("retries transient Windows errors and then succeeds", () => {
    let calls = 0;
    const rename = (() => {
      if (++calls <= 2) throw eperm();
    }) as typeof fs.renameSync;
    fsutil.renameWithRetry("a", "b", { rename, delays: [1, 1, 1] });
    expect(calls).toBe(3);
  });

  it("gives up after the retries, and doesn't retry other errors", () => {
    let calls = 0;
    const always = (() => {
      calls++;
      throw eperm();
    }) as typeof fs.renameSync;
    expect(() => fsutil.renameWithRetry("a", "b", { rename: always, delays: [1, 1] })).toThrow(/EPERM/);
    expect(calls).toBe(3);
    calls = 0;
    const missing = (() => {
      calls++;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }) as typeof fs.renameSync;
    expect(() => fsutil.renameWithRetry("a", "b", { rename: missing, delays: [1, 1] })).toThrow(/ENOENT/);
    expect(calls).toBe(1);
  });
});

describe("SessionRecorder without a voice connection", () => {
  const fakeChannel = (id = "chan") => ({ id, name: "Table", guild: { id: "guild" } }) as never;

  function recorder(sessionId: string, onSegment = vi.fn(), log = vi.fn(), resume?: { startedAtMs: number; participants: []; segments: Segment[] }) {
    fs.mkdirSync(sessionPaths(sessionId).audio, { recursive: true });
    const r = new SessionRecorder(sessionId, fakeChannel(), async () => null, { onSegment, log, resume });
    return { r, onSegment, log, finish: (r as unknown as { finishClip: (u: string, s: number, f: string, d: number) => void }).finishClip.bind(r) };
  }

  it("journals a clip and hands it on even when timeline.json can't be written (S1, S10)", async () => {
    const { r, onSegment, log, finish } = recorder("s1-journal");
    const p = sessionPaths("s1-journal");
    const clip = path.join(p.audio, "u1", "000001000.wav");
    fs.mkdirSync(path.dirname(clip), { recursive: true });
    fs.writeFileSync(clip, "x");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw eperm();
    });

    expect(() => finish("u1", 1000, clip, 900)).not.toThrow();
    expect(onSegment).toHaveBeenCalledWith("audio/u1/000001000.wav", []);
    expect(timeline.readSegmentJournal(p.segmentsJournal)).toEqual([
      { discordId: "u1", startMs: 1000, endMs: 1900, file: "audio/u1/000001000.wav" },
    ]);

    // stop() tries the snapshot, fails after its retries, logs, and still returns the timeline.
    const t = await r.stop();
    expect(t.endedAt).not.toBeNull();
    expect(t.segments).toHaveLength(1);
    expect(log.mock.calls.some(([m]) => /writing timeline\.json failed/.test(m))).toBe(true);
  }, 15_000);

  it("drops clips under the minimum length without handing them on", () => {
    const { onSegment, finish } = recorder("s1-short");
    const clip = path.join(sessionPaths("s1-short").audio, "u1", "000000500.wav");
    fs.mkdirSync(path.dirname(clip), { recursive: true });
    fs.writeFileSync(clip, "x");
    finish("u1", 500, clip, 100);
    expect(onSegment).not.toHaveBeenCalled();
    expect(fs.existsSync(clip)).toBe(false);
  });

  it("finalizes timeline.json with endedAt on stop (S8), and resumes on the same clock (S3)", async () => {
    const startedAtMs = Date.parse("2026-11-01T18:00:00Z");
    const prior: Segment = { discordId: "u1", startMs: 1000, endMs: 2000, file: "audio/u1/000001000.wav" };
    const { r } = recorder("s3-resume", vi.fn(), vi.fn(), { startedAtMs, participants: [], segments: [prior] });
    expect(r.startedAtMs).toBe(startedAtMs);
    const t = await r.stop();
    const onDisk = JSON.parse(fs.readFileSync(sessionPaths("s3-resume").timeline, "utf8")) as Timeline;
    expect(onDisk.startedAt).toBe("2026-11-01T18:00:00.000Z");
    expect(onDisk.endedAt).toBe(t.endedAt);
    expect(onDisk.segments).toEqual([prior]);
  });
});

describe("readTimeline (S10)", () => {
  it("adds clips only the journal lists and skips a torn last line", () => {
    const dir = sessionPaths("s10").dir;
    fs.mkdirSync(dir, { recursive: true });
    const seg = (ms: number): Segment => ({ discordId: "u", startMs: ms, endMs: ms + 500, file: `audio/u/${ms}.wav` });
    const snapshot: Timeline = {
      sessionId: "s10", guildId: "g", channelId: "c", startedAt: "2026-11-01T18:00:00.000Z", endedAt: null,
      sampleRate: 16000, channels: 1, participants: [], segments: [seg(1000)],
    };
    fs.writeFileSync(path.join(dir, "timeline.json"), JSON.stringify(snapshot));
    fs.writeFileSync(
      path.join(dir, timeline.SEGMENT_JOURNAL),
      `${JSON.stringify(seg(1000))}\n${JSON.stringify(seg(3000))}\n${JSON.stringify(seg(2000))}\n{"discordId":"u","sta`,
    );
    expect(timeline.readTimeline(dir).segments.map((s) => s.startMs)).toEqual([1000, 2000, 3000]);
  });
});

function row(over: Partial<SessionRow>): SessionRow {
  return {
    id: "x", guild_id: "g", channel_id: "c", text_channel_id: "t", number: 1, status: "complete", error: null,
    started_at: "2026-11-01T18:00:00.000Z", ended_at: null, summarized_at: null, audio_purged: 0, ...over,
  };
}

describe("restart plan (S3, S8)", () => {
  it("resumes recent recordings, fails stale ones and processes shutdown-stopped ones", () => {
    const now = Date.parse("2026-11-01T20:00:00Z");
    const recent = row({ id: "recent", status: "recording" });
    const stale = row({ id: "stale", status: "recording" });
    const transcribing = row({ id: "tr", status: "transcribing" });
    const stopped = row({ id: "stopped", status: "failed", error: recovery.SHUTDOWN_NOTE });
    const other = row({ id: "other", status: "failed", error: "LLM error" });
    for (const [id, minutesAgo] of [["recent", 5], ["stale", 90]] as const) {
      const p = sessionPaths(id);
      fs.mkdirSync(p.dir, { recursive: true });
      fs.writeFileSync(p.timeline, "{}");
      const t = new Date(now - minutesAgo * 60_000);
      fs.utimesSync(p.timeline, t, t);
    }
    const plan = recovery.planRestart([recent, stale, transcribing, stopped, other], {
      now,
      resumeWindowMs: 30 * 60_000,
      paths: sessionPaths,
    });
    expect(plan.resume.map((s) => s.id)).toEqual(["recent"]);
    expect(plan.interrupted.map((s) => s.id)).toEqual(["stale", "tr"]);
    expect(plan.process.map((s) => s.id)).toEqual(["stopped"]);

    const never = recovery.planRestart([recent], { now, resumeWindowMs: 0, paths: sessionPaths });
    expect(never.resume).toEqual([]);
    expect(never.interrupted.map((s) => s.id)).toEqual(["recent"]);
  });
});

describe("/scrib process default session (C5)", () => {
  it("skips the live recording and merged sessions, preferring a failed one", () => {
    const sessions = [
      row({ id: "live", number: 4, status: "recording", started_at: "2026-11-01T21:00:00Z" }),
      row({ id: "merged", number: 3, status: "complete", error: "Merged into session 1 (x).", started_at: "2026-11-01T20:00:00Z" }),
      row({ id: "done", number: 2, status: "complete", started_at: "2026-11-01T19:00:00Z" }),
      row({ id: "failed", number: 1, status: "failed", started_at: "2026-11-01T18:00:00Z" }),
      row({ id: "elsewhere", number: 9, status: "failed", guild_id: "other", started_at: "2026-11-01T22:00:00Z" }),
    ];
    expect(recovery.defaultSessionToProcess(sessions, "g")?.id).toBe("failed");
    expect(recovery.defaultSessionToProcess(sessions.filter((s) => s.id !== "failed"), "g")?.id).toBe("done");
    expect(recovery.defaultSessionToProcess([sessions[0]!], "g")).toBeUndefined();
  });
});

describe("transcribe() survives a worker restart (S6, C4)", () => {
  it("retries refused polls, resubmits on 404 and resolves", async () => {
    const calls: string[] = [];
    const replies: (() => Response | never)[] = [
      () => Response.json({ id: "a", status: "queued", progress: 0, error: null }), // POST
      () => {
        throw new TypeError("fetch failed"); // GET: connection refused while the worker restarts
      },
      () => new Response("starting", { status: 503 }), // GET
      () => new Response("unknown job", { status: 404 }), // GET: the new worker forgot job a
      () => Response.json({ id: "b", status: "queued", progress: 0, error: null }), // POST again
      () => Response.json({ id: "b", status: "running", progress: 0.5, error: null }),
      () => Response.json({ id: "b", status: "done", progress: 1, error: null }),
    ];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      const next = replies.shift();
      if (!next) throw new Error("unexpected call");
      return next();
    });
    const waiting: string[] = [];
    const progress: number[] = [];
    await workerClient.transcribe("/s", [], {
      deleteAudio: false,
      pollMs: 1,
      retryDelaysMs: [1],
      onWaiting: (m) => waiting.push(m),
      onProgress: (f) => progress.push(f),
    });
    expect(calls).toEqual([
      "POST /jobs/transcribe", "GET /jobs/a", "GET /jobs/a", "GET /jobs/a", "POST /jobs/transcribe", "GET /jobs/b", "GET /jobs/b",
    ]);
    expect(waiting.some((m) => /resubmitting/.test(m))).toBe(true);
    expect(progress).toEqual([0.5]);
  });

  it("gives up after the retry window with a message that nothing is lost", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      workerClient.transcribe("/s", [], { deleteAudio: false, pollMs: 1, retryDelaysMs: [5], retryForMs: 30 }),
    ).rejects.toThrow(/every clip is kept on disk/);
  });

  it("fails at once on a real refusal", async () => {
    vi.stubGlobal("fetch", async () => new Response("timeline.json not found", { status: 404 }));
    await expect(workerClient.transcribe("/s", [], { deleteAudio: false, pollMs: 1, retryDelaysMs: [1] })).rejects.toThrow(/404/);
  });
});

describe("backlogMinutes (S5)", () => {
  it("divides the queue by the recent rate", () => {
    expect(workerClient.backlogMinutes({ queued: 300, stats: { clips: 10, clipsPerMin: 30 } })).toBe(10);
    expect(workerClient.backlogMinutes({ queued: 0 })).toBe(0);
    expect(workerClient.backlogMinutes({ queued: 5, stats: { clips: 0 } })).toBeNull();
  });
});

describe("DailyLog (S9)", () => {
  it("writes one file per day and prunes its own old files only", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-logs-"));
    fs.writeFileSync(path.join(dir, "bot-2026-10-01.log"), "old\n");
    fs.writeFileSync(path.join(dir, "worker-2026-10-01.log"), "worker's\n");
    let now = new Date("2026-11-01T12:00:00Z");
    const log = new DailyLog(dir, 14, "bot", () => now);
    log.write("first\nsecond line");
    now = new Date("2026-11-02T01:00:00Z");
    log.write("next day");
    expect(fs.readFileSync(path.join(dir, "bot-2026-11-01.log"), "utf8")).toBe("first\n  second line\n");
    expect(fs.readFileSync(path.join(dir, "bot-2026-11-02.log"), "utf8")).toBe("next day\n");
    expect(fs.existsSync(path.join(dir, "bot-2026-10-01.log"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "worker-2026-10-01.log"))).toBe(true);
  });
});

describe("failure messages name the session (C6)", () => {
  it("says which session failed and the exact command to resume it", async () => {
    const { Store } = await import("../src/db.js");
    const { processSession } = await import("../src/pipeline.js");
    const store = new Store(":memory:");
    store.createSession({ id: "c6", guildId: "g", channelId: "c", textChannelId: null, startedAt: "2026-11-01T18:00:00.000Z" });
    const s = store.createSession({ id: "c6b", guildId: "g", channelId: "c", textChannelId: null, startedAt: "2026-11-01T19:00:00.000Z" });
    fs.mkdirSync(sessionPaths("c6b").dir, { recursive: true }); // no timeline.json: transcription can't start
    const notes: string[] = [];
    await expect(processSession(store, "c6b", { notify: (t) => void notes.push(t), log: () => {} })).rejects.toThrow();
    expect(notes.at(-1)).toMatch(new RegExp(`Processing session ${s.number} failed`));
    expect(notes.at(-1)).toContain(`/scrib process session:${s.number}`);
    expect(notes.at(-1)).toContain("Every recorded clip is kept on disk.");
  });
});
