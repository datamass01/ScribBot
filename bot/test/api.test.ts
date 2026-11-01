import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-api-"));
process.env.DATA_DIR = dataDir;
process.env.API_TOKEN = "secret-token";
process.env.API_PORT = "0"; // any free port
process.env.WORKER_URL = "http://127.0.0.1:9"; // nothing listens here: the worker reads as unreachable
// No Anthropic credentials anywhere: empty values stop dotenv filling them from a real .env,
// and an empty config dir hides any `ant auth login` profile on this machine.
process.env.LLM_PROVIDER = "anthropic";
process.env.AUTO_SUMMARIZE = "true"; // the credential warnings only apply to automatic summaries (see status-manual.test.ts)
process.env.ANTHROPIC_API_KEY = "";
process.env.ANTHROPIC_AUTH_TOKEN = "";
delete process.env.ANTHROPIC_PROFILE;
process.env.ANTHROPIC_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-ant-"));

describe("resolveAnthropicCredentials", () => {
  const none = async () => null;
  it("follows the SDK's order and never returns the secret", async () => {
    const { resolveAnthropicCredentials: resolve } = await import("../src/api/status.js");
    expect(await resolve({ apiKey: "sk-ant-x", authToken: "tok" }, none)).toEqual({ credentials: "api key", error: null });
    expect(await resolve({ authToken: "tok" }, none)).toEqual({ credentials: "auth token", error: null });
    expect(await resolve({}, async () => ({ authentication: { type: "user_oauth" } }))).toEqual({
      credentials: "ant profile (user_oauth)",
      error: null,
    });
    expect(await resolve({}, none)).toEqual({ credentials: null, error: null });
  });
  it("reports a broken profile as missing credentials with the reason", async () => {
    const { resolveAnthropicCredentials: resolve } = await import("../src/api/status.js");
    const broken = async () => {
      throw new Error('profile "work" not found');
    };
    expect(await resolve({}, broken)).toEqual({ credentials: null, error: 'profile "work" not found' });
  });
});

describe("Foundry API", () => {
  let app: Awaited<ReturnType<typeof import("../src/api/server.js").startApi>>;
  let store: import("../src/db.js").Store;
  let base: string;
  const auth = { authorization: "Bearer secret-token", "content-type": "application/json" };

  beforeAll(async () => {
    const { Store } = await import("../src/db.js");
    const { startApi } = await import("../src/api/server.js");
    store = new Store(":memory:");
    app = await startApi(store, () => null);
    const addr = app.server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => app?.close());

  it("requires the token except for /health", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/sessions`)).status).toBe(401);
    expect((await fetch(`${base}/sessions`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(`${base}/sessions?token=secret-token`)).status).toBe(200);
  });

  it("stores the roster and actor names", async () => {
    const res = await fetch(`${base}/roster`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        world: "w",
        users: [
          { id: "u1", name: "Alice", isGM: false, discordId: "111", character: { id: "a1", name: "Thorin", img: "t.png" } },
          { id: "u2", name: "GM", isGM: true },
        ],
        actors: [
          { id: "a1", name: "Thorin", type: "character", classes: [{ name: "Fighter", level: 3 }, { name: "Rogue", level: 2 }], level: 5 },
          { id: "a2", name: "Grubnak" },
        ],
      }),
    });
    expect(await res.json()).toEqual({ ok: true, users: 2, actors: 2, links: 0 });
    expect(store.getRoster().find((r) => r.foundry_user_id === "u1")).toMatchObject({ actor_name: "Thorin", discord_id: "111" });
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "foundry-actors.json"), "utf8"));
    expect(saved[0]).toMatchObject({ name: "Thorin", classes: [{ name: "Fighter", level: 3 }, { name: "Rogue", level: 2 }], level: 5 });
    expect(saved[1]).toMatchObject({ name: "Grubnak", classes: [], level: null, race: null, hpMax: null });
  });

  it("asks Foundry to correct a stale Discord ID flag after a roster sync (05 C11)", async () => {
    const { bus } = await import("../src/events.js");
    const roster = store.getRoster();
    store.upsertMapping({ guildId: "g", discordId: "222222", foundryUserId: "u1", characterName: "Thorin" });
    const events: unknown[] = [];
    const off = bus.onEvent((e) => events.push(e));
    const res = await fetch(`${base}/roster`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ world: "w", users: [{ id: "u1", name: "Alice", isGM: false, discordId: "111" }], actors: [] }),
    });
    off();
    store.deleteMapping("g", "222222");
    store.replaceRoster(roster);
    expect(await res.json()).toMatchObject({ links: 1 });
    expect(events).toContainEqual({ type: "roster.link", links: [{ foundryUserId: "u1", discordId: "222222" }] });
  });

  it("accepts a chat log for a session and reports missing summaries", async () => {
    const s = store.createSession({ id: "s1", guildId: "g", channelId: "c", textChannelId: null, startedAt: new Date().toISOString() });
    const { bus } = await import("../src/events.js");
    const events: unknown[] = [];
    const off = bus.onEvent((e) => events.push(e));
    const res = await fetch(`${base}/sessions/latest/chatlog`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ messages: [{ id: "m1", timestamp: Date.now(), content: "<p>hi</p>" }], combats: [] }),
    });
    off();
    expect(await res.json()).toMatchObject({ ok: true, messages: 1 });
    // The headless Foundry client waits for this before letting the summary run.
    expect(events).toContainEqual({ type: "chatlog.received", sessionId: "s1" });
    expect(fs.existsSync(path.join(dataDir, "sessions", s.id, "chatlog.json"))).toBe(true);
    // Older modules send no game system; it is stored as null.
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "sessions", s.id, "chatlog.json"), "utf8")).system).toBeNull();

    const summary = await fetch(`${base}/sessions/s1/summary`, { headers: auth });
    expect(summary.status).toBe(404);
    const info = await (await fetch(`${base}/sessions/s1`, { headers: auth })).json();
    expect(info).toMatchObject({ number: 1, status: "recording", hasChatlog: true, hasSummary: false });
  });

  it("keeps the game system sent with a chat log", async () => {
    const s = { id: "s1" }; // the session from the previous test; a newer one would change "latest" for later tests
    const system = { id: "pf1", title: "Pathfinder 1", version: "11.8" };
    const res = await fetch(`${base}/sessions/${s.id}/chatlog`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ world: "w", system, messages: [], combats: [] }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "sessions", s.id, "chatlog.json"), "utf8")).system).toEqual(system);
  });

  it("serves the dashboard page without the token", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("ScribBot Monitor");
  });

  it("reports component status behind the token, without secrets", async () => {
    expect((await fetch(`${base}/status`)).status).toBe(401);
    const status = await (await fetch(`${base}/status`, { headers: auth })).json();
    expect(status.worker).toMatchObject({ reachable: false });
    expect(status.warnings).toContain("Transcription worker is unreachable.");
    expect(status.foundry).toMatchObject({ rosterUsers: 2, rosterLinked: 1, lastRosterWorld: "w" });
    expect(status.foundry.lastChatlogAt).toBeTruthy();
    expect(status.sessions[0]).toMatchObject({ id: "s1", status: "recording", hasChatlog: true, processing: false });
    expect(JSON.stringify(status)).not.toContain("secret-token");
  });

  it("warns when automatic summaries use the Anthropic provider without credentials", async () => {
    const status = await (await fetch(`${base}/status`, { headers: auth })).json();
    expect(status.llm).toMatchObject({ provider: "anthropic", credentials: null, autoSummarize: true });
    expect(status.warnings.some((w: string) => w.includes("No credentials configured for LLM provider 'anthropic'"))).toBe(true);
    expect(status.warnings.some((w: string) => w.includes("ant auth login"))).toBe(true);
  });

  it("returns captured log lines after a sequence number", async () => {
    const { record } = await import("../src/monitor.js");
    record("warn", "first");
    record("error", "second");
    const all = await (await fetch(`${base}/logs`, { headers: auth })).json();
    const first = all.find((e: { msg: string }) => e.msg === "first");
    expect(first).toMatchObject({ level: "warn" });
    const after = await (await fetch(`${base}/logs?after=${first.seq}`, { headers: auth })).json();
    expect(after.map((e: { msg: string }) => e.msg)).toEqual(["second"]);
  });

  it("saves the actor details as the session's copy when a sync names the session", async () => {
    store.createSession({ id: "s-actors", guildId: "g", channelId: "c", textChannelId: null, startedAt: new Date().toISOString() });
    const roster = store.getRoster();
    const actor = { id: "n1", name: "Mayor Vell", type: "npc", race: "Human", gender: "Male", age: "58", height: null, weight: null, hpMax: 14 };
    const res = await fetch(`${base}/roster`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ world: "w", users: [], actors: [actor], sessionId: "s-actors" }),
    });
    store.replaceRoster(roster);
    expect(res.status).toBe(200);
    const copy = JSON.parse(fs.readFileSync(path.join(dataDir, "sessions", "s-actors", "actors.json"), "utf8"));
    expect(copy).toEqual([{ ...actor, classes: [], level: null }]);
  });

});
