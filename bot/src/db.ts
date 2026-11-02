import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
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
  /** Its trash folder was removed for good. The row stays so session numbers are never reused. */
  purged_at: string | null;
  /** When the summary or story was last sent to Foundry (summary.ready / story.ready). */
  summary_sent_at: string | null;
  story_sent_at: string | null;
  /** When Foundry confirmed the journal entry exists (module 0.7.0+), and the entry's name. */
  summary_journal_at: string | null;
  summary_journal_name: string | null;
  story_journal_at: string | null;
  story_journal_name: string | null;
  /** The campaign (Foundry world) it belongs to; null until the layout migration (layout.ts). */
  campaign_id: number | null;
  /** Its recording folder relative to DATA_DIR, e.g. campaigns/<world>/sessions/012/recordings/<id>; null: the old flat sessions/<id>. */
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
  /** The last roster sync from this world: the most recent one is where new recordings go. */
  last_seen_at: string | null;
  created_at: string;
}

/** The campaign for recordings made before any Foundry world was known. */
export const UNASSIGNED_FOLDER = "_unassigned";

/** "012": zero-padded so folders sort by number. */
export const sessionFolderName = (n: number) => String(n).padStart(3, "0");

/** Windows-safe folder name for a world id (Foundry ids are already lowercase letters, digits and dashes). */
export function worldFolderName(worldId: string) {
  const clean = worldId.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  return clean && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean) && clean !== UNASSIGNED_FOLDER ? clean : `world-${clean || "unnamed"}`;
}

export interface MappingRow {
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

const MIGRATIONS: string[] = [
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
  // 4: campaigns (one per Foundry world) and the campaigns/<world>/sessions/<NNN>/recordings/<id> layout.
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
];

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
   * and filed as campaigns/<world>/sessions/<NNN>/recordings/<id>.
   */
  createSession(s: { id: string; guildId: string; channelId: string; textChannelId: string | null; startedAt: string; campaignId?: number }) {
    const campaign = this.getCampaign(s.campaignId ?? this.defaultCampaign().id);
    if (!campaign) throw new Error("No such campaign.");
    const n = this.nextNumber(campaign.id, s.guildId);
    const dir = recordingRel(campaign.folder, n, s.id);
    this.db
      .prepare(
        `INSERT INTO sessions (id, guild_id, channel_id, text_channel_id, number, status, started_at, campaign_id, dir)
         VALUES (?, ?, ?, ?, ?, 'recording', ?, ?, ?)`,
      )
      .run(s.id, s.guildId, s.channelId, s.textChannelId, n, s.startedAt, campaign.id, dir);
    return this.getSession(s.id)!;
  }

  /**
   * The next number in a campaign. Sessions not yet moved to the campaign layout count too
   * (they were numbered per server), so a new session never repeats an old number.
   */
  nextNumber(campaignId: number, guildId: string) {
    const { n } = this.db
      .prepare(
        `SELECT COALESCE(MAX(number), 0) + 1 AS n FROM sessions
         WHERE campaign_id = ? OR (campaign_id IS NULL AND guild_id = ?)`,
      )
      .get(campaignId, guildId) as { n: number };
    return n;
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

  /** The campaign for a Foundry world, created on first sight; records the sync time and title. */
  touchWorld(worldId: string, title?: string | null, seen = true) {
    const existing = this.campaignByWorld(worldId);
    const now = new Date().toISOString();
    if (existing) {
      this.db
        .prepare("UPDATE campaigns SET title = COALESCE(?, title), last_seen_at = CASE WHEN ? THEN ? ELSE last_seen_at END WHERE id = ?")
        .run(title ?? null, seen ? 1 : 0, now, existing.id);
      return this.getCampaign(existing.id)!;
    }
    let folder = worldFolderName(worldId);
    for (let i = 2; this.db.prepare("SELECT 1 FROM campaigns WHERE folder = ?").get(folder); i++) folder = `${worldFolderName(worldId)}-${i}`;
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO campaigns (world_id, folder, title, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(worldId, folder, title ?? null, seen ? now : null, now);
    return this.getCampaign(Number(lastInsertRowid))!;
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
   * Where a new recording goes: the world Foundry synced from most recently, else the campaign of
   * the newest session, else "_unassigned" (created only when `create` is true).
   */
  defaultCampaign(): CampaignRow;
  defaultCampaign(opts: { create: false }): CampaignRow | null;
  defaultCampaign(opts: { create?: boolean } = {}): CampaignRow | null {
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

  getMappings(guildId: string) {
    return this.db.prepare("SELECT * FROM mappings WHERE guild_id = ?").all(guildId) as MappingRow[];
  }

  /** Every guild's mappings (the Foundry roster is one world shared by all of them). */
  getAllMappings() {
    return this.db.prepare("SELECT * FROM mappings ORDER BY guild_id, discord_id").all() as MappingRow[];
  }

  upsertMapping(m: {
    guildId: string;
    discordId: string;
    foundryUserId?: string | null;
    actorId?: string | null;
    characterName?: string | null;
    isGm?: boolean;
  }) {
    const existing = this.db
      .prepare("SELECT * FROM mappings WHERE guild_id = ? AND discord_id = ?")
      .get(m.guildId, m.discordId) as MappingRow | undefined;
    const merged = {
      foundry_user_id: m.foundryUserId !== undefined ? m.foundryUserId : (existing?.foundry_user_id ?? null),
      actor_id: m.actorId !== undefined ? m.actorId : (existing?.actor_id ?? null),
      character_name: m.characterName !== undefined ? m.characterName : (existing?.character_name ?? null),
      is_gm: m.isGm !== undefined ? Number(m.isGm) : (existing?.is_gm ?? 0),
    };
    this.db
      .prepare(
        `INSERT INTO mappings (guild_id, discord_id, foundry_user_id, actor_id, character_name, is_gm)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, discord_id) DO UPDATE SET
           foundry_user_id = excluded.foundry_user_id,
           actor_id = excluded.actor_id,
           character_name = excluded.character_name,
           is_gm = excluded.is_gm`,
      )
      .run(m.guildId, m.discordId, merged.foundry_user_id, merged.actor_id, merged.character_name, merged.is_gm);
  }

  deleteMapping(guildId: string, discordId: string) {
    this.db.prepare("DELETE FROM mappings WHERE guild_id = ? AND discord_id = ?").run(guildId, discordId);
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

/** campaigns/<folder>/sessions/<NNN>/recordings/<id>, relative to DATA_DIR. */
export const recordingRel = (campaignFolder: string, number: number, id: string) =>
  `campaigns/${campaignFolder}/sessions/${sessionFolderName(number)}/recordings/${id}`;
