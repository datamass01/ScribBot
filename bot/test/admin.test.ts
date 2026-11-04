import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-admin-"));
process.env.DATA_DIR = dataDir;
process.env.API_TOKEN = "secret-token";
process.env.API_PORT = "0";
process.env.WORKER_URL = "http://127.0.0.1:9";
process.env.LLM_PROVIDER = "anthropic";
process.env.REVIEW_BEFORE_FOUNDRY = "false"; // these test sending as such; review.test.ts covers the review gate
process.env.ANTHROPIC_API_KEY = "";
process.env.ANTHROPIC_AUTH_TOKEN = "";
delete process.env.ANTHROPIC_PROFILE;
process.env.ANTHROPIC_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-ant-"));
process.env.AUDIO_RETENTION_DAYS = "14";

type Store = import("../src/db.js").Store;
type SessionRow = import("../src/db.js").SessionRow;
type BotEvent = import("../src/events.js").BotEvent;
const { sessionPaths } = await import("../src/paths.js");

/** Records what the routes asked the Discord side to do. */
function fakeSessions() {
  const calls: string[] = [];
  const recording = new Set<string>();
  return {
    calls,
    recording,
    listChannels: () => [{ id: "g1", name: "Table", voice: [], text: [] }],
    isRecording: (id: string) => recording.has(id),
    startFromConsole: async (o: { guildId: string; voiceChannelId: string; textChannelId: string }): Promise<SessionRow> => {
      calls.push(`start ${o.guildId} ${o.voiceChannelId} ${o.textChannelId}`);
      throw new Error("Already recording in this server. Stop that recording first.");
    },
    stopFromConsole: async (id: string): Promise<SessionRow> => {
      calls.push(`stop ${id}`);
      throw new Error("That session isn't recording.");
    },
    processFromConsole: async (s: SessionRow, o: { summaryOnly?: boolean; retranscribe?: boolean }) => {
      calls.push(`${o.summaryOnly ? "summarize" : "process"} ${s.id}${o.retranscribe ? " retranscribe" : ""}`);
    },
    postToDiscord: async (s: SessionRow, what: string, channelId?: string) => {
      calls.push(`discord ${s.id} ${what} ${channelId ?? "-"}`);
      return { channelId: channelId ?? "t1", channelName: "table" };
    },
    reviseFromConsole: async (s: SessionRow, feedback: string) => {
      calls.push(`revise ${s.id} ${feedback}`);
    },
    mergeInto: (a: SessionRow, b: SessionRow) => {
      calls.push(`merge ${b.id} into ${a.id}`);
      return "merged";
    },
    setMapping: (g: string, d: string, v: string, c?: number) => {
      calls.push(`map ${g} ${d} ${v} @${c}`);
      return `**${v}**`;
    },
    clearMapping: (g: string, d: string, c?: number) => void calls.push(`unmap ${g} ${d} @${c}`),
    setGm: (g: string, d: string, gm: boolean, c?: number) => void calls.push(`gm ${g} ${d} ${gm} @${c}`),
    playingCampaignId: () => 0,
    memberNames: async (_g: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, `user-${id}`])),
  };
}

describe("Console admin API", () => {
  let app: Awaited<ReturnType<typeof import("../src/api/server.js").startApi>>;
  let store: Store;
  let base: string;
  let sessions: ReturnType<typeof fakeSessions>;
  const restarts: string[] = [];
  const events: BotEvent[] = [];
  const auth = { authorization: "Bearer secret-token" };
  const json = { ...auth, "content-type": "application/json" };
  let seq = 0;

  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { ...(body === undefined ? auth : json), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const newSession = (files: Record<string, string> = {}) => {
    const id = `2026-11-01-s${++seq}`;
    const row = store.createSession({ id, guildId: "g1", channelId: "v1", textChannelId: "t1", startedAt: new Date(Date.UTC(2026, 10, 1, seq)).toISOString() });
    store.setSessionStatus(id, "complete");
    const dir = sessionPaths(id).dir;
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    return row;
  };

  beforeAll(async () => {
    const { Store } = await import("../src/db.js");
    const { startApi } = await import("../src/api/server.js");
    const { bus } = await import("../src/events.js");
    bus.onEvent((e) => events.push(e));
    store = new Store(":memory:");
    sessions = fakeSessions();
    app = await startApi(store, () => null, {}, { sessions, restart: (why) => restarts.push(why) });
    const addr = app.server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => app?.close());
  beforeEach(() => {
    sessions.calls.length = 0;
    sessions.recording.clear();
    events.length = 0;
  });

  it("needs the token and refuses any request from a web page", async () => {
    expect((await fetch(`${base}/admin/sessions`)).status).toBe(401);
    const fromPage = await call("GET", "/admin/sessions", undefined, { origin: "http://localhost:30000" });
    expect(fromPage.status).toBe(403);
    expect(fromPage.body.error).toMatch(/web page/);
    expect((await call("GET", "/admin/sessions")).status).toBe(200);
  });

  it("lists sessions with their files, and saves a title and notes", async () => {
    const s = newSession({ "transcript.json": "{}", "summary.json": "{}" });
    const listed = (await call("GET", "/admin/sessions")).body.sessions.find((x: any) => x.id === s.id);
    expect(listed).toMatchObject({ number: s.number, hasTranscript: true, hasSummary: true, hasChatlog: false, deletedAt: null, recording: false });
    const patched = await call("PATCH", `/admin/sessions/${s.id}`, { title: "  The Sunken Keep ", notes: "" });
    expect(patched.body.session).toMatchObject({ title: "The Sunken Keep", notes: null });
  });

  it("moves a deleted session to the trash, restores it, and empties it for good", async () => {
    const s = newSession({ "transcript.md": "# hi" });
    const dir = sessionPaths(s.id).dir;
    const trash = path.join(dataDir, "trash", s.id);

    const del = await call("DELETE", `/admin/sessions/${s.id}`);
    expect(del.status).toBe(200);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(trash, "transcript.md"))).toBe(true);
    expect((await call("GET", "/admin/sessions")).body.sessions.map((x: any) => x.id)).not.toContain(s.id);
    expect((await call("GET", "/admin/sessions?deleted=only")).body.sessions.map((x: any) => x.id)).toContain(s.id);
    expect(store.latestSession()?.id).not.toBe(s.id);

    // A session in the trash can't be processed, merged or posted.
    expect((await call("POST", `/admin/sessions/${s.id}/process`, {})).status).toBe(409);
    expect(sessions.calls).toEqual([]);

    expect((await call("POST", `/admin/sessions/${s.id}/restore`, {})).status).toBe(200);
    expect(fs.existsSync(path.join(dir, "transcript.md"))).toBe(true);

    await call("DELETE", `/admin/sessions/${s.id}`);
    expect((await call("DELETE", `/admin/trash/${s.id}`)).status).toBe(200);
    expect(fs.existsSync(trash)).toBe(false);
    expect(store.getSession(s.id)).toMatchObject({ purged_at: expect.any(String) });
    // A trashed number is free again: the next session follows the highest one not in the trash.
    const highest = Math.max(0, ...store.listSessions(1000).map((x) => x.number));
    expect(newSession().number).toBe(highest + 1);
  });

  it("won't delete a session that is recording or still in the live folder list twice", async () => {
    const s = newSession();
    sessions.recording.add(s.id);
    const res = await call("DELETE", `/admin/sessions/${s.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/recording/);
    expect(fs.existsSync(sessionPaths(s.id).dir)).toBe(true);
  });

  it("passes process, summarize and merge to the same code as the slash commands", async () => {
    const a = newSession();
    const b = newSession();
    expect((await call("POST", `/admin/sessions/${a.id}/process`, { retranscribe: true })).status).toBe(200);
    expect((await call("POST", `/admin/sessions/${a.id}/summarize`, {})).status).toBe(200);
    expect((await call("POST", `/admin/sessions/${b.id}/merge`, { into: a.id })).body).toEqual({ ok: true, message: "merged" });
    expect(sessions.calls).toEqual([`process ${a.id} retranscribe`, `summarize ${a.id}`, `merge ${b.id} into ${a.id}`]);
  });

  it("returns a refusal as a message and keeps serving (nothing escapes into the bot)", async () => {
    const s = newSession();
    const start = await call("POST", "/admin/sessions", { guildId: "g1", voiceChannelId: "v1", textChannelId: "t1" });
    expect(start).toEqual({ status: 409, body: { ok: false, error: "Already recording in this server. Stop that recording first." } });
    expect((await call("POST", `/admin/sessions/${s.id}/stop`, {})).status).toBe(409);
    expect((await call("POST", "/admin/sessions", { guildId: "g1" })).status).toBe(400);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("posts a summary to Foundry even with auto-import off, and records when", async () => {
    const none = newSession();
    expect((await call("POST", `/admin/sessions/${none.id}/summary/import`, {})).status).toBe(409);
    const s = newSession({ "summary.json": JSON.stringify({ summary: { title: "Into the Mire" } }) });
    const res = await call("POST", `/admin/sessions/${s.id}/summary/import`, {});
    expect(res.body).toEqual({ ok: true, title: "Into the Mire", foundryConnected: false });
    expect(events).toContainEqual({ type: "summary.ready", sessionId: s.id, number: s.number, title: "Into the Mire", manual: true });
    expect(store.getSession(s.id)?.summary_sent_at).toBeTruthy();
  });

  it("posts a session's content to Discord only when the Console asks", async () => {
    const s = newSession({ "summary.json": "{}" });
    const ok = await call("POST", `/admin/sessions/${s.id}/discord`, { what: "transcript", channelId: "123456789012" });
    expect(ok.body).toEqual({ ok: true, channelId: "123456789012", channelName: "table" });
    expect((await call("POST", `/admin/sessions/${s.id}/discord`, { what: "summary" })).status).toBe(200);
    expect((await call("POST", `/admin/sessions/${s.id}/discord`, { what: "audio" })).status).toBe(400);
    expect((await call("POST", `/admin/sessions/${s.id}/discord`, { what: "story", channelId: "#general" })).status).toBe(400);
    expect(sessions.calls).toEqual([`discord ${s.id} transcript 123456789012`, `discord ${s.id} summary -`]);
  });

  it("records Foundry's confirmation that the journal entry exists", async () => {
    const ack = (id: string, body: unknown, token = "secret-token") =>
      fetch(`${base}/sessions/${id}/journal`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "http://localhost:30000" },
        body: JSON.stringify(body),
      });
    const s = newSession({ "summary.json": JSON.stringify({ summary: { title: "Into the Mire" } }) });
    await call("POST", `/admin/sessions/${s.id}/summary/import`, {});
    const sent = (await call("GET", `/admin/sessions/${s.id}`)).body;
    expect(sent).toMatchObject({ summarySentAt: expect.any(String), summaryJournalAt: null });

    expect((await ack(s.id, { kind: "summary", journalId: "j1", name: "x" }, "nope")).status).toBe(401);
    expect((await ack(s.id, { kind: "notes", journalId: "j1", name: "x" })).status).toBe(400);
    expect((await ack("no-such-session", { kind: "summary", journalId: "j1", name: "x" })).status).toBe(404);
    // The module calls from Foundry's page, so this route (unlike /admin) accepts an Origin.
    const ok = await ack(s.id, { kind: "summary", journalId: "j1", name: "Session 7: Into the Mire", world: "w" });
    expect(await ok.json()).toEqual({ ok: true, sessions: 1 });
    const done = (await call("GET", `/admin/sessions/${s.id}`)).body;
    expect(done.summaryJournalName).toBe("Session 7: Into the Mire");
    expect(done.summaryJournalAt >= done.summarySentAt).toBe(true);
    expect(done.storyJournalAt).toBeNull();
  });

  it("marks every session a stitched story covers when Foundry confirms it", async () => {
    const a = newSession();
    const b = newSession();
    const dir = path.join(sessionPaths(b.id).dir, "story");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.story.md"), "# The Long Night\n\n## High level summary\n\nThey won.\n");
    fs.writeFileSync(path.join(dir, "lines.json"), JSON.stringify({ sessions: [{ id: a.id }, { id: b.id }] }));
    expect((await call("POST", `/admin/sessions/${a.id}/story/import`, {})).status).toBe(200);
    expect(store.getSession(b.id)?.story_sent_at).toBeTruthy();
    const res = await fetch(`${base}/sessions/${b.id}/journal`, {
      method: "POST",
      headers: { ...json },
      body: JSON.stringify({ kind: "story", journalId: "j2", name: "Session 5 + 6: The Long Night" }),
    });
    expect(await res.json()).toEqual({ ok: true, sessions: 2 });
    for (const id of [a.id, b.id]) expect(store.getSession(id)?.story_journal_name).toBe("Session 5 + 6: The Long Night");
  });

  it("previews only the known text files", async () => {
    const s = newSession({ "transcript.md": "# Session\nhello", "chatlog.json": "{}" });
    const detail = (await call("GET", `/admin/sessions/${s.id}`)).body;
    expect(detail.previews).toEqual(["transcript.md"]);
    expect(detail.files.map((f: any) => f.name)).toEqual(["chatlog.json", "transcript.md"]);
    expect((await call("GET", `/admin/sessions/${s.id}/preview/transcript.md`)).body.text).toContain("hello");
    expect((await call("GET", `/admin/sessions/${s.id}/preview/chatlog.json`)).status).toBe(404);
    expect((await call("GET", `/admin/sessions/${s.id}/preview/..%2Fscribbot.db`)).status).toBe(404);
  });

  it("maps speakers through the slash command code and validates ids", async () => {
    expect((await call("PUT", "/admin/mappings/g1/123456789", { character: "Thorin" })).body).toEqual({ ok: true, mapped: "**Thorin**" });
    expect((await call("POST", "/admin/mappings/g1/123456789/gm", { isGm: true })).status).toBe(200);
    expect((await call("DELETE", "/admin/mappings/g1/123456789")).status).toBe(200);
    expect((await call("PUT", "/admin/mappings/g1/not-an-id", { character: "Thorin" })).status).toBe(400);
    expect(sessions.calls).toEqual(["map g1 123456789 Thorin @0", "gm g1 123456789 true @0", "unmap g1 123456789 @0"]);
  });

  it("changes a named campaign's mappings, and refuses an unknown one", async () => {
    const c = store.createCampaign({ name: "Mapping test" });
    expect((await call("PUT", `/admin/mappings/g1/123456789?campaign=${c.id}`, { character: "Elara" })).status).toBe(200);
    expect((await call("DELETE", `/admin/mappings/g1/123456789?campaign=${c.id}`)).status).toBe(200);
    expect((await call("PUT", "/admin/mappings/g1/123456789?campaign=99999", { character: "Elara" })).status).toBe(404);
    expect(sessions.calls).toEqual([`map g1 123456789 Elara @${c.id}`, `unmap g1 123456789 @${c.id}`]);
    store.deleteCampaign(c.id);
  });

  it("lists a campaign's mappings with the shared ones it doesn't override", async () => {
    const c = store.createCampaign({ name: "Mapped campaign" });
    store.upsertMapping({ campaignId: 0, guildId: "g1", discordId: "111111", characterName: "Thorin" });
    store.upsertMapping({ campaignId: 0, guildId: "g1", discordId: "222222", characterName: "Elara" });
    store.upsertMapping({ campaignId: c.id, guildId: "g1", discordId: "222222", characterName: "Grubnak" });
    const r = (await call("GET", `/admin/mappings?campaign=${c.id}`)).body;
    expect(r.mappings.map((m: any) => [m.discordId, m.character, m.shared])).toEqual([["111111", "Thorin", true], ["222222", "Grubnak", false]]);
    store.deleteMapping("g1", "111111", 0);
    store.deleteMapping("g1", "222222", 0);
    store.deleteCampaign(c.id);
  });

  it("manages campaigns for the Campaign tab without ever returning a password", async () => {
    const created = await call("POST", "/admin/campaigns", { name: "Curse of Strahd" });
    expect(created.status).toBe(200);
    const id = created.body.campaign.id;
    expect(created.body.campaign).toMatchObject({ name: "Curse of Strahd", folder: "curse-of-strahd", worldId: null });

    const patch = await call("PATCH", `/admin/campaigns/${id}`, {
      worldId: "strahd", foundryUrl: "https://foundry.example.com/game", foundryUser: "Scribe", foundryPassword: "hunter2",
    });
    expect(patch.status).toBe(200);
    expect((await call("PATCH", `/admin/campaigns/${id}`, { foundryUrl: "ftp://nope" })).status).toBe(400);

    const list = await call("GET", "/admin/campaigns");
    expect(JSON.stringify(list.body)).not.toContain("hunter2");
    const c = list.body.campaigns.find((x: any) => x.id === id);
    expect(c).toMatchObject({ worldId: "strahd", foundry: { url: "https://foundry.example.com", user: "Scribe", passwordSet: true } });
    expect(list.body.foundryDefaults).toHaveProperty("passwordSet");
    expect(list.body.foundryDefaults).not.toHaveProperty("url"); // .env's address is never shown for a campaign

    // Choosing it makes it the campaign being played; null goes back to automatic.
    expect((await call("POST", "/admin/campaigns/playing", { campaignId: id })).body.playing).toMatchObject({ id, name: "Curse of Strahd" });
    expect((await call("GET", "/admin/campaigns")).body.chosenId).toBe(id);
    expect(store.defaultCampaign().id).toBe(id);
    expect((await call("POST", "/admin/campaigns/playing", { campaignId: null })).status).toBe(200);
    expect((await call("GET", "/admin/campaigns")).body.chosenId).toBeNull();

    // Clearing the password; deleting is refused once it holds a session.
    await call("PATCH", `/admin/campaigns/${id}`, { foundryPassword: null });
    expect(store.getCampaign(id)!.foundry_password).toBeNull();
    const s = store.createSession({ id: "2026-11-02-camp", guildId: "g1", channelId: "v", textChannelId: null, startedAt: new Date().toISOString(), campaignId: id });
    const refused = await call("DELETE", `/admin/campaigns/${id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("1 session");
    store.db.prepare("DELETE FROM sessions WHERE id = ?").run(s.id);
    expect((await call("DELETE", `/admin/campaigns/${id}`)).status).toBe(200);
    expect(store.getCampaign(id)).toBeUndefined();
  });

  it("refuses to restart while recording and restarts otherwise", async () => {
    const s = newSession();
    sessions.recording.add(s.id);
    expect((await call("POST", "/admin/restart", {})).status).toBe(409);
    sessions.recording.clear();
    expect((await call("POST", "/admin/restart", {})).body).toEqual({ ok: true, restarting: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(restarts).toEqual(["restart requested from the Console"]);
  });

  it("lists the models a provider accepts, for the Console's model help", async () => {
    const claude = await call("GET", "/admin/llm/models?provider=claude-code");
    expect(claude.status).toBe(200);
    expect(claude.body).toMatchObject({ provider: "claude-code", source: "fixed" });
    expect(claude.body.models.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining(["opus", "sonnet", "claude-opus-5-5"]));
    const local = await call("GET", "/admin/llm/models?provider=openai-compatible");
    expect(local.body.models).toEqual([]);
    expect(local.body.notes.join(" ")).toMatch(/ollama list/);
    expect((await call("GET", "/admin/llm/models?provider=nope")).status).toBe(400);
  });

  it("says why an LLM test can't run without credentials", async () => {
    const res = await call("POST", "/admin/llm/test", {});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ANTHROPIC_API_KEY|credentials/i);
  });
});

describe("without the Console wired in", () => {
  it("has no admin routes", async () => {
    const { Store } = await import("../src/db.js");
    const { startApi } = await import("../src/api/server.js");
    const app = await startApi(new Store(":memory:"), () => null);
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/admin/sessions`, { headers: { authorization: "Bearer secret-token" } });
    expect(res.status).toBe(404);
    await app.close();
  });
});
