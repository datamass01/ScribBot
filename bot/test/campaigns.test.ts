// The Campaign tab: choosing the campaign being played, each campaign's own Foundry server,
// character mappings and notes, and the migration that keeps older mappings for every campaign.
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { campaignFolderOfPath, campaignNoteFile } from "../src/campaign.js";
import { ALL_CAMPAIGNS, MIGRATIONS, Store, UNASSIGNED_FOLDER } from "../src/db.js";
import { allowedOrigins } from "../src/api/origins.js";
import { foundryTarget } from "../src/foundry/index.js";
import { type FoundryPage, type FoundryTarget, HeadlessFoundry } from "../src/foundry/client.js";

const session = (store: Store, id: string, campaignId?: number) =>
  store.createSession({ id, guildId: "g", channelId: "v", textChannelId: null, startedAt: new Date().toISOString(), ...(campaignId ? { campaignId } : {}) });

describe("the campaign being played", () => {
  it("is the chosen campaign, else the world Foundry synced last", () => {
    const store = new Store(":memory:");
    const tomb = store.touchWorld("tomb", "Tomb of Annihilation");
    const strahd = store.createCampaign({ name: "Curse of Strahd" });
    expect(store.defaultCampaign().id).toBe(tomb.id); // automatic
    store.selectCampaign(strahd.id);
    expect(store.defaultCampaign().id).toBe(strahd.id);
    expect(session(store, "a").campaign_id).toBe(strahd.id); // new recordings go there
    // Another world syncing doesn't take over a chosen campaign.
    store.touchWorld("tomb", null);
    expect(store.defaultCampaign().id).toBe(strahd.id);
    store.selectCampaign(null);
    expect(store.defaultCampaign().id).toBe(tomb.id);
  });

  it("gets its world from the first sync while it has none, and never steals another campaign's", () => {
    const store = new Store(":memory:");
    const tomb = store.touchWorld("tomb", "Tomb");
    const strahd = store.createCampaign({ name: "Curse of Strahd" });
    expect(strahd.folder).toBe("curse-of-strahd");
    store.selectCampaign(strahd.id);
    store.touchWorld("tomb", null); // a world that is already a campaign stays there
    expect(store.getCampaign(strahd.id)!.world_id).toBeNull();
    const claimed = store.touchWorld("strahd-world", "Barovia");
    expect(claimed.id).toBe(strahd.id);
    expect(store.getCampaign(strahd.id)).toMatchObject({ world_id: "strahd-world", title: "Barovia", folder: "curse-of-strahd" });
    expect(store.campaignByWorld("tomb")!.id).toBe(tomb.id);
    // The layout migration's touches (seen = false) never claim.
    const other = store.createCampaign({ name: "Other" });
    store.selectCampaign(other.id);
    expect(store.touchWorld("old-world", null, false).id).not.toBe(other.id);
  });

  it("refuses the unassigned campaign and duplicate worlds; moves an empty campaign's world", () => {
    const store = new Store(":memory:");
    const un = store.unassignedCampaign();
    expect(() => store.updateCampaign(un.id, { worldId: "w" })).toThrow(/unassigned/);
    const busy = store.touchWorld("busy", null);
    session(store, "s1", busy.id);
    const empty = store.touchWorld("empty", null);
    const mine = store.createCampaign({ name: "Mine" });
    expect(() => store.createCampaign({ name: "Dup", worldId: "busy" })).toThrow(/already/);
    expect(() => store.updateCampaign(mine.id, { worldId: "busy" })).toThrow(/1 session/);
    store.updateCampaign(mine.id, { worldId: "empty" });
    expect(store.getCampaign(empty.id)).toBeUndefined(); // it had nothing, so it was removed
    expect(store.campaignByWorld("empty")!.id).toBe(mine.id);
    expect(() => store.deleteCampaign(busy.id)).toThrow(/session/);
  });

  it("keeps the Foundry login per campaign; a blank address joins nothing, never .env's", () => {
    const store = new Store(":memory:");
    expect(foundryTarget(store).url).toBeTruthy(); // no campaign yet: FOUNDRY_URL (or the first origin)
    const c = store.createCampaign({ name: "Strahd", worldId: "strahd" });
    store.selectCampaign(c.id);
    expect(foundryTarget(store)).toMatchObject({ url: null, campaignId: c.id });
    store.updateCampaign(c.id, { foundryUrl: " https://vtt.example.com/ ", foundryPassword: "pw" });
    const t = foundryTarget(store);
    expect(t).toMatchObject({ url: "https://vtt.example.com", password: "pw", campaignId: c.id, campaign: "Strahd", world: "strahd" });
    expect(t.user).toBe("ScribBot"); // the user still falls back to FOUNDRY_USER
    expect(allowedOrigins(store).has("https://vtt.example.com")).toBe(true);
    store.updateCampaign(c.id, { foundryUrl: null, foundryPassword: "" });
    expect(store.getCampaign(c.id)).toMatchObject({ foundry_url: null, foundry_password: null });
    expect(allowedOrigins(store).has("https://vtt.example.com")).toBe(false);
    expect(foundryTarget(store).url).toBeNull();
    // The unassigned campaign never has a server of its own.
    store.selectCampaign(store.unassignedCampaign().id);
    expect(foundryTarget(store).campaignId).toBeNull();
  });
});

describe("character mappings per campaign", () => {
  it("lets a campaign override a shared mapping without touching other campaigns", () => {
    const store = new Store(":memory:");
    const a = store.createCampaign({ name: "A" });
    const b = store.createCampaign({ name: "B" });
    store.upsertMapping({ campaignId: ALL_CAMPAIGNS, guildId: "g", discordId: "1", characterName: "Thorin" });
    store.upsertMapping({ campaignId: a.id, guildId: "g", discordId: "1", isGm: true }); // keeps the shared character name
    expect(store.getMappings("g", a.id)).toMatchObject([{ campaign_id: a.id, character_name: "Thorin", is_gm: 1 }]);
    expect(store.getMappings("g", b.id)).toMatchObject([{ campaign_id: ALL_CAMPAIGNS, character_name: "Thorin", is_gm: 0 }]);
    store.deleteMapping("g", "1", a.id); // A's own goes; the shared one shows through again
    expect(store.getMappings("g", a.id)).toMatchObject([{ campaign_id: ALL_CAMPAIGNS }]);
    store.deleteCampaign(b.id);
    expect(store.getCampaignMappings(a.id)).toHaveLength(1);
  });

  it("migrates older mappings to every campaign", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "scrib-mig5-")), "scribbot.db");
    const db = new Database(file);
    for (const sql of MIGRATIONS.slice(0, 4)) db.exec(sql);
    db.pragma("user_version = 4");
    db.prepare("INSERT INTO mappings (guild_id, discord_id, character_name, is_gm) VALUES ('g', '1', 'Thorin', 0)").run();
    db.prepare("INSERT INTO campaigns (world_id, folder, created_at) VALUES ('w', 'w', 'x')").run();
    db.close();
    const store = new Store(file);
    const c = store.campaignByWorld("w")!;
    expect(store.getMappings("g", c.id)).toMatchObject([{ campaign_id: ALL_CAMPAIGNS, character_name: "Thorin" }]);
    expect(store.getCampaign(c.id)).toMatchObject({ foundry_url: null, selected_at: null });
    store.db.close();
  });
});

describe("campaign notes", () => {
  it("are the campaign's own, else the shared ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-notes-"));
    fs.writeFileSync(path.join(dir, "glossary.md"), "- Shared");
    expect(campaignNoteFile("glossary.md", "strahd", dir)).toBe(path.join(dir, "glossary.md"));
    fs.mkdirSync(path.join(dir, "strahd"));
    fs.writeFileSync(path.join(dir, "strahd", "glossary.md"), "- Strahd");
    expect(campaignNoteFile("glossary.md", "strahd", dir)).toBe(path.join(dir, "strahd", "glossary.md"));
    expect(campaignNoteFile("glossary.md", "..", dir)).toBe(path.join(dir, "glossary.md"));
    expect(campaignNoteFile("context.md", "strahd", dir)).toBe(path.join(dir, "context.md"));
  });

  it("are found from a session or recording folder", () => {
    expect(campaignFolderOfPath(path.join("D:", "data", "campaigns", "strahd", "sessions", "2026-11-01-a", "recordings", "x"))).toBe("strahd");
    expect(campaignFolderOfPath("data/campaigns/_unassigned/sessions/x")).toBe(UNASSIGNED_FOLDER);
    expect(campaignFolderOfPath("data/sessions/2026-11-01-a")).toBeNull();
  });
});

describe("the headless client and the campaign being played", () => {
  const quiet = () => {};
  function pages() {
    const opened: { target: FoundryTarget | undefined; closed: boolean; imports: string[] }[] = [];
    const launch = vi.fn(async (target?: FoundryTarget): Promise<FoundryPage> => {
      const p = { target, closed: false, imports: [] as string[] };
      opened.push(p);
      return {
        status: async () => ({ ready: true, botSocket: true, world: target?.world ?? "w1", user: "ScribBot", gmOnline: true }),
        announce: async () => {},
        exportChatlog: async () => {},
        importSummary: async (id: string) => (p.imports.push(id), { imported: true, name: id }),
        importStory: async (id: string) => (p.imports.push(`story:${id}`), { imported: true, name: id }),
        onClosed: () => {},
        close: async () => void (p.closed = true),
      };
    });
    return { launch, opened };
  }

  it("joins the campaign's server, and switches when it changes but not during a recording", async () => {
    let target: FoundryTarget = { url: "http://a", user: "ScribBot", world: "wa" };
    const { launch, opened } = pages();
    const c = new HeadlessFoundry({ mode: "always", url: "http://env", user: "ScribBot", target: () => target, launch, chatlogWaitMs: 50, log: quiet });
    c.start();
    await vi.waitFor(() => expect(c.status().state).toBe("connected"));
    expect(opened[0]!.target?.url).toBe("http://a");

    c.onEvent({ type: "session.started", sessionId: "s1", number: 1, startedAt: "x" });
    target = { url: "http://b", user: "ScribBot", world: "wb" };
    c.retarget();
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toHaveLength(1); // still recording on a
    expect(c.status().url).toBe("http://a");

    c.onEvent({ type: "session.stopped", sessionId: "s1", number: 1, startedAt: "x", endedAt: "y" });
    c.onEvent({ type: "chatlog.received", sessionId: "s1" } as never);
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    expect(opened[0]!.closed).toBe(true);
    expect(opened[1]!.target?.url).toBe("http://b");
    await c.stop();
  });

  it("doesn't join anything for a campaign without an address, and joins once it has one", async () => {
    let target: FoundryTarget = { url: null, user: "ScribBot", campaign: "Strahd" };
    const { launch, opened } = pages();
    const c = new HeadlessFoundry({ mode: "always", url: "http://env", user: "ScribBot", target: () => target, launch, chatlogWaitMs: 50, log: quiet });
    c.start();
    c.onEvent({ type: "session.started", sessionId: "s1", number: 1, startedAt: "x" });
    await new Promise((r) => setTimeout(r, 20));
    expect(launch).not.toHaveBeenCalled();
    expect(c.status()).toMatchObject({ state: "idle", url: null });
    expect(c.status().error).toMatch(/no Foundry address/);
    target = { url: "http://a", user: "ScribBot", campaign: "Strahd" };
    c.retarget();
    await vi.waitFor(() => expect(c.status().state).toBe("connected"));
    expect(opened[0]!.target?.url).toBe("http://a");
    // Clearing the address mid-recording keeps that recording's page; afterwards it leaves and joins nothing.
    target = { url: null, user: "ScribBot", campaign: "Strahd" };
    c.retarget();
    await new Promise((r) => setTimeout(r, 20));
    expect(opened[0]!.closed).toBe(false);
    c.onEvent({ type: "session.stopped", sessionId: "s1", number: 1, startedAt: "x", endedAt: "y" });
    c.onEvent({ type: "chatlog.received", sessionId: "s1" } as never);
    await vi.waitFor(() => expect(opened[0]!.closed).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(launch).toHaveBeenCalledTimes(1);
    await c.stop();
  });

  it("imports a journal only into its own campaign's world", async () => {
    const worldOf: Record<string, string> = { s1: "wa", s2: "wb" };
    let target: FoundryTarget = { url: "http://a", user: "ScribBot", world: "wa" };
    const { launch, opened } = pages();
    const c = new HeadlessFoundry({
      mode: "session", url: "http://env", user: "ScribBot", target: () => target, launch, chatlogWaitMs: 50, log: quiet,
      belongs: (id, world) => !world || worldOf[id] === world,
    });
    c.start();
    c.onEvent({ type: "summary.ready", sessionId: "s2" } as never); // world b: doesn't join a
    c.onEvent({ type: "summary.ready", sessionId: "s1" } as never);
    await vi.waitFor(() => expect(opened[0]?.imports).toEqual(["s1"]));
    expect(c.status().pendingImports).toEqual(["s2"]);
    await vi.waitFor(() => expect(opened[0]!.closed).toBe(true));
    target = { url: "http://b", user: "ScribBot", world: "wb" };
    c.retarget();
    await vi.waitFor(() => expect(opened[1]?.imports).toEqual(["s2"]));
    expect(c.status().pendingImports).toEqual([]);
    await c.stop();
  });
});

describe("/scrib map in the campaign being played", () => {
  it("writes the playing campaign's mappings and refuses Foundry users from another world", async () => {
    const { CommandHandler } = await import("../src/commands.js");
    const { bus } = await import("../src/events.js");
    const store = new Store(":memory:");
    const cmd = new CommandHandler({} as never, store);
    expect(cmd.playingCampaignId()).toBe(ALL_CAMPAIGNS); // no campaign yet: shared by all

    const strahd = store.createCampaign({ name: "Strahd", worldId: "strahd" });
    store.selectCampaign(strahd.id);
    store.replaceRoster([{ foundry_user_id: "fu1", user_name: "Alice", is_gm: 0, actor_id: "a1", actor_name: "Ireena", actor_img: null, discord_id: null }]);
    store.setMeta("roster_world", "tomb");
    const events: unknown[] = [];
    const off = bus.onEvent((e) => events.push(e));
    try {
      expect(() => cmd.setMapping("g", "123456", "foundry:fu1")).toThrow(/world tomb/);
      expect(cmd.setMapping("g", "123456", "Ireena")).toContain("Ireena");
      expect(store.getMappings("g", strahd.id)).toMatchObject([{ campaign_id: strahd.id, character_name: "Ireena" }]);

      store.setMeta("roster_world", "strahd");
      expect(cmd.setMapping("g", "123456", "foundry:fu1")).toContain("Foundry user Alice");
      expect(events).toContainEqual({ type: "roster.link", links: [{ foundryUserId: "fu1", discordId: "123456" }] });
      cmd.clearMapping("g", "123456");
      expect(store.getMappings("g", strahd.id)).toEqual([]);
    } finally {
      off();
    }
  });
});
