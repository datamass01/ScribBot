/**
 * One-time move from the old flat layout (DATA_DIR/sessions/<id>/) to campaign folders
 * (DATA_DIR/campaigns/<world>/sessions/<NNN>/recordings/<id>/, docs/design.md §6.1).
 *
 * planLayout() only reads and says what would happen. applyLayout() first copies DATA_DIR/sessions,
 * DATA_DIR/trash and the database to DATA_DIR/backups/layout-<time>/, then moves one game at a
 * time, recording each move in the database as it lands, so an interruption leaves every session
 * findable. Used by `npm run migrate-layout` (bot stopped) and the Console (bot running, idle).
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { UNASSIGNED_FOLDER, recordingRel, sessionFolderName, worldFolderName, type CampaignRow, type SessionRow, type Store } from "./db.js";
import { renameWithRetry } from "./fsutil.js";
import { composeSession, moveFolder } from "./layout.js";
import { mergedInto } from "./merge.js";
import { trashFolder } from "./trash.js";

/** Files that belong to a recording; everything else in an old folder belongs to the game. */
const RECORDING_FILES = new Set(["timeline.json", "timeline.segments.jsonl", "audio", "transcript.partial.jsonl", "transcript.json", "transcript.md", "chatlog.json", "actors.json"]);
/** A game's own write-ups (kept at the game's root). */
const GAME_FILES = new Set(["summary.json", "summary.md", "notes.json", "story"]);
const PREMERGE = /^(timeline\.json|transcript\.json|transcript\.md|chatlog\.json)\.premerge-(\d+)$/;

export interface PlannedGame {
  id: string;
  oldNumber: number;
  number: number;
  campaign: string;
  /** Where its folder is now (null: none on disk) and where it goes. */
  from: string | null;
  to: string;
  inTrash: boolean;
  /** Recordings merged into it, which move into its recordings/ folder. */
  merged: { id: string; number: number; from: string | null }[];
  notes: string[];
}

export interface LayoutPlan {
  games: PlannedGame[];
  campaigns: { folder: string; worldId: string | null; title: string | null; isNew: boolean }[];
  backupDir: string;
  backupBytes: number;
  warnings: string[];
}

const exists = (p: string) => fs.existsSync(p);

function folderBytes(dir: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? folderBytes(p) : fs.statSync(p).size;
    }
  } catch {
    /* gone */
  }
  return total;
}

/** The Foundry world a session's chat log names, if any. */
function worldOf(folder: string): string | null {
  try {
    const log = JSON.parse(fs.readFileSync(path.join(folder, "chatlog.json"), "utf8")) as { world?: unknown };
    return typeof log.world === "string" && log.world ? log.world : null;
  } catch {
    return null;
  }
}

/** The id inside "Merged into session 12 (2026-11-01-6ae0bcc6)." */
function mergeTarget(row: SessionRow, all: SessionRow[]): SessionRow | null {
  const into = mergedInto(row);
  if (into == null) return null;
  const id = /\(([^)]+)\)/.exec(row.error ?? "")?.[1];
  return all.find((s) => s.id === id) ?? all.find((s) => s.guild_id === row.guild_id && s.number === into && s.id !== row.id) ?? null;
}

const oldFolder = (row: SessionRow) => {
  for (const p of [path.join(config.sessionsDir, row.id), trashFolder(row.id)]) if (exists(p)) return p;
  return null;
};

export function planLayout(store: Store): LayoutPlan {
  const all = store.listSessions(1_000_000, { deleted: "include" });
  const legacy = all.filter((s) => !s.dir).sort((a, b) => a.started_at.localeCompare(b.started_at));
  const warnings: string[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = path.join(config.dataDir, "backups", `layout-${stamp}`);

  // Which campaign: the world each session's chat log names, else the one most named, else the
  // world Foundry synced from last, else _unassigned.
  const named = new Map<string, number>();
  for (const s of legacy) {
    const f = oldFolder(s);
    const w = f ? worldOf(f) : null;
    if (w) named.set(w, (named.get(w) ?? 0) + 1);
  }
  const mostNamed = [...named.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  // Read only: a dry run must not create the "_unassigned" campaign.
  const fallback = store.defaultCampaign({ create: false }) ?? { folder: UNASSIGNED_FOLDER, world_id: null, title: null };
  const campaigns = new Map<string, { folder: string; worldId: string | null; title: string | null; isNew: boolean }>();
  const campaignFor = (world: string | null) => {
    if (world) {
      const existing = store.campaignByWorld(world);
      const key = `w:${world}`;
      if (!campaigns.has(key)) campaigns.set(key, { folder: existing?.folder ?? worldFolderName(world), worldId: world, title: existing?.title ?? null, isNew: !existing });
      return campaigns.get(key)!;
    }
    const key = `c:${fallback.folder}`;
    if (!campaigns.has(key)) campaigns.set(key, { folder: fallback.folder, worldId: fallback.world_id, title: fallback.title, isNew: false });
    return campaigns.get(key)!;
  };

  // Numbers stay the same unless two games would land on one folder (several servers in one campaign).
  const taken = new Map<string, Set<number>>();
  for (const s of all) {
    if (!s.dir || s.merged_into_id) continue;
    const folder = s.dir.split("/")[1]!;
    if (!taken.has(folder)) taken.set(folder, new Set());
    taken.get(folder)!.add(s.number);
  }

  const games: PlannedGame[] = [];
  const children = new Map<string, SessionRow[]>();
  for (const s of legacy) {
    const target = mergeTarget(s, all);
    if (target) {
      if (!children.has(target.id)) children.set(target.id, []);
      children.get(target.id)!.push(s);
    }
  }
  for (const s of legacy) {
    if (mergeTarget(s, all)) continue;
    const from = oldFolder(s);
    const camp = campaignFor((from && worldOf(from)) || mostNamed);
    if (!taken.has(camp.folder)) taken.set(camp.folder, new Set());
    const used = taken.get(camp.folder)!;
    let number = s.number;
    const notes: string[] = [];
    if (used.has(number)) {
      number = Math.max(0, ...used) + 1;
      notes.push(`renumbered ${s.number} → ${number}: that number is already used in campaign ${camp.folder}`);
    }
    used.add(number);
    const merged = (children.get(s.id) ?? []).map((c) => ({ id: c.id, number: c.number, from: oldFolder(c) }));
    if (from && fs.readdirSync(from).some((f) => PREMERGE.test(f))) notes.push("its own files from before the merge are restored from the *.premerge copies");
    if (!from) notes.push("no folder on disk (nothing was recorded, or it was removed); only the database is updated");
    games.push({
      id: s.id,
      oldNumber: s.number,
      number,
      campaign: camp.folder,
      from,
      to: path.join(config.dataDir, "campaigns", camp.folder, "sessions", sessionFolderName(number)),
      inTrash: Boolean(s.deleted_at),
      merged,
      notes,
    });
  }
  for (const s of legacy) {
    const into = mergedInto(s);
    if (into != null && !mergeTarget(s, all)) warnings.push(`Session ${s.number} says it was merged into session ${into}, which wasn't found; it is moved as its own session.`);
  }
  for (const [world, n] of named) if (world !== mostNamed && n) warnings.push(`Sessions from more than one Foundry world: ${[...named.keys()].join(", ")}. Each goes to its own campaign.`);

  const backupBytes = folderBytes(config.sessionsDir) + folderBytes(config.trashDir);
  return { games, campaigns: [...campaigns.values()], backupDir, backupBytes, warnings: [...new Set(warnings)] };
}

/** Old flat folder → the game's root with recordings/<id>/ (game files stay at the root). */
function restructure(flat: string, root: string, id: string) {
  const staging = `${flat}.migrating`;
  renameWithRetry(flat, staging);
  const rec = path.join(root, "recordings", id);
  fs.mkdirSync(rec, { recursive: true });
  const names = fs.readdirSync(staging);
  // The game's own files before a merge (the earliest *.premerge-<n> is the recording on its own).
  const premerge = new Map<string, { n: number; file: string }>();
  for (const f of names) {
    const m = PREMERGE.exec(f);
    if (m && (!premerge.has(m[1]!) || Number(m[2]) < premerge.get(m[1]!)!.n)) premerge.set(m[1]!, { n: Number(m[2]), file: f });
  }
  for (const f of names) {
    const src = path.join(staging, f);
    if (PREMERGE.test(f)) continue;
    if (premerge.has(f)) {
      fs.rmSync(src, { recursive: true, force: true }); // the merged version: rebuilt from the recordings
      continue;
    }
    const dest = GAME_FILES.has(f) || !RECORDING_FILES.has(f) ? path.join(root, f) : path.join(rec, f);
    renameWithRetry(src, dest);
  }
  for (const [name, { file }] of premerge) renameWithRetry(path.join(staging, file), path.join(rec, name));
  // Clips an old merge copied in (audio/<user>/m<n>-<clip>.wav) belong to the merged recording.
  if (premerge.size && exists(path.join(rec, "audio"))) {
    for (const user of fs.readdirSync(path.join(rec, "audio"))) {
      const dir = path.join(rec, "audio", user);
      for (const f of fs.readdirSync(dir)) if (/^m\d+-/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
    }
  }
  fs.rmSync(staging, { recursive: true, force: true }); // only *.premerge leftovers remain (backed up)
}

/** A merged recording's old folder → <game>/recordings/<id>/; its write-ups beside it. */
function restructureMerged(flat: string, root: string, id: string, number: number) {
  const rec = path.join(root, "recordings", id);
  moveFolder(flat, rec);
  const keep = [...GAME_FILES].filter((f) => exists(path.join(rec, f)));
  if (keep.length) {
    const archive = path.join(rec, `from-session-${sessionFolderName(number)}`);
    fs.mkdirSync(archive, { recursive: true });
    for (const f of keep) renameWithRetry(path.join(rec, f), path.join(archive, f));
  }
}

function backup(plan: LayoutPlan) {
  fs.mkdirSync(plan.backupDir, { recursive: true });
  for (const [src, name] of [[config.sessionsDir, "sessions"], [config.trashDir, "trash"]] as const) {
    if (exists(src)) fs.cpSync(src, path.join(plan.backupDir, name), { recursive: true });
  }
  return plan.backupDir;
}

export interface ApplyResult {
  moved: number;
  backupDir: string;
  errors: string[];
}

export function applyLayout(store: Store, plan: LayoutPlan = planLayout(store)): ApplyResult {
  if (!plan.games.length) return { moved: 0, backupDir: "", errors: [] };
  const backupDir = backup(plan);
  store.db.exec(`VACUUM INTO '${path.join(backupDir, "scribbot.db").replaceAll("'", "''")}'`);
  const errors: string[] = [];
  const camp = new Map<string, CampaignRow>();
  for (const c of plan.campaigns) {
    const existing = store.listCampaigns().find((x) => x.folder === c.folder);
    camp.set(c.folder, existing ?? (c.worldId ? store.touchWorld(c.worldId, c.title, false) : store.unassignedCampaign()));
  }
  let moved = 0;
  for (const g of plan.games) {
    const c = camp.get(g.campaign) ?? store.defaultCampaign();
    try {
      // In the trash the game's folder is trash/<id>, restructured in place, so restoring puts it back as a game.
      const root = g.inTrash ? trashFolder(g.id) : g.to;
      if (g.from) restructure(g.from, root, g.id);
      store.setSessionPlace(g.id, { dir: recordingRel(c.folder, g.number, g.id), campaignId: c.id, number: g.number });
      for (const m of g.merged) {
        if (m.from) restructureMerged(m.from, root, m.id, m.number);
        store.db.transaction(() => {
          store.setSessionPlace(m.id, { dir: recordingRel(c.folder, g.number, m.id), campaignId: c.id });
          store.setMergedInto(m.id, g.id);
        })();
      }
      if (!g.inTrash && g.from) composeSession(store, g.id);
      moved++;
    } catch (err) {
      errors.push(`Session ${g.oldNumber} (${g.id}): ${(err as Error).message}`);
    }
  }
  console.log(`[layout] moved ${moved} session(s) to the campaign layout; backup in ${backupDir}`);
  return { moved, backupDir, errors };
}
