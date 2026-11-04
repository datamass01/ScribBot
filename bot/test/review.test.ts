import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { JsonRequest, LLMProvider } from "../src/summarize/provider.js";
import type { Summary, SummaryFile } from "../src/summarize/schema.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-review-"));
process.env.DATA_DIR = dataDir;
process.env.CAMPAIGN_DIR = path.join(dataDir, "campaign");
process.env.API_TOKEN = "secret-token";
process.env.API_PORT = "0";
process.env.WORKER_URL = "http://127.0.0.1:9";
process.env.LLM_PROVIDER = "anthropic";
process.env.ANTHROPIC_API_KEY = "";
process.env.ANTHROPIC_AUTH_TOKEN = "";
delete process.env.ANTHROPIC_PROFILE;
process.env.ANTHROPIC_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-ant-"));
process.env.REVIEW_BEFORE_FOUNDRY = "true";

type Store = import("../src/db.js").Store;
type SessionRow = import("../src/db.js").SessionRow;
type BotEvent = import("../src/events.js").BotEvent;
const { sessionPaths } = await import("../src/paths.js");

const summary: Summary = {
  title: "Blood on the Bridge",
  recap: "Thorin threatened Grubnak at the bridge.",
  scenes: [{ title: "The Bridge", location: "Old Bridge", summary: "A goblin blocks the bridge." }],
  combats: [],
  quotes: [{ t: "00:00:12", character: "Thorin", text: "Stand aside, little one, or taste my axe!", context: "At the bridge" }],
  characterHighlights: [{ character: "Thorin", highlights: ["Threatened a goblin"] }],
  npcs: [{ name: "Grubnak", description: "Goblin chief" }],
  loot: [],
  hooks: ["Who does Grubnak serve?"],
};

class FakeProvider implements LLMProvider {
  readonly name = "fake";
  readonly model = "fake-1";
  requests: JsonRequest<z.ZodType>[] = [];
  constructor(private readonly reply: Summary) {}
  async generateJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<z.infer<S>> {
    this.requests.push(req);
    return this.reply as z.infer<S>;
  }
}

const participants = [
  { discordId: "1", displayName: "Alice", character: "Thorin", actorId: null, isGm: false },
  { discordId: "2", displayName: "Bob", character: null, actorId: null, isGm: true },
];
const startedAt = "2026-11-01T18:00:00.000Z";

function fakeSessions() {
  const calls: string[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    calls,
    listChannels: () => [],
    isRecording: () => false,
    startFromConsole: unused,
    stopFromConsole: unused,
    processFromConsole: async () => {},
    reviseFromConsole: async (s: SessionRow, feedback: string) => void calls.push(`revise ${s.id} ${feedback}`),
    postToDiscord: async () => ({ channelId: "t1", channelName: "table" }),
    mergeInto: () => "",
    setMapping: () => "",
    clearMapping: () => {},
    setGm: () => {},
    playingCampaignId: () => 0,
    memberNames: async () => ({}),
  };
}

describe("review before Foundry", () => {
  let app: Awaited<ReturnType<typeof import("../src/api/server.js").startApi>>;
  let store: Store;
  let base: string;
  let sessions: ReturnType<typeof fakeSessions>;
  const events: BotEvent[] = [];
  let seq = 0;
  const auth = { authorization: "Bearer secret-token" };

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: body === undefined ? auth : { ...auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  /** A summarized session with a transcript the quote can be found in. */
  const newSession = () => {
    const id = `2026-11-01-r${++seq}`;
    const row = store.createSession({ id, guildId: "g1", channelId: "v1", textChannelId: "t1", startedAt });
    store.setSessionStatus(id, "complete");
    const p = sessionPaths(id);
    fs.mkdirSync(p.recording, { recursive: true });
    fs.writeFileSync(
      p.timeline,
      JSON.stringify({ sessionId: id, guildId: "g1", channelId: "v1", startedAt, endedAt: null, sampleRate: 48000, channels: 1, participants, segments: [] }),
    );
    const line = (t: number, id: string, text: string) => {
      const who = participants.find((x) => x.discordId === id)!;
      return { t, end: t + 2, discordId: id, speaker: who.displayName, character: who.character, isGm: who.isGm, text };
    };
    const transcript = JSON.stringify({
      sessionId: id, model: "test", language: "en", createdAt: startedAt,
      lines: [line(12, "1", "Stand aside, little one, or taste my axe!"), line(30, "2", "The goblin flees.")],
    });
    fs.writeFileSync(p.recordingTranscript, transcript);
    fs.writeFileSync(p.transcriptJson, transcript);
    const file: SummaryFile = {
      sessionId: id, sessionNumber: row.number, startedAt, endedAt: null, provider: "fake", model: "fake-1", createdAt: startedAt,
      participants, summary: { ...summary, quotes: summary.quotes.map((q) => ({ ...q, seconds: 12, verified: true })) }, droppedQuotes: [],
    };
    fs.writeFileSync(p.summary, JSON.stringify(file));
    return row;
  };

  beforeAll(async () => {
    const { Store } = await import("../src/db.js");
    const { startApi } = await import("../src/api/server.js");
    const { bus } = await import("../src/events.js");
    bus.onEvent((e) => events.push(e));
    store = new Store(":memory:");
    sessions = fakeSessions();
    app = await startApi(store, () => null, {}, { sessions });
    const addr = app.server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => app?.close());
  beforeEach(() => {
    events.length = 0;
    sessions.calls.length = 0;
  });

  it("holds a summary from Foundry until it's approved", async () => {
    const s = newSession();
    const listed = (await call("GET", "/admin/sessions")).body.sessions.find((x: any) => x.id === s.id);
    expect(listed).toMatchObject({ reviewRequired: true, summaryReview: { state: "pending", approvedAt: null }, storyReview: null });

    const post = await call("POST", `/admin/sessions/${s.id}/summary/import`, {});
    expect(post.status).toBe(409);
    expect(post.body.error).toMatch(/hasn't been reviewed yet.*\/scrib approve session:\d+/);
    expect(events).toEqual([]);

    // Foundry can't fetch it either, and the module's dialog is told why.
    expect((await call("GET", `/sessions/${s.id}/summary`)).status).toBe(409);
    expect((await call("GET", `/sessions/${s.id}`)).body).toMatchObject({ hasSummary: true, summaryApproved: false });
  });

  it("approves exactly what the reviewer saw, then sends it", async () => {
    const s = newSession();
    const review = (await call("GET", `/admin/sessions/${s.id}/review`)).body;
    expect(review).toMatchObject({ required: true, summary: { approved: false, file: { summary: { title: "Blood on the Bridge" } } }, story: null });

    expect((await call("POST", `/admin/sessions/${s.id}/summary/approve`, { hash: "not-it" })).status).toBe(409);
    const ok = await call("POST", `/admin/sessions/${s.id}/summary/approve`, { hash: review.summary.hash });
    expect(ok.body).toMatchObject({ ok: true, posted: true, title: "Blood on the Bridge" });
    expect(events).toContainEqual({ type: "summary.ready", sessionId: s.id, number: s.number, title: "Blood on the Bridge", manual: true });
    expect((await call("GET", `/sessions/${s.id}/summary`)).status).toBe(200);
    expect((await call("GET", `/sessions/${s.id}`)).body.summaryApproved).toBe(true);
  });

  it("saves edits, which need approving again", async () => {
    const s = newSession();
    let review = (await call("GET", `/admin/sessions/${s.id}/review`)).body;
    await call("POST", `/admin/sessions/${s.id}/summary/approve`, { hash: review.summary.hash, post: false });

    const edited = {
      ...summary,
      title: "Blood on the Old Bridge",
      quotes: [...summary.quotes, { t: "00:05:00", character: "Thorin", text: "I never said this", context: "added by hand" }],
    };
    const bad = await call("PUT", `/admin/sessions/${s.id}/summary`, { summary: { ...edited, title: 42 }, hash: review.summary.hash });
    expect(bad.status).toBe(400);
    const saved = await call("PUT", `/admin/sessions/${s.id}/summary`, { summary: edited, hash: review.summary.hash });
    expect(saved.status).toBe(200);
    expect(saved.body.summary).toMatchObject({ approved: false, changedSinceApproval: true });
    const file = saved.body.summary.file as SummaryFile;
    expect(file).toMatchObject({ editedAt: expect.any(String), provider: "fake" });
    // The hand-added quote is kept (the reviewer's call), marked unverified, at its own time.
    expect((file.summary.quotes as { text: string; verified: boolean; seconds: number }[]).map((q) => [q.text, q.verified, q.seconds])).toEqual([
      ["Stand aside, little one, or taste my axe!", true, 12],
      ["I never said this", false, 300],
    ]);
    expect(fs.readFileSync(sessionPaths(s.id).summaryMd, "utf8")).toMatch(/Blood on the Old Bridge/);

    // An edit based on what was there before is refused, so nothing is overwritten unseen.
    const stale = await call("PUT", `/admin/sessions/${s.id}/summary`, { summary, hash: review.summary.hash });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/changed since you opened it/);

    const listed = (await call("GET", "/admin/sessions")).body.sessions.find((x: any) => x.id === s.id);
    expect(listed.summaryReview.state).toBe("changed");
    review = saved.body;
    expect((await call("POST", `/admin/sessions/${s.id}/summary/approve`, { hash: review.summary.hash })).body.posted).toBe(true);
  });

  it("passes revision requests to the Discord side, which runs them", async () => {
    const s = newSession();
    expect((await call("POST", `/admin/sessions/${s.id}/summary/revise`, { feedback: "  " })).status).toBe(400);
    expect((await call("POST", `/admin/sessions/${s.id}/summary/revise`, { feedback: "Grubnak is a hobgoblin" })).status).toBe(200);
    expect(sessions.calls).toEqual([`revise ${s.id} Grubnak is a hobgoblin`]);
  });

  it("revises with the LLM from the current summary and earlier feedback, keeping known quotes", async () => {
    const { reviseSession } = await import("../src/pipeline.js");
    const s = newSession();
    const revised: Summary = {
      ...summary,
      npcs: [{ name: "Grubnak", description: "Hobgoblin chief" }],
      quotes: [...summary.quotes, { t: "00:01:00", character: "Thorin", text: "Words nobody said", context: "invented" }],
    };
    const provider = new FakeProvider(revised);
    const told: string[] = [];
    let held: boolean | null = null;
    const file = await reviseSession(store, s.id, "Grubnak is a hobgoblin", {
      provider,
      log: () => {},
      notify: (t) => void told.push(t),
      onSummary: (_f, info) => void (held = info.held),
    });
    expect(held).toBe(true); // review is on: not sent
    expect(events.filter((e) => e.type === "summary.ready")).toEqual([]);
    expect(file.summary.npcs[0]!.description).toBe("Hobgoblin chief");
    expect(file.summary.quotes.map((q) => q.text)).toEqual(["Stand aside, little one, or taste my axe!"]);
    expect(file.droppedQuotes.map((q) => q.text)).toEqual(["Words nobody said"]);
    expect(file.revisions).toEqual([{ at: expect.any(String), feedback: "Grubnak is a hobgoblin", provider: "fake", model: "fake-1" }]);
    const prompt = String(provider.requests[0]!.prompt);
    expect(prompt).toContain("<current_summary>");
    expect(prompt).toContain("Grubnak is a hobgoblin");
    expect(store.getSession(s.id)?.status).toBe("complete");

    // The next revision is told about the first, so it doesn't undo it.
    const again = new FakeProvider(revised);
    await reviseSession(store, s.id, "Thorin is a dwarf", { provider: again, log: () => {} });
    expect(String(again.requests[0]!.prompt)).toMatch(/<earlier_feedback>\n- Grubnak is a hobgoblin\n<\/earlier_feedback>/);
  });

  it("leaves the summary as it was when a revision fails", async () => {
    const { reviseSession } = await import("../src/pipeline.js");
    const s = newSession();
    const before = fs.readFileSync(sessionPaths(s.id).summary, "utf8");
    const failing: LLMProvider = { name: "fake", model: "x", generateJson: async () => { throw new Error("rate limited"); } };
    const told: string[] = [];
    await expect(reviseSession(store, s.id, "fix it", { provider: failing, log: () => {}, notify: (t) => void told.push(t) })).rejects.toThrow("rate limited");
    expect(fs.readFileSync(sessionPaths(s.id).summary, "utf8")).toBe(before);
    expect(store.getSession(s.id)).toMatchObject({ status: "complete", error: expect.stringMatching(/rate limited.*unchanged/) });
    expect(told[0]).toMatch(/Revising session \d+'s summary failed: rate limited/);
  });

  it("holds a story too, and lets it be edited as Markdown", async () => {
    const s = newSession();
    const dir = path.join(sessionPaths(s.id).dir, "story");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.story.md"), "# The Bridge\n\n## High level summary\n\nThey crossed.\n");

    expect((await call("POST", `/admin/sessions/${s.id}/story/import`, {})).status).toBe(409);
    expect((await call("POST", `/sessions/${s.id}/story/import`, {})).status).toBe(409);
    expect((await call("GET", `/sessions/${s.id}/story`)).status).toBe(409);

    const review = (await call("GET", `/admin/sessions/${s.id}/review`)).body;
    expect(review.story).toMatchObject({ approved: false, file: { title: "The Bridge", problem: null } });
    const notReady = await call("PUT", `/admin/sessions/${s.id}/story`, { markdown: "no sections", hash: review.story.hash });
    expect(notReady.status).toBe(409);
    const saved = await call("PUT", `/admin/sessions/${s.id}/story`, { markdown: "# The Old Bridge\r\n\r\n## High level summary\r\n\r\nThey crossed it.\r\n", hash: review.story.hash });
    expect(saved.body.story.file.title).toBe("The Old Bridge");
    expect(fs.readFileSync(path.join(dir, "summary.story.md"), "utf8")).not.toContain("\r");

    const ok = await call("POST", `/admin/sessions/${s.id}/story/approve`, { hash: saved.body.story.hash });
    expect(ok.body).toMatchObject({ posted: true, title: "The Old Bridge" });
    expect(events).toContainEqual({ type: "story.ready", sessionId: s.id, number: s.number, title: "The Old Bridge" });
    expect((await call("GET", `/sessions/${s.id}/story`)).status).toBe(200);
  });

  it("holds a new summary from the pipeline, and sends it straight on with review off", async () => {
    const { processSession } = await import("../src/pipeline.js");
    const { config } = await import("../src/config.js");
    const { vi } = await import("vitest");
    const s = newSession();
    fs.rmSync(sessionPaths(s.id).summary);
    const provider: LLMProvider = {
      name: "fake",
      model: "fake-1",
      generateJson: async (req) => (req.schemaName === "chunk_notes"
        ? { scenes: [], events: [], combats: [], quotes: [], npcs: [], loot: [], openThreads: [] }
        : summary) as never,
    };
    const held: boolean[] = [];
    await processSession(store, s.id, { provider, log: () => {}, onSummary: (_f, i) => void held.push(i.held) });
    expect(events.filter((e) => e.type === "summary.ready")).toEqual([]);
    expect(store.getSession(s.id)?.summary_sent_at).toBeNull();

    const off = vi.spyOn(config, "reviewBeforeFoundry", "get").mockReturnValue(false);
    try {
      await processSession(store, s.id, { provider, log: () => {}, onSummary: (_f, i) => void held.push(i.held) });
      expect(events.filter((e) => e.type === "summary.ready").map((e) => e.sessionId)).toEqual([s.id]);
      expect((await call("GET", `/sessions/${s.id}/summary`)).status).toBe(200);
    } finally {
      off.mockRestore();
    }
    expect(held).toEqual([true, false]);
  });
});
