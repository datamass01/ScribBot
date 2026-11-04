// Configuration: the setup checklist and a form for .env, built from shared/schemas/settings.json.
// Secrets never come to the page: it only knows whether one is set, and can replace or clear it.
import { $, api, attempt, confirmDialog, esc, openDialog, pill, toast } from "./util.js";
import { restartWorker } from "./monitoring.js";

let root = null;
let view = null; // GET /api/config
let edits = {}; // key -> new value ("" = default)
// For a setting with a kindPicker (LLM_PROVIDER: API or CLI): the kind picked in the form, and the
// value last chosen under each kind, so switching back restores it. Form state only, never saved.
let kindChoice = {}; // key -> kind
let kindPicks = {}; // key -> {kind: value}
// The "Which models?" box under Model: open or not, and each provider's list from the bot
// (GET /admin/llm/models), kept for the page's life. {loading} while asked, {failed} on an error.
let modelsOpen = false;
let modelLists = {}; // provider -> list | {loading: true} | {failed: message}
let pendingRestart = {}; // process -> {keys}: saved settings it hasn't restarted with yet
let group = null;
let status = null;

const PROC_LABEL = { bot: "bot", worker: "worker", console: "console" };
// Set per campaign in the Campaign tab now, so the form doesn't show them. A campaign without an
// address joins nothing; .env's FOUNDRY_URL applies only while no campaign is being played, and
// FOUNDRY_USER / FOUNDRY_PASSWORD are the fallback login.
const CAMPAIGN_KEYS = new Set(["FOUNDRY_URL", "FOUNDRY_USER", "FOUNDRY_PASSWORD"]);

export function show(el, s) {
  root = el;
  status = s;
  if (!root.dataset.ready) {
    root.innerHTML = `
      <section class="card" id="c-setup"><div class="card-head"><h2>Setup checklist</h2></div><p class="muted">Checking…</p></section>
      <div id="c-restart"></div>
      <section class="card" id="c-form"><p class="muted">Loading settings…</p></section>
      <div class="savebar" id="c-savebar" hidden>
        <span class="count" id="c-count"></span>
        <button data-act="discard">Discard</button>
        <button class="primary" data-act="save">Save to .env</button>
      </div>`;
    root.dataset.ready = "1";
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onInput);
    window.addEventListener("beforeunload", (e) => {
      if (Object.keys(edits).length) e.preventDefault();
    });
  }
  load();
  loadSetup();
}

export function hide() {
  if ($("c-savebar")) $("c-savebar").hidden = true;
}

export function update(s) {
  status = s;
  if (!root || root.hidden) return;
  renderRestart(s.console?.pendingRestart || {});
}

async function load() {
  try {
    view = await api("GET", "/api/config");
    kindChoice = {}; kindPicks = {};
  } catch (err) {
    $("c-form").innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
    return;
  }
  group = group || view.groups[0];
  renderForm();
  renderRestart(view.pendingRestart || {});
}

async function loadSetup() {
  try {
    const r = await api("GET", "/api/setup");
    const icon = { ok: "✓", warn: "!", err: "✕", skip: "–" };
    const bad = r.checks.filter((c) => c.state === "err").length;
    $("c-setup").innerHTML = `<div class="card-head"><h2>Setup checklist</h2>
        ${bad ? pill("err", `${bad} to fix`) : pill("ok", "ready")}<span class="spacer"></span>
        ${view && !view.envExists ? `<button class="primary" data-act="create-env">Create .env from the template</button>` : ""}
        <button data-act="recheck">Check again</button></div>
      <div class="checks">${r.checks.map((c) => `<div class="check-row">
        <span class="icon ${c.state}">${icon[c.state] ?? "?"}</span>
        <div><b>${esc(c.label)}</b>${c.detail ? ` <span class="muted small">${esc(c.detail)}</span>` : ""}
          ${c.fix && c.state !== "ok" ? `<div class="fix">${esc(c.fix)}</div>` : ""}</div></div>`).join("")}</div>`;
  } catch (err) {
    $("c-setup").innerHTML = `<div class="card-head"><h2>Setup checklist</h2></div><p class="error-text">${esc(err.message)}</p>`;
  }
}

// ---------- the form
const current = (s) => {
  if (s.key in edits) return edits[s.key];
  const v = view.values[s.key] || {};
  return s.type === "secret" ? null : (v.value ?? "");
};

/** Same rules as the Console's warnings_for(): known costs to speed, accuracy or safety. */
function warningsFor(s, value) {
  if (s.type === "secret") return [];
  const v = value === "" ? s.default : value;
  return (s.warnings || []).filter(({ when }) => {
    if (when.eq !== undefined) return String(v).trim().toLowerCase() === String(when.eq).toLowerCase();
    const n = Number(v);
    if (Number.isNaN(n) || v === "") return false;
    return (when.gt !== undefined && n > when.gt) || (when.lt !== undefined && n < when.lt);
  }).map((w) => w.text);
}

const kindOf = (s, value) => s.options.find((o) => o.value === value)?.kind;

/** The kind the form lists for `s`: what the user picked, else the kind of its current value. */
function currentKind(s) {
  if (s.key in kindChoice) return kindChoice[s.key];
  const v = current(s);
  return kindOf(s, v === "" ? s.default : v) ?? s.kindPicker.kinds[0].value;
}

function kindRow(s) {
  const v = view.values[s.key] || {};
  const kind = currentKind(s);
  const opts = s.kindPicker.kinds
    .map((k) => `<option value="${esc(k.value)}" ${k.value === kind ? "selected" : ""}>${esc(k.label)}</option>`).join("");
  return `<div class="setting">
    <div class="name"><label for="k-${s.key}"><b>${esc(s.kindPicker.label)}</b></label>
      <div class="small muted">picks the ${esc(s.label.toLowerCase())} list below</div></div>
    <div class="control"><div class="row"><select id="k-${s.key}" data-kind-for="${s.key}" ${v.overridden ? "disabled" : ""}>${opts}</select></div>
      <div class="help">${esc(s.kindPicker.help)}</div></div></div>`;
}

/** Switches `s` to another kind: the value last picked there, the saved one if it's of that kind, or its first option. */
function switchKind(s, kind) {
  const prev = current(s) === "" ? s.default : current(s);
  (kindPicks[s.key] ||= {})[kindOf(s, prev)] = prev;
  kindChoice[s.key] = kind;
  const saved = view.values[s.key]?.value || s.default;
  const value = kindPicks[s.key][kind] ?? (kindOf(s, saved) === kind ? saved : s.options.find((o) => o.kind === kind).value);
  setValue(s, value);
}

// ---------- "Which models?" under Model

/** The provider selected in the form (saved or not), and its label. */
function selectedProvider() {
  const s = view.settings.find((x) => x.key === "LLM_PROVIDER");
  const value = current(s) || s.default;
  return { value, label: s.options.find((o) => o.value === value)?.label || value };
}

function modelHelp() {
  const link = `<a href="#" class="help-link" data-act="models" aria-expanded="${modelsOpen}">${modelsOpen ? "Hide the model list" : "Which models?"}</a>`;
  if (!modelsOpen) return `<div class="help">${link}</div>`;
  const { value } = selectedProvider();
  if (!modelLists[value]) fetchModels(value);
  return `<div class="help">${link}</div><div class="model-help" id="model-help">${modelBox()}</div>`;
}

function modelBox() {
  const { value, label } = selectedProvider();
  const l = modelLists[value];
  if (!l || l.loading) return `<p class="muted small">Asking ${esc(label)} which models it has…</p>`;
  if (l.failed) return `<p class="error-text small">${esc(l.failed)}</p>`;
  const chosen = current(view.settings.find((x) => x.key === "LLM_MODEL"));
  const from = l.source === "cli"
    ? `listed by <code>${esc(l.command)}</code> <button class="linkish" data-act="refresh-models">Refresh</button>`
    : "built into ScribBot";
  const rows = l.models.map((m) => `<tr class="${m.id === chosen ? "chosen" : ""}">
      <td><button class="linkish" data-act="use-model" data-model="${esc(m.id)}" title="Put ${esc(m.id)} in Model"><code>${esc(m.id)}</code></button></td>
      <td>${esc(m.label || "")}${m.isDefault ? ` <span class="muted">(default)</span>` : ""}</td>
      <td class="muted">${esc(m.note || "")}</td></tr>`).join("");
  return `<div class="small"><b>${esc(label)}</b>: ${from}</div>
    ${l.error ? `<p class="error-text small">Couldn't read the list: ${esc(l.error)}${l.command ? `. Run <code>${esc(l.command)}</code> yourself to see why.` : ""}</p>` : ""}
    ${rows ? `<table class="models"><tbody>${rows}</tbody></table><div class="small muted">Click an id to put it in Model.</div>` : ""}
    <ul class="small">${l.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
    <p class="small muted model-note">Your LLM provider's support site may list more or different models than shown here. If you have trouble setting the right model, check it for the exact model id to use.</p>`;
}

/** Asks the bot for a provider's models, then redraws only the box (never under the cursor in Model). */
async function fetchModels(provider, refresh = false) {
  modelLists[provider] = { loading: true };
  const redraw = () => {
    const box = document.getElementById("model-help");
    if (box && selectedProvider().value === provider) box.innerHTML = modelBox();
  };
  queueMicrotask(redraw);
  try {
    modelLists[provider] = await api("GET", `/api/admin/llm/models?provider=${encodeURIComponent(provider)}${refresh ? "&refresh=1" : ""}`);
  } catch (err) {
    modelLists[provider] = { failed: err.message };
  }
  redraw();
}

/** Records `value` as the form's value for `s` (an edit unless it's what .env already says). */
function setValue(s, value) {
  const original = s.type === "secret" ? null : (view.values[s.key]?.value ?? "");
  if (s.type !== "secret" && (s.type === "enum" || s.type === "bool") && value === s.default && original === "") value = "";
  if (s.type !== "secret" && value === original) delete edits[s.key];
  else edits[s.key] = value;
  return value;
}

function visibleSetting(s) {
  if (!s.showIf) return true;
  const other = view.settings.find((o) => o.key === s.showIf.key);
  const v = current(other);
  return s.showIf.values.includes(v === "" ? other.default : v);
}

function control(s) {
  const v = view.values[s.key] || {};
  const locked = v.overridden ? "disabled" : "";
  const id = `f-${s.key}`;
  if (s.type === "secret") {
    const replacing = s.key in edits;
    const stateText = v.overridden ? "set in the environment" : v.set ? (v.isDefault ? "still the example value" : "set") : "not set";
    const gen = s.key === "API_TOKEN" ? `<button data-act="generate" data-key="${s.key}" ${locked}>Generate</button>` : "";
    return `<div class="row">
        ${pill(v.set && !v.isDefault ? "ok" : v.isDefault && v.set ? "warn" : "skip", stateText)}
        ${replacing ? "" : `<button data-act="replace" data-key="${s.key}" ${locked}>${v.set ? "Replace" : "Set"}</button>`}
        ${v.set && !replacing ? `<button class="danger" data-act="clear" data-key="${s.key}" ${locked}>Clear</button>` : ""} ${gen}
      </div>
      ${replacing ? `<div class="row"><input id="${id}" data-key="${s.key}" type="${s.key === "API_TOKEN" ? "text" : "password"}" autocomplete="off"
          spellcheck="false" value="${esc(edits[s.key])}" placeholder="${edits[s.key] === "" && v.set ? "(will be cleared)" : "new value"}">
          <button data-act="undo" data-key="${s.key}">Cancel</button></div>` : ""}`;
  }
  const value = current(s);
  const ph = s.blankMeans ? `blank = ${s.blankMeans}` : s.default ? `blank = ${s.default}` : "";
  let input;
  if (s.type === "enum" || s.type === "bool") {
    const listed = s.kindPicker ? s.options.filter((o) => o.kind === currentKind(s)) : s.options;
    const opts = listed.map((o) => `<option value="${esc(o.value)}" ${(value === "" ? s.default : value) === o.value ? "selected" : ""}>${esc(o.label)}${o.value === s.default ? " (default)" : ""}</option>`).join("");
    input = `<select id="${id}" data-key="${s.key}" ${locked}>${opts}</select>`;
  } else {
    const type = s.type === "int" || s.type === "number" ? "number" : "text";
    const step = s.type === "int" ? "1" : "any";
    input = `<input id="${id}" data-key="${s.key}" type="${type}" ${type === "number" ? `step="${step}"` : ""}
      ${s.min !== undefined ? `min="${s.min}"` : ""} ${s.max !== undefined ? `max="${s.max}"` : ""}
      value="${esc(value)}" placeholder="${esc(ph)}" spellcheck="false" ${locked}>`;
  }
  const reset = s.tuned && value !== "" && value !== s.default
    ? `<button data-act="reset" data-key="${s.key}" title="The tuned default is ${esc(s.default)}">Reset to default (${esc(s.default)})</button>` : "";
  const test = s.key === "LLM_PROVIDER" ? `<button data-act="test-llm" title="Asks the running bot for one tiny structured answer">Test summaries</button>` : "";
  return `<div class="row">${input}${reset}${test}</div>`;
}

function settingRow(s) {
  const v = view.values[s.key] || {};
  const warn = warningsFor(s, s.type === "secret" ? "" : current(s));
  const procs = s.readBy.map((p) => p === "bot" && s.live
    ? `<span title="The bot re-reads it for each summary: no restart needed">${PROC_LABEL[p]} · live</span>`
    : `<span title="Read by the ${p} at startup">${PROC_LABEL[p]}</span>`).join("");
  return `${s.kindPicker ? kindRow(s) : ""}<div class="setting ${s.key in edits ? "changed" : ""}" data-row="${s.key}">
    <div class="name"><label for="f-${s.key}"><b>${esc(s.label)}</b></label><code>${esc(s.key)}</code>
      <div class="procs">${procs}</div>${s.tuned ? `<div class="small muted">tuned default: ${esc(s.default)}</div>` : ""}</div>
    <div class="control">${control(s)}
      ${s.help ? `<div class="help">${esc(s.help)}</div>` : ""}
      ${s.key === "LLM_MODEL" ? modelHelp() : ""}
      ${v.overridden ? `<div class="notice warn small">Set in the environment, which wins over .env; change it there.</div>` : ""}
      ${warn.length ? `<div class="warnings">${warn.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}</div>` : ""}
    </div></div>`;
}

function renderForm() {
  const settings = view.settings.filter((s) => s.group === group && visibleSetting(s) && !CAMPAIGN_KEYS.has(s.key));
  const moved = view.settings.filter((s) => s.group === group && CAMPAIGN_KEYS.has(s.key));
  const movedNote = moved.length
    ? `<div class="setting"><div class="name"><b>Foundry server and login</b></div><div class="control"><div class="help">
        The Foundry address, ScribBot's Foundry user and its password are set for each campaign in the <a href="#campaign">Campaign tab</a>.
        A campaign with no address set there doesn't join Foundry. <code>FOUNDRY_USER</code> and <code>FOUNDRY_PASSWORD</code> in .env are still the login for a campaign that doesn't set its own,
        and <code>FOUNDRY_URL</code> is only used while no campaign is being played.
      </div></div></div>` : "";
  const basic = settings.filter((s) => !s.advanced).map(settingRow).join("");
  const advanced = settings.filter((s) => s.advanced);
  const changedIn = (g) => view.settings.some((s) => s.group === g && s.key in edits);
  const openAdvanced = advanced.some((s) => s.key in edits || (s.tuned && current(s) !== "" && current(s) !== s.default));
  $("c-form").innerHTML = `
    <div class="card-head"><h2>Settings</h2><span class="muted small"><code>${esc(view.envPath)}</code></span></div>
    ${view.envExists ? "" : `<div class="notice warn">There's no .env yet. Create it from the template (above) before saving settings.</div>`}
    <div class="groups" role="tablist">${view.groups.map((g) =>
      `<button data-group="${esc(g)}" aria-pressed="${g === group}">${esc(g)}${changedIn(g) ? " •" : ""}</button>`).join("")}</div>
    <div>${movedNote}${basic || (advanced.length || movedNote ? "" : `<p class="muted">Nothing to set here with the current choices.</p>`)}</div>
    ${advanced.length ? `<details class="advanced" ${openAdvanced ? "open" : ""}><summary>Advanced (${advanced.length})</summary>${advanced.map(settingRow).join("")}</details>` : ""}
    ${view.unknownKeys.length ? `<p class="muted small">Also in .env, not managed here: ${view.unknownKeys.map((k) => `<code>${esc(k)}</code>`).join(", ")}</p>` : ""}`;
  renderSavebar();
}

function renderSavebar() {
  const n = Object.keys(edits).length;
  $("c-savebar").hidden = !n;
  $("c-count").textContent = `${n} unsaved change${n === 1 ? "" : "s"}`;
}

function renderRestart(pending) {
  pendingRestart = pending;
  const procs = Object.keys(pending);
  const el = $("c-restart");
  if (!el) return;
  if (!procs.length) { el.innerHTML = ""; return; }
  const recording = (status?.recordings || []).length > 0;
  const line = (p) => `<li><b>${PROC_LABEL[p]}</b>: ${pending[p].keys.map((k) => `<code>${esc(k)}</code>`).join(", ")}</li>`;
  el.innerHTML = `<div class="notice warn"><b>Saved. These settings apply after a restart:</b><ul>${procs.map(line).join("")}</ul>
    <div class="row" style="margin-top:8px">
      ${pending.bot ? `<button data-act="restart-bot" ${recording ? "disabled title=\"A session is recording. Stop it first.\"" : ""}>Restart bot</button>` : ""}
      ${pending.worker ? `<button data-act="restart-worker" ${recording ? "disabled title=\"A session is recording. Stop it first.\"" : ""}>Restart worker</button>` : ""}
      ${pending.console ? `<span class="small">Restart the Console: Ctrl+C in its window, then <code>.\\start-console.ps1</code>.</span>` : ""}
    </div>
    <p class="small" style="margin:6px 0 0">The restart buttons work when the bot and worker were started with <code>start.ps1</code> / <code>start-worker.ps1</code>, which start them again.</p></div>`;
}

// ---------- events
function onInput(e) {
  const kindFor = e.target.dataset?.kindFor;
  if (kindFor && view) {
    if (e.type !== "change") return;
    switchKind(view.settings.find((x) => x.key === kindFor), e.target.value);
    renderForm();
    document.getElementById(`k-${kindFor}`)?.focus();
    return;
  }
  const key = e.target.dataset?.key;
  if (!key || !view) return;
  const s = view.settings.find((x) => x.key === key);
  const value = setValue(s, e.target.value);
  // Re-render only when it changes what's shown (showIf, warnings), and never under the cursor while typing text.
  if (e.type === "change" || s.type === "enum" || s.type === "bool") {
    renderForm();
    document.getElementById(`f-${key}`)?.focus();
  } else {
    const row = root.querySelector(`[data-row="${key}"]`);
    row?.classList.toggle("changed", key in edits);
    const warn = warningsFor(s, value);
    const box = row?.querySelector(".warnings");
    if (box) box.innerHTML = warn.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("");
    else if (warn.length && row) row.querySelector(".control").insertAdjacentHTML("beforeend", `<div class="warnings">${warn.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}</div>`);
    renderSavebar();
  }
}

async function onClick(e) {
  const g = e.target.closest("[data-group]");
  if (g) { group = g.dataset.group; return renderForm(); }
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const key = btn.dataset.key;
  switch (btn.dataset.act) {
    case "replace": edits[key] = ""; renderForm(); return document.getElementById(`f-${key}`)?.focus();
    case "clear": {
      const ok = await confirmDialog(`Clear ${key}?`, "<p>It will be blank in .env after you save.</p>", { ok: "Clear", danger: true });
      if (ok) { edits[key] = ""; renderForm(); }
      return;
    }
    case "undo": delete edits[key]; return renderForm();
    case "generate": {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      edits[key] = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      renderForm();
      toast("New token generated. Save, restart the bot, and paste the same token into the Foundry module's settings (the headless client sets it itself).");
      return;
    }
    case "reset": {
      edits[key] = "";
      renderForm();
      return;
    }
    case "discard": edits = {}; kindChoice = {}; kindPicks = {}; return renderForm();
    case "save": return save();
    case "recheck": return loadSetup();
    case "create-env": {
      const ok = await attempt(() => api("POST", "/api/config/create-env", {}), ".env created from the template.");
      if (ok) { await load(); loadSetup(); }
      return;
    }
    case "models":
      e.preventDefault();
      modelsOpen = !modelsOpen;
      return renderForm();
    case "refresh-models":
      return fetchModels(selectedProvider().value, true);
    case "use-model": {
      setValue(view.settings.find((x) => x.key === "LLM_MODEL"), btn.dataset.model);
      renderForm();
      return document.getElementById("f-LLM_MODEL")?.focus();
    }
    case "test-llm": {
      // The test runs in the bot with what .env says (summary settings are live), not what this form shows.
      const llmKeys = view.settings.filter((s) => s.group === "Summaries").map((s) => s.key);
      const label = (keys) => keys.map((k) => view.settings.find((s) => s.key === k)?.label || k).join(", ");
      const unsaved = llmKeys.filter((k) => k in edits);
      if (unsaved.length) {
        toast(`Save first: Test summaries uses the saved settings, not the unsaved ${label(unsaved)}.`, "err");
        return;
      }
      // Only reached for a summary setting that isn't live (none today).
      const notApplied = (pendingRestart.bot?.keys || []).filter((k) => llmKeys.includes(k));
      if (notApplied.length) {
        toast(`Restart the bot first: it's still running with the old ${label(notApplied)}.`, "err");
        return;
      }
      btn.disabled = true;
      toast("Asking the LLM… (uses the settings the bot is running with)");
      await attempt(() => api("POST", "/api/admin/llm/test", {}), (r) => r.ok ? `${r.provider} / ${r.model} answered in ${(r.ms / 1000).toFixed(1)} s.` : "The LLM answered, but not as expected.");
      btn.disabled = false;
      return;
    }
    case "restart-bot": {
      const ok = await confirmDialog("Restart the bot?",
        "<p>The bot shuts down cleanly and <code>start.ps1</code> starts it again with the new settings. It's back in Discord within a few seconds.</p>", { ok: "Restart bot" });
      if (ok) await attempt(() => api("POST", "/api/admin/restart", {}), "Bot restarting…");
      return;
    }
    case "restart-worker": return restartWorker(false);
  }
}

async function save() {
  const changed = view.settings.filter((s) => s.key in edits);
  const problems = changed.flatMap((s) => warningsFor(s, edits[s.key]).map((w) => `<li><b>${esc(s.label)}</b>: ${esc(w)}</li>`));
  if (problems.length) {
    const ok = await confirmDialog("Save these settings?", `<p>Some of the new values are known to cost speed, accuracy or safety:</p><ul>${problems.join("")}</ul>`, { ok: "Save anyway" });
    if (!ok) return;
  }
  try {
    const r = await api("POST", "/api/config", { version: view.version, changes: edits });
    edits = {}; kindChoice = {}; kindPicks = {};
    toast(r.changed.length ? `Saved ${r.changed.length} setting(s) to .env.` : "Nothing changed.", "ok");
    await load();
    loadSetup();
  } catch (err) {
    if (err.body?.problems) {
      const list = Object.entries(err.body.problems).map(([k, v]) => `<li><code>${esc(k)}</code>: ${esc(v)}</li>`).join("");
      openDialog(`<form><h3>Not saved</h3><ul>${list}</ul><div class="actions"><button class="primary" value="cancel">OK</button></div></form>`);
    } else {
      toast(err.message, "err");
    }
  }
}
