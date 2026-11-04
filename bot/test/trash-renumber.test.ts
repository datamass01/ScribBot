import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrib-trash-"));
process.env.DATA_DIR = dataDir;

const { Store } = await import("../src/db.js");
const { sessionPaths } = await import("../src/paths.js");
const { deleteSession, restoreSession, trashFolder } = await import("../src/trash.js");

type StoreT = InstanceType<typeof Store>;
const notRecording = () => false;

describe("trash numbering", () => {
  let store: StoreT;
  let hour = 0;

  const add = () => {
    const id = `2026-11-01-r${++hour}`;
    const row = store.createSession({ id, guildId: "g1", channelId: "v1", textChannelId: null, startedAt: new Date(Date.UTC(2026, 10, 1, hour)).toISOString() });
    store.setSessionStatus(id, "complete");
    fs.mkdirSync(sessionPaths(id).recording, { recursive: true });
    fs.writeFileSync(path.join(sessionPaths(id).dir, "summary.md"), id);
    return row;
  };
  const trash = (id: string) => deleteSession(store, store.getSession(id)!, notRecording);
  const restore = (id: string) => restoreSession(store, store.getSession(id)!);
  const num = (id: string) => store.getSession(id)!.number;
  /** Each game's folder is named by its id and still holds its own files. */
  const inPlace = (id: string) =>
    path.basename(sessionPaths(id).dir) === id && fs.readFileSync(path.join(sessionPaths(id).dir, "summary.md"), "utf8") === id;
  /** Pretend a session started earlier (as if it was recorded before the one it clashes with). */
  const startedAt = (id: string, iso: string) => store.db.prepare("UPDATE sessions SET started_at = ? WHERE id = ?").run(iso, id);

  beforeEach(() => {
    fs.rmSync(path.join(dataDir, "campaigns"), { recursive: true, force: true });
    fs.rmSync(path.join(dataDir, "trash"), { recursive: true, force: true });
    store = new Store(":memory:");
  });

  it("numbers the next session after the highest one that isn't in the trash", () => {
    const [a, b, c] = [add(), add(), add()];
    expect([a.number, b.number, c.number]).toEqual([1, 2, 3]);
    trash(c.id);
    expect(add().number).toBe(3);
    // A trashed session in the middle doesn't free the top number.
    trash(a.id);
    expect(add().number).toBe(4);
  });

  it("restores to the same folder without renumbering when its number is free", () => {
    const [, b] = [add(), add(), add()];
    trash(b.id);
    expect(fs.existsSync(path.join(trashFolder(b.id), "summary.md"))).toBe(true);
    expect(restore(b.id)).toMatchObject({ number: 2, renumbered: [], message: "Session 2 restored." });
    expect(inPlace(b.id)).toBe(true);
    expect(fs.existsSync(trashFolder(b.id))).toBe(false);
  });

  it("moves the later-starting of two clashing sessions up, and the ones after it, without moving folders", () => {
    const old = add();
    trash(old.id);
    const new1 = add(); // takes number 1
    const new2 = add();
    expect([new1.number, new2.number]).toEqual([1, 2]);
    const dirs = [new1.id, new2.id].map((id) => store.getSession(id)!.dir);

    const r = restore(old.id);
    // The restored session started first, so it keeps 1; the newer 1 becomes 2, and 2 becomes 3.
    expect(r.number).toBe(1);
    expect([num(old.id), num(new1.id), num(new2.id)]).toEqual([1, 2, 3]);
    expect([old.id, new1.id, new2.id].every(inPlace)).toBe(true);
    expect([new1.id, new2.id].map((id) => store.getSession(id)!.dir)).toEqual(dirs);
    expect(r.message).toBe("Session 1 restored. Renumbered to make room: 1 → 2, 2 → 3.");
  });

  it("moves the restored session up when it is the newer one, stopping at the first gap", () => {
    const [s1, s2, s3, s4, s5] = [add(), add(), add(), add(), add()];
    trash(s2.id);
    trash(s4.id); // leaves a gap at 4
    // s1 is renumbered to 2 (as if recorded earlier while 2 was in the trash).
    store.db.prepare("UPDATE sessions SET number = 2 WHERE id = ?").run(s1.id);
    startedAt(s1.id, "2026-10-01T00:00:00.000Z");

    const r = restore(s2.id);
    // s2 is newer than the other 2, so it becomes 3 and s3 becomes 4; 5 is left alone.
    expect(r.number).toBe(3);
    expect([num(s1.id), num(s2.id), num(s3.id), num(s5.id)]).toEqual([2, 3, 4, 5]);
    expect([s1.id, s2.id, s3.id, s5.id].every(inPlace)).toBe(true);
    expect(r.message).toBe("Session 2 restored as session 3. Renumbered to make room: 3 → 4.");
  });

  it("refuses, changing nothing, when a session it would renumber is recording", () => {
    const a = add();
    trash(a.id);
    const b = add();
    store.setSessionStatus(b.id, "recording");
    expect(() => restore(a.id)).toThrow(/renumbers session 1, which is recording/);
    expect(num(b.id)).toBe(1);
    expect(store.getSession(a.id)!.deleted_at).not.toBeNull();
    expect(fs.existsSync(trashFolder(a.id))).toBe(true);
  });

  it("updates the merge note of a recording merged into a renumbered game", () => {
    const a = add();
    trash(a.id);
    const b = add();
    const c = add();
    // c was merged into b: its folder lives in b's recordings/ and its note names b's number.
    const cDir = `campaigns/_unassigned/sessions/${b.id}/recordings/${c.id}`;
    fs.renameSync(sessionPaths(c.id).recording, path.join(dataDir, ...cDir.split("/")));
    fs.rmSync(path.join(dataDir, "campaigns", "_unassigned", "sessions", c.id), { recursive: true, force: true });
    store.setSessionPlace(c.id, { dir: cDir, campaignId: b.campaign_id! });
    store.setMergedInto(c.id, b.id);
    store.setSessionStatus(c.id, "complete", `Merged into session 1 (${b.id}).`);

    restore(a.id);
    expect(num(b.id)).toBe(2);
    expect(store.getSession(c.id)).toMatchObject({ error: `Merged into session 2 (${b.id}).`, dir: cDir });
    expect(fs.existsSync(sessionPaths(c.id).recording)).toBe(true);
  });
});
