// Sessions: create, stop, resume, re-run, merge, label and trash sessions, post them to Foundry,
// and manage who plays which character. Every action calls the bot's /admin API through the
// Console, which runs the same code as the matching /scrib command.
import { $, api, attempt, bytes, confirmDialog, dur, esc, openDialog, pill, showText, toast, when } from "./util.js";

const REFRESH_MS = 5000;
const STATUS_CLASS = { recording: "err", transcribing: "info", summarizing: "info", complete: "ok", failed: "err" };

let root = null;
let status = null;
let list = [];
let readOnly = false;
let filter = "all";
let search = "";
let selected = null;
let detail = null;
let fetchedAt = 0;
let loading = false;
let mappings = null;
let campaigns = [];
let campaignFilter = "all";

export function show(el, s) {
  root = el;
  status = s;
  if (!root.dataset.ready) {
    root.innerHTML = `
      <section class="card">
        <div class="card-head">
          <h2>Sessions</h2><span id="s-campaign"></span><span class="spacer"></span>
          <div class="toolbar">
            <button class="primary" data-act="new">● New recording</button>
            <div class="seg" role="group" aria-label="Show">
              <button data-filter="all" aria-pressed="true">All</button>
              <button data-filter="attention" aria-pressed="false">Needs attention</button>
              <button data-filter="trash" aria-pressed="false">Trash</button>
            </div>
            <input type="search" id="s-search" placeholder="Search title or #" aria-label="Search sessions">
          </div>
        </div>
        <div id="s-banner"></div>
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Started</th><th>Title</th><th class="hide-narrow">Length</th><th>Status</th>
            <th class="hide-narrow" title="Transcript · Chat log · Summary · Story">Files</th><th class="hide-narrow">Foundry</th><th></th></tr></thead>
          <tbody id="s-rows"><tr><td colspan="8" class="muted">Loading…</td></tr></tbody>
        </table></div>
      </section>
      <section class="card" id="s-detail" hidden></section>
      <section class="card" id="s-mappings"></section>
      <div class="menu-list" id="s-menu" hidden role="menu"></div>`;
    root.dataset.ready = "1";
    root.addEventListener("click", onClick);
    $("s-search").addEventListener("input", (e) => { search = e.target.value.trim().toLowerCase(); render(); });
    root.addEventListener("change", (e) => {
      if (e.target.id === "s-campaign-filter") { campaignFilter = e.target.value; render(); }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#s-menu") && !e.target.closest("[data-act=menu]")) $("s-menu").hidden = true;
    });
  }
  refresh();
  loadMappings();
}

export function hide() {
  if ($("s-menu")) $("s-menu").hidden = true;
}

export function update(s) {
  status = s;
  if (!root || root.hidden) return;
  const busy = list.some((x) => x.recording || x.processing);
  if (Date.now() - fetchedAt > (busy ? 3000 : REFRESH_MS)) refresh();
}

async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const r = await api("GET", `/api/admin/sessions?deleted=${filter === "trash" ? "only" : "exclude"}`);
    list = r.sessions || [];
    readOnly = Boolean(r.readOnly);
    if (!readOnly) campaigns = (await api("GET", "/api/admin/campaigns").catch(() => ({ campaigns: [] }))).campaigns || [];
    fetchedAt = Date.now();
    render();
    if (selected) loadDetail(selected, false);
  } catch (err) {
    $("s-rows").innerHTML = `<tr><td colspan="8" class="error-text">${esc(err.message)}</td></tr>`;
  } finally {
    loading = false;
  }
}

// ---------- what each session can do, and why not
const llmProblem = () => {
  const l = status?.llm;
  if (!l || status?.monitor?.bot !== "online") return null;
  if (l.credentialsError) return l.credentialsError;
  if (!l.credentials) return "No LLM credentials (Configuration → Summaries).";
  if (!l.model) return "No LLM model set (Configuration → Summaries).";
  return null;
};

function actionsFor(s) {
  const off = readOnly ? "Start the bot to change sessions." : null;
  if (s.deletedAt) {
    return [
      { act: "restore", label: "Restore", why: off || (s.purgedAt ? "Deleted permanently." : null) },
      { act: "purge", label: "Delete permanently…", danger: true, why: off || (s.purgedAt ? "Already deleted." : null) },
    ];
  }
  const busy = s.recording ? "It's recording." : s.processing ? "It's being processed." : null;
  const merged = s.mergedInto != null ? `Merged into session ${s.mergedInto}.` : null;
  return [
    { act: "process", label: s.status === "failed" ? "Resume" : "Process again", hint: "Transcribe what's missing (and summarize if that's on); finished steps are skipped.",
      why: off || busy || merged },
    { act: "retranscribe", label: "Re-transcribe", hint: "Redo speech-to-text from the audio.",
      why: off || busy || merged || (s.audioPurged ? "The audio was deleted after transcription." : null) },
    { act: "summarize", label: "Summarize", hint: "Send the transcript to the LLM and write the summary.",
      why: off || busy || merged || (!s.hasTranscript ? "No transcript yet." : llmProblem()) },
    { act: "post-summary", label: "Post summary to Foundry", hint: "Creates or updates its journal entry.",
      why: off || merged || (!s.hasSummary ? "No summary yet." : null) },
    { act: "post-story", label: "Post story to Foundry", hint: "The summarize-session skill's write-up.",
      why: off || merged || (!s.hasStory ? "No story write-up yet." : null) },
    { act: "merge", label: "Merge into an earlier session…", hint: "For a game split in two by a restart.", why: off || busy || merged },
    ...(campaigns.length > 1 ? [{ act: "move-campaign", label: "Move to another campaign…", hint: "Renumbers it there; its folder moves with it.",
      why: off || busy || merged || (s.legacyLayout ? "Update the folder layout first." : null) }] : []),
    { act: "open", label: "Details, title and notes" },
    { act: "trash", label: "Trash…", hint: "Move it to the trash, where it can be restored or deleted for good.", danger: true, why: off || busy },
  ];
}

/**
 * Where a session's summary or story stands in Foundry: confirmed by the bridge client (module
 * 0.7.0+) since it was last sent, sent but not confirmed yet, or never sent.
 */
const WAITING = "Foundry hasn't confirmed it yet: no bridge client or GM online, “Import summaries automatically” off, " +
  "or ScribBot Bridge older than 0.7.0 (which never confirms).";
function journal(s, kind) {
  const sent = s[`${kind}SentAt`], at = s[`${kind}JournalAt`], name = s[`${kind}JournalName`];
  if (at && (!sent || at >= sent)) return { state: "ok", short: `${kind} ✓`, long: `in Foundry as “${name}” (${when(at)})`, title: `In Foundry as “${name}”, confirmed ${when(at)}` };
  if (sent) return { state: "warn", short: `${kind} sent`, long: `sent ${when(sent)}, not confirmed yet`, title: `Sent ${when(sent)}. ${WAITING}` };
  return null;
}

function primaryFor(s) {
  if (readOnly) return "";
  if (s.deletedAt) return `<button data-act="restore" data-id="${esc(s.id)}">Restore</button>`;
  if (s.recording) return `<button class="danger" data-act="stop" data-id="${esc(s.id)}">■ Stop</button>`;
  if (s.processing) return "";
  if (s.status === "failed" && s.mergedInto == null) return `<button data-act="process" data-id="${esc(s.id)}">Resume</button>`;
  return "";
}

// ---------- the table
function visible() {
  return list.filter((s) => {
    if (campaignFilter !== "all" && String(s.campaignId) !== campaignFilter) return false;
    if (filter === "attention" && !(s.status === "failed" && s.mergedInto == null)) return false;
    if (!search) return true;
    return String(s.number) === search.replace(/^#/, "") || (s.title || "").toLowerCase().includes(search) || s.id.includes(search);
  });
}

function render() {
  const banner = readOnly
    ? `<div class="notice readonly-banner" style="margin-bottom:10px">The bot isn't running, so sessions are read-only. Start it with <code>.\\start.ps1</code>.</div>`
    : "";
  // A merged recording moves with its game, so it isn't counted on its own.
  const legacy = list.filter((s) => s.legacyLayout && s.mergedInto == null).length;
  const numbered = list.filter((s) => s.numberedFolder).length;
  const why = legacy
    ? `${legacy} session${legacy === 1 ? " uses" : "s use"} the old folder layout (<code>data\\sessions\\&lt;id&gt;</code>).
        Moving them into campaign folders (<code>data\\campaigns\\&lt;world&gt;\\sessions\\&lt;session id&gt;</code>) is needed to merge them; everything is backed up first.`
    : `${numbered} session folder${numbered === 1 ? " is" : "s are"} still named by number (<code>sessions\\012</code>).
        Renaming ${numbered === 1 ? "it" : "them"} to the session's id lets sessions be renumbered without moving folders; the database is backed up first.`;
  const layout = (legacy || numbered) && !readOnly
    ? `<div class="notice warn" style="margin-bottom:10px">${why}
        <button data-act="migrate" style="margin-left:6px">Update folder layout…</button></div>` : "";
  $("s-banner").innerHTML = banner + layout;
  renderCampaignHeader();
  const rowsHtml = visible().map((s) => {
    const end = s.endedAt ? Date.parse(s.endedAt) : s.recording ? Date.now() : null;
    const length = end ? dur((end - Date.parse(s.startedAt)) / 1000) : "–";
    const stat = s.deletedAt ? pill("skip", s.purgedAt ? "deleted" : "in trash")
      : s.recording ? pill("err", "recording")
      : s.mergedInto != null ? pill("skip", `merged into #${s.mergedInto}`)
      : pill(STATUS_CLASS[s.status] ?? "info", s.status, s.error || "");
    const bar = s.progress != null ? `<div class="bar" title="${Math.round(s.progress * 100)}%"><i style="width:${s.progress * 100}%"></i></div>` : "";
    const f = (ok, letter, title) => `<span class="${ok ? "y" : "n"}" title="${title}${ok ? "" : " (missing)"}">${letter}</span>`;
    const sent = ["summary", "story"].map((k) => journal(s, k)).filter(Boolean)
      .map((j) => `<span class="${j.state}-text" title="${esc(j.title)}">${esc(j.short)}</span>`).join(" · ");
    const err = s.status === "failed" && s.error && s.mergedInto == null ? `<div class="error-text">${esc(s.error)}</div>` : "";
    return `<tr class="clickable ${selected === s.id ? "selected" : ""}" data-row="${esc(s.id)}">
      <td>${s.number}</td><td>${esc(when(s.startedAt))}</td>
      <td>${s.title ? esc(s.title) : `<span class="muted">–</span>`}${s.recordings > 1 ? ` <span class="pill info" title="A game recorded in parts, merged into one">${s.recordings} recordings</span>` : ""}
        ${campaigns.length > 1 && campaignFilter === "all" && s.campaign ? `<div class="muted small">${esc(s.campaign)}</div>` : ""}${err}</td>
      <td class="hide-narrow">${length}</td><td>${stat}${bar}</td>
      <td class="files hide-narrow">${f(s.hasTranscript, "T", "Transcript")}${f(s.hasChatlog, "C", "Chat log")}${f(s.hasSummary, "S", "Summary")}${f(s.hasStory, "St", "Story")}</td>
      <td class="hide-narrow small muted">${sent || "–"}</td>
      <td class="actions-cell">${primaryFor(s)} <button data-act="menu" data-id="${esc(s.id)}" aria-label="More actions for session ${s.number}">⋯</button></td></tr>`;
  }).join("");
  const empty = filter === "trash" ? "The trash is empty." : list.length ? "No session matches." : "No sessions yet. Start one with New recording, or /scrib start in Discord.";
  $("s-rows").innerHTML = rowsHtml || `<tr><td colspan="8" class="muted">${empty}</td></tr>`;
  for (const b of root.querySelectorAll("[data-filter]")) b.setAttribute("aria-pressed", String(b.dataset.filter === filter));
  root.querySelector("[data-act=new]").disabled = readOnly;
  root.querySelector("[data-act=new]").title = readOnly ? "Start the bot first." : "";
}

function openMenu(btn, s) {
  const menu = $("s-menu");
  menu.innerHTML = actionsFor(s).map((a) =>
    `<button role="menuitem" data-act="${a.act}" data-id="${esc(s.id)}" ${a.why ? "disabled" : ""} class="${a.danger ? "danger" : ""}" title="${esc(a.why || "")}">
      ${esc(a.label)}${a.why ? `<small>${esc(a.why)}</small>` : a.hint ? `<small>${esc(a.hint)}</small>` : ""}</button>`).join("");
  const r = btn.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 40)}px`;
  menu.style.right = `${Math.max(window.innerWidth - r.right, 8)}px`;
  menu.hidden = false;
  menu.querySelector("button:not(:disabled)")?.focus();
}

// ---------- clicks
async function onClick(e) {
  const filterBtn = e.target.closest("[data-filter]");
  if (filterBtn) {
    filter = filterBtn.dataset.filter;
    fetchedAt = 0;
    list = [];
    $("s-rows").innerHTML = `<tr><td colspan="8" class="muted">Loading…</td></tr>`;
    return refresh();
  }
  const btn = e.target.closest("[data-act]");
  if (!btn) {
    const row = e.target.closest("[data-row]");
    if (row) return loadDetail(row.dataset.row, true);
    return;
  }
  e.stopPropagation();
  const s = list.find((x) => x.id === btn.dataset.id) || (detail?.id === btn.dataset.id ? detail : null);
  $("s-menu").hidden = true;
  switch (btn.dataset.act) {
    case "new": return newRecording();
    case "menu": return s && openMenu(btn, s);
    case "open": return s && loadDetail(s.id, true);
    case "stop": return s && stop(s);
    case "process": return s && run(s, "process", {}, `Processing session ${s.number}…`);
    case "retranscribe": return s && retranscribe(s);
    case "summarize": return s && run(s, "summarize", {}, `Summarizing session ${s.number}…`);
    case "post-summary": return s && post(s, "summary");
    case "post-story": return s && post(s, "story");
    case "merge": return s && merge(s);
    case "trash": return s && trash(s);
    case "restore": return s && run(s, "restore", {}, (r) => r?.message || `Session ${s.number} restored.`);
    case "purge": return s && purge(s);
    case "save-labels": return s && saveLabels(s);
    case "preview": return s && preview(s, btn.dataset.name);
    case "migrate": return migrateLayout();
    case "move-campaign": return s && moveCampaign(s);
    case "rename-campaign": return renameCampaign();
    case "close-detail": selected = null; detail = null; $("s-detail").hidden = true; return render();
    case "map-add": return mapDialog(null);
    case "map-edit": return mapDialog(mappings?.mappings.find((m) => m.discordId === btn.dataset.discord && m.guildId === btn.dataset.guild));
    case "map-remove": return unmap(btn.dataset.guild, btn.dataset.discord);
    case "map-gm": return setGm(btn.dataset.guild, btn.dataset.discord, btn.dataset.value === "true");
    case "map-refresh": return loadMappings();
    case "purge-audio": return purgeAudio();
  }
}

async function run(s, action, body, okText) {
  const r = await attempt(() => api("POST", `/api/admin/sessions/${encodeURIComponent(s.id)}/${action}`, body), okText);
  fetchedAt = 0;
  refresh();
  return r;
}

async function stop(s) {
  const ok = await confirmDialog(`Stop recording session ${s.number}?`,
    "<p>The bot leaves the voice channel, posts in the session's text channel, then transcribes the recording.</p>", { ok: "Stop recording", danger: true });
  if (ok) run(s, "stop", {}, `Session ${s.number} stopped. Transcribing now.`);
}

async function retranscribe(s) {
  const ok = await confirmDialog(`Re-transcribe session ${s.number}?`,
    "<p>Speech-to-text runs again on every clip, replacing the transcript. This takes about as long as the first time.</p>", { ok: "Re-transcribe" });
  if (ok) run(s, "process", { retranscribe: true }, `Re-transcribing session ${s.number}…`);
}

async function post(s, what) {
  const r = await run(s, `${what}/import`, {});
  if (r && r !== true) {
    const headless = status?.foundry?.headless && status.foundry.headless.mode !== "off";
    toast(r.foundryConnected
      ? `Sent “${r.title}” to Foundry. The Foundry column shows ✓ once Foundry confirms the journal entry.`
      : headless
        ? `No Foundry client is connected right now; the headless client joins to import “${r.title}”.`
        : `No Foundry client is connected, so nothing received “${r.title}”. Open the world as the GM or bridge user and post it again, ` +
          "or import it from Foundry's journal sidebar (Import ScribBot Session).", r.foundryConnected || headless ? "ok" : "err");
  }
}

async function merge(s) {
  const candidates = list.filter((x) => x.id !== s.id && x.guildId === s.guildId && !x.deletedAt && x.mergedInto == null && x.startedAt < s.startedAt);
  if (!candidates.length) return toast("There's no earlier session in this server to merge into.", "err");
  const r = await openDialog(`<form><h3>Merge session ${s.number} into…</h3>
    <p class="muted small">Use this when one game was recorded as two sessions (for example after a restart). Session ${s.number}'s lines and chat are
      added to the session you pick, after the gap; its files are kept and the other session's originals are backed up as <code>*.premerge-${s.number}</code>.
      Both must be transcribed.</p>
    <label class="field"><span>The session it continues</span><select name="into" required>
      ${candidates.map((c) => `<option value="${esc(c.id)}">#${c.number} · ${esc(when(c.startedAt))}${c.title ? ` · ${esc(c.title)}` : ""}</option>`).join("")}
    </select></label>
    <div class="actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok">Merge</button></div></form>`);
  if (!r) return;
  const res = await run(s, "merge", { into: r.data.into });
  if (res && res !== true) showText("Merged", res.message.replace(/\*\*/g, ""));
}

/** The trash settings from .env (Configuration → Storage and retention): how long it keeps a session, and whether to say so first. */
async function trashSettings() {
  try {
    const cfg = await api("GET", "/api/config");
    const value = (key) => {
      const v = cfg.values?.[key]?.value;
      return v === undefined || v === "" ? cfg.settings.find((x) => x.key === key)?.default ?? "" : v;
    };
    const days = Number(value("TRASH_RETENTION_DAYS"));
    return { days: Number.isFinite(days) ? days : 14, confirm: value("TRASH_CONFIRM") !== "false", version: cfg.version };
  } catch {
    return { days: null, confirm: true, version: null }; // couldn't read .env: still ask
  }
}

/** "for 14 days, then deleted permanently" (or until deleted by hand when the trash never empties itself). */
const keptFor = (days) =>
  days === null ? "until the trash is emptied (see Configuration → Storage and retention)"
  : days > 0 ? `for ${days} day${days === 1 ? "" : "s"}, then deleted permanently`
  : "until you delete it permanently (the trash never empties itself)";

async function trash(s) {
  const settings = await trashSettings();
  let hidden = false;
  if (settings.confirm) {
    const inFoundry = ["summary", "story"].filter((k) => s[`${k}SentAt`] || s[`${k}JournalAt`]);
    const sent = inFoundry.length
      ? `<p class="notice warn">Its ${inFoundry.join(" and ")} went to Foundry; ${inFoundry.length > 1 ? "those journal entries stay" : "that journal entry stays"} there.</p>` : "";
    const r = await openDialog(`<form><h3>Move session ${s.number} to the trash</h3>
      <p>Session ${s.number} will be kept in the trash <b>${esc(keptFor(settings.days))}</b>.
        Until then you can restore it from the Trash filter.</p>${sent}
      <p class="muted small">The number of days is set under Configuration → Storage and retention.</p>
      <label class="check"><input type="checkbox" name="hide"> Don't show this again</label>
      <div class="actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary danger" value="ok">Move to trash</button></div></form>`);
    if (!r) return;
    // Saved to .env (TRASH_CONFIRM=false); turned back on under Configuration → Storage and retention.
    if (r.data.hide) hidden = await attempt(() => api("POST", "/api/config", { changes: { TRASH_CONFIRM: "false" }, version: settings.version }));
  }
  const kept = settings.days > 0 ? ` It's kept for ${settings.days} day${settings.days === 1 ? "" : "s"}.` : "";
  const again = hidden ? " That message won't be shown again; turn it back on under Configuration → Storage and retention." : "";
  const ok = await attempt(() => api("DELETE", `/api/admin/sessions/${encodeURIComponent(s.id)}`), `Session ${s.number} moved to the trash.${kept}${again}`);
  if (ok && selected === s.id) { selected = null; $("s-detail").hidden = true; }
  fetchedAt = 0;
  refresh();
}

async function purge(s) {
  const ok = await confirmDialog(`Delete session ${s.number} permanently?`,
    "<p>Its folder in the trash is removed. This can't be undone.</p>", { ok: "Delete permanently", danger: true });
  if (!ok) return;
  await attempt(() => api("DELETE", `/api/admin/trash/${encodeURIComponent(s.id)}`), `Session ${s.number} deleted permanently.`);
  fetchedAt = 0;
  refresh();
}

// ---------- new recording
async function newRecording() {
  let guilds;
  try {
    guilds = (await api("GET", "/api/admin/discord")).guilds || [];
  } catch (err) {
    return toast(err.message, "err");
  }
  if (!guilds.length) return toast("The bot isn't in any Discord server yet (or isn't logged in).", "err");
  const voiceOptions = (g) => g.voice.map((v) => {
    const who = v.members.length ? `${v.members.length}: ${v.members.map((m) => m.name).join(", ")}` : "empty";
    return `<option value="${esc(v.id)}" ${v.canJoin ? "" : "disabled"}>${esc(v.name)} (${esc(who)})${v.canJoin ? "" : " · no permission"}</option>`;
  }).join("");
  const textOptions = (g) => g.text.map((t) => `<option value="${esc(t.id)}" ${t.id === g.lastTextChannelId ? "selected" : ""}>#${esc(t.name)}</option>`).join("");
  const pick = (g) => [...g.voice].filter((v) => v.canJoin).sort((a, b) => b.members.length - a.members.length)[0]?.id;
  const r = await openDialog(`<form><h3>New recording</h3>
    <label class="field" ${guilds.length > 1 ? "" : "hidden"}><span>Server</span><select name="guildId" id="nr-guild">
      ${guilds.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}${g.recording ? ` (recording #${g.recording.number})` : ""}</option>`).join("")}</select></label>
    ${campaigns.length ? `<label class="field"><span>Campaign</span><select name="campaignId">
      ${campaigns.map((c) => `<option value="${c.id}" ${c.isDefault ? "selected" : ""}>${esc(c.name)}${c.worldId ? "" : " (no Foundry world yet)"}</option>`).join("")}
      </select><small>Numbered and filed under this campaign. The default is the Foundry world that synced most recently.</small></label>` : ""}
    <label class="field"><span>Voice channel</span><select name="voiceChannelId" id="nr-voice" required></select></label>
    <label class="field"><span>Text channel for notices</span><select name="textChannelId" id="nr-text" required></select>
      <small>The recording notice is posted here, as <code>/scrib start</code> would, so everyone knows they're being recorded.</small></label>
    <p class="notice warn small" style="margin:0">Make sure everyone at the table has agreed to be recorded.</p>
    <div class="actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok">● Start recording</button></div></form>`,
  {
    onOpen: (dlg) => {
      const fill = () => {
        const g = guilds.find((x) => x.id === dlg.querySelector("#nr-guild").value) || guilds[0];
        dlg.querySelector("#nr-voice").innerHTML = voiceOptions(g);
        const best = pick(g);
        if (best) dlg.querySelector("#nr-voice").value = best;
        dlg.querySelector("#nr-text").innerHTML = textOptions(g);
        dlg.querySelector("button.primary").disabled = Boolean(g.recording);
        dlg.querySelector("button.primary").title = g.recording ? `Already recording session ${g.recording.number} in this server.` : "";
      };
      dlg.querySelector("#nr-guild").addEventListener("change", fill);
      fill();
    },
  });
  if (!r) return;
  toast("Joining the voice channel…");
  const body = { ...r.data, ...(r.data.campaignId ? { campaignId: Number(r.data.campaignId) } : {}) };
  if (!r.data.campaignId) delete body.campaignId;
  const res = await attempt(() => api("POST", "/api/admin/sessions", body), (x) => `Recording session ${x.session.number}.`);
  fetchedAt = 0;
  refresh();
  return res;
}

// ---------- detail
async function loadDetail(id, scroll) {
  selected = id;
  render();
  try {
    detail = await api("GET", `/api/admin/sessions/${encodeURIComponent(id)}`);
  } catch (err) {
    detail = list.find((x) => x.id === id) || null;
    if (!detail) return;
    detail = { ...detail, files: null, offlineError: err.message };
  }
  renderDetail();
  if (scroll) $("s-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDetail() {
  const s = detail;
  const el = $("s-detail");
  if (!s) { el.hidden = true; return; }
  el.hidden = false;
  const editing = el.contains(document.activeElement) && document.activeElement.matches("input, textarea");
  if (editing) return; // don't replace what someone is typing
  const end = s.endedAt ? Date.parse(s.endedAt) : null;
  const people = s.participants?.length
    ? `<div class="chips">${s.participants.map((p) => `<div class="chip">${esc(p.displayName)}<small>${p.isGm ? "GM" : esc(p.character || "unmapped")}</small></div>`).join("")}</div>`
    : `<span class="muted">${s.recording ? "Shown on the Monitoring tab while recording." : "–"}</span>`;
  const files = s.files
    ? (s.files.length ? `<table><tbody>${s.files.map((f) => `<tr><td><code>${esc(f.name)}</code></td><td style="text-align:right">${bytes(f.bytes)}</td></tr>`).join("")}</tbody></table>` : `<span class="muted">No files.</span>`)
    : `<span class="muted">${esc(s.offlineError || "")}</span>`;
  const previews = (s.previews || []).map((n) => `<button data-act="preview" data-id="${esc(s.id)}" data-name="${esc(n)}">${esc(n)}</button>`).join(" ");
  const actions = actionsFor(s).filter((a) => a.act !== "open").map((a) =>
    `<button data-act="${a.act}" data-id="${esc(s.id)}" ${a.why ? "disabled" : ""} class="${a.danger ? "danger" : ""}" title="${esc(a.why || a.hint || "")}">${esc(a.label)}</button>`).join(" ");
  el.innerHTML = `
    <div class="card-head"><h2>Session ${s.number}${s.title ? ` · ${esc(s.title)}` : ""}</h2><span class="spacer"></span>
      ${s.recording ? `<button class="danger" data-act="stop" data-id="${esc(s.id)}">■ Stop</button>` : ""}
      <button data-act="close-detail" aria-label="Close">✕</button></div>
    <div class="detail">
      ${s.error && s.mergedInto == null ? `<div class="notice ${s.status === "failed" ? "err" : "warn"}">${esc(s.error)}</div>` : ""}
      <div class="detail-grid">
        <div class="stack">
          <label class="field"><span>Title</span><input id="d-title" maxlength="200" value="${esc(s.title || "")}" placeholder="e.g. The Sunken Keep" ${readOnly ? "disabled" : ""}></label>
          <label class="field"><span>Notes</span><textarea id="d-notes" maxlength="5000" style="min-height:90px;font-family:inherit" ${readOnly ? "disabled" : ""}>${esc(s.notes || "")}</textarea></label>
          <div class="row"><button data-act="save-labels" data-id="${esc(s.id)}" ${readOnly ? "disabled" : ""}>Save title and notes</button></div>
        </div>
        <div>${[
          ["Campaign", s.campaign ? esc(s.campaign) : "–"],
          ["Recordings", s.recordings ?? 1],
          ["Started", esc(when(s.startedAt))],
          ["Length", end ? dur((end - Date.parse(s.startedAt)) / 1000) : s.recording ? "recording" : "–"],
          ["Status", esc(s.status)],
          ["Clips", s.clips ?? "–"],
          ["Audio", s.audioPurged ? "deleted" : "kept"],
          ...["summary", "story"].map((k) => {
            const j = journal(s, k);
            return [`${k === "summary" ? "Summary" : "Story"} in Foundry`, j ? `<span class="${j.state}-text" title="${esc(j.title)}">${esc(j.long)}</span>` : "not sent"];
          }),
          ["Folder", s.folder ? `<code>${esc(s.folder)}</code>` : "–"],
        ].map(([k, v]) => `<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--border);padding:4px 0"><span class="muted">${k}</span><span>${v}</span></div>`).join("")}</div>
      </div>
      <div><h2 class="muted small" style="margin:0 0 6px">SPEAKERS</h2>${people}</div>
      ${previews ? `<div class="row"><span class="muted">Read:</span> ${previews}</div>` : ""}
      <div class="row">${actions}</div>
      <details><summary class="muted">Files</summary>${files}</details>
    </div>`;
}

async function saveLabels(s) {
  const body = { title: $("d-title").value, notes: $("d-notes").value };
  const r = await attempt(() => api("PATCH", `/api/admin/sessions/${encodeURIComponent(s.id)}`, body), "Saved.");
  if (r) {
    document.activeElement?.blur();
    fetchedAt = 0;
    refresh();
  }
}

async function preview(s, name) {
  try {
    const r = await api("GET", `/api/admin/sessions/${encodeURIComponent(s.id)}/preview/${encodeURIComponent(name)}`);
    showText(`Session ${s.number}: ${name}`, r.text, r.truncated ? "Only the first 512 KB is shown." : "");
  } catch (err) {
    toast(err.message, "err");
  }
}

// ---------- players and characters (/scrib map, unmap, gm)
async function loadMappings() {
  const el = $("s-mappings");
  if (!el) return;
  try {
    mappings = await api("GET", "/api/admin/mappings");
  } catch (err) {
    mappings = null;
    el.innerHTML = `<div class="card-head"><h2>Players and characters</h2></div><p class="muted">${esc(err.body?.offline ? "Needs the bot to be running." : err.message)}</p>`;
    return;
  }
  const rowsHtml = mappings.mappings.map((m) => `<tr>
      <td>${m.name ? esc(m.name) : `<span class="muted">${esc(m.discordId)}</span>`}</td>
      <td>${m.isGm ? "<b>GM</b>" : esc(m.character || "–")}${m.foundryUserId ? ` <span class="muted small">(Foundry linked)</span>` : ""}</td>
      <td class="actions-cell">
        <button data-act="map-edit" data-guild="${esc(m.guildId)}" data-discord="${esc(m.discordId)}">Change</button>
        <button data-act="map-gm" data-guild="${esc(m.guildId)}" data-discord="${esc(m.discordId)}" data-value="${!m.isGm}">${m.isGm ? "Not GM" : "Make GM"}</button>
        <button class="danger" data-act="map-remove" data-guild="${esc(m.guildId)}" data-discord="${esc(m.discordId)}">Remove</button></td></tr>`).join("");
  el.innerHTML = `<div class="card-head"><h2>Players and characters</h2><span class="spacer"></span>
      <button data-act="map-refresh">Refresh</button><button data-act="map-add">Map a player…</button></div>
    <p class="muted small" style="margin-top:0">Who speaks for which character, the same as <code>/scrib map</code> and <code>/scrib gm</code>.
      Picking a Foundry user also stores the Discord ID in Foundry. A change applies to people who haven't spoken yet in a running recording.</p>
    <div class="table-wrap"><table><thead><tr><th>Discord user</th><th>Character</th><th></th></tr></thead>
    <tbody>${rowsHtml || `<tr><td colspan="3" class="muted">Nobody is mapped yet. Linked Foundry users are recognized without a mapping.</td></tr>`}</tbody></table></div>
    <div class="row" style="margin-top:10px"><button data-act="purge-audio" title="Delete kept audio older than AUDIO_RETENTION_DAYS now, instead of waiting for the 6-hourly check">Purge expired audio now</button></div>`;
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
  const roster = (mappings?.roster || []).filter((r) => r.actorName || r.isGm);
  const r = await openDialog(`<form><h3>${existing ? `Change ${esc(existing.name || existing.discordId)}` : "Map a player"}</h3>
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
  await attempt(() => api("PUT", `/api/admin/mappings/${encodeURIComponent(guildId)}/${encodeURIComponent(discordId)}`, { character }),
    (x) => `Mapped to ${x.mapped.replace(/\*\*/g, "")}.`);
  loadMappings();
}

async function unmap(guildId, discordId) {
  const ok = await confirmDialog("Remove this mapping?", "<p>They'll be labelled by their Foundry link, or else their Discord name.</p>", { ok: "Remove", danger: true });
  if (!ok) return;
  await attempt(() => api("DELETE", `/api/admin/mappings/${encodeURIComponent(guildId)}/${encodeURIComponent(discordId)}`), "Removed.");
  loadMappings();
}

async function setGm(guildId, discordId, isGm) {
  await attempt(() => api("POST", `/api/admin/mappings/${encodeURIComponent(guildId)}/${encodeURIComponent(discordId)}/gm`, { isGm }), isGm ? "Marked as GM." : "No longer GM.");
  loadMappings();
}

async function purgeAudio() {
  await attempt(() => api("POST", "/api/admin/maintenance/purge-audio", {}), (r) => `Audio purged for ${r.purged} session(s).`);
}

// ---------- campaigns (one per Foundry world) and the folder layout
function renderCampaignHeader() {
  const el = $("s-campaign");
  if (!el) return;
  if (!campaigns.length) { el.innerHTML = ""; return; }
  if (campaigns.length === 1) {
    const c = campaigns[0];
    el.innerHTML = `<span class="muted small" title="Folder data\\campaigns\\${esc(c.folder)}">· ${esc(c.name)}</span>
      <button class="link small" data-act="rename-campaign" data-campaign="${c.id}">Rename…</button>`;
    return;
  }
  el.innerHTML = `<select id="s-campaign-filter" aria-label="Campaign">
      <option value="all">All campaigns</option>
      ${campaigns.map((c) => `<option value="${c.id}" ${String(c.id) === campaignFilter ? "selected" : ""}>${esc(c.name)} (${c.sessions})</option>`).join("")}
    </select> <button class="link small" data-act="rename-campaign">Rename…</button>`;
}

async function renameCampaign() {
  const current = campaigns.find((c) => String(c.id) === campaignFilter) ?? campaigns.find((c) => c.isDefault) ?? campaigns[0];
  if (!current) return;
  const r = await openDialog(`<form><h3>Rename a campaign</h3>
    <label class="field" ${campaigns.length > 1 ? "" : "hidden"}><span>Campaign</span><select name="id">
      ${campaigns.map((c) => `<option value="${c.id}" ${c.id === current.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
    <label class="field"><span>Name shown here</span><input name="alias" maxlength="100" value="${esc(current.alias || "")}" placeholder="${esc(current.title || current.folder)}">
      <small>Only the name shown in the Console changes. The folder stays <code>data\\campaigns\\${esc(current.folder)}</code>, named after the Foundry world
        ${current.worldId ? `<code>${esc(current.worldId)}</code>` : ""}. Leave blank to use the world's title.</small></label>
    <div class="actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok">Save</button></div></form>`);
  if (!r) return;
  await attempt(() => api("PATCH", `/api/admin/campaigns/${encodeURIComponent(r.data.id || current.id)}`, { alias: r.data.alias.trim() || null }), "Saved.");
  fetchedAt = 0;
  refresh();
}

async function moveCampaign(s) {
  const others = campaigns.filter((c) => c.id !== s.campaignId);
  const r = await openDialog(`<form><h3>Move session ${s.number} to another campaign</h3>
    <p class="muted small">Its folder, with all its recordings, moves to the other campaign, where it gets the next free number.
      Use this for a recording filed under the wrong world, or one made before Foundry was connected.</p>
    <label class="field"><span>Campaign</span><select name="campaignId" required>
      ${others.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></label>
    <div class="actions"><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok">Move</button></div></form>`);
  if (!r) return;
  await run(s, "campaign", { campaignId: Number(r.data.campaignId) }, (x) => `Moved; it is now session ${x.session.number} of ${x.session.campaign}.`);
}

async function migrateLayout() {
  let plan;
  try {
    plan = await api("GET", "/api/admin/layout");
  } catch (err) {
    return toast(err.message, "err");
  }
  if (!plan.pending) { toast("Every session already uses the current folder layout.", "ok"); fetchedAt = 0; return refresh(); }
  const mb = Math.max(1, Math.round(plan.backupBytes / 1024 / 1024));
  const rowsHtml = plan.plan.map((g) => `<tr><td>${g.number}${g.newNumber !== g.number ? ` → ${g.newNumber}` : ""}</td>
      <td><code>${esc(g.campaign)}\\sessions\\${esc(g.id)}</code>${g.inTrash ? " <span class=\"muted\">(in the trash)</span>" : ""}${g.kind === "rename" ? " <span class=\"muted\">(renamed)</span>" : ""}</td>
      <td>${g.merged.length ? `+ session ${g.merged.join(", ")}` : ""}${g.notes.map((n) => `<div class="muted small">${esc(n)}</div>`).join("")}</td></tr>`).join("");
  const r = await openDialog(`<form><h3>Update folder layout</h3>
    <p>Each session's folder is <code>data\\campaigns\\&lt;world&gt;\\sessions\\&lt;session id&gt;\\</code>: in its campaign (named after
      the Foundry world) and named after its first recording's id, so renumbering never moves it. Sessions still in
      <code>data\\sessions\\&lt;id&gt;</code> move there; folders still named by number (<code>sessions\\012</code>) are renamed.
      Summaries, transcripts and stories sit in that folder; each Discord recording goes in its <code>recordings\\</code> sub-folder,
      and merged recordings move in with the game they continue. Numbers, ids, Foundry journals and Discord stay as they are.</p>
    <p class="notice ok small" style="margin:0">${plan.backupBytes
      ? `Everything is copied to <code>${esc(plan.backupDir)}</code> first (about ${mb} MB).`
      : `The database is copied to <code>${esc(plan.backupDir)}</code> first; renamed folders keep their files as they are.`}</p>
    ${plan.warnings.map((w) => `<p class="notice warn small" style="margin:0">${esc(w)}</p>`).join("")}
    ${plan.busy ? `<p class="notice err small" style="margin:0">Not now: ${esc(plan.busy)}</p>` : ""}
    <div class="table-wrap" style="max-height:40vh;overflow:auto"><table><thead><tr><th>#</th><th>Folder</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
    <div class="actions"><button value="cancel" formnovalidate>Cancel</button>
      <button class="primary" value="ok" ${plan.busy ? "disabled" : ""}>Back up and update ${plan.pending} session${plan.pending === 1 ? "" : "s"}</button></div></form>`, { wide: true });
  if (!r) return;
  toast("Backing up and updating…");
  await attempt(() => api("POST", "/api/admin/layout/migrate", {}), (x) => `Updated ${x.moved} session(s). Backup: ${x.backupDir}`);
  fetchedAt = 0;
  refresh();
}
