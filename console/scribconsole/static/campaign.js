// Campaign: which campaign is being played, and what each campaign is: its name, Foundry world and
// Foundry server, who plays which character, the world description and the glossary.
// Campaign changes go through the bot's /admin API (the same code as the /scrib commands); the
// notes are files the Console writes itself (CAMPAIGN_DIR/<campaign folder>/). Foundry passwords
// never come to the page: only whether one is set.
import { $, api, attempt, confirmDialog, esc, openDialog, pill, toast, when } from "./util.js";

let root = null;
let status = null;
let data = null; // GET /api/admin/campaigns
let selectedId = null; // the campaign shown below the list
let mappings = null; // GET /api/admin/mappings?campaign=<selected>
let notes = {}; // name -> GET /api/campaign/<name>?campaign=<folder>
let loading = false;

const NOTES = {
  context: { file: "context.md", label: "World description", help: "The setting, the party and the story so far. The summarizer reads it with every session of this campaign." },
  glossary: { file: "glossary.md", label: "Glossary", help: "Names of people, places and things, one per line with an optional “: note”. Speech-to-text is steered towards them, and the summarizer spells them this way." },
};

export function show(el, s) {
  root = el;
  status = s;
  if (!root.dataset.ready) {
    root.innerHTML = `
      <section class="card" id="cp-list"><div class="card-head"><h2>Campaigns</h2></div><p class="muted">Loading…</p></section>
      <section class="card" id="cp-detail" hidden></section>
      <section class="card" id="cp-mappings" hidden></section>
      <section class="card" id="cp-notes" hidden></section>`;
    root.dataset.ready = "1";
    root.addEventListener("click", onClick);
    root.addEventListener("submit", (e) => { e.preventDefault(); save(); });
  }
  load();
}

export function update(s) {
  const before = status?.campaign?.id;
  status = s;
  if (!root || root.hidden) return;
  // The bot can change the campaign being played by itself (a roster sync claims a world).
  if (s.campaign?.id !== before && !loading) load(false);
}

const playing = () => data?.campaigns.find((c) => c.isDefault) ?? null;
const current = () => data?.campaigns.find((c) => c.id === selectedId) ?? null;

async function load(full = true) {
  loading = true;
  try {
    data = await api("GET", "/api/admin/campaigns");
  } catch (err) {
    $("cp-list").innerHTML = `<div class="card-head"><h2>Campaigns</h2></div><p class="error-text">${esc(err.message)}</p>`;
    return;
  } finally {
    loading = false;
  }
  const visibleIds = new Set(data.campaigns.map((c) => c.id));
  if (!visibleIds.has(selectedId)) selectedId = playing()?.id ?? data.campaigns.find((c) => !c.unassigned)?.id ?? data.campaigns[0]?.id ?? null;
  renderList();
  renderDetail();
  if (full) {
    loadMappings();
    loadNotes();
  }
}

// ---------- the list, and the campaign being played

function foundryLabel(c) {
  return c.foundry?.url ? esc(c.foundry.url) : `<span class="muted">none</span>`;
}

function renderList() {
  const el = $("cp-list");
  const ro = data.readOnly;
  const real = data.campaigns.filter((c) => !c.unassigned || c.sessions);
  const p = playing();
  const auto = data.chosenId == null;
  const rowsHtml = real.map((c) => `<tr class="clickable ${c.id === selectedId ? "selected" : ""}" data-pick="${c.id}">
      <td><b>${esc(c.name)}</b>${c.unassigned ? ` <span class="muted small">(recordings made before any world was known)</span>` : ""}</td>
      <td class="hide-narrow">${c.worldId ? `<code>${esc(c.worldId)}</code>` : `<span class="muted">not yet</span>`}</td>
      <td class="hide-narrow small">${c.unassigned ? "" : foundryLabel(c)}</td>
      <td>${c.sessions}</td>
      <td class="actions-cell">${c.isDefault ? pill("ok", c.chosen ? "being played" : "being played (automatic)") : c.unassigned || ro ? ""
        : `<button data-act="play" data-id="${c.id}">Play this campaign</button>`}</td></tr>`).join("");
  el.innerHTML = `<div class="card-head"><h2>Campaigns</h2><span class="spacer"></span>
      ${ro ? "" : `<button class="primary" data-act="new">New campaign…</button>`}</div>
    ${ro ? `<div class="notice readonly-banner" style="margin-bottom:10px">The bot isn't running, so campaigns are read-only (the notes below can still be edited). Start it with <code>.\\start.ps1</code>.</div>` : ""}
    <p class="muted small" style="margin-top:0">The campaign being played is where new recordings are filed and numbered, whose character mappings
      <code>/scrib map</code> changes, and whose Foundry server ScribBot joins.
      ${auto ? `Nothing is chosen, so it's the Foundry world that synced last${p ? ` (now <b>${esc(p.name)}</b>)` : ""}.`
        : `${ro ? "" : `<button class="link small" data-act="auto">Go back to automatic</button> (the Foundry world that synced last).`}`}</p>
    <div class="table-wrap"><table><thead><tr><th>Campaign</th><th class="hide-narrow">Foundry world</th><th class="hide-narrow">Foundry server</th><th>Sessions</th><th></th></tr></thead>
    <tbody>${rowsHtml || `<tr><td colspan="5" class="muted">No campaigns yet. Make one with <b>New campaign…</b>, or open a world in Foundry with the ScribBot module and it appears by itself.</td></tr>`}</tbody></table></div>`;
}

// ---------- one campaign: name, world and Foundry server

function renderDetail() {
  const el = $("cp-detail");
  const c = current();
  el.hidden = !c;
  if (!c) return;
  const ro = data.readOnly;
  const d = data.foundryDefaults || {};
  const dis = ro ? "disabled" : "";
  const locked = c.unassigned ? "disabled" : dis;
  const pwState = c.foundry.passwordSet ? pill("ok", "set for this campaign")
    : d.passwordSet ? pill("skip", "using FOUNDRY_PASSWORD from .env") : pill("warn", "not set");
  el.innerHTML = `<div class="card-head"><h2>${esc(c.name)}</h2>
      ${c.isDefault ? pill("ok", "being played") : ""}<span class="spacer"></span>
      ${!c.isDefault && !c.unassigned && !ro ? `<button data-act="play" data-id="${c.id}">Play this campaign</button>` : ""}
      ${!c.unassigned && !ro && c.rows === 0 ? `<button class="danger" data-act="delete" data-id="${c.id}">Delete…</button>` : ""}</div>
    <form id="cp-form" class="detail-grid" autocomplete="off">
      <div class="stack">
        <h3 class="small muted" style="margin:0">CAMPAIGN</h3>
        <label class="field"><span>Name</span><input name="alias" maxlength="100" value="${esc(c.alias || "")}" placeholder="${esc(c.title || c.folder)}" ${dis}>
          <small>${c.title ? `Foundry calls the world “${esc(c.title)}”. ` : ""}Blank uses the world's title.</small></label>
        <label class="field"><span>Foundry world</span><input name="worldId" maxlength="200" value="${esc(c.worldId || "")}" placeholder="e.g. curse-of-strahd" spellcheck="false" ${locked}>
          <small>The world's id (its folder in Foundry's Data/worlds). Left blank, it's filled in the first time a world syncs while this campaign is being played.
            ${data.rosterWorld ? `Foundry last synced <code>${esc(data.rosterWorld)}</code>.` : ""}</small></label>
        <div class="small muted">Files in <code>${esc(c.folderPath)}</code> · ${c.sessions} session${c.sessions === 1 ? "" : "s"}${c.lastSeenAt ? ` · last synced ${esc(when(c.lastSeenAt))}` : ""}</div>
      </div>
      <div class="stack">
        <h3 class="small muted" style="margin:0">FOUNDRY SERVER</h3>
        <label class="field"><span>Address</span><input name="foundryUrl" maxlength="500" value="${esc(c.foundry.url || "")}" placeholder="https://foundry.example.com" spellcheck="false" ${locked}>
          <small>Where ScribBot joins Foundry while this campaign is being played. Blank: ScribBot doesn't join Foundry for this campaign (nothing from <code>.env</code> is used).
            Pages from this address may call the bot, so it needn't be in <code>FOUNDRY_ORIGINS</code>. Kept in the bot's database, which git ignores.</small></label>
        <label class="field"><span>ScribBot's Foundry user</span><input name="foundryUser" maxlength="100" value="${esc(c.foundry.user || "")}" placeholder="${esc(d.user ? `blank = ${d.user}` : "ScribBot")}" ${locked}>
          <small>The player ScribBot logs in as; the GM makes it the module's <b>Bridge user</b>.</small></label>
        <div class="field"><span>Password</span>
          <div class="row">${pwState}
            <input name="foundryPassword" type="password" maxlength="500" placeholder="${c.foundry.passwordSet ? "type to replace" : "password"}" ${locked} style="flex:1;min-width:140px">
            ${c.foundry.passwordSet && !ro ? `<button type="button" class="danger" data-act="clear-password">Clear</button>` : ""}</div>
          <small>Kept by the bot, never shown again. ${d.headless === "off" ? "ScribBot doesn't join Foundry itself now (<code>FOUNDRY_HEADLESS=off</code> in Configuration)." : ""}</small></div>
      </div>
    </form>
    ${ro || c.unassigned ? "" : `<div class="row" style="margin-top:12px"><button class="primary" data-act="save">Save campaign</button>
      <span class="muted small">A change to the Foundry server applies at ScribBot's next join; one recording in progress keeps its server until it ends.</span></div>`}`;
}

async function save() {
  const c = current();
  const form = $("cp-form");
  if (!c || !form) return;
  const f = Object.fromEntries(new FormData(form));
  const body = {};
  const norm = (v) => (v ?? "").trim();
  if (norm(f.alias) !== (c.alias || "")) body.alias = norm(f.alias) || null;
  if (f.worldId !== undefined && norm(f.worldId) !== (c.worldId || "")) body.worldId = norm(f.worldId) || null;
  if (f.foundryUrl !== undefined && norm(f.foundryUrl) !== (c.foundry.url || "")) body.foundryUrl = norm(f.foundryUrl) || null;
  if (f.foundryUser !== undefined && norm(f.foundryUser) !== (c.foundry.user || "")) body.foundryUser = norm(f.foundryUser) || null;
  if (f.foundryPassword) body.foundryPassword = f.foundryPassword;
  if (!Object.keys(body).length) return toast("Nothing changed.");
  const ok = await attempt(() => api("PATCH", `/api/admin/campaigns/${c.id}`, body), "Campaign saved.");
  if (ok) load(false);
}

async function newCampaign() {
  const r = await openDialog(`<form><h3>New campaign</h3>
    <label class="field"><span>Name</span><input name="name" maxlength="100" required placeholder="e.g. Curse of Strahd"></label>
    <label class="field"><span>Foundry world (optional)</span><input name="worldId" maxlength="200" spellcheck="false" placeholder="the world's id, e.g. curse-of-strahd">
      <small>Leave blank to have it filled in the first time Foundry syncs while this campaign is being played.</small></label>
    <label class="check"><input type="checkbox" name="play" value="1" checked> Play this campaign now</label>
    <p class="muted small" style="margin:0">Then set its Foundry server, characters, world description and glossary below.</p>
    <div class="actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok">Create</button></div></form>`);
  if (!r) return;
  const res = await attempt(() => api("POST", "/api/admin/campaigns", { name: r.data.name.trim(), worldId: r.data.worldId?.trim() || null }),
    (x) => `Campaign “${x.campaign.name}” created.`);
  if (!res) return;
  selectedId = res.campaign.id;
  if (r.data.play) await choose(res.campaign.id, true);
  load();
}

async function choose(id, quiet = false) {
  const said = (x) => id === null
    ? `Back to automatic${x.playing ? `: now ${x.playing.name}, the world Foundry synced last` : ""}.`
    : `Now playing ${x.playing?.name ?? "it"}.${x.note ? ` ${x.note}` : ""}`;
  const res = await attempt(() => api("POST", "/api/admin/campaigns/playing", { campaignId: id }), quiet ? undefined : said);
  if (res && !quiet) load();
  return res;
}

async function deleteCampaign(c) {
  const ok = await confirmDialog(`Delete “${c.name}”?`,
    `<p>It has no sessions. Its character mappings go with it; its notes in <code>campaign\\${esc(c.folder)}</code> stay on disk.</p>`,
    { ok: "Delete", danger: true });
  if (!ok) return;
  if (await attempt(() => api("DELETE", `/api/admin/campaigns/${c.id}`), "Campaign deleted.")) {
    selectedId = null;
    load();
  }
}

// ---------- players and characters (/scrib map, unmap, gm), for the campaign shown

const q = () => `campaign=${encodeURIComponent(current()?.id ?? "")}`;

async function loadMappings() {
  const el = $("cp-mappings");
  const c = current();
  el.hidden = !c;
  if (!c) return;
  try {
    mappings = await api("GET", `/api/admin/mappings?${q()}`);
  } catch (err) {
    mappings = null;
    el.innerHTML = `<div class="card-head"><h2>Players and characters</h2></div><p class="muted">${esc(err.body?.offline ? "Needs the bot to be running." : err.message)}</p>`;
    return;
  }
  const rowsHtml = mappings.mappings.map((m) => `<tr>
      <td>${m.name ? esc(m.name) : `<span class="muted">${esc(m.discordId)}</span>`}</td>
      <td>${m.isGm ? "<b>GM</b>" : esc(m.character || "–")}${m.foundryUserId ? ` <span class="muted small">(Foundry linked)</span>` : ""}
        ${m.shared ? ` <span class="pill skip" title="Made before campaigns had their own mappings, so it applies in every campaign. Changing it here makes one for this campaign only.">every campaign</span>` : ""}</td>
      <td class="actions-cell">
        <button data-act="map-edit" data-guild="${esc(m.guildId)}" data-discord="${esc(m.discordId)}">Change</button>
        <button data-act="map-gm" data-guild="${esc(m.guildId)}" data-discord="${esc(m.discordId)}" data-value="${!m.isGm}">${m.isGm ? "Not GM" : "Make GM"}</button>
        <button class="danger" data-act="map-remove" data-guild="${esc(m.guildId)}" data-discord="${esc(m.discordId)}" data-shared="${m.shared}">Remove</button></td></tr>`).join("");
  const rosterNote = mappings.rosterMatches ? ""
    : `<div class="notice warn small" style="margin-bottom:8px">The Foundry roster ScribBot has is from the world <code>${esc(mappings.rosterWorld)}</code>,
        not this campaign's, so its Foundry users can't be picked here. Open this campaign's world in Foundry, or type a character name.</div>`;
  el.innerHTML = `<div class="card-head"><h2>Players and characters</h2><span class="muted small">in ${esc(c.name)}</span><span class="spacer"></span>
      <button data-act="map-refresh">Refresh</button><button data-act="map-add">Map a player…</button></div>
    <p class="muted small" style="margin-top:0">Who speaks for which character in this campaign. <code>/scrib map</code> and <code>/scrib gm</code> change the campaign being played.
      Picking a Foundry user also stores the Discord ID in Foundry. A change applies to people who haven't spoken yet in a running recording.</p>
    ${rosterNote}
    <div class="table-wrap"><table><thead><tr><th>Discord user</th><th>Character</th><th></th></tr></thead>
    <tbody>${rowsHtml || `<tr><td colspan="3" class="muted">Nobody is mapped yet. Linked Foundry users are recognized without a mapping.</td></tr>`}</tbody></table></div>`;
}

async function mapDialog(existing) {
  let guilds = [];
  try {
    guilds = (await api("GET", "/api/admin/discord")).guilds || [];
  } catch (err) {
    return toast(err.message, "err");
  }
  if (!guilds.length) return toast("The bot isn't in any Discord server.", "err");
  const people = new Map();
  for (const g of guilds) for (const v of g.voice) for (const m of v.members) people.set(`${g.id}:${m.id}`, { guildId: g.id, id: m.id, name: m.name });
  for (const m of mappings?.mappings || []) people.set(`${m.guildId}:${m.discordId}`, { guildId: m.guildId, id: m.discordId, name: m.name || m.discordId });
  const roster = mappings?.rosterMatches ? (mappings?.roster || []).filter((r) => r.actorName || r.isGm) : [];
  const r = await openDialog(`<form><h3>${existing ? `Change ${esc(existing.name || existing.discordId)}` : "Map a player"} <span class="muted small">in ${esc(current()?.name)}</span></h3>
    <label class="field" ${guilds.length > 1 && !existing ? "" : "hidden"}><span>Server</span><select name="guildId">
      ${guilds.map((g) => `<option value="${esc(g.id)}" ${existing?.guildId === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select></label>
    <label class="field" ${existing ? "hidden" : ""}><span>Discord user</span><select name="person">
      ${[...people.values()].map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}
      <option value="">Someone else (enter their user ID)…</option></select>
      <small>People in voice channels right now, and everyone already mapped.</small></label>
    <label class="field" ${existing ? "hidden" : ""}><span>…or their Discord user ID</span><input name="discordId" inputmode="numeric" pattern="\\d{5,25}" placeholder="Right-click the user → Copy User ID"></label>
    <label class="field"><span>Character</span><select name="character">
      ${roster.map((x) => `<option value="foundry:${esc(x.foundryUserId)}">${esc(x.actorName ? `${x.actorName} (Foundry user ${x.userName})` : `${x.userName} (GM)`)}</option>`).join("")}
      <option value="">Another name…</option></select></label>
    <label class="field"><span>…or a character name</span><input name="name" maxlength="100" placeholder="Not linked to a Foundry actor"></label>
    <div class="actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok">Save</button></div></form>`);
  if (!r) return;
  const guildId = existing?.guildId || r.data.guildId || guilds[0].id;
  const discordId = existing?.discordId || r.data.discordId?.trim() || r.data.person;
  const character = r.data.character || r.data.name?.trim();
  if (!discordId) return toast("Pick a Discord user or enter their ID.", "err");
  if (!character) return toast("Pick a character or enter a name.", "err");
  await attempt(() => api("PUT", `/api/admin/mappings/${encodeURIComponent(guildId)}/${encodeURIComponent(discordId)}?${q()}`, { character }),
    (x) => `Mapped to ${x.mapped.replace(/\*\*/g, "")}.`);
  loadMappings();
}

async function unmap(guildId, discordId, shared) {
  const body = shared
    ? "<p>This mapping is shared by <b>every campaign</b>, so it goes from all of them. They'll be labelled by their Foundry link, or else their Discord name.</p>"
    : "<p>They'll be labelled by their Foundry link, or else their Discord name.</p>";
  const ok = await confirmDialog("Remove this mapping?", body, { ok: "Remove", danger: true });
  if (!ok) return;
  await attempt(() => api("DELETE", `/api/admin/mappings/${encodeURIComponent(guildId)}/${encodeURIComponent(discordId)}?${q()}`), "Removed.");
  loadMappings();
}

async function setGm(guildId, discordId, isGm) {
  await attempt(() => api("POST", `/api/admin/mappings/${encodeURIComponent(guildId)}/${encodeURIComponent(discordId)}/gm?${q()}`, { isGm }),
    isGm ? "Marked as GM." : "No longer GM.");
  loadMappings();
}

// ---------- the world description and glossary, as files in CAMPAIGN_DIR/<folder>/

async function loadNotes() {
  const el = $("cp-notes");
  const c = current();
  el.hidden = !c;
  if (!c) return;
  const folder = c.folder;
  const parts = await Promise.all(Object.keys(NOTES).map(async (name) => {
    try {
      return [name, await api("GET", `/api/campaign/${name}?campaign=${encodeURIComponent(folder)}`)];
    } catch (err) {
      return [name, { error: err.message }];
    }
  }));
  if (current()?.folder !== folder) return; // another campaign was picked meanwhile
  notes = Object.fromEntries(parts);
  el.innerHTML = `<div class="card-head"><h2>World description and glossary</h2><span class="muted small">for ${esc(c.name)}</span></div>
    ${parts.map(([name, f]) => `<div class="field" style="margin-top:8px"><span>${esc(NOTES[name].label)} <span class="muted small">${NOTES[name].file}</span></span>
      <small>${esc(NOTES[name].help)}</small>
      ${f.error ? `<p class="error-text">${esc(f.error)}</p>` : `
      ${f.inherited ? `<div class="notice info small">This campaign has no ${NOTES[name].file} of its own yet, so it uses the shared one (<code>${esc(f.sharedPath)}</code>), shown below.
        Saving makes a copy for this campaign only.</div>` : ""}
      <textarea id="cp-note-${name}" spellcheck="${name === "context"}">${esc(f.text ?? "")}</textarea>
      <div class="row"><button data-act="save-note" data-name="${name}">Save ${esc(NOTES[name].label.toLowerCase())}</button>
        <span class="muted small"><code>${esc(f.path)}</code> · used from the next recording or summary on.</span></div>`}</div>`).join("")}`;
}

async function saveNote(name) {
  const c = current();
  if (!c) return;
  const ok = await attempt(() => api("PUT", `/api/campaign/${name}?campaign=${encodeURIComponent(c.folder)}`, { text: $(`cp-note-${name}`).value }),
    `${NOTES[name].label} saved for ${c.name}.`);
  if (ok) loadNotes();
}

// ---------- events

async function onClick(e) {
  const pick = e.target.closest("[data-pick]");
  const btn = e.target.closest("[data-act]");
  if (pick && !btn) {
    selectedId = Number(pick.dataset.pick);
    renderList();
    renderDetail();
    loadMappings();
    loadNotes();
    return;
  }
  if (!btn) return;
  const c = current();
  switch (btn.dataset.act) {
    case "new": return newCampaign();
    case "play": return choose(Number(btn.dataset.id));
    case "auto": return choose(null);
    case "save": e.preventDefault(); return save();
    case "clear-password": {
      const ok = await confirmDialog("Clear this campaign's Foundry password?",
        `<p>${data.foundryDefaults?.passwordSet ? "It goes back to FOUNDRY_PASSWORD from .env." : "ScribBot can't log in to Foundry until a password is set."}</p>`, { ok: "Clear", danger: true });
      if (ok && await attempt(() => api("PATCH", `/api/admin/campaigns/${c.id}`, { foundryPassword: null }), "Password cleared.")) load(false);
      return;
    }
    case "delete": return c && deleteCampaign(c);
    case "map-add": return mapDialog(null);
    case "map-edit": return mapDialog(mappings?.mappings.find((m) => m.discordId === btn.dataset.discord && m.guildId === btn.dataset.guild));
    case "map-remove": return unmap(btn.dataset.guild, btn.dataset.discord, btn.dataset.shared === "true");
    case "map-gm": return setGm(btn.dataset.guild, btn.dataset.discord, btn.dataset.value === "true");
    case "map-refresh": return loadMappings();
    case "save-note": return saveNote(btn.dataset.name);
  }
}
