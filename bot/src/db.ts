import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

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
];

export class Store {
  readonly db: Database.Database;

  constructor(file = path.join(config.dataDir, "scribbot.db")) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
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

  createSession(s: { id: string; guildId: string; channelId: string; textChannelId: string | null; startedAt: string }) {
    const { n } = this.db
      .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM sessions WHERE guild_id = ?")
      .get(s.guildId) as { n: number };
    this.db
      .prepare(
        `INSERT INTO sessions (id, guild_id, channel_id, text_channel_id, number, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'recording', ?)`,
      )
      .run(s.id, s.guildId, s.channelId, s.textChannelId, n, s.startedAt);
    return this.getSession(s.id)!;
  }

  getSession(id: string) {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  /** Accepts a full id, or a session number scoped to the guild. */
  findSession(guildId: string, ref: string) {
    if (/^\d+$/.test(ref)) {
      return this.db
        .prepare("SELECT * FROM sessions WHERE guild_id = ? AND number = ?")
        .get(guildId, Number(ref)) as SessionRow | undefined;
    }
    return this.getSession(ref);
  }

  latestSession(guildId?: string) {
    const sql = guildId
      ? "SELECT * FROM sessions WHERE guild_id = ? ORDER BY started_at DESC LIMIT 1"
      : "SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1";
    const stmt = this.db.prepare(sql);
    return (guildId ? stmt.get(guildId) : stmt.get()) as SessionRow | undefined;
  }

  listSessions(limit = 20) {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?")
      .all(limit) as SessionRow[];
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
