/**
 * ScribBot Bridge: connects this world to the ScribBot Discord recorder.
 *
 * Only the active GM's browser talks to the bot:
 *  - pushes the user → character roster (so Discord voices map to actors)
 *  - logs combats as they happen (Foundry deletes a Combat when it ends)
 *  - when recording stops, uploads that window's chat messages and combats
 *  - when the summary is ready, builds a JournalEntry from it
 */
import { buildJournalPages } from "./journal.js";

const MODULE = "scribbot-bridge";
const COMBAT_LOG_DAYS = 14;

const setting = (key) => game.settings.get(MODULE, key);
const isActiveGM = () => game.user.isGM && (game.users.activeGM ?? game.user) === game.user;
const log = (...args) => console.log("ScribBot |", ...args);

// ---------------------------------------------------------------- settings

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(MODULE, key, { config: true, ...data });
  reg("botUrl", { name: "SCRIBBOT.Settings.BotUrl.Name", hint: "SCRIBBOT.Settings.BotUrl.Hint", scope: "client", type: String, default: "http://localhost:7420", onChange: () => bridge.reconnect() });
  reg("apiToken", { name: "SCRIBBOT.Settings.Token.Name", hint: "SCRIBBOT.Settings.Token.Hint", scope: "client", type: String, default: "", onChange: () => bridge.reconnect() });
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
  };
  if (game.user.isGM) bridge.connect();
});

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
      if (isActiveGM()) this.syncRoster().catch((e) => console.error(e));
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

  reconnect() {
    if (!game.user.isGM) return;
    this.closedByUs = true;
    this.socket?.close();
    this.connect();
  }

  async onEvent(msg) {
    if (!isActiveGM()) return; // with several GMs online, only one acts
    switch (msg.type) {
      case "session.started":
        ui.notifications.info(`ScribBot is recording session ${msg.number}.`);
        break;
      case "session.stopped":
        await this.exportChatlog(msg.sessionId, msg.startedAt, msg.endedAt);
        break;
      case "summary.ready":
        if (setting("autoImport")) await this.importSummary(msg.sessionId);
        else ui.notifications.info(`ScribBot summary for session ${msg.number} is ready. Import it from the Journal sidebar.`);
        break;
      case "session.status":
        if (msg.status === "failed") ui.notifications.warn(`ScribBot: processing failed: ${msg.error}`);
        break;
    }
  }

  // ---- roster

  async syncRoster() {
    const users = game.users.contents.map((u) => ({
      id: u.id,
      name: u.name,
      isGM: u.isGM,
      discordId: u.getFlag(MODULE, "discordId") || null,
      character: u.character ? { id: u.character.id, name: u.character.name, img: u.character.img ?? null } : null,
    }));
    const actors = game.actors.contents.map((a) => ({ id: a.id, name: a.name, type: a.type ?? null }));
    const res = await this.api("/roster", { method: "POST", body: { world: game.world.id, users, actors } });
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
      }));

    const combats = combatTracker.entries().filter((c) => (c.startedAt ?? c.createdAt) <= to && (c.endedAt ?? Date.now()) >= from);
    const res = await this.api(`/sessions/${sessionId}/chatlog`, {
      method: "POST",
      body: { world: game.world.id, exportedAt: Date.now(), messages, combats },
    });
    log(`chat log sent: ${res.messages} messages, ${res.combats} combats`);
    ui.notifications.info(`ScribBot: sent ${res.messages} chat messages and ${res.combats} combats for the summary.`);
  }

  // ---- journal import

  async importSummary(sessionId = "latest") {
    const file = await this.api(`/sessions/${sessionId}/summary`);
    let transcript = null;
    if (setting("includeTranscript")) transcript = await this.api(`/sessions/${file.sessionId}/transcript`).catch(() => null);

    const folder = await this.ensureFolder();
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
    return entry;
  }

  async ensureFolder() {
    const name = setting("journalFolder");
    if (!name) return null;
    return game.folders.find((f) => f.type === "JournalEntry" && f.name === name) ?? Folder.create({ name, type: "JournalEntry" });
  }
}

const bridge = new Bridge();

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

// Keep the roster fresh when characters are assigned or renamed.
const resync = foundry.utils.debounce(() => {
  if (isActiveGM() && bridge.socket?.readyState === WebSocket.OPEN) bridge.syncRoster().catch((e) => console.error(e));
}, 2000);
Hooks.on("updateUser", resync);
Hooks.on("createActor", resync);
Hooks.on("updateActor", (actor, changes) => "name" in changes && resync());

// ---------------------------------------------------------------- journal sidebar button

Hooks.on("renderJournalDirectory", (app, html) => {
  if (!game.user.isGM) return;
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
    sessions = (await bridge.api("/sessions")).filter((s) => s.hasSummary);
  } catch (err) {
    ui.notifications.error(`ScribBot: ${err.message}`);
    return;
  }
  if (!sessions.length) {
    ui.notifications.warn("ScribBot has no summarized sessions yet.");
    return;
  }
  const options = sessions
    .map((s) => `<option value="${s.id}">Session ${s.number} (${new Date(s.startedAt).toLocaleDateString()})</option>`)
    .join("");
  const sessionId = await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize("SCRIBBOT.Import") },
    content: `<div class="form-group"><label>Session</label><select name="session">${options}</select></div>`,
    ok: { label: "Import", callback: (_ev, button) => button.form.elements.session.value },
  });
  if (sessionId) await bridge.importSummary(sessionId).catch((err) => ui.notifications.error(`ScribBot: ${err.message}`));
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
