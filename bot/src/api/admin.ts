import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { ALL_CAMPAIGNS, UNASSIGNED_FOLDER, campaignName as nameOf, gameFolderOf, type CampaignRow, type SessionRow, type Store } from "../db.js";
import { bus } from "../events.js";
import { mergedInto, unusableReason } from "../merge.js";
import { sessionPaths, sessionRecordings } from "../paths.js";
import { isProcessing, processingProgress, purgeExpiredAudio } from "../pipeline.js";
import { announceStory, findStoryFile, storyPath } from "../story.js";
import { createProvider } from "../summarize/provider.js";
import { listModels } from "../summarize/models.js";
import type { SummaryFile } from "../summarize/schema.js";
import { moveToCampaign, sessionTimeline } from "../layout.js";
import { applyLayout, planLayout } from "../migrate-layout.js";
import { workerHealth } from "../worker-client.js";
import { deleteSession, purgeSession, restoreSession, trashFolder } from "../trash.js";
import { llmConfigProblem } from "../summarize/readiness.js";

/**
 * The Console's API (docs/console-design.md §3.2). Each route wraps what a slash command already
 * does, with the same checks and messages. Only the Console calls it, from its own process: the
 * routes need the API token, a loopback peer and no Origin header (see `adminGuard`), so no web
 * page, Foundry's included, can reach them.
 */

/** What the routes need from the Discord side; CommandHandler implements it (tests pass a fake). */
export interface AdminSessions {
  listChannels(): unknown[];
  isRecording(sessionId: string): boolean;
  startFromConsole(opts: { guildId: string; voiceChannelId: string; textChannelId: string; campaignId?: number }): Promise<SessionRow>;
  stopFromConsole(sessionId: string): Promise<SessionRow>;
  processFromConsole(session: SessionRow, opts: { summaryOnly?: boolean; retranscribe?: boolean }): Promise<void>;
  mergeInto(a: SessionRow, b: SessionRow): string;
  /** `campaignId` left out: the campaign being played (`playingCampaignId()`), as for the slash commands. */
  setMapping(guildId: string, discordId: string, value: string, campaignId?: number): string;
  clearMapping(guildId: string, discordId: string, campaignId?: number): void;
  setGm(guildId: string, discordId: string, isGm: boolean, campaignId?: number): void;
  playingCampaignId(): number;
  memberNames(guildId: string, ids: string[]): Promise<Record<string, string | null>>;
}

export interface AdminDeps {
  sessions: AdminSessions;
  /** Clean shutdown, then exit with code 75 so start.ps1 starts the bot again. */
  restart?: (reason: string) => void;
  /** The campaign being played, or a campaign's Foundry server, changed: the headless client re-targets. */
  campaignChanged?: () => void;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** onRequest check for /admin/*: on top of the token, only a local process with no browser Origin. */
export function adminGuard(req: FastifyRequest): string | null {
  if (!req.url.startsWith("/admin")) return null;
  if (req.headers.origin) return "admin routes can't be called from a web page";
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return "admin routes only answer this machine";
  return null;
}

class HttpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Text files the Console may preview, by name. Nothing else in a session folder is served. */
const PREVIEWS: Record<string, (id: string) => string> = {
  "transcript.md": (id) => sessionPaths(id).transcriptMd,
  "summary.md": (id) => sessionPaths(id).summaryMd,
  "story.md": (id) => storyPath(id),
};
const PREVIEW_LIMIT = 512 * 1024;

function folderOf(s: SessionRow) {
  return s.deleted_at ? trashFolder(s.id) : sessionPaths(s.id).dir;
}

function filesIn(dir: string) {
  const out: { name: string; bytes: number }[] = [];
  const walk = (d: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Audio clips are many and small: one line for the folder.
        if (e.name === "audio") {
          let bytes = 0;
          let count = 0;
          const sum = (x: string) => {
            for (const f of fs.readdirSync(x, { withFileTypes: true })) {
              if (f.isDirectory()) sum(path.join(x, f.name));
              else {
                count++;
                bytes += fs.statSync(path.join(x, f.name)).size;
              }
            }
          };
          try {
            sum(path.join(d, e.name));
          } catch {
            /* being written to */
          }
          out.push({ name: `${rel}/ (${count} clips)`, bytes });
        } else walk(path.join(d, e.name), rel);
      } else {
        try {
          out.push({ name: rel, bytes: fs.statSync(path.join(d, e.name)).size });
        } catch {
          /* removed meanwhile */
        }
      }
    }
  };
  walk(dir, "");
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function registerAdminRoutes(app: FastifyInstance, store: Store, deps: AdminDeps, foundrySockets: () => number) {
  const { sessions } = deps;

  const campaignName = (id: number | null) => {
    const c = id == null ? null : store.getCampaign(id);
    return c ? { campaignId: c.id, campaign: nameOf(c), campaignFolder: c.folder } : { campaignId: null, campaign: null, campaignFolder: null };
  };

  const summary = (s: SessionRow) => {
    const p = sessionPaths(s.id);
    const live = !s.deleted_at;
    return {
      id: s.id,
      guildId: s.guild_id,
      ...campaignName(s.campaign_id),
      /** Still in the old flat data/sessions/<id> folder (the layout migration hasn't run). */
      legacyLayout: !s.dir,
      /** In a campaign folder still named by number (sessions/012); the layout migration renames it to its id. */
      numberedFolder: Boolean(s.dir && !s.merged_into_id && gameFolderOf(s.dir) !== s.id),
      recordings: sessionRecordings(s.id).length,
      number: s.number,
      title: s.title,
      notes: s.notes,
      status: s.status,
      error: s.error,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      summarizedAt: s.summarized_at,
      audioPurged: Boolean(s.audio_purged),
      deletedAt: s.deleted_at,
      purgedAt: s.purged_at,
      summarySentAt: s.summary_sent_at,
      storySentAt: s.story_sent_at,
      // Foundry's confirmation (module 0.7.0+). Older than the last send: that send isn't confirmed yet.
      summaryJournalAt: s.summary_journal_at,
      summaryJournalName: s.summary_journal_name,
      storyJournalAt: s.story_journal_at,
      storyJournalName: s.story_journal_name,
      textChannelId: s.text_channel_id,
      mergedInto: mergedInto(s),
      recording: sessions.isRecording(s.id),
      processing: isProcessing(s.id),
      progress: processingProgress(s.id),
      hasTranscript: live && fs.existsSync(p.transcriptJson),
      hasChatlog: live && fs.existsSync(p.chatlog),
      hasSummary: live && fs.existsSync(p.summary),
      hasStory: live && findStoryFile(s.id) !== null,
    };
  };

  const find = (id: string) => {
    const s = store.getSession(id);
    if (!s) throw new HttpError(404, "No such session.");
    return s;
  };
  const usable = (s: SessionRow) => {
    const why = unusableReason(s);
    if (why) throw new HttpError(409, why);
    return s;
  };

  /** Runs a handler and turns thrown errors into `{ ok: false, error }`; nothing escapes into the bot. */
  const handle =
    <R extends FastifyRequest>(fn: (req: R) => Promise<unknown> | unknown) =>
    async (req: R, reply: FastifyReply) => {
      try {
        const result = await fn(req);
        return result ?? { ok: true };
      } catch (err) {
        const code = err instanceof HttpError ? err.code : err instanceof z.ZodError ? 400 : 409;
        const message = err instanceof z.ZodError ? err.issues.map((i) => i.message).join("; ") : err instanceof Error ? err.message : String(err);
        console.warn(`[admin] ${req.method} ${req.url.split("?")[0]} refused: ${message}`);
        return reply.code(code).send({ ok: false, error: message });
      }
    };

  type IdReq = FastifyRequest<{ Params: { id: string } }>;

  // ---------- Discord ----------

  app.get("/admin/discord", handle(() => ({ guilds: sessions.listChannels() })));

  // ---------- sessions ----------

  app.get(
    "/admin/sessions",
    handle((req: FastifyRequest<{ Querystring: { deleted?: string; limit?: string } }>) => {
      const deleted = req.query.deleted === "only" ? "only" : req.query.deleted === "include" ? "include" : "exclude";
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
      // A recording merged into another game is shown as part of that game (its `recordings` count).
      return { sessions: store.listSessions(limit, { deleted }).filter((x) => !x.merged_into_id).map(summary) };
    }),
  );

  app.get(
    "/admin/sessions/:id",
    handle((req: IdReq) => {
      const s = find(req.params.id);
      const dir = folderOf(s);
      // Never open timeline.json while it's being recorded into (the recorder renames over it).
      let timeline: { participants: unknown[]; clips: number } | null = null;
      if (!sessions.isRecording(s.id) && !s.deleted_at && fs.existsSync(dir)) {
        try {
          const t = sessionTimeline(store, s.id);
          timeline = { participants: t.participants, clips: t.segments.length };
        } catch {
          timeline = null;
        }
      }
      return {
        ...summary(s),
        folder: dir,
        files: filesIn(dir),
        participants: timeline?.participants ?? null,
        clips: timeline?.clips ?? null,
        previews: Object.keys(PREVIEWS).filter((name) => !s.deleted_at && fs.existsSync(PREVIEWS[name]!(s.id))),
      };
    }),
  );

  app.get(
    "/admin/sessions/:id/preview/:name",
    handle((req: FastifyRequest<{ Params: { id: string; name: string } }>) => {
      const s = find(req.params.id);
      const file = PREVIEWS[req.params.name]?.(s.id);
      if (!file || s.deleted_at || !fs.existsSync(file)) throw new HttpError(404, "Nothing to preview.");
      const buf = fs.readFileSync(file);
      return { name: req.params.name, truncated: buf.length > PREVIEW_LIMIT, text: buf.subarray(0, PREVIEW_LIMIT).toString("utf8") };
    }),
  );

  const StartBody = z.object({
    guildId: z.string().min(1),
    voiceChannelId: z.string().min(1),
    textChannelId: z.string().min(1),
    campaignId: z.number().int().optional(),
  });
  app.post(
    "/admin/sessions",
    handle(async (req) => ({ ok: true, session: summary(await sessions.startFromConsole(StartBody.parse(req.body))) })),
  );

  app.post("/admin/sessions/:id/stop", handle(async (req: IdReq) => ({ ok: true, session: summary(await sessions.stopFromConsole(req.params.id)) })));

  const ProcessBody = z.object({ retranscribe: z.boolean().optional() }).optional();
  app.post(
    "/admin/sessions/:id/process",
    handle(async (req: IdReq) => {
      const s = usable(find(req.params.id));
      await sessions.processFromConsole(s, { retranscribe: ProcessBody.parse(req.body)?.retranscribe });
      return { ok: true, session: summary(find(s.id)) };
    }),
  );
  app.post(
    "/admin/sessions/:id/summarize",
    handle(async (req: IdReq) => {
      const s = usable(find(req.params.id));
      await sessions.processFromConsole(s, { summaryOnly: true });
      return { ok: true, session: summary(find(s.id)) };
    }),
  );

  app.post(
    "/admin/sessions/:id/summary/import",
    handle((req: IdReq) => {
      const s = usable(find(req.params.id));
      const file = sessionPaths(s.id).summary;
      if (!fs.existsSync(file)) throw new HttpError(409, `Session ${s.number} has no summary yet. Summarize it first.`);
      const { summary: sum } = JSON.parse(fs.readFileSync(file, "utf8")) as SummaryFile;
      console.log(`[admin] asking Foundry to import the summary of session ${s.number}`);
      bus.emitEvent({ type: "summary.ready", sessionId: s.id, number: s.number, title: sum.title, manual: true });
      store.markSent(s.id, "summary");
      return { ok: true, title: sum.title, foundryConnected: foundrySockets() > 0 };
    }),
  );
  app.post(
    "/admin/sessions/:id/story/import",
    handle((req: IdReq) => {
      const s = usable(find(req.params.id));
      const story = announceStory(store, s);
      return { ok: true, title: story.title, foundryConnected: foundrySockets() > 0 };
    }),
  );

  const MergeBody = z.object({ into: z.string().min(1) });
  app.post(
    "/admin/sessions/:id/merge",
    handle((req: IdReq) => {
      const b = find(req.params.id);
      const a = find(MergeBody.parse(req.body).into);
      return { ok: true, message: sessions.mergeInto(a, b) };
    }),
  );

  const Labels = z.object({
    title: z.string().max(200).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
  });
  app.patch(
    "/admin/sessions/:id",
    handle((req: IdReq) => {
      const s = find(req.params.id);
      const body = Labels.parse(req.body ?? {});
      const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
      store.setSessionLabels(s.id, { title: clean(body.title), notes: clean(body.notes) });
      return { ok: true, session: summary(find(s.id)) };
    }),
  );

  app.delete(
    "/admin/sessions/:id",
    handle((req: IdReq) => {
      const s = find(req.params.id);
      deleteSession(store, s, (id) => sessions.isRecording(id));
      return { ok: true, session: summary(find(s.id)) };
    }),
  );
  app.post(
    "/admin/sessions/:id/restore",
    handle((req: IdReq) => {
      const s = find(req.params.id);
      const r = restoreSession(store, s, (id) => sessions.isRecording(id));
      return { ok: true, session: summary(find(s.id)), number: r.number, renumbered: r.renumbered, message: r.message };
    }),
  );
  app.delete(
    "/admin/trash/:id",
    handle((req: IdReq) => {
      const s = find(req.params.id);
      purgeSession(store, s);
      return { ok: true };
    }),
  );

  // ---------- campaigns (one per Foundry world) and the folder layout ----------

  // The Campaign tab: what each campaign is (name, world, Foundry server) and which one is being played.
  // Passwords never leave the bot: only whether one is set.
  const campaignView = (c: CampaignRow, def: CampaignRow | null, all: SessionRow[]) => ({
    id: c.id,
    worldId: c.world_id,
    folder: c.folder,
    title: c.title,
    alias: c.alias,
    name: nameOf(c),
    lastSeenAt: c.last_seen_at,
    createdAt: c.created_at,
    isDefault: def?.id === c.id,
    chosen: Boolean(c.selected_at) && def?.id === c.id,
    unassigned: c.folder === UNASSIGNED_FOLDER,
    sessions: all.filter((x) => x.campaign_id === c.id && !x.merged_into_id && !x.deleted_at).length,
    /** Counting the trash and merged recordings: a campaign can be deleted only at 0. */
    rows: store.campaignSessionCount(c.id),
    folderPath: path.join(config.dataDir, "campaigns", c.folder),
    foundry: { url: c.foundry_url, user: c.foundry_user, passwordSet: Boolean(c.foundry_password) },
  });

  app.get(
    "/admin/campaigns",
    handle(() => {
      const all = store.listSessions(1_000_000, { deleted: "include" });
      const def = store.defaultCampaign({ create: false });
      return {
        campaigns: store.listCampaigns().map((c) => campaignView(c, def, all)),
        /** The campaign chosen in the Campaign tab (null: the world Foundry synced last decides). */
        chosenId: store.selectedCampaign()?.id ?? null,
        /** The world of the last roster sync: its Foundry users can be mapped in that world's campaign. */
        rosterWorld: store.getMeta("roster_world"),
        /**
         * The .env fallbacks for a campaign's Foundry user and password (only whether one is set). No
         * address: a campaign without its own joins nothing, so .env's isn't shown or sent.
         */
        foundryDefaults: { user: config.foundry.user, passwordSet: config.foundry.password !== "", headless: config.foundry.headless },
      };
    }),
  );

  const optionalText = (max: number) => z.string().max(max).nullable().optional();
  const FoundryUrl = z
    .string()
    .max(500)
    .nullable()
    .optional()
    .refine((v) => !v || /^https?:\/\/[^\s/]+/i.test(v.trim()), "The Foundry address must start with http:// or https://.");
  const CampaignPatch = z.object({
    alias: optionalText(100),
    worldId: optionalText(200),
    foundryUrl: FoundryUrl,
    foundryUser: optionalText(100),
    foundryPassword: optionalText(500),
  });
  const CampaignCreate = z.object({ name: z.string().min(1, "Give the campaign a name.").max(100), worldId: optionalText(200) });

  app.post(
    "/admin/campaigns",
    handle((req) => {
      const body = CampaignCreate.parse(req.body);
      const c = store.createCampaign({ name: body.name, worldId: body.worldId ?? null });
      console.log(`[admin] campaign "${nameOf(c)}" created (folder ${c.folder})`);
      return { ok: true, campaign: campaignView(c, store.defaultCampaign({ create: false }), []) };
    }),
  );

  app.patch(
    "/admin/campaigns/:id",
    handle((req: IdReq) => {
      const c = store.getCampaign(Number(req.params.id));
      if (!c) throw new HttpError(404, "No such campaign.");
      const body = CampaignPatch.parse(req.body);
      if (body.alias !== undefined) store.setCampaignAlias(c.id, body.alias?.trim() || null);
      store.updateCampaign(c.id, body);
      // Field names only: never the values (the password).
      const changed = Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined);
      if (changed.length) console.log(`[admin] campaign "${nameOf(store.getCampaign(c.id)!)}": ${changed.join(", ")} changed`);
      if (body.worldId !== undefined || body.foundryUrl !== undefined || body.foundryUser !== undefined || body.foundryPassword !== undefined) {
        deps.campaignChanged?.();
      }
      return { ok: true };
    }),
  );

  app.delete(
    "/admin/campaigns/:id",
    handle((req: IdReq) => {
      const c = store.getCampaign(Number(req.params.id));
      if (!c) throw new HttpError(404, "No such campaign.");
      const wasPlaying = store.defaultCampaign({ create: false })?.id === c.id;
      store.deleteCampaign(c.id);
      console.log(`[admin] campaign "${nameOf(c)}" deleted`);
      if (wasPlaying) deps.campaignChanged?.();
      return { ok: true };
    }),
  );

  const PlayingBody = z.object({ campaignId: z.number().int().nullable() });
  app.post(
    "/admin/campaigns/playing",
    handle((req) => {
      const { campaignId } = PlayingBody.parse(req.body);
      if (campaignId !== null) {
        const c = store.getCampaign(campaignId);
        if (!c) throw new HttpError(404, "No such campaign.");
        if (c.folder === UNASSIGNED_FOLDER) throw new HttpError(409, "Pick a real campaign: the unassigned one only holds recordings made before any was known.");
      }
      store.selectCampaign(campaignId);
      const now = store.defaultCampaign({ create: false });
      console.log(`[admin] campaign being played: ${campaignId === null ? "automatic" : `"${nameOf(store.getCampaign(campaignId)!)}"`}`);
      deps.campaignChanged?.();
      const live = store.listSessions(50).filter((x) => sessions.isRecording(x.id));
      return {
        ok: true,
        playing: now ? { id: now.id, name: nameOf(now) } : null,
        // A recording keeps the campaign it started in.
        note: live.length ? "A recording in progress stays in the campaign it started in; the change applies to the next one." : null,
      };
    }),
  );

  const MoveBody = z.object({ campaignId: z.number().int() });
  app.post(
    "/admin/sessions/:id/campaign",
    handle((req: IdReq) => {
      const s = usable(find(req.params.id));
      if (!s.dir) throw new HttpError(409, "Update the folder layout first (Sessions → Update folder layout).");
      if (sessions.isRecording(s.id) || isProcessing(s.id)) throw new HttpError(409, `Session ${s.number} is busy; wait for it to finish.`);
      const moved = moveToCampaign(store, s.id, MoveBody.parse(req.body).campaignId);
      return { ok: true, session: summary(moved) };
    }),
  );

  /** Why moving folders now would get in the way, or null. */
  const layoutBusy = async () => {
    const all = store.listSessions(1_000_000, { deleted: "include" });
    const rec = all.filter((x) => sessions.isRecording(x.id) || x.status === "recording");
    if (rec.length) return `Session ${rec.map((x) => x.number).join(", ")} is recording. Stop it first.`;
    const busy = all.filter((x) => isProcessing(x.id));
    if (busy.length) return `Session ${busy.map((x) => x.number).join(", ")} is being processed. Wait for it to finish.`;
    try {
      const health = await workerHealth(2000);
      if (health.queued) return `The worker still has ${health.queued} clip(s) queued. Wait until it's idle.`;
    } catch {
      // Not running: it can't be writing into a session folder.
    }
    return null;
  };

  app.get(
    "/admin/layout",
    handle(async () => {
      const plan = planLayout(store);
      return {
        pending: plan.games.length,
        plan: plan.games.map((g) => ({ kind: g.kind, id: g.id, number: g.oldNumber, newNumber: g.number, campaign: g.campaign, from: g.from, to: g.to, inTrash: g.inTrash,
          merged: g.merged.map((m) => m.number), notes: g.notes })),
        campaigns: plan.campaigns,
        warnings: plan.warnings,
        backupDir: plan.backupDir,
        backupBytes: plan.backupBytes,
        busy: plan.games.length ? await layoutBusy() : null,
      };
    }),
  );

  app.post(
    "/admin/layout/migrate",
    handle(async () => {
      const busy = await layoutBusy();
      if (busy) throw new HttpError(409, busy);
      const r = applyLayout(store);
      if (r.errors.length) return { ok: false, moved: r.moved, backupDir: r.backupDir, errors: r.errors, error: r.errors.join(" ") };
      return { ok: true, moved: r.moved, backupDir: r.backupDir };
    }),
  );

  // ---------- speakers and characters ----------

  /** ?campaign=<id> on the mapping routes; left out, the campaign being played. */
  const campaignParam = (req: FastifyRequest) => {
    const raw = (req.query as { campaign?: string } | undefined)?.campaign;
    if (raw === undefined || raw === "") return sessions.playingCampaignId();
    const id = Number(raw);
    if (!Number.isInteger(id) || (id !== ALL_CAMPAIGNS && !store.getCampaign(id))) throw new HttpError(404, "No such campaign.");
    return id;
  };

  app.get(
    "/admin/mappings",
    handle(async (req) => {
      const campaignId = campaignParam(req);
      const all = store.getCampaignMappings(campaignId);
      const guilds = [...new Set(all.map((m) => m.guild_id))];
      const names: Record<string, string | null> = {};
      for (const g of guilds) Object.assign(names, await sessions.memberNames(g, all.filter((m) => m.guild_id === g).map((m) => m.discord_id)));
      const world = campaignId === ALL_CAMPAIGNS ? null : (store.getCampaign(campaignId)?.world_id ?? null);
      const rosterWorld = store.getMeta("roster_world");
      return {
        campaignId,
        mappings: all.map((m) => ({
          guildId: m.guild_id,
          discordId: m.discord_id,
          name: names[m.discord_id] ?? null,
          character: m.character_name,
          foundryUserId: m.foundry_user_id,
          actorId: m.actor_id,
          isGm: Boolean(m.is_gm),
          /** Shared by every campaign (made before campaigns had their own mappings). */
          shared: m.campaign_id === ALL_CAMPAIGNS && campaignId !== ALL_CAMPAIGNS,
        })),
        rosterWorld,
        /** The synced roster is this campaign's world (or either is unknown): its Foundry users can be picked. */
        rosterMatches: !world || !rosterWorld || world === rosterWorld,
        roster: store.getRoster().map((r) => ({
          foundryUserId: r.foundry_user_id,
          userName: r.user_name,
          isGm: Boolean(r.is_gm),
          actorName: r.actor_name,
          discordId: r.discord_id,
        })),
      };
    }),
  );

  type MapReq = FastifyRequest<{ Params: { guildId: string; discordId: string } }>;
  const snowflake = z.string().regex(/^\d{5,25}$/, "not a Discord id");
  const MapBody = z.object({ character: z.string().min(1).max(100) });
  app.put(
    "/admin/mappings/:guildId/:discordId",
    handle((req: MapReq) => {
      const discordId = snowflake.parse(req.params.discordId);
      return { ok: true, mapped: sessions.setMapping(req.params.guildId, discordId, MapBody.parse(req.body).character, campaignParam(req)) };
    }),
  );
  app.delete(
    "/admin/mappings/:guildId/:discordId",
    handle((req: MapReq) => {
      sessions.clearMapping(req.params.guildId, snowflake.parse(req.params.discordId), campaignParam(req));
      return { ok: true };
    }),
  );
  const GmBody = z.object({ isGm: z.boolean() });
  app.post(
    "/admin/mappings/:guildId/:discordId/gm",
    handle((req: MapReq) => {
      sessions.setGm(req.params.guildId, snowflake.parse(req.params.discordId), GmBody.parse(req.body).isGm, campaignParam(req));
      return { ok: true };
    }),
  );

  // ---------- maintenance ----------

  app.post(
    "/admin/maintenance/purge-audio",
    handle(() => {
      if (config.audioRetentionDays <= 0) throw new HttpError(409, "AUDIO_RETENTION_DAYS is 0: audio is kept forever.");
      const before = store.listSessions(100_000).filter((s) => s.audio_purged).length;
      purgeExpiredAudio(store, config.audioRetentionDays);
      const after = store.listSessions(100_000).filter((s) => s.audio_purged).length;
      return { ok: true, purged: after - before };
    }),
  );

  // The model ids a provider accepts, for the Console's "Which models?" box. `provider` is the one
  // selected in the form (maybe unsaved); LLM_CLI_PATH applies only if it was saved for that provider.
  app.get(
    "/admin/llm/models",
    handle(async (req: FastifyRequest<{ Querystring: { provider?: string; refresh?: string } }>) => {
      const provider = req.query.provider || config.llm.provider;
      const cliPath = provider === config.llm.provider ? config.llm.cliPath : undefined;
      try {
        return await listModels(provider, { cliPath, refresh: req.query.refresh === "1" });
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
    }),
  );

  app.post(
    "/admin/llm/test",
    handle(async () => {
      const problem = await llmConfigProblem();
      if (problem) throw new HttpError(409, problem);
      const started = Date.now();
      const provider = await createProvider();
      const result = await Promise.race([
        provider.generateJson({
          system: "You are a connectivity check. Reply with the JSON requested.",
          prompt: 'Return {"ok": true}.',
          schema: z.object({ ok: z.boolean() }),
          schemaName: "connectivity_check",
          effort: "low",
          maxTokens: 50,
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer within 60 s")), 60_000).unref()),
      ]);
      return { ok: result.ok === true, provider: provider.name, model: provider.model, ms: Date.now() - started };
    }),
  );

  app.post(
    "/admin/restart",
    handle(() => {
      if (!deps.restart) throw new HttpError(501, "This bot process can't restart itself.");
      const recording = store.listSessions(1000).filter((s) => sessions.isRecording(s.id));
      if (recording.length) throw new HttpError(409, `Session ${recording.map((s) => s.number).join(", ")} is recording. Stop it first.`);
      const busy = store.listSessions(1000).filter((s) => isProcessing(s.id));
      if (busy.length) throw new HttpError(409, `Session ${busy.map((s) => s.number).join(", ")} is being processed. Wait for it to finish.`);
      const restart = deps.restart;
      // Answer first; the shutdown closes this server.
      setTimeout(() => restart("restart requested from the Console"), 200).unref();
      return { ok: true, restarting: true };
    }),
  );
}
