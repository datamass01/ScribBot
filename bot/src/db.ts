import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { foundryBaseUrl } from "./foundry/url.js";
import { setSessionLookup } from "./paths.js";

export type SessionStatus =
  | "recording"
  | "transcribing"
  | "summarizing"
  | "complete"
  | "failed";

export interface SessionRow {
  id: string;
  guild_id: string;
  channel_id: string;
  text_channel_id: string | null;
  number: number;
  status: SessionStatus;
  error: string | null;
  started_at: string;
  ended_at: string | null;
  summarized_at: string | null;
  audio_purged: number;
  /** GM-editable label and notes (the Console's Sessions tab). */
  title: string | null;
  notes: string | null;
  /** Moved to DATA_DIR/trash (soft delete); null while the session is live. */
  deleted_at: string | null;
  /** Its trash folder was removed for good. The row stays so merges still resolve. */
  purged_at: string | null;
  /** When the summary or story was last sent to Foundry (summary.ready / story.ready). */
  summary_sent_at: string | null;
  story_sent_at: string | null;
  /** When Foundry confirmed the journal entry exists (module 0.7.0+), and the entry's name. */
  summary_journal_at: string | null;
  summary_journal_name: string | null;
  story_journal_at: string | null;
  story_journal_name: string | null;
  /** When the summary or story was approved for Foundry (migration 6), and a hash of the file approved. */
  summary_approved_at: string | null;
  summary_approved_hash: string | null;
  story_approved_at: string | null;
  story_approved_hash: string | null;
  /** The campaign (Foundry world) it belongs to; null until the layout migration (layout.ts). */
  campaign_id: number | null;
  /** Its recording folder relative to DATA_DIR, e.g. campaigns/<world>/sessions/<game id>/recordings/<id>; null: the old flat sessions/<id>. */
  dir: string | null;
  /** The session it was merged into (its recording folder then lives in that session's recordings/). */
  merged_into_id: string | null;
}

export interface CampaignRow {
  id: number;
  /** Foundry's game.world.id; null for the "_unassigned" campaign. */
  world_id: string | null;
  /** Folder name under DATA_DIR/campaigns: the world id, never changed afterwards. */
  folder: string;
  /** The world's title as Foundry reports it. */
  title: string | null;
  /** A display name set in the Console; the folder doesn't change. */
  alias: string | null;
  /** The last roster sync from this world: without a chosen campaign, the most recent one is where new recordings go. */
  last_seen_at: string | null;
  created_at: string;
  /** The Foundry server ScribBot joins for this campaign (the Campaign tab); null: FOUNDRY_URL / FOUNDRY_USER / FOUNDRY_PASSWORD from .env. */
  foundry_url: string | null;
  foundry_user: string | null;
  foundry_password: string | null;
  /** Chosen in the Campaign tab as the campaign being played; the latest choice wins. Null: not chosen. */
  selected_at: string | null;
}

/** A campaign as people read it: the Console's alias, else Foundry's title, else the folder. */
export const campaignName = (c: Pick<CampaignRow, "alias" | "title" | "folder">) => c.alias || c.title || c.folder;

/** The campaign for recordings made before any Foundry world was known. */
export const UNASSIGNED_FOLDER = "_unassigned";

/** "012": a session number as a label (merged write-ups go in from-session-012/); folders are named by id. */
export const sessionFolderName = (n: number) => String(n).padStart(3, "0");

/** Windows-safe folder name for a world id (Foundry ids are already lowercase letters, digits and dashes). */
export function worldFolderName(worldId: string) {
  const clean = worldId.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  return clean && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean) && clean !== UNASSIGNED_FOLDER ? clean : `world-${clean || "unnamed"}`;
}

/** `mappings.campaign_id` for a mapping shared by every campaign (mappings made before campaigns had their own). */
export const ALL_CAMPAIGNS = 0;

export interface MappingRow {
  /** The campaign it applies in, or ALL_CAMPAIGNS; a campaign's own mapping wins over a shared one. */
  campaign_id: number;
  guild_id: string;
  discord_id: string;
  foundry_user_id: string | null;
  actor_id: string | null;
  character_name: string | null;
  is_gm: number;
}

export interface RosterRow {
  foundry_user_id: string;
  user_name: string;
  is_gm: number;
  actor_id: string | null;
  actor_name: string | null;
  actor_img: string | null;
  discord_id: string | null;
}

/** Exported for the migration tests. */
export const MIGRATIONS: string[] = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     guild_id TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     text_channel_id TEXT,
     number INTEGER NOT NULL,
     status TEXT NOT NULL,
     error TEXT,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     summarized_at TEXT,
     audio_purged INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE mappings (
     guild_id TEXT NOT NULL,
     discord_id TEXT NOT NULL,
     foundry_user_id TEXT,
     actor_id TEXT,
     character_name TEXT,
     is_gm INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (guild_id, discord_id)
   );
   CREATE TABLE roster (
     foundry_user_id TEXT PRIMARY KEY,
     user_name TEXT NOT NULL,
     is_gm INTEGER NOT NULL DEFAULT 0,
     actor_id TEXT,
     actor_name TEXT,
     actor_img TEXT,
     discord_id TEXT
   );`,
  // 2: labels, soft delete and journal posting times for the Console (docs/console-design.md).
  `ALTER TABLE sessions ADD COLUMN title TEXT;
   ALTER TABLE sessions ADD COLUMN notes TEXT;
   ALTER TABLE sessions ADD COLUMN deleted_at TEXT;
   ALTER TABLE sessions ADD COLUMN purged_at TEXT;
   ALTER TABLE sessions ADD COLUMN summary_sent_at TEXT;
   ALTER TABLE sessions ADD COLUMN story_sent_at TEXT;`,
  // 3: Foundry's confirmation that the journal entry exists (POST /sessions/:id/journal).
  `ALTER TABLE sessions ADD COLUMN summary_journal_at TEXT;
   ALTER TABLE sessions ADD COLUMN summary_journal_name TEXT;
   ALTER TABLE sessions ADD COLUMN story_journal_at TEXT;
   ALTER TABLE sessions ADD COLUMN story_journal_name TEXT;`,
  // 4: campaigns (one per Foundry world) and the campaign layout (game folders were named by number then; now by id).
  `CREATE TABLE campaigns (
     id INTEGER PRIMARY KEY,
     world_id TEXT UNIQUE,
     folder TEXT NOT NULL UNIQUE,
     title TEXT,
     alias TEXT,
     last_seen_at TEXT,
     created_at TEXT NOT NULL
   );
   ALTER TABLE sessions ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id);
   ALTER TABLE sessions ADD COLUMN dir TEXT;
   ALTER TABLE sessions ADD COLUMN merged_into_id TEXT;`,
  // 5: the Campaign tab. Each campaign has its own Foundry server login and character mappings, and
  // one can be chosen as the campaign being played. Existing mappings stay shared by every campaign (0).
  `ALTER TABLE campaigns ADD COLUMN foundry_url TEXT;
   ALTER TABLE campaigns ADD COLUMN foundry_user TEXT;
   ALTER TABLE campaigns ADD COLUMN foundry_password TEXT;
   ALTER TABLE campaigns ADD COLUMN selected_at TEXT;
   CREATE TABLE mappings_v5 (
     campaign_id INTEGER NOT NULL DEFAULT 0,
     guild_id TEXT NOT NULL,
     discord_id TEXT NOT NULL,
     foundry_user_id TEXT,
     actor_id TEXT,
     character_name TEXT,
     is_gm INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (campaign_id, guild_id, discord_id)
   );
   INSERT INTO mappings_v5 (campaign_id, guild_id, discord_id, foundry_user_id, actor_id, character_name, is_gm)
     SELECT 0, guild_id, discord_id, foundry_user_id, actor_id, character_name, is_gm FROM mappings;
   DROP TABLE mappings;
   ALTER TABLE mappings_v5 RENAME TO mappings;
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`,
  // 6: review before Foundry. Who approved which content (a hash of the file), so an edit or a new
  // summary needs approving again.
  `ALTER TABLE sessions ADD COLUMN summary_approved_at TEXT;
   ALTER TABLE sessions ADD COLUMN summary_approved_hash TEXT;
   ALTER TABLE sessions ADD COLUMN story_approved_at TEXT;
   ALTER TABLE sessions ADD COLUMN story_approved_hash TEXT;`,
];

/** A folder name for a campaign made in the Console before its Foundry world is known. */
export function campaignFolderFromName(name: string) {
  const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return worldFolderName(slug || "campaign");
}

export class Store {
  readonly db: Database.Database;

  constructor(file = path.join(config.dataDir, "scribbot.db")) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    // sessionPaths() resolves folders through the database (the newest Store wins; one per process).
    const dirOf = this.db.prepare("SELECT dir FROM sessions WHERE id = ?");
    const recordingsOf = this.db.prepare("SELECT id FROM sessions WHERE id = ? OR merged_into_id = ? ORDER BY started_at");
    const mergedOf = this.db.prepare("SELECT merged_into_id AS m FROM sessions WHERE id = ?");
    setSessionLookup({
      dir: (id) => (dirOf.get(id) as { dir: string | null } | undefined)?.dir ?? null,
      recordings: (id) => (recordingsOf.all(id, id) as { id: string }[]).map((r) => r.id),
      primary: (id) => (mergedOf.get(id) as { m: string | null } | undefined)?.m ?? id,
    });
  }

  private migrate() {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[i]!);
        this.db.pragma(`user_version = ${i + 1}`);
      })();
    }
  }

  // ---------- sessions ----------

  /**
   * A new recording, numbered within its campaign (default: the world Foundry last synced from)
   * and filed as campaigns/<world>/sessions/<id>/recordings/<id>. The folder is named by id, never
   * by number, so renumbering only touches the database.
   */
  createSession(s: { id: string; guildId: string; channelId: string; textChannelId: string | null; startedAt: string; campaignId?: number }) {
    const campaign = this.getCampaign(s.campaignId ?? this.defaultCampaign().id);
    if (!campaign) throw new Error("No such campaign.");
    const n = this.nextNumber(campaign.id, s.guildId);
    const dir = recordingRel(campaign.folder, s.id, s.id);
    this.db
      .prepare(
        `INSERT INTO sessions (id, guild_id, channel_id, text_channel_id, number, status, started_at, campaign_id, dir)
         VALUES (?, ?, ?, ?, ?, 'recording', ?, ?, ?)`,
      )
      .run(s.id, s.guildId, s.channelId, s.textChannelId, n, s.startedAt, campaign.id, dir);
    return this.getSession(s.id)!;
  }

  /**
   * The next number in a campaign: one past the highest game that isn't in the trash. Sessions not
   * yet moved to the campaign layout count too (they were numbered per server). A trashed session
   * can therefore share its number with a newer one; restoring it renumbers (trash.ts).
   */
  nextNumber(campaignId: number, guildId: string) {
    const { n } = this.db
      .prepare(
        `SELECT COALESCE(MAX(number), 0) + 1 AS n FROM sessions
         WHERE (campaign_id = ? OR (campaign_id IS NULL AND guild_id = ?)) AND deleted_at IS NULL AND merged_into_id IS NULL`,
      )
      .get(campaignId, guildId) as { n: number };
    return n;
  }

  /**
   * The games (not in the trash, not merged into another) that share a session's numbering:
   * its campaign plus the server's sessions from before the campaign layout, as nextNumber counts.
   */
  numberingPeers(s: Pick<SessionRow, "id" | "campaign_id" | "guild_id">) {
    const scope = s.campaign_id == null ? "guild_id = ?" : "(campaign_id = ? OR (campaign_id IS NULL AND guild_id = ?))";
    const args = s.campaign_id == null ? [s.guild_id] : [s.campaign_id, s.guild_id];
    return this.db
      .prepare(`SELECT * FROM sessions WHERE ${scope} AND deleted_at IS NULL AND merged_into_id IS NULL AND id != ? ORDER BY number`)
      .all(...args, s.id) as SessionRow[];
  }

  /** A recording and any merged into it, oldest first: the recordings of one game. */
  recordingsOf(id: string) {
    return this.db
      .prepare("SELECT * FROM sessions WHERE id = ? OR merged_into_id = ? ORDER BY started_at")
      .all(id, id) as SessionRow[];
  }

  setSessionPlace(id: string, place: { dir: string; campaignId: number; number?: number }) {
    this.db.prepare("UPDATE sessions SET dir = ?, campaign_id = ?, number = COALESCE(?, number) WHERE id = ?").run(place.dir, place.campaignId, place.number ?? null, id);
  }

  setMergedInto(id: string, intoId: string | null) {
    this.db.prepare("UPDATE sessions SET merged_into_id = ? WHERE id = ?").run(intoId, id);
  }

  // ---------- campaigns ----------

  listCampaigns() {
    return this.db.prepare("SELECT * FROM campaigns ORDER BY last_seen_at IS NULL, last_seen_at DESC, id").all() as CampaignRow[];
  }

  getCampaign(id: number) {
    return this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as CampaignRow | undefined;
  }

  campaignByWorld(worldId: string) {
    return this.db.prepare("SELECT * FROM campaigns WHERE world_id = ?").get(worldId) as CampaignRow | undefined;
  }

  /**
   * The campaign for a Foundry world, created on first sight; records the sync time and title.
   * A sync (`seen`) from a world no campaign has yet goes to the chosen campaign when that one has
   * no world yet: a campaign made in the Console gets its world the first time Foundry syncs.
   */
  touchWorld(worldId: string, title?: string | null, seen = true) {
    const now = new Date().toISOString();
    let existing = this.campaignByWorld(worldId);
    const chosen = seen && !existing ? this.selectedCampaign() : undefined;
    if (chosen && chosen.world_id === null && chosen.folder !== UNASSIGNED_FOLDER) {
      this.db.prepare("UPDATE campaigns SET world_id = ? WHERE id = ?").run(worldId, chosen.id);
      console.log(`[db] Foundry world ${worldId} is now the campaign "${campaignName(chosen)}" (the campaign being played had no world yet)`);
      existing = this.getCampaign(chosen.id);
    }
    if (existing) {
      this.db
        .prepare("UPDATE campaigns SET title = COALESCE(?, title), last_seen_at = CASE WHEN ? THEN ? ELSE last_seen_at END WHERE id = ?")
        .run(title ?? null, seen ? 1 : 0, now, existing.id);
      return this.getCampaign(existing.id)!;
    }
    const folder = this.freeFolder(worldFolderName(worldId));
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO campaigns (world_id, folder, title, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(worldId, folder, title ?? null, seen ? now : null, now);
    return this.getCampaign(Number(lastInsertRowid))!;
  }

  private freeFolder(base: string) {
    let folder = base;
    for (let i = 2; this.db.prepare("SELECT 1 FROM campaigns WHERE folder = ?").get(folder); i++) folder = `${base}-${i}`;
    return folder;
  }

  /** A campaign made in the Console: a name, and the Foundry world if it's known already. */
  createCampaign(c: { name: string; worldId?: string | null }) {
    const name = c.name.trim();
    if (!name) throw new Error("Give the campaign a name.");
    const worldId = c.worldId?.trim() || null;
    if (worldId) {
      const owner = this.campaignByWorld(worldId);
      if (owner) throw new Error(`World ${worldId} is already the campaign "${campaignName(owner)}".`);
    }
    const folder = this.freeFolder(worldId ? worldFolderName(worldId) : campaignFolderFromName(name));
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO campaigns (world_id, folder, alias, created_at) VALUES (?, ?, ?, ?)")
      .run(worldId, folder, name, new Date().toISOString());
    return this.getCampaign(Number(lastInsertRowid))!;
  }

  /**
   * Change a campaign's world or Foundry login (undefined: leave as is; null or "": back to .env).
   * A world another campaign has can only move here when that campaign has no sessions (it is then
   * removed); the folder never changes.
   */
  updateCampaign(
    id: number,
    patch: { worldId?: string | null; foundryUrl?: string | null; foundryUser?: string | null; foundryPassword?: string | null },
  ) {
    const c = this.getCampaign(id);
    if (!c) throw new Error("No such campaign.");
    this.db.transaction(() => {
      if (patch.worldId !== undefined) {
        const worldId = patch.worldId?.trim() || null;
        if (c.folder === UNASSIGNED_FOLDER && worldId) throw new Error("The unassigned campaign can't have a Foundry world; make a new campaign instead.");
        const owner = worldId ? this.campaignByWorld(worldId) : undefined;
        if (owner && owner.id !== id) {
          const n = this.campaignSessionCount(owner.id);
          if (n) {
            throw new Error(
              `World ${worldId} is already the campaign "${campaignName(owner)}" with ${n} session(s). ` +
                "Move them here first (Sessions → Move to another campaign), or use that campaign.",
            );
          }
          this.deleteCampaign(owner.id);
        }
        this.db.prepare("UPDATE campaigns SET world_id = ? WHERE id = ?").run(worldId, id);
      }
      const text = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
      const columns: [string, string | null | undefined][] = [
        ["foundry_url", patch.foundryUrl === undefined ? undefined : text(patch.foundryUrl) ? foundryBaseUrl(patch.foundryUrl!) : null],
        ["foundry_user", text(patch.foundryUser)],
        // A password is kept exactly as typed; "" or null clears it.
        ["foundry_password", patch.foundryPassword === undefined ? undefined : patch.foundryPassword || null],
      ];
      for (const [column, value] of columns) {
        if (value !== undefined) this.db.prepare(`UPDATE campaigns SET ${column} = ? WHERE id = ?`).run(value, id);
      }
    })();
    return this.getCampaign(id)!;
  }

  /** Sessions filed under a campaign, the trash and merged recordings included. */
  campaignSessionCount(id: number) {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE campaign_id = ?").get(id) as { n: number }).n;
  }

  /** Remove a campaign with no sessions (none in the trash either), with its own mappings. */
  deleteCampaign(id: number) {
    const c = this.getCampaign(id);
    if (!c) throw new Error("No such campaign.");
    const n = this.campaignSessionCount(id);
    if (n) throw new Error(`"${campaignName(c)}" has ${n} session(s), counting the trash; move or delete them first.`);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM mappings WHERE campaign_id = ?").run(id);
      this.db.prepare("DELETE FROM campaigns WHERE id = ?").run(id);
    })();
  }

  /** Choose the campaign being played (null: none, so the world Foundry synced last decides). */
  selectCampaign(id: number | null) {
    this.db.transaction(() => {
      if (id !== null && !this.getCampaign(id)) throw new Error("No such campaign.");
      this.db.prepare("UPDATE campaigns SET selected_at = NULL").run();
      if (id !== null) this.db.prepare("UPDATE campaigns SET selected_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    })();
  }

  /** The campaign chosen in the Campaign tab, if any. */
  selectedCampaign() {
    return this.db.prepare("SELECT * FROM campaigns WHERE selected_at IS NOT NULL ORDER BY selected_at DESC LIMIT 1").get() as
      | CampaignRow
      | undefined;
  }

  unassignedCampaign() {
    const row = this.db.prepare("SELECT * FROM campaigns WHERE folder = ?").get(UNASSIGNED_FOLDER) as CampaignRow | undefined;
    if (row) return row;
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO campaigns (world_id, folder, created_at) VALUES (NULL, ?, ?)")
      .run(UNASSIGNED_FOLDER, new Date().toISOString());
    return this.getCampaign(Number(lastInsertRowid))!;
  }

  /**
   * Where a new recording goes, the campaign being played: the one chosen in the Campaign tab, else
   * the world Foundry synced from most recently, else the campaign of the newest session, else
   * "_unassigned" (created only when `create` is true).
   */
  defaultCampaign(): CampaignRow;
  defaultCampaign(opts: { create: false }): CampaignRow | null;
  defaultCampaign(opts: { create?: boolean } = {}): CampaignRow | null {
    const chosen = this.selectedCampaign();
    if (chosen) return chosen;
    const seen = this.db
      .prepare("SELECT * FROM campaigns WHERE world_id IS NOT NULL AND last_seen_at IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1")
      .get() as CampaignRow | undefined;
    if (seen) return seen;
    const latest = this.db
      .prepare("SELECT c.* FROM sessions s JOIN campaigns c ON c.id = s.campaign_id WHERE s.deleted_at IS NULL ORDER BY s.started_at DESC LIMIT 1")
      .get() as CampaignRow | undefined;
    if (latest) return latest;
    if (opts.create === false) {
      return (this.db.prepare("SELECT * FROM campaigns WHERE folder = ?").get(UNASSIGNED_FOLDER) as CampaignRow | undefined) ?? null;
    }
    return this.unassignedCampaign();
  }

  setCampaignAlias(id: number, alias: string | null) {
    this.db.prepare("UPDATE campaigns SET alias = ? WHERE id = ?").run(alias, id);
  }

  getSession(id: string) {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  /**
   * Accepts a full id, or a session number. Numbers count per campaign, so with several
   * campaigns the one new recordings go to wins, then the newest.
   */
  findSession(guildId: string, ref: string) {
    if (/^\d+$/.test(ref)) {
      const def = this.defaultCampaign({ create: false })?.id ?? -1;
      return this.db
        .prepare(
          `SELECT * FROM sessions WHERE guild_id = ? AND number = ? AND merged_into_id IS NULL
           ORDER BY (campaign_id = ?) DESC, started_at DESC LIMIT 1`,
        )
        .get(guildId, Number(ref), def) as SessionRow | undefined;
    }
    return this.getSession(ref);
  }

  /** The newest session that isn't in the trash. */
  latestSession(guildId?: string) {
    const sql = guildId
      ? "SELECT * FROM sessions WHERE guild_id = ? AND deleted_at IS NULL ORDER BY started_at DESC LIMIT 1"
      : "SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY started_at DESC LIMIT 1";
    const stmt = this.db.prepare(sql);
    return (guildId ? stmt.get(guildId) : stmt.get()) as SessionRow | undefined;
  }

  /** Newest first. Deleted sessions are left out unless asked for. */
  listSessions(limit = 20, opts: { deleted?: "exclude" | "include" | "only" } = {}) {
    const where = { exclude: "WHERE deleted_at IS NULL", include: "", only: "WHERE deleted_at IS NOT NULL" }[opts.deleted ?? "exclude"];
    return this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as SessionRow[];
  }

  setSessionLabels(id: string, labels: { title?: string | null; notes?: string | null }) {
    if (labels.title !== undefined) this.db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(labels.title, id);
    if (labels.notes !== undefined) this.db.prepare("UPDATE sessions SET notes = ? WHERE id = ?").run(labels.notes, id);
  }

  markDeleted(id: string, deleted: boolean) {
    this.db.prepare("UPDATE sessions SET deleted_at = ? WHERE id = ?").run(deleted ? new Date().toISOString() : null, id);
  }

  markPurged(id: string) {
    this.db.prepare("UPDATE sessions SET purged_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  /** Deleted sessions whose trash folder is still there, deleted before `olderThan`. */
  trashOlderThan(olderThan: Date) {
    return this.db
      .prepare("SELECT * FROM sessions WHERE deleted_at IS NOT NULL AND purged_at IS NULL AND deleted_at < ?")
      .all(olderThan.toISOString()) as SessionRow[];
  }

  /** Foundry has the journal entry (the bridge client's confirmation). */
  markJournal(id: string, what: "summary" | "story", name: string) {
    this.db
      .prepare(`UPDATE sessions SET ${what}_journal_at = ?, ${what}_journal_name = ? WHERE id = ?`)
      .run(new Date().toISOString(), name, id);
  }

  /** Approve this content (by hash) of the summary or story for Foundry. */
  markApproved(id: string, what: "summary" | "story", hash: string) {
    this.db
      .prepare(`UPDATE sessions SET ${what}_approved_at = ?, ${what}_approved_hash = ? WHERE id = ?`)
      .run(new Date().toISOString(), hash, id);
  }

  markSent(id: string, what: "summary" | "story") {
    const column = what === "summary" ? "summary_sent_at" : "story_sent_at";
    this.db.prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`).run(new Date().toISOString(), id);
  }

  setSessionStatus(id: string, status: SessionStatus, error: string | null = null) {
    this.db.prepare("UPDATE sessions SET status = ?, error = ? WHERE id = ?").run(status, error, id);
  }

  endSession(id: string, endedAt: string) {
    this.db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(endedAt, id);
  }

  markSummarized(id: string) {
    this.db
      .prepare("UPDATE sessions SET summarized_at = ?, status = 'complete', error = NULL WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  markAudioPurged(id: string) {
    this.db.prepare("UPDATE sessions SET audio_purged = 1 WHERE id = ?").run(id);
  }

  sessionsWithExpiredAudio(olderThan: Date) {
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE audio_purged = 0 AND summarized_at IS NOT NULL AND summarized_at < ?",
      )
      .all(olderThan.toISOString()) as SessionRow[];
  }

  // ---------- mappings ----------

  /**
   * The mappings in force for a campaign on a server: the campaign's own, plus the shared ones
   * (ALL_CAMPAIGNS) for people it doesn't map itself.
   */
  getMappings(guildId: string, campaignId: number) {
    const rows = this.db
      .prepare("SELECT * FROM mappings WHERE guild_id = ? AND campaign_id IN (?, 0) ORDER BY discord_id")
      .all(guildId, campaignId) as MappingRow[];
    return effective(rows);
  }

  /** Every server's mappings in force for a campaign (the Foundry roster is one world shared by all of them). */
  getCampaignMappings(campaignId: number) {
    const rows = this.db
      .prepare("SELECT * FROM mappings WHERE campaign_id IN (?, 0) ORDER BY guild_id, discord_id")
      .all(campaignId) as MappingRow[];
    return effective(rows);
  }

  /**
   * Set a mapping in a campaign (or ALL_CAMPAIGNS). Fields left out keep the value in force: the
   * campaign's own, else the shared one it overrides from now on.
   */
  upsertMapping(m: {
    campaignId: number;
    guildId: string;
    discordId: string;
    foundryUserId?: string | null;
    actorId?: string | null;
    characterName?: string | null;
    isGm?: boolean;
  }) {
    const existing = this.getMappings(m.guildId, m.campaignId).find((x) => x.discord_id === m.discordId);
    const merged = {
      foundry_user_id: m.foundryUserId !== undefined ? m.foundryUserId : (existing?.foundry_user_id ?? null),
      actor_id: m.actorId !== undefined ? m.actorId : (existing?.actor_id ?? null),
      character_name: m.characterName !== undefined ? m.characterName : (existing?.character_name ?? null),
      is_gm: m.isGm !== undefined ? Number(m.isGm) : (existing?.is_gm ?? 0),
    };
    this.db
      .prepare(
        `INSERT INTO mappings (campaign_id, guild_id, discord_id, foundry_user_id, actor_id, character_name, is_gm)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (campaign_id, guild_id, discord_id) DO UPDATE SET
           foundry_user_id = excluded.foundry_user_id,
           actor_id = excluded.actor_id,
           character_name = excluded.character_name,
           is_gm = excluded.is_gm`,
      )
      .run(m.campaignId, m.guildId, m.discordId, merged.foundry_user_id, merged.actor_id, merged.character_name, merged.is_gm);
  }

  /** Remove the mapping in force for someone in a campaign: its own, else the shared one. */
  deleteMapping(guildId: string, discordId: string, campaignId: number) {
    const existing = this.getMappings(guildId, campaignId).find((x) => x.discord_id === discordId);
    if (!existing) return;
    this.db
      .prepare("DELETE FROM mappings WHERE campaign_id = ? AND guild_id = ? AND discord_id = ?")
      .run(existing.campaign_id, guildId, discordId);
  }

  // ---------- small settings ----------

  getMeta(key: string) {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string | null } | undefined)?.value ?? null;
  }

  setMeta(key: string, value: string | null) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ---------- Foundry roster ----------

  replaceRoster(rows: RosterRow[]) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM roster").run();
      const insert = this.db.prepare(
        `INSERT INTO roster (foundry_user_id, user_name, is_gm, actor_id, actor_name, actor_img, discord_id)
         VALUES (@foundry_user_id, @user_name, @is_gm, @actor_id, @actor_name, @actor_img, @discord_id)`,
      );
      for (const r of rows) insert.run(r);
    })();
  }

  getRoster() {
    return this.db.prepare("SELECT * FROM roster ORDER BY user_name").all() as RosterRow[];
  }
}

/**
 * campaigns/<folder>/sessions/<game id>/recordings/<id>, relative to DATA_DIR. The game's folder is
 * named after its first recording's id (the session merges keep), so it never changes with its number.
 */
export const recordingRel = (campaignFolder: string, gameId: string, id: string) =>
  `campaigns/${campaignFolder}/sessions/${gameId}/recordings/${id}`;

/** The game folder's name in a campaign-layout `dir` (…/sessions/<name>/recordings/<id>), or null. */
/** A campaign's own mappings hide the shared (ALL_CAMPAIGNS) ones for the same person. */
function effective(rows: MappingRow[]) {
  const own = new Set(rows.filter((m) => m.campaign_id !== ALL_CAMPAIGNS).map((m) => `${m.guild_id}:${m.discord_id}`));
  return rows.filter((m) => m.campaign_id !== ALL_CAMPAIGNS || !own.has(`${m.guild_id}:${m.discord_id}`));
}

export const gameFolderOf = (dir: string | null) => /^campaigns\/[^/]+\/sessions\/([^/]+)\/recordings\/[^/]+$/.exec(dir ?? "")?.[1] ?? null;
