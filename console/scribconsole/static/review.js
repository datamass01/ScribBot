// Review before Foundry: a session's summary or story as Foundry's journal will show it, built with
// the Foundry module's own journal.js, beside an editor. Corrections are saved to the bot; the LLM
// can be asked to revise the summary with feedback; approving sends it to Foundry. Everything goes
// through the bot's /admin review routes (bot/src/api/admin.ts), which check what was approved.
import { buildJournalPages, buildStoryPages } from "/static/foundry/journal.js";
import { api, attempt, confirmDialog, esc, pill, toast, when } from "./util.js";

const POLL_MS = 3000;

/** The summary's sections in the order Foundry's pages show them, and how each item is edited. */
const SECTIONS = [
  { key: "recap", label: "Recap", page: "Recap", kind: "markdown", hint: "Markdown: blank lines between paragraphs, **bold**, *italics*, - lists." },
  { key: "scenes", label: "Scenes", page: "Scenes", add: "Add a scene",
    fields: [["title", "Title", "text"], ["location", "Location", "text?"], ["summary", "What happened", "area"]],
    blank: () => ({ title: "", location: null, summary: "" }) },
  { key: "combats", label: "Combats", page: "Combats", add: "Add a combat",
    fields: [["name", "Name", "text"], ["location", "Location", "text?"], ["participants", "Party (comma-separated)", "list"],
      ["enemies", "Enemies (comma-separated)", "list"], ["rounds", "Rounds", "number?"], ["keyMoments", "Key moments (one per line)", "lines"],
      ["outcome", "Outcome", "area"]],
    blank: () => ({ name: "", location: null, participants: [], enemies: [], rounds: null, keyMoments: [], outcome: "" }) },
  { key: "quotes", label: "Quotes", page: "Quotes", add: "Add a quote",
    fields: [["character", "Character", "text"], ["t", "Time (HH:MM:SS)", "time"], ["text", "Words, as spoken", "area"], ["context", "Context", "text"]],
    blank: () => ({ t: "00:00:00", character: "", text: "", context: "", seconds: 0, verified: false }) },
  { key: "characterHighlights", label: "Characters", page: "Characters", add: "Add a character",
    fields: [["character", "Character", "text"], ["highlights", "Highlights (one per line)", "lines"]],
    blank: () => ({ character: "", highlights: [] }) },
  { key: "npcs", label: "NPCs", page: "NPCs, Loot & Threads", add: "Add an NPC",
    fields: [["name", "Name", "text"], ["description", "Who they are, what they did", "area"]], blank: () => ({ name: "", description: "" }) },
  { key: "loot", label: "Loot", page: "NPCs, Loot & Threads", add: "Add an item",
    fields: [["item", "Item", "text"], ["recipient", "Taken by", "text?"]], blank: () => ({ item: "", recipient: null }) },
  { key: "hooks", label: "Open threads", page: "NPCs, Loot & Threads", kind: "lines", hint: "One per line." },
];

const clone = (v) => JSON.parse(JSON.stringify(v));
const secondsOf = (t) => {
  const m = String(t ?? "").trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
};

/** A stand-in for each story image: Foundry gets the real one when the story is imported. */
function placeholderImages(names) {
  const out = {};
  for (const name of names) {
    const label = name.replace(/[<>&"']/g, "");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="120"><rect width="100%" height="100%" fill="#d9cfb8"/>` +
      `<text x="50%" y="50%" font-family="sans-serif" font-size="16" fill="#5b4a2f" text-anchor="middle" dominant-baseline="middle">🖼 ${label}: copied into Foundry on import</text></svg>`;
    out[name] = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
  return out;
}

/** Foundry renders @UUID[Actor.id]{Name} as a content link; so does the preview. */
const contentLinks = (html) => html.replace(/@UUID\[Actor\.[^\]]+\]\{([^}]*)\}/g, '<a class="content-link" title="Opens the actor sheet in Foundry">$1</a>');

let state = null;

/**
 * Opens the review for a session in `el` (the Sessions tab hides its list meanwhile).
 * `onClose(changed)` is called when it's closed.
 */
export async function openReview(el, sessionId, kind, { onClose, onDiscord } = {}) {
  state = { el, sessionId, kind, onClose, onDiscord, data: null, draft: null, dirty: false, page: 0, poll: null, saving: false };
  el.hidden = false;
  el.innerHTML = `<div class="muted">Loading…</div>`;
  el.onclick = onClick;
  el.oninput = onInput;
  el.onchange = onInput;
  await load();
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function closeReview(changed = false) {
  if (!state) return;
  clearTimeout(state.poll);
  const { el, onClose } = state;
  state = null;
  el.hidden = true;
  el.innerHTML = "";
  onClose?.(changed);
}

/** Leaving with unsaved edits asks first. */
export async function confirmLeave() {
  if (!state?.dirty) return true;
  return confirmDialog("Discard your changes?", "<p>Your edits haven't been saved.</p>", { ok: "Discard", danger: true });
}

async function load({ keepDraft = false } = {}) {
  const s = state;
  let data;
  try {
    data = await api("GET", `/api/admin/sessions/${encodeURIComponent(s.sessionId)}/review`);
  } catch (err) {
    s.el.innerHTML = `<div class="notice err">${esc(err.message)}</div><div class="row"><button data-r="close">Back to sessions</button></div>`;
    return;
  }
  if (state !== s) return;
  s.data = data;
  if (!data[s.kind]) s.kind = data.summary ? "summary" : "story";
  if (!keepDraft || !s.dirty) {
    s.draft = s.kind === "summary" ? clone(data.summary?.file.summary ?? null) : data.story?.file.markdown ?? "";
    s.dirty = false;
  }
  render();
  clearTimeout(s.poll);
  if (data.busy) s.poll = setTimeout(() => state === s && load({ keepDraft: true }), POLL_MS);
}

// ---------- rendering

function render() {
  const s = state;
  const d = s.data;
  const item = d[s.kind];
  const number = d.session.number;
  const tabs = ["summary", "story"].filter((k) => d[k]).map((k) =>
    `<button data-r="kind" data-kind="${k}" aria-pressed="${k === s.kind}">${k === "summary" ? "Summary" : "Story"} ${stateBadge(d[k])}</button>`).join("");
  s.el.innerHTML = `
    <div class="card-head">
      <button data-r="close" aria-label="Back to sessions">← Sessions</button>
      <h2>Review session ${number}${d.session.title ? ` · ${esc(d.session.title)}` : ""}</h2>
      <span class="spacer"></span>
      <div class="seg" role="group" aria-label="What to review">${tabs}</div>
    </div>
    ${!item ? `<div class="notice warn">Session ${number} has nothing to review yet.</div>` : `
    ${banner(d, item)}
    <div class="review-grid">
      <div class="review-edit">
        <div class="review-pane-head"><h3>Edit</h3><span class="spacer"></span><span class="muted small" id="r-dirty"></span></div>
        <div id="r-editor">${s.kind === "summary" ? summaryEditor() : storyEditor()}</div>
      </div>
      <div class="review-preview">
        <div class="review-pane-head"><h3>As it will look in Foundry</h3></div>
        <div id="r-preview"></div>
      </div>
    </div>
    <div class="review-actions" id="r-actions"></div>
    ${s.kind === "summary" ? reviseBox(item) : ""}`}`;
  if (item) {
    renderPreview();
    renderActions();
  }
}

function stateBadge(item) {
  if (!item) return "";
  if (item.approved) return `<span class="ok-text small">✓</span>`;
  return `<span class="warn-text small">●</span>`;
}

function banner(d, item) {
  const what = state.kind;
  const out = [];
  if (d.busy) out.push(`<div class="notice info">The LLM is revising this summary. This page reloads it when it's done.</div>`);
  else if (d.session.error && /^Revising/.test(d.session.error)) out.push(`<div class="notice err">${esc(d.session.error)}</div>`);
  if (!d.required) out.push(`<div class="notice">Review isn't required (<code>REVIEW_BEFORE_FOUNDRY=false</code>): ${what === "summary" ? "new summaries go to Foundry as soon as they're written" : "stories go to Foundry when someone posts them"}. You can still edit here and post.</div>`);
  else if (item.approved) out.push(`<div class="notice ok">Approved ${esc(when(item.approvedAt))}. Foundry may import this version.</div>`);
  else if (item.changedSinceApproval) out.push(`<div class="notice warn">Changed since it was approved: Foundry won't get it until it's approved again.</div>`);
  else out.push(`<div class="notice warn">Waiting for review: Foundry won't get this ${what} until it's approved.</div>`);
  if (what === "story" && item.file.problem) out.push(`<div class="notice err">${esc(item.file.problem)}</div>`);
  return out.join("");
}

// ---------- the summary editor

function field(path, label, type, value) {
  const attr = `data-path="${esc(path)}" data-type="${type}"`;
  const v = value ?? "";
  if (type === "area") return `<label class="field"><span>${esc(label)}</span><textarea class="prose" rows="3" ${attr}>${esc(v)}</textarea></label>`;
  if (type === "lines") return `<label class="field"><span>${esc(label)}</span><textarea class="prose" rows="3" ${attr}>${esc((value ?? []).join("\n"))}</textarea></label>`;
  if (type === "list") return `<label class="field"><span>${esc(label)}</span><input ${attr} value="${esc((value ?? []).join(", "))}"></label>`;
  if (type === "number?") return `<label class="field"><span>${esc(label)}</span><input type="number" min="0" step="1" ${attr} value="${esc(v)}"></label>`;
  if (type === "time") return `<label class="field"><span>${esc(label)}</span><input ${attr} value="${esc(v)}" pattern="(\\d+:)?\\d{1,2}:\\d{2}" placeholder="01:23:45"></label>`;
  return `<label class="field"><span>${esc(label)}${type === "text?" ? ' <small>(optional)</small>' : ""}</span><input ${attr} value="${esc(v)}"></label>`;
}

function summaryEditor() {
  const d = state.draft;
  const name = `Session ${state.data.session.number}: `;
  const head = `<details open class="review-section"><summary>Journal entry</summary>
    <label class="field"><span>Title</span><div class="row"><span class="muted">${esc(name)}</span><input style="flex:1" data-path="title" data-type="text" value="${esc(d.title)}" maxlength="200"></div></label>
  </details>`;
  return head + SECTIONS.map((sec) => {
    const value = d[sec.key];
    let body;
    if (sec.kind === "markdown") {
      body = `<textarea class="prose" rows="10" data-path="${sec.key}" data-type="area">${esc(value)}</textarea><small class="muted">${esc(sec.hint)}</small>`;
    } else if (sec.kind === "lines") {
      body = `<textarea class="prose" rows="4" data-path="${sec.key}" data-type="lines">${esc(value.join("\n"))}</textarea><small class="muted">${esc(sec.hint)}</small>`;
    } else {
      body = value.map((it, i) => `<fieldset class="review-item">
          <legend>${esc(sec.label.replace(/s$/, ""))} ${i + 1}${sec.key === "quotes" ? quoteTag(it) : ""}
            <button type="button" class="link danger" data-r="remove" data-key="${sec.key}" data-i="${i}">Remove</button></legend>
          ${sec.fields.map(([k, label, type]) => field(`${sec.key}.${i}.${k}`, label, type, it[k])).join("")}
        </fieldset>`).join("") +
        `<button type="button" data-r="add" data-key="${sec.key}">+ ${esc(sec.add)}</button>`;
    }
    const count = Array.isArray(value) ? ` <span class="muted small">(${value.length})</span>` : "";
    return `<details class="review-section" ${sec.kind === "markdown" ? "open" : ""} data-section="${sec.key}">
      <summary>${esc(sec.label)}${count}</summary>${body}</details>`;
  }).join("");
}

function quoteTag(q) {
  return q.verified
    ? ` <span class="ok-text small" title="Found in the transcript">verified</span>`
    : ` <span class="warn-text small" title="Not found in the transcript: kept because a person added or changed it">not in transcript</span>`;
}

function storyEditor() {
  return `<p class="muted small" style="margin-top:0">The story write-up (<code>story/summary.story.md</code>) from the summarize-session skill. Each <code>## </code> heading becomes a journal page.</p>
    <textarea class="story-md" data-path="markdown" data-type="story" spellcheck="true">${esc(state.draft)}</textarea>`;
}

function reviseBox(item) {
  const revisions = item.file.revisions ?? [];
  const history = revisions.length
    ? `<details><summary class="muted small">Asked before (${revisions.length})</summary><ul class="small">${revisions.map((r) =>
        `<li><span class="muted">${esc(when(r.at))} · ${esc(r.model)}:</span> ${esc(r.feedback)}</li>`).join("")}</ul></details>` : "";
  const busy = state.data.busy;
  return `<section class="review-revise">
    <h3>Ask the LLM for corrections</h3>
    <p class="muted small">Say what's wrong, as you would to a person: “The innkeeper is Brannoc, not Brandon”, “Elara cast the sleep spell, not Thorin”,
      “Leave out the scene about snacks”. The LLM rewrites the summary from its notes and the current text, your edits included, and changes only what you asked.
      Earlier requests are sent along so they aren't undone. The new version needs approving.</p>
    <textarea id="r-feedback" class="prose" rows="3" maxlength="4000" placeholder="What should be corrected?" ${busy ? "disabled" : ""}></textarea>
    <div class="row"><button data-r="revise" ${busy ? "disabled" : ""}>${busy ? "Revising…" : "Ask the LLM to revise"}</button>
      <span class="muted small">Uses the LLM set under Configuration → Summaries. Takes about as long as summarizing.</span></div>
    ${history}
  </section>`;
}

// ---------- preview

function previewPages() {
  const s = state;
  const d = s.data;
  if (s.kind === "summary") {
    const file = d.summary.file;
    const summary = { ...s.draft, quotes: s.draft.quotes.map((q) => ({ ...q, seconds: secondsOf(q.t) })) };
    return {
      name: `Session ${file.sessionNumber}: ${summary.title}`,
      pages: buildJournalPages({ ...file, summary }, null, d.actors),
      note: "Plus a Transcript page when “Include transcript” is on in Foundry's module settings.",
    };
  }
  const story = d.story.file;
  const title = s.draft.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "Session story";
  const assets = [...s.draft.matchAll(/!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?\s*\)/g)].map((m) => m[1]);
  return {
    name: title,
    pages: buildStoryPages({ ...story, markdown: s.draft }, d.actors, placeholderImages(assets)),
    note: story.assets?.length ? "Images are copied into Foundry's files on import; here they're shown as placeholders." : "",
  };
}

function renderPreview() {
  const s = state;
  const box = s.el.querySelector("#r-preview");
  if (!box) return;
  let built;
  try {
    built = previewPages();
  } catch (err) {
    box.innerHTML = `<div class="notice err">The preview couldn't be built: ${esc(err.message)}</div>`;
    return;
  }
  const { name, pages, note } = built;
  s.page = Math.min(s.page, Math.max(pages.length - 1, 0));
  const page = pages[s.page];
  box.innerHTML = `<div class="fvtt-journal">
      <div class="fvtt-titlebar"><span>📖</span><span class="fvtt-title">${esc(name)}</span></div>
      <div class="fvtt-body">
        <nav class="fvtt-toc" aria-label="Pages">${pages.map((p, i) =>
          `<button data-r="page" data-i="${i}" aria-current="${i === s.page}"><span class="n">${i + 1}</span>${esc(p.name)}</button>`).join("") || `<span class="muted">No pages</span>`}</nav>
        <article class="fvtt-page">${page ? `<h1 class="fvtt-page-title">${esc(page.name)}</h1>${contentLinks(page.text.content)}` : `<p class="muted">Nothing to show: every section is empty.</p>`}</article>
      </div>
    </div>
    ${note ? `<p class="muted small">${esc(note)}</p>` : ""}`;
}

function renderActions() {
  const s = state;
  const box = s.el.querySelector("#r-actions");
  if (!box) return;
  const item = s.data[s.kind];
  const busy = s.data.busy;
  const why = busy ? "Wait for the revision to finish." : s.dirty ? "Save your changes first, so you approve what you see." : "";
  const approveLabel = item.approved ? "Post to Foundry again" : "Approve and post to Foundry";
  box.innerHTML = `
    <button data-r="save" ${!s.dirty || busy ? "disabled" : ""}>Save changes</button>
    <button data-r="discard" ${!s.dirty ? "disabled" : ""}>Discard changes</button>
    <button data-r="discord" ${s.dirty ? "disabled" : ""} title="${s.dirty ? "Save your changes first." : "Post this to a Discord text channel through the bot"}">Post to Discord…</button>
    <span class="spacer"></span>
    ${item.approved || !s.data.required ? "" : `<button data-r="approve-only" ${why ? "disabled" : ""} title="${esc(why || "Approve without sending it now; post it later from the session's menu.")}">Approve only</button>`}
    <button class="primary" data-r="approve" ${why ? "disabled" : ""} title="${esc(why)}">${approveLabel}</button>`;
  const dirty = s.el.querySelector("#r-dirty");
  if (dirty) dirty.textContent = s.dirty ? "Unsaved changes" : "";
}

// ---------- editing

function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[/^\d+$/.test(k) ? Number(k) : k];
  o[keys.at(-1)] = value;
}

function readInput(el) {
  const v = el.value;
  switch (el.dataset.type) {
    case "text?": return v.trim() ? v : null;
    case "number?": return v.trim() === "" ? null : Math.max(0, Math.round(Number(v)) || 0);
    case "list": return v.split(",").map((x) => x.trim()).filter(Boolean);
    case "lines": return v.split("\n").map((x) => x.trim()).filter(Boolean);
    default: return v;
  }
}

let previewTimer = null;
function onInput(e) {
  const el = e.target.closest("[data-path]");
  if (!el || !state) return;
  if (el.dataset.type === "story") state.draft = el.value;
  else setPath(state.draft, el.dataset.path, readInput(el));
  if (!state.dirty) {
    state.dirty = true;
    renderActions();
  }
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => state && renderPreview(), 150);
}

/** Re-renders the editor, keeping which sections are open and where the page is scrolled. */
function rerenderEditor() {
  const ed = state.el.querySelector("#r-editor");
  const open = new Set([...ed.querySelectorAll("details[open][data-section]")].map((x) => x.dataset.section));
  ed.innerHTML = summaryEditor();
  for (const det of ed.querySelectorAll("details[data-section]")) det.open = open.has(det.dataset.section);
  renderPreview();
  renderActions();
}

async function onClick(e) {
  const btn = e.target.closest("[data-r]");
  if (!btn || !state) return;
  const s = state;
  switch (btn.dataset.r) {
    case "close":
      if (await confirmLeave()) closeReview(true);
      return;
    case "kind":
      if (btn.dataset.kind === s.kind || !(await confirmLeave())) return;
      s.kind = btn.dataset.kind;
      s.page = 0;
      s.dirty = false;
      s.draft = s.kind === "summary" ? clone(s.data.summary.file.summary) : s.data.story.file.markdown;
      return render();
    case "page":
      s.page = Number(btn.dataset.i);
      return renderPreview();
    case "add": {
      const sec = SECTIONS.find((x) => x.key === btn.dataset.key);
      s.draft[sec.key].push(sec.blank());
      s.dirty = true;
      rerenderEditor();
      s.el.querySelector(`details[data-section="${sec.key}"]`).open = true;
      return;
    }
    case "remove":
      s.draft[btn.dataset.key].splice(Number(btn.dataset.i), 1);
      s.dirty = true;
      return rerenderEditor();
    case "discard":
      s.draft = s.kind === "summary" ? clone(s.data.summary.file.summary) : s.data.story.file.markdown;
      s.dirty = false;
      return render();
    case "save":
      return save();
    case "approve":
    case "approve-only":
      return approve(btn.dataset.r === "approve");
    case "revise":
      return revise();
    case "discord":
      return s.onDiscord?.(s.kind);
  }
}

async function save() {
  const s = state;
  if (s.saving) return false;
  const form = s.el.querySelector("#r-editor");
  for (const input of form.querySelectorAll("input")) if (!input.reportValidity()) return false;
  s.saving = true;
  const item = s.data[s.kind];
  const body = s.kind === "summary" ? { summary: s.draft, hash: item.hash } : { markdown: s.draft, hash: item.hash };
  const r = await attempt(() => api("PUT", `/api/admin/sessions/${encodeURIComponent(s.sessionId)}/${s.kind}`, body), "Saved.");
  s.saving = false;
  if (!r || state !== s) return false;
  s.data = r;
  s.draft = s.kind === "summary" ? clone(r.summary.file.summary) : r.story.file.markdown;
  s.dirty = false;
  render();
  return true;
}

async function approve(post) {
  const s = state;
  const item = s.data[s.kind];
  const r = await attempt(() => api("POST", `/api/admin/sessions/${encodeURIComponent(s.sessionId)}/${s.kind}/approve`, { hash: item.hash, post }));
  if (state !== s) return;
  if (!r) return load(); // changed meanwhile (the message says so): show what's there now
  if (!post) toast(`Approved. Post it from the session's menu when you're ready.`, "ok");
  else if (r.foundryConnected) toast(`Approved and sent “${r.title}” to Foundry. The Foundry column shows ✓ once Foundry confirms the journal entry.`, "ok");
  else toast(`Approved “${r.title}”. No Foundry client is connected right now; the headless client (if on) joins to import it, or import it from Foundry's journal sidebar.`, "ok");
  closeReview(true);
}

async function revise() {
  const s = state;
  const box = s.el.querySelector("#r-feedback");
  const feedback = box.value.trim();
  if (!feedback) return toast("Say what to correct first.", "err");
  // The LLM starts from the saved summary: save edits first, so they're part of it.
  if (s.dirty && !(await save())) return;
  const r = await attempt(() => api("POST", `/api/admin/sessions/${encodeURIComponent(s.sessionId)}/summary/revise`, { feedback }),
    "Asked the LLM to revise it. This page reloads the new version when it's ready.");
  if (!r || state !== s) return;
  await load();
}
