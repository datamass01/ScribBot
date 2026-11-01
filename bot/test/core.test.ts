import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store, type MappingRow, type RosterRow } from "../src/db.js";
import { resolveParticipant, speakerLabel } from "../src/participants.js";
import { WavFileWriter } from "../src/wav.js";

const roster: RosterRow[] = [
  { foundry_user_id: "fu1", user_name: "Alice", is_gm: 0, actor_id: "act1", actor_name: "Thorin", actor_img: null, discord_id: null },
  { foundry_user_id: "fu2", user_name: "Carol", is_gm: 0, actor_id: "act2", actor_name: "Elara", actor_img: null, discord_id: "333" },
  { foundry_user_id: "fu3", user_name: "Gamemaster", is_gm: 1, actor_id: null, actor_name: null, actor_img: null, discord_id: "999" },
];

const mapping = (m: Partial<MappingRow> & { discord_id: string }): MappingRow => ({
  guild_id: "g",
  foundry_user_id: null,
  actor_id: null,
  character_name: null,
  is_gm: 0,
  ...m,
});

describe("resolveParticipant", () => {
  it("follows a mapping to the Foundry user's assigned character", () => {
    const p = resolveParticipant("111", "alice_d", [mapping({ discord_id: "111", foundry_user_id: "fu1" })], roster);
    expect(p).toMatchObject({ character: "Thorin", actorId: "act1", isGm: false });
    expect(speakerLabel(p)).toBe("Thorin (alice_d)");
  });

  it("prefers an explicit character name over the roster", () => {
    const p = resolveParticipant(
      "111",
      "alice_d",
      [mapping({ discord_id: "111", foundry_user_id: "fu1", character_name: "Thorin Oakenshield" })],
      roster,
    );
    expect(p.character).toBe("Thorin Oakenshield");
  });

  it("matches the Discord ID flag set in Foundry when there is no mapping", () => {
    expect(resolveParticipant("333", "carol", [], roster).character).toBe("Elara");
  });

  it("treats Foundry GMs as GM with no character", () => {
    const p = resolveParticipant("999", "dm_dave", [], roster);
    expect(p).toMatchObject({ isGm: true, character: null });
    expect(speakerLabel(p)).toBe("GM (dm_dave)");
  });

  it("falls back to the display name", () => {
    const p = resolveParticipant("444", "stranger", [], roster);
    expect(speakerLabel(p)).toBe("stranger");
  });
});

describe("Store", () => {
  it("numbers sessions per guild and merges partial mapping updates", () => {
    const store = new Store(":memory:");
    const a = store.createSession({ id: "a", guildId: "g1", channelId: "c", textChannelId: null, startedAt: "2026-01-01T00:00:00Z" });
    const b = store.createSession({ id: "b", guildId: "g1", channelId: "c", textChannelId: null, startedAt: "2026-01-08T00:00:00Z" });
    const c = store.createSession({ id: "c", guildId: "g2", channelId: "c", textChannelId: null, startedAt: "2026-01-09T00:00:00Z" });
    expect([a.number, b.number, c.number]).toEqual([1, 2, 1]);
    expect(store.findSession("g1", "2")?.id).toBe("b");

    store.upsertMapping({ guildId: "g1", discordId: "u", characterName: "Thorin" });
    store.upsertMapping({ guildId: "g1", discordId: "u", isGm: true });
    expect(store.getMappings("g1")[0]).toMatchObject({ character_name: "Thorin", is_gm: 1 });
  });
});

describe("WavFileWriter", () => {
  it("writes a header whose sizes match the PCM data", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "scrib-")), "t.wav");
    const w = new WavFileWriter(file, 48000, 1);
    w.write(Buffer.alloc(9600)); // 100 ms
    await new Promise<void>((resolve, reject) => w.end((err?: Error | null) => (err ? reject(err) : resolve())));
    const buf = fs.readFileSync(file);
    expect(buf.length).toBe(44 + 9600);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.readUInt32LE(4)).toBe(36 + 9600);
    expect(buf.readUInt32LE(24)).toBe(48000);
    expect(buf.readUInt32LE(40)).toBe(9600);
  });
});

describe("glossaryNames", async () => {
  const { glossaryNames } = await import("../src/campaign.js");
  it("takes list items up to the note, skipping headings", () => {
    expect(glossaryNames("# Glossary\n- Thorin: dwarf, fighter\n* Phandalin\nGrubnak the Vile\n\n")).toEqual([
      "Thorin",
      "Phandalin",
      "Grubnak the Vile",
    ]);
  });
});

describe("ensureCampaignFiles", async () => {
  const { ensureCampaignFiles } = await import("../src/campaign.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  it("creates missing campaign files from their templates and never overwrites", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-campaign-"));
    fs.writeFileSync(path.join(dir, "glossary.example.md"), "- Thorin\n");
    fs.writeFileSync(path.join(dir, "context.example.md"), "template\n");
    fs.writeFileSync(path.join(dir, "context.md"), "my campaign\n");
    expect(ensureCampaignFiles(dir)).toEqual([path.join(dir, "glossary.md")]);
    expect(fs.readFileSync(path.join(dir, "glossary.md"), "utf8")).toBe("- Thorin\n");
    expect(fs.readFileSync(path.join(dir, "context.md"), "utf8")).toBe("my campaign\n");
    expect(ensureCampaignFiles(dir)).toEqual([]);
  });
});
