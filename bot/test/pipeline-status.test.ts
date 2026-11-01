// The /status pipeline block (docs/assessment/05 C1), ported from the monitor's tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PipelineTracker, isHallucination, parseCache, quality, type PipelineSession } from "../src/api/pipeline.js";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-pipe-"));
  let now = 1_000_000;
  const clock = () => now;
  const tracker = new PipelineTracker(dir, clock, (party) => [...party, "Grubnak", "glabrezu"]);
  return { dir, tracker, advance: (ms: number) => (now += ms) };
}

function session(dir: string, id: string, opts: { clips?: number; converted?: number; transcript?: boolean; texts?: string[] } = {}) {
  const folder = path.join(dir, id);
  fs.mkdirSync(folder, { recursive: true });
  const segs = Array.from({ length: opts.clips ?? 0 }, (_, i) => ({ discordId: "u", startMs: i * 1000, endMs: i * 1000 + 500, file: `audio/u/${i}.wav` }));
  fs.writeFileSync(path.join(folder, "timeline.json"), JSON.stringify({
    sessionId: id, guildId: "g", channelId: "c", startedAt: "2026-11-01T18:00:00Z", endedAt: null,
    sampleRate: 16000, channels: 1, participants: [], segments: segs,
  }));
  if (opts.converted != null) {
    const lines = segs.slice(0, opts.converted).map((s, i) =>
      JSON.stringify({ file: s.file, segments: [{ start: 0, end: 1, text: opts.texts?.[i] ?? "Stand aside!", probability: 0.9 }] }));
    fs.writeFileSync(path.join(folder, "transcript.partial.jsonl"), `${lines.join("\n")}\n`);
  }
  if (opts.transcript) fs.writeFileSync(path.join(folder, "transcript.json"), "{}");
  return folder;
}

const row = (id: string, over: Partial<PipelineSession> = {}): PipelineSession => ({
  id, number: 1, status: "transcribing", processing: true, progress: null, clips: null, hasTranscript: false, ...over,
});
const worker = { reachable: true, queued: 0, liveClips: { done: 0, failed: 0 } };

describe("parseCache and quality", () => {
  it("counts a retried clip once and flags noise and hallucinations", () => {
    const clips = parseCache([
      JSON.stringify({ file: "a", segments: [{ text: "Thank you.", probability: 0.9 }] }),
      JSON.stringify({ file: "b", segments: [{ text: "...", probability: 0.9 }] }),
      JSON.stringify({ file: "b", segments: [{ text: "Hello there", probability: 0.2 }] }),
      '{"file": "c", "segm', // torn
    ].join("\n"));
    expect(clips.map((c) => [c.file, c.noise])).toEqual([["a", false], ["b", true]]);
    expect(isHallucination("Grubnak, glabrezu, Grubnak", new Set(["grubnak", "glabrezu"]))).toBe(true);
    expect(isHallucination("Grubnak swings his axe", new Set(["grubnak"]))).toBe(false);
    expect(quality(clips, new Set())).toMatchObject({ clips: 2, noise: 1, noisePct: 50, hallucinations: 1 });
  });
});

describe("PipelineTracker", () => {
  it("reports conversion from the worker's cache, and never opens timeline.json while recording", () => {
    const { dir, tracker } = setup();
    session(dir, "done", { clips: 10, converted: 4 });
    session(dir, "live", { clips: 99, converted: 2 });
    const read = vi.spyOn(fs, "readFileSync");
    const p = tracker.build({
      sessions: [row("done", { number: 1 }), row("live", { number: 2, status: "recording", processing: false })],
      recordings: [{ sessionId: "live", number: 2, clips: 7, speakers: [{ character: "Thorin" }] }],
      worker,
    });
    const openedTimelines = read.mock.calls.map(([f]) => String(f)).filter((f) => f.endsWith("timeline.json"));
    read.mockRestore();
    expect(openedTimelines.some((f) => f.includes(`${path.sep}live${path.sep}`))).toBe(false);
    expect(p.conversions.map((c) => [c.number, c.phase, c.converted, c.clips, c.pending])).toEqual([
      [1, "finishing", 4, 10, 6],
      [2, "recording", 2, 7, 5],
    ]);
    expect(p.shutdown.state).toBe("no");
  });

  it("measures rate and trend over time, and calls a stuck worker stalled", () => {
    const { dir, tracker, advance } = setup();
    const folder = session(dir, "s", { clips: 100, converted: 10 });
    const sessions = [row("s")];
    let p = tracker.build({ sessions, recordings: [], worker: { ...worker, queued: 50 } });
    expect(p.queue.ratePerMin).toBeNull();
    advance(60_000);
    session(dir, "s", { clips: 100, converted: 40 });
    fs.utimesSync(path.join(folder, "transcript.partial.jsonl"), new Date(), new Date(Date.now() + 5000)); // new mtime
    p = tracker.build({ sessions, recordings: [], worker: { ...worker, queued: 20 } });
    expect(p.queue.ratePerMin).toBe(30);
    expect(p.queue.trendPerMin).toBe(-30);
    expect(p.queue.etaSec).toBe(120);
    expect(p.shutdown.state).toBe("wait");
    advance(130_000);
    p = tracker.build({ sessions, recordings: [], worker: { ...worker, queued: 20 } });
    expect(p.queue.stalled).toBe(true);
    expect(p.alerts.map((a) => a.key)).toContain("stalled");
  });

  it("says it's safe once nothing is pending, and points failed sessions at /scrib process", () => {
    const { dir, tracker } = setup();
    session(dir, "f", { clips: 5, converted: 5 });
    const p = tracker.build({ sessions: [row("f", { number: 7, status: "failed", processing: false })], recordings: [], worker });
    expect(p.conversions[0]?.phase).toBe("failed");
    expect(p.alerts.find((a) => a.key === "failed-f")?.text).toContain("/scrib process session:7");
    expect(p.shutdown.state).toBe("safe");
    expect(p.shutdown.reasons.join(" ")).toContain("/scrib process session:7");
  });

  it("warns when a large share of converted clips look hallucinated", () => {
    const { dir, tracker } = setup();
    session(dir, "h", { clips: 40, converted: 40, texts: Array.from({ length: 40 }, (_, i) => (i < 10 ? "Grubnak, glabrezu" : "We cross the bridge")) });
    const p = tracker.build({ sessions: [row("h", { number: 3 })], recordings: [], worker });
    expect(p.conversions[0]?.quality?.hallucinationPct).toBe(25);
    expect(p.alerts.map((a) => a.key)).toContain("quality-h");
  });
});
