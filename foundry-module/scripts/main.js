/**
 * ScribBot Bridge: connects this world to the ScribBot Discord recorder.
 *
 * One browser, the "bridge", talks to the bot: the active GM's by default, or the user
 * picked in the "Bridge user" setting (which may be a player, e.g. whoever runs the bot):
 *  - pushes the user → character roster (so Discord voices map to actors)
 *  - when recording stops, uploads that window's chat messages and combats
 *  - when the summary is ready, fetches it and gets a JournalEntry created
 *  - when asked (/scrib story, or the Journal sidebar), imports a story write-up the same way
 *
 * GM-only work stays with the active GM's client:
 *  - logs combats as they happen (Foundry deletes a Combat when it ends)
 *  - creates the journal entry, relayed over Foundry's socket when the bridge is a player
 *  - writes users' "Discord ID" flags from the bot's /scrib map links (roster.link), relayed the same way
 */
import { actorDetails, changesDetails, hasDetails, isDetailItem } from "./actors.js";
import { buildJournalPages, buildStoryPages } from "./journal.js";
import { bridgeRole, journalTarget, planDiscordLinks, shouldExportMessage } from "./roles.js";

const MODULE = "scribbot-bridge";
const SOCKET = `module.${MODULE}`;
const COMBAT_LOG_DAYS = 14;
const RELAY_TIMEOUT_MS = 30_000;

const setting = (key) => game.settings.get(MODULE, key);
const isActiveGM = () => game.user.isGM && (game.users.activeGM ?? game.user) === game.user;
const bridgeUserId = () => setting("bridgeUser") || null;
const role = () =>
  bridgeRole({ bridgeUserId: bridgeUserId(), userId: game.user.id, isGM: game.user.isGM, activeGMId: game.users.activeGM?.id ?? null });
const log = (...args) => console.log("ScribBot |", ...args);

// ---------------------------------------------------------------- settings

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(MODULE, key, { config: true, ...data });
  reg("botUrl", { name: "SCRIBBOT.Settings.BotUrl.Name", hint: "SCRIBBOT.Settings.BotUrl.Hint", scope: "client", type: String, default: "http://localhost:7420", onChange: () => bridge.reconnect() });
  reg("apiToken", { name: "SCRIBBOT.Settings.Token.Name", hint: "SCRIBBOT.Settings.Token.Hint", scope: "client", type: String, default: "", onChange: () => bridge.reconnect() });
  // Choices are filled in on "ready", once game.users exists.
  reg("bridgeUser", { name: "SCRIBBOT.Settings.BridgeUser.Name", hint: "SCRIBBOT.Settings.BridgeUser.Hint", scope: "world", type: String, default: "", choices: {}, onChange: () => bridge.reconnect() });
  reg("journalFolder", { name: "SCRIBBOT.Settings.Folder.Name", hint: "SCRIBBOT.Settings.Folder.Hint", scope: "world", type: String, default: "ScribBot Sessions" });
  reg("autoImport", { name: "SCRIBBOT.Settings.AutoImport.Name", hint: "SCRIBBOT.Settings.AutoImport.Hint", scope: "world", type: Boolean, default: true });
  reg("includeTranscript", { name: "SCRIBBOT.Settings.Transcript.Name", hint: "SCRIBBOT.Settings.Transcript.Hint", scope: "world", type: Boolean, default: false });
  reg("playersCanView", { name: "SCRIBBOT.Settings.PlayersView.Name", hint: "SCRIBBOT.Settings.PlayersView.Hint", scope: "world", type: Boolean, default: true });
  game.settings.register(MODULE, "combatLog", { scope: "world", config: false, type: Array, default: [] });

  game.settings.registerMenu(MODULE, "discordIds", {
    name: "SCRIBBOT.Settings.DiscordIds.Name",
    label: "SCRIBBOT.Settings.DiscordIds.Label",
    hint: "SCRIBBOT.Settings.DiscordIds.Hint",
    icon: "fab fa-discord",
    type: DiscordIdConfig,
    restricted: true,
  });
});

Hooks.once("ready", () => {
  game.modules.get(MODULE).api = {
    syncRoster: () => bridge.syncRoster(),
    exportChatlog: (sessionId = "latest") => bridge.exportChatlog(sessionId),
    importSummary: (sessionId = "latest") => bridge.importSummary(sessionId),
    importStory: (sessionId = "latest") => bridge.importStory(sessionId),
    /** Read by ScribBot's headless client to check this client is the bridge and connected. */
    status: () => ({ ...role(), botSocket: bridge.socket?.readyState === WebSocket.OPEN }),
  };
  refreshBridgeUserChoices();
  game.socket.on(SOCKET, (msg) => relay.onMessage(msg).catch((e) => console.error("ScribBot |", e)));
  if (role().connect) bridge.connect();
});

function refreshBridgeUserChoices() {
  const cfg = game.settings.settings.get(`${MODULE}.bridgeUser`);
  if (!cfg) return;
  const choices = { "": game.i18n.localize("SCRIBBOT.Settings.BridgeUser.ActiveGM") };
  for (const u of game.users.contents) choices[u.id] = u.isGM ? `${u.name} (GM)` : u.name;
  cfg.choices = choices;
}
Hooks.on("createUser", refreshBridgeUserChoices);
Hooks.on("updateUser", refreshBridgeUserChoices);

// ---------------------------------------------------------------- bot API client

class Bridge {
  socket = null;
  retryMs = 2000;
  closedByUs = false;

  get baseUrl() {
    return String(setting("botUrl") || "").replace(/\/+$/, "");
  }

  async api(path, { method = "GET", body } = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${setting("apiToken")}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`ScribBot ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  connect() {
    if (!this.baseUrl || !setting("apiToken")) {
      log("not connecting: set the ScribBot URL and API token in module settings");
      return;
    }
    this.closedByUs = false;
    const wsUrl = `${this.baseUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(setting("apiToken"))}`;
    const socket = new WebSocket(wsUrl);
    this.socket = socket;
    socket.addEventListener("open", () => {
      log("connected to", this.baseUrl);
      this.retryMs = 2000;
      if (role().act) this.syncRoster().catch((e) => console.error(e));
    });
    socket.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onEvent(msg).catch((err) => {
        console.error("ScribBot |", err);
        ui.notifications.error(`ScribBot: ${err.message}`);
      });
    });
    socket.addEventListener("close", () => {
      if (this.closedByUs || this.socket !== socket) return;
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 60_000);
    });
  }

  // Also runs on every client when the world's bridge user changes, so the old bridge
  // disconnects and the new one connects.
  reconnect() {
    this.closedByUs = true;
    this.socket?.close();
    this.socket = null;
    if (role().connect) this.connect();
  }

  async onEvent(msg) {
    if (!role().act) return; // with several GMs online and no bridge user, only the active GM acts
    switch (msg.type) {
      case "session.started":
        ui.notifications.info(`ScribBot is recording session ${msg.number}.`);
        // Fresh character and NPC details for this session (derived values such as max HP
        // don't fire an update hook, so take them now).
        await this.syncRoster(msg.sessionId);
        break;
      case "session.stopped":
        // And again at the end, so level-ups and changes during play are in the session's copy.
        await this.syncRoster(msg.sessionId).catch((e) => console.error("ScribBot |", e));
        await this.exportChatlog(msg.sessionId, msg.startedAt, msg.endedAt);
        break;
      case "summary.ready":
        if (setting("autoImport")) await this.importSummary(msg.sessionId);
        else ui.notifications.info(`ScribBot summary for session ${msg.number} is ready. Import it from the Journal sidebar.`);
        break;
      case "story.ready":
        // Always imported: a story is only announced when someone asks for it.
        await this.importStory(msg.sessionId);
        break;
      case "session.status":
        if (msg.status === "failed") ui.notifications.warn(`ScribBot: processing failed: ${msg.error}`);
        break;
      case "roster.link":
        await this.linkDiscordIds(msg.links);
        break;
    }
  }

  /**
   * Store the Discord IDs the bot knows from /scrib map as each user's "Discord ID" flag, so
   * nobody has to type them in. Only a GM may edit other users: a player bridge relays this to
   * the active GM's client. With no GM online it waits; the bot sends it again on the next roster sync.
   */
  async linkDiscordIds(links) {
    let changed;
    if (game.user.isGM) changed = await applyDiscordLinks(links);
    else if (game.users.activeGM) changed = await relay.request("linkDiscord", { links });
    else {
      log("Discord ID links from /scrib map are waiting for a GM to log in");
      return;
    }
    if (changed) await this.syncRoster();
  }

  // ---- roster

  /** @param {string} [sessionId] also save the actor details as that session's copy */
  async syncRoster(sessionId) {
    const users = game.users.contents.map((u) => ({
      id: u.id,
      name: u.name,
      isGM: u.isGM,
      discordId: u.getFlag(MODULE, "discordId") || null,
      character: u.character ? { id: u.character.id, name: u.character.name, img: u.character.img ?? null } : null,
    }));
    const actors = game.actors.contents.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type ?? null,
      ...(hasDetails(a) ? actorDetails(a) : {}),
    }));
    const body = { world: game.world.id, users, actors, ...(sessionId ? { sessionId } : {}) };
    const res = await this.api("/roster", { method: "POST", body });
    log(`roster synced: ${res.users} users, ${res.actors} actors`);
  }

  // ---- chat + combat export

  async exportChatlog(sessionId, startedAt, endedAt) {
    if (!startedAt || !endedAt) {
      const s = await this.api(`/sessions/${sessionId}`);
      sessionId = s.id;
      startedAt = s.startedAt;
      endedAt = s.endedAt ?? new Date().toISOString();
    }
    const from = Date.parse(startedAt) - 60_000;
    const to = Date.parse(endedAt) + 60_000;
    const icStyle = CONST.CHAT_MESSAGE_STYLES?.IC ?? CONST.CHAT_MESSAGE_TYPES?.IC;

    const messages = game.messages.contents
      .filter((m) => m.timestamp >= from && m.timestamp <= to)
      .map((m) => ({
        id: m.id,
        timestamp: m.timestamp,
        alias: m.speaker?.alias ?? m.alias ?? null,
        actorId: m.speaker?.actor ?? null,
        userName: (m.author ?? m.user)?.name ?? null,
        inCharacter: (m.style ?? m.type) === icStyle,
        isRoll: Boolean(m.isRoll),
        whisper: (m.whisper?.length ?? 0) > 0 || Boolean(m.blind),
        flavor: m.flavor || null,
        content: m.content ?? "",
        rolls: (m.rolls ?? []).map((r) => ({
          formula: r.formula,
          total: Number.isFinite(r.total) ? r.total : null,
          flavor: r.options?.flavor ?? null,
        })),
      }))
      .filter((m) => shouldExportMessage(m, game.user.isGM));

    const combats = combatTracker.entries().filter((c) => (c.startedAt ?? c.createdAt) <= to && (c.endedAt ?? Date.now()) >= from);
    const res = await this.api(`/sessions/${sessionId}/chatlog`, {
      method: "POST",
      body: {
        world: game.world.id,
        system: { id: game.system.id, title: game.system.title ?? null, version: game.system.version ?? null },
        exportedAt: Date.now(),
        messages,
        combats,
      },
    });
    log(`chat log sent: ${res.messages} messages, ${res.combats} combats`);
    ui.notifications.info(`ScribBot: sent ${res.messages} chat messages and ${res.combats} combats for the summary.`);
  }

  // ---- journal import

  /** Imports waiting for a GM to come online (bridge is a player who can't create journals): "summary:<id>" or "story:<id>". */
  pendingImports = new Set();

  /** Where a journal can be created from this client: "self", "gm" (relay) or "none". */
  journalTarget() {
    return journalTarget({
      isGM: game.user.isGM,
      activeGMId: game.users.activeGM?.id ?? null,
      canCreate: JournalEntry.canUserCreate(game.user),
    });
  }

  async importSummary(sessionId = "latest") {
    const file = await this.api(`/sessions/${sessionId}/summary`);
    let transcript = null;
    if (setting("includeTranscript")) transcript = await this.api(`/sessions/${file.sessionId}/transcript`).catch(() => null);

    const target = this.journalTarget();
    if (target === "none") {
      this.pendingImports.add(`summary:${file.sessionId}`);
      ui.notifications.warn(`ScribBot: session ${file.sessionNumber}'s summary is ready, but no GM is online to create the journal entry. It will be imported when a GM connects.`);
      return null;
    }
    const result = target === "self" ? await createSessionJournal(file, transcript) : await relay.request("createJournal", { file, transcript });
    this.pendingImports.delete(`summary:${file.sessionId}`);
    if (target === "gm") ui.notifications.info(`ScribBot: the GM's client imported "${result.name}".`);
    return result;
  }

  /** Imports a story write-up (summarize-session skill) as its own journal entry, one page per section. */
  async importStory(sessionId = "latest") {
    const file = await this.api(`/sessions/${sessionId}/story`);
    const target = this.journalTarget();
    if (target === "none") {
      this.pendingImports.add(`story:${file.sessionId}`);
      ui.notifications.warn(`ScribBot: the story "${file.title}" is ready, but no GM is online to create the journal entry. It will be imported when a GM connects.`);
      return null;
    }
    const images = await this.uploadStoryImages(file);
    const result = target === "self" ? await createStoryJournal(file, images) : await relay.request("createStory", { file, images });
    this.pendingImports.delete(`story:${file.sessionId}`);
    if (target === "gm") ui.notifications.info(`ScribBot: the GM's client imported "${result.name}".`);
    return result;
  }

  /**
   * Copies a story's images from the bot into Foundry's file storage (scribbot/<session>/), so the
   * journal loads them from Foundry and never needs the bot or its token. Needs permission to
   * upload files; without it the story is imported without images. Returns { src: path }.
   */
  async uploadStoryImages(file) {
    const images = {};
    if (!file.assets?.length) return images;
    if (!game.user.can("FILES_UPLOAD")) {
      ui.notifications.warn(`ScribBot: ${game.user.name} may not upload files, so "${file.title}" is imported without its images. A GM can allow it in User Management (Upload New Files), or import it themselves.`);
      return images;
    }
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
    const dir = `scribbot/${file.sessionId}`;
    for (const d of ["scribbot", dir]) await FP.createDirectory("data", d).catch(() => {}); // exists already
    for (const name of file.assets) {
      try {
        const res = await fetch(`${this.baseUrl}/sessions/${file.sessionId}/story/assets/${encodeURIComponent(name)}`, {
          headers: { Authorization: `Bearer ${setting("apiToken")}` },
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        const blob = await res.blob();
        const up = await FP.upload("data", dir, new File([blob], name, { type: blob.type }), {}, { notify: false });
        images[name] = up?.path ?? `${dir}/${name}`;
      } catch (err) {
        console.error("ScribBot |", err);
        ui.notifications.warn(`ScribBot: couldn't copy the image ${name} into Foundry (${err.message}); the story is imported without it.`);
      }
    }
    return images;
  }

  async retryPendingImports() {
    for (const key of [...this.pendingImports]) {
      const [kind, sessionId] = key.split(/:(.*)/s);
      const run = kind === "story" ? this.importStory(sessionId) : this.importSummary(sessionId);
      await run.catch((err) => ui.notifications.error(`ScribBot: ${err.message}`));
    }
  }
}

const bridge = new Bridge();

// A player bridge hands queued summaries to the first GM who connects.
Hooks.on("userConnected", (user, connected) => {
  if (!connected || !user.isGM || !role().act || !bridge.pendingImports.size) return;
  setTimeout(() => bridge.retryPendingImports(), 3000); // let that GM's client finish loading
});

// ---------------------------------------------------------------- journal creation

/** Creates (or refreshes) the session's journal entry. Runs on a GM's client, or a player's allowed to create journals. */
/** GM-only: write the "Discord ID" flags a roster.link asked for. Returns how many changed. */
async function applyDiscordLinks(links) {
  if (!game.user.isGM) throw new Error("only a GM can set other users' Discord IDs");
  const users = game.users.contents.map((u) => ({ id: u.id, discordId: u.getFlag(MODULE, "discordId") ?? null }));
  const changes = planDiscordLinks(links, users);
  for (const c of changes) {
    const user = game.users.get(c.userId);
    if (!user) continue;
    if (c.discordId) await user.setFlag(MODULE, "discordId", c.discordId);
    else await user.unsetFlag(MODULE, "discordId");
    log(`${user.name}: Discord ID ${c.previous ?? "(none)"} → ${c.discordId ?? "(none)"} (from /scrib map)`);
  }
  return changes.length;
}

async function createSessionJournal(file, transcript) {
  const folder = await ensureFolder();
  const pages = buildJournalPages(file, transcript, game.actors.contents);
  const name = `Session ${file.sessionNumber}: ${file.summary.title}`;
  const ownership = { default: setting("playersCanView") ? CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE };

  let entry = game.journal.find((j) => j.getFlag(MODULE, "sessionId") === file.sessionId);
  if (entry) {
    await entry.deleteEmbeddedDocuments("JournalEntryPage", entry.pages.map((p) => p.id));
    await entry.update({ name, folder: folder?.id ?? null });
    await entry.createEmbeddedDocuments("JournalEntryPage", pages);
  } else {
    entry = await JournalEntry.create({
      name,
      folder: folder?.id ?? null,
      ownership,
      pages,
      flags: { [MODULE]: { sessionId: file.sessionId, sessionNumber: file.sessionNumber } },
    });
  }
  ui.notifications.info(`ScribBot: imported "${name}".`);
  entry.sheet.render(true);
  return { id: entry.id, name };
}

/** Creates (or refreshes) the journal entry for a story write-up. Same placement and permissions as summaries. */
async function createStoryJournal(file, images = {}) {
  const folder = await ensureFolder();
  const pages = buildStoryPages(file, game.actors.contents, images);
  if (!pages.length) throw new Error(`the story "${file.title}" has no sections to import`);
  const name = `Session ${file.sessionNumbers.join(" + ")}: ${file.title}`;
  const ownership = { default: setting("playersCanView") ? CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE };

  let entry = game.journal.find((j) => j.getFlag(MODULE, "storyId") === file.sessionId);
  if (entry) {
    await entry.deleteEmbeddedDocuments("JournalEntryPage", entry.pages.map((p) => p.id));
    await entry.update({ name, folder: folder?.id ?? null });
    await entry.createEmbeddedDocuments("JournalEntryPage", pages);
  } else {
    entry = await JournalEntry.create({
      name,
      folder: folder?.id ?? null,
      ownership,
      pages,
      flags: { [MODULE]: { storyId: file.sessionId, sessionNumbers: file.sessionNumbers } },
    });
  }
  ui.notifications.info(`ScribBot: imported "${name}".`);
  entry.sheet.render(true);
  return { id: entry.id, name };
}

async function ensureFolder() {
  const name = setting("journalFolder");
  if (!name) return null;
  const existing = game.folders.find((f) => f.type === "JournalEntry" && f.name === name);
  if (existing) return existing;
  // Players usually can't create folders; put the entry at the top level instead.
  return Folder.canUserCreate?.(game.user) === false ? null : Folder.create({ name, type: "JournalEntry" });
}

// ---------------------------------------------------------------- relay to the GM's client
//
// Module socket messages reach every connected client, so payloads must be fine for any
// player to see: only the summary, transcript and story travel this way, never whispers. The GM's
// client rebuilds the pages itself with buildJournalPages / buildStoryPages, which escape all text.

const relay = {
  pending: new Map(),

  /** Ask the active GM's client to run an action; resolves with its result. */
  request(action, data) {
    const gm = game.users.activeGM;
    if (!gm) return Promise.reject(new Error("no GM is online"));
    const id = foundry.utils.randomID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${gm.name}'s client didn't respond. Is ScribBot Bridge enabled and up to date there?`));
      }, RELAY_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      game.socket.emit(SOCKET, { kind: "request", id, action, data, from: game.user.id, to: gm.id });
    });
  },

  async onMessage(msg) {
    if (!msg || msg.to !== game.user.id) return;

    if (msg.kind === "reply") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.data);
      return;
    }

    // Requests: only the active GM serves them, and only for the configured bridge user.
    if (msg.kind !== "request" || !isActiveGM() || !bridgeUserId() || msg.from !== bridgeUserId()) return;
    let data = null;
    let error = null;
    try {
      if (msg.action === "createJournal") {
        if (!msg.data?.file?.summary || !msg.data.file.sessionId) throw new Error("malformed summary");
        data = await createSessionJournal(msg.data.file, msg.data.transcript ?? null);
      } else if (msg.action === "createStory") {
        const f = msg.data?.file;
        if (typeof f?.markdown !== "string" || !f.sessionId || !Array.isArray(f.sessionNumbers)) throw new Error("malformed story");
        // Only paths the bridge uploaded under scribbot/, never an arbitrary URL from the socket.
        const images = Object.fromEntries(
          Object.entries(msg.data?.images ?? {}).filter(([, p]) => typeof p === "string" && /^scribbot\/[\w./ ()-]+$/.test(p) && !p.includes("..")),
        );
        data = await createStoryJournal(f, images);
      } else if (msg.action === "linkDiscord") {
        data = await applyDiscordLinks(msg.data?.links);
      } else {
        throw new Error(`unknown action "${msg.action}"`);
      }
    } catch (err) {
      error = err.message;
    }
    game.socket.emit(SOCKET, { kind: "reply", id: msg.id, data, error, from: game.user.id, to: msg.from });
  },
};

// ---------------------------------------------------------------- combat tracking

const combatTracker = {
  entries() {
    const saved = foundry.utils.deepClone(setting("combatLog") ?? []);
    // Combats still running have no saved end yet; take a live snapshot.
    for (const c of game.combats.contents) {
      const live = snapshotCombat(c);
      const i = saved.findIndex((s) => s.id === c.id);
      if (i >= 0) saved[i] = { ...saved[i], ...live, startedAt: saved[i].startedAt ?? live.startedAt };
      else saved.push(live);
    }
    return saved;
  },

  async save(combat, patch = {}) {
    if (!isActiveGM()) return;
    const cutoff = Date.now() - COMBAT_LOG_DAYS * 86_400_000;
    const log = (setting("combatLog") ?? []).filter((c) => (c.endedAt ?? c.createdAt ?? Date.now()) > cutoff);
    const i = log.findIndex((c) => c.id === combat.id);
    const next = { ...(i >= 0 ? log[i] : { createdAt: Date.now(), startedAt: null, endedAt: null }), ...snapshotCombat(combat), ...patch };
    if (i >= 0 && log[i].startedAt && !patch.startedAt) next.startedAt = log[i].startedAt;
    if (i >= 0) log[i] = next;
    else log.push(next);
    await game.settings.set(MODULE, "combatLog", log);
  },
};

function snapshotCombat(combat) {
  return {
    id: combat.id,
    name: combat.scene?.name ?? null,
    scene: combat.scene?.name ?? null,
    round: combat.round ?? 0,
    startedAt: combat.started ? Date.now() : null,
    combatants: combat.combatants.contents.map((c) => ({
      name: c.name,
      actorId: c.actorId ?? null,
      isNPC: !c.hasPlayerOwner,
      defeated: Boolean(c.isDefeated),
      hidden: Boolean(c.hidden),
    })),
  };
}

Hooks.on("combatStart", (combat) => combatTracker.save(combat, { startedAt: Date.now() }));
Hooks.on("updateCombat", (combat, changes) => {
  if ("round" in changes || "turn" in changes) combatTracker.save(combat);
});
Hooks.on("updateCombatant", (combatant) => combatant.parent && combatTracker.save(combatant.parent));
Hooks.on("deleteCombat", (combat) => combatTracker.save(combat, { endedAt: Date.now() }));

// Keep the roster fresh when characters are assigned, renamed, level up or their details change.
// While recording, the bot also saves each sync as the session's copy of the actor details.
const resync = foundry.utils.debounce(() => {
  if (role().act && bridge.socket?.readyState === WebSocket.OPEN) bridge.syncRoster().catch((e) => console.error(e));
}, 2000);
Hooks.on("updateUser", resync);
Hooks.on("createActor", resync);
Hooks.on("deleteActor", resync);
Hooks.on("updateActor", (actor, changes) => changesDetails(changes) && resync());
for (const hook of ["createItem", "updateItem", "deleteItem"]) Hooks.on(hook, (item) => isDetailItem(item) && resync());

// ---------------------------------------------------------------- journal sidebar button

// Shown to whoever holds the bot connection (a player bridge included), since the button
// needs the bot's URL and token.
Hooks.on("renderJournalDirectory", (app, html) => {
  if (!role().connect) return;
  const root = html instanceof HTMLElement ? html : html[0];
  if (root.querySelector(".scribbot-import")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "scribbot-import";
  button.innerHTML = `<i class="fas fa-feather-pointed"></i> ${game.i18n.localize("SCRIBBOT.Import")}`;
  button.addEventListener("click", () => promptImport());
  const target = root.querySelector(".header-actions") ?? root.querySelector(".directory-header");
  target?.append(button);
});

async function promptImport() {
  let sessions;
  try {
    sessions = (await bridge.api("/sessions")).filter((s) => s.hasSummary || s.hasStory);
  } catch (err) {
    ui.notifications.error(`ScribBot: ${err.message}`);
    return;
  }
  if (!sessions.length) {
    ui.notifications.warn("ScribBot has no summaries or stories yet.");
    return;
  }
  // One option per thing to import: "summary:<id>" (the bot's AI summary) or "story:<id>" (a story write-up).
  const options = sessions
    .flatMap((s) => {
      const when = `Session ${s.number} (${new Date(s.startedAt).toLocaleDateString()})`;
      return [
        ...(s.hasStory ? [`<option value="story:${s.id}">${when}: story</option>`] : []),
        ...(s.hasSummary ? [`<option value="summary:${s.id}">${when}: summary</option>`] : []),
      ];
    })
    .join("");
  const choice = await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize("SCRIBBOT.Import") },
    content: `<div class="form-group"><label>Import</label><select name="choice">${options}</select></div>`,
    ok: { label: "Import", callback: (_ev, button) => button.form.elements.choice.value },
  });
  if (!choice) return;
  const [kind, sessionId] = choice.split(/:(.*)/s);
  const run = kind === "story" ? bridge.importStory(sessionId) : bridge.importSummary(sessionId);
  await run.catch((err) => ui.notifications.error(`ScribBot: ${err.message}`));
}

// ---------------------------------------------------------------- Discord ID editor

const { ApplicationV2 } = foundry.applications.api;

class DiscordIdConfig extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "scribbot-discord-ids",
    tag: "form",
    classes: ["scribbot-discord-ids"],
    window: { title: "ScribBot: Discord accounts", icon: "fab fa-discord" },
    position: { width: 480 },
    form: { handler: DiscordIdConfig.#onSubmit, closeOnSubmit: true },
  };

  async _renderHTML() {
    const esc = foundry.utils.escapeHTML ?? ((s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`));
    const rows = game.users.contents
      .map((u) => {
        const who = u.isGM ? "GM" : (u.character?.name ?? "no character assigned");
        const value = esc(u.getFlag(MODULE, "discordId") ?? "");
        return `<div class="form-group">
          <label>${esc(u.name)} <span class="hint">(${esc(who)})</span></label>
          <input type="text" name="${u.id}" value="${value}" placeholder="Discord user ID" pattern="\\d{15,22}">
        </div>`;
      })
      .join("");
    const div = document.createElement("div");
    div.innerHTML = `<p class="hint">In Discord, enable Developer Mode, then right-click a user and choose <b>Copy User ID</b>.</p>
      ${rows}
      <footer><button type="submit"><i class="fas fa-save"></i> Save</button></footer>`;
    return div;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  static async #onSubmit(_event, _form, formData) {
    for (const [userId, value] of Object.entries(formData.object)) {
      const user = game.users.get(userId);
      const id = String(value ?? "").trim();
      if (!user || id === (user.getFlag(MODULE, "discordId") ?? "")) continue;
      if (id) await user.setFlag(MODULE, "discordId", id);
      else await user.unsetFlag(MODULE, "discordId");
    }
    if (bridge.socket?.readyState === WebSocket.OPEN) await bridge.syncRoster();
  }
}
