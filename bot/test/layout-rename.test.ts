import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-rename-"));
process.env.DATA_DIR = dataDir;

const { Store } = await import("../src/db.js");
const { sessionPaths } = await import("../src/paths.js");
const { applyLayout, planLayout } = await import("../src/migrate-layout.js");
const { trashFolder } = await import("../src/trash.js");

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

describe("layout migration: numbered game folders", () => {
  it("renames campaigns/<world>/sessions/012 to the game's id, with its merged recordings", () => {
    const store = new Store(":memory:");
    const erat = store.touchWorld("erat", "Erat");
    const insert = store.db.prepare(
      `INSERT INTO sessions (id, guild_id, channel_id, number, status, started_at, campaign_id, dir, merged_into_id, error, deleted_at)
       VALUES (?, 'g', 'c', ?, 'complete', ?, ?, ?, ?, ?, ?)`,
    );
    const rel = (folder: string, id: string) => `campaigns/erat/sessions/${folder}/recordings/${id}`;
    insert.run("game", 12, "2026-11-01T01:00:00.000Z", erat.id, rel("012", "game"), null, null, null);
    insert.run("cont", 13, "2026-11-01T03:00:00.000Z", erat.id, rel("012", "cont"), "game", "Merged into session 12 (game).", null);
    insert.run("solo", 14, "2026-11-08T01:00:00.000Z", erat.id, rel("014", "solo"), null, null, null);
    insert.run("trashed", 9, "2026-10-20T01:00:00.000Z", erat.id, rel("009", "trashed"), null, null, "2026-11-01T00:00:00.000Z");
    insert.run("done", 15, "2026-11-09T01:00:00.000Z", erat.id, rel("done", "done"), null, null, null); // already by id

    const sessions = path.join(dataDir, "campaigns", "erat", "sessions");
    write(path.join(sessions, "012", "summary.md"), "# twelve\n");
    write(path.join(sessions, "012", "recordings", "game", "timeline.json"), "{}");
    write(path.join(sessions, "012", "recordings", "cont", "timeline.json"), "{}");
    write(path.join(sessions, "014", "story", "summary.story.md"), "# fourteen\n");
    write(path.join(trashFolder("trashed"), "summary.md"), "# nine\n");
    write(path.join(sessions, "done", "summary.md"), "# fifteen\n");

    const plan = planLayout(store);
    expect(plan.games.map((g) => [g.kind, g.id, g.inTrash]).sort()).toEqual([
      ["rename", "game", false],
      ["rename", "solo", false],
      ["rename", "trashed", true],
    ]);
    expect(plan.backupBytes).toBe(0); // nothing flat to copy; only the database

    const r = applyLayout(store, plan);
    expect(r).toMatchObject({ moved: 3, errors: [] });
    expect(fs.existsSync(path.join(r.backupDir, "scribbot.db"))).toBe(true);

    expect(fs.readdirSync(sessions).sort()).toEqual(["done", "game", "solo"]);
    expect(fs.readFileSync(path.join(sessionPaths("game").dir, "summary.md"), "utf8")).toBe("# twelve\n");
    expect(sessionPaths("cont").recording).toBe(path.join(sessions, "game", "recordings", "cont"));
    expect(fs.existsSync(path.join(sessionPaths("cont").recording, "timeline.json"))).toBe(true);
    expect(fs.existsSync(path.join(sessionPaths("solo").dir, "story", "summary.story.md"))).toBe(true);
    // Numbers don't change; the trashed one stays in the trash and will be restored by id.
    expect(store.getSession("game")!.number).toBe(12);
    expect(store.getSession("trashed")!.dir).toBe(rel("trashed", "trashed"));
    expect(fs.existsSync(path.join(trashFolder("trashed"), "summary.md"))).toBe(true);

    expect(planLayout(store).games).toEqual([]);
  });
});
