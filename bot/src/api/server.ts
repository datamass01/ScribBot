import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { config } from "../config.js";
import { writeFileAtomic } from "../fsutil.js";
import type { RosterRow, SessionRow, Store } from "../db.js";
import { bus } from "../events.js";
import { linksToWrite } from "../links.js";
import { logsSince } from "../monitor.js";
import { foundryActorsFile, sessionPaths } from "../paths.js";
import { ChatLogSchema, RosterPayloadSchema } from "../types.js";
import { buildStatus, type FoundryActivity, type MonitorSources } from "./status.js";

const DASHBOARD_FILE = new URL("../../public/dashboard.html", import.meta.url);
/** Served without the token: the page holds no data and asks for the token itself. */
const PUBLIC_PATHS = new Set(["/health", "/", "/dashboard"]);

function tokenMatches(given: string | undefined) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.api.token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const publicSession = (s: SessionRow) => ({
  id: s.id,
  number: s.number,
  status: s.status,
  error: s.error,
  startedAt: s.started_at,
  endedAt: s.ended_at,
  summarizedAt: s.summarized_at,
  hasSummary: fs.existsSync(sessionPaths(s.id).summary),
  hasChatlog: fs.existsSync(sessionPaths(s.id).chatlog),
});

export async function startApi(store: Store, getRecording: () => SessionRow | null, monitor: MonitorSources = {}) {
  const foundry: FoundryActivity = { sockets: 0, lastRosterAt: null, lastRosterWorld: null, lastChatlogAt: null };
  if (config.api.token === "change-me") {
    console.warn("[api] API_TOKEN is still 'change-me': set a real secret in .env");
  }

  const app = Fastify({ bodyLimit: 25 * 1024 * 1024, logger: false });
  await app.register(cors, {
    origin: config.api.origins,
    methods: ["GET", "POST"],
    allowedHeaders: ["authorization", "content-type"],
  });
  await app.register(websocket);

  // Browsers cannot set headers on WebSocket upgrades, so ?token= is accepted too.
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method === "OPTIONS" || PUBLIC_PATHS.has(req.url.split("?")[0]!)) return;
    const header = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const query = (req.query as { token?: string } | undefined)?.token;
    if (!tokenMatches(header ?? query)) {
      return reply.code(401).send({ error: "invalid or missing API token" });
    }
  });

  const findSession = (ref: string) => {
    if (ref === "latest") return store.latestSession();
    return store.getSession(ref);
  };

  app.get("/health", async () => ({ ok: true, name: "scribbot" }));

  const dashboard = (_req: FastifyRequest, reply: FastifyReply) =>
    reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(fs.readFileSync(DASHBOARD_FILE, "utf8"));
  app.get("/", dashboard);
  app.get("/dashboard", dashboard);

  app.get("/status", async () => buildStatus(store, monitor, foundry));

  app.get<{ Querystring: { after?: string } }>("/logs", async (req) => logsSince(Number(req.query.after) || 0));

  app.get("/ws", { websocket: true }, (socket) => {
    const send = (data: unknown) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(data));
    const rec = getRecording();
    send({ type: "hello", recording: rec ? publicSession(rec) : null });
    const off = bus.onEvent(send);
    foundry.sockets++;
    socket.on("close", () => {
      off();
      foundry.sockets--;
    });
  });

  app.post("/roster", async (req, reply) => {
    const parsed = RosterPayloadSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const rows: RosterRow[] = parsed.data.users.map((u) => ({
      foundry_user_id: u.id,
      user_name: u.name,
      is_gm: Number(u.isGM),
      actor_id: u.character?.id ?? null,
      actor_name: u.character?.name ?? null,
      actor_img: u.character?.img ?? null,
      discord_id: u.discordId,
    }));
    store.replaceRoster(rows);
    const actorsJson = JSON.stringify(parsed.data.actors, null, 2);
    writeFileAtomic(foundryActorsFile(), actorsJson);
    // The session's own copy: the session named in the sync (start/stop), else the one recording.
    const session = (parsed.data.sessionId ? findSession(parsed.data.sessionId) : null) ?? getRecording();
    if (session) {
      fs.mkdirSync(sessionPaths(session.id).dir, { recursive: true });
      writeFileAtomic(sessionPaths(session.id).actors, actorsJson);
    }
    foundry.lastRosterAt = new Date().toISOString();
    foundry.lastRosterWorld = parsed.data.world;
    // Fill in Foundry's "Discord ID" flags from /scrib map, including mappings made while Foundry
    // was offline; this repeats on every sync until the flags match (05 C11).
    const links = linksToWrite(store.getAllMappings(), rows);
    if (links.length) {
      console.log(`[api] asking Foundry to link ${links.length} user(s) to their Discord IDs (from /scrib map)`);
      bus.emitEvent({ type: "roster.link", links });
    }
    return { ok: true, users: rows.length, actors: parsed.data.actors.length, links: links.length };
  });

  app.get("/sessions", async () => store.listSessions(50).map(publicSession));

  app.get<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
    const s = findSession(req.params.id);
    return s ? publicSession(s) : reply.code(404).send({ error: "no such session" });
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/chatlog", async (req, reply) => {
    const s = findSession(req.params.id);
    if (!s) return reply.code(404).send({ error: "no such session" });
    const parsed = ChatLogSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    fs.mkdirSync(sessionPaths(s.id).dir, { recursive: true });
    writeFileAtomic(sessionPaths(s.id).chatlog, JSON.stringify(parsed.data, null, 2));
    foundry.lastChatlogAt = new Date().toISOString();
    return { ok: true, messages: parsed.data.messages.length, combats: parsed.data.combats.length };
  });

  const serveJson = (key: "summary" | "transcriptJson") =>
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const s = findSession(req.params.id);
      if (!s) return reply.code(404).send({ error: "no such session" });
      const file = sessionPaths(s.id)[key];
      if (!fs.existsSync(file)) return reply.code(404).send({ error: `${key} not available yet`, status: s.status });
      return reply.type("application/json").send(fs.readFileSync(file, "utf8"));
    };
  app.get("/sessions/:id/summary", serveJson("summary"));
  app.get("/sessions/:id/transcript", serveJson("transcriptJson"));

  await app.listen({ host: config.api.host, port: config.api.port });
  console.log(`[api] listening on http://${config.api.host}:${config.api.port}`);
  return app;
}
