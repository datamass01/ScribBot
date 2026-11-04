// Monitoring: the bot's dashboard and the old watchdog's offline page in one, fed by the Console's
// /status (the bot's own when it's up, a stand-in built locally when it's down).
import { $, api, attempt, ago, bytes, clock, confirmDialog, dur, esc, pill, rows, toast, when } from "./util.js";

let root = null;
let last = null;
let logs = [];
let lastSeq = 0;
let logTimer = null;
let tickTimer = null;

export function show(el, status) {
  root = el;
  if (!root.dataset.ready) {
    root.innerHTML = `
      <div class="stack" id="m-warnings"></div>
      <div id="m-pipeline"></div>
      <div id="m-recordings" class="stack"></div>
      <div class="grid" id="m-components"></div>
      <section class="card">
        <div class="card-head"><h2>Activity</h2><span class="spacer"></span>
          <select id="m-log-level" aria-label="Filter">
            <option value="all">All</option><option value="event">Events</option>
            <option value="warn">Warnings and errors</option><option value="error">Errors</option>
          </select>
          <input id="m-log-search" type="search" placeholder="Filter text" aria-label="Filter text">
          <label class="check"><input id="m-log-follow" type="checkbox" checked> Follow</label>
        </div>
        <div class="log" id="m-log"></div>
        <p class="muted small" id="m-log-note"></p>
      </section>`;
    root.dataset.ready = "1";
    $("m-log-level").addEventListener("change", renderLogs);
    $("m-log-search").addEventListener("input", renderLogs);
    root.addEventListener("click", onClick);
  }
  if (status) update(status);
  pollLogs();
  tickTimer = setInterval(() => {
    for (const el of root.querySelectorAll("[data-elapsed]")) el.textContent = clock((Date.now() - Date.parse(el.dataset.elapsed)) / 1000);
  }, 1000);
}

export function hide() {
  clearTimeout(logTimer);
  clearInterval(tickTimer);
}

export function update(s) {
  last = s;
  if (!root || root.hidden) return;
  const p = s.pipeline || s.monitor?.pipeline;
  const offline = s.monitor?.bot !== "online";
  const banner = offline
    ? `<div class="notice warn">The bot isn't running, so this is what the Console can see on its own. Start it with <code>.\\start.ps1</code>.</div>` : "";
  $("m-warnings").innerHTML = banner + (s.warnings || []).map((w) => `<div class="notice warn">⚠ ${esc(w)}</div>`).join("");
  renderPipeline(p, s);
  renderRecordings(s);
  renderComponents(s);
}

// ---------- worker controls
async function onClick(e) {
  const btn = e.target.closest("button[data-worker]");
  if (!btn) return;
  const action = btn.dataset.worker;
  if (action === "restart") {
    const ok = await confirmDialog("Restart the worker?",
      "<p>The worker exits and <code>start-worker.ps1</code> starts it again. The clip being transcribed is redone; queued clips are re-queued from disk when it starts.</p>" +
      "<p class=\"muted small\">Only works when the worker was started with <code>start-worker.ps1</code> or <code>start.ps1</code>.</p>", { ok: "Restart" });
    if (!ok) return;
    await restartWorker(false);
    return;
  }
  btn.disabled = true;
  await attempt(() => api("POST", `/api/worker/${action}`, { reason: "from the Console" }), action === "pause" ? "Worker paused." : "Worker resumed.");
  btn.disabled = false;
}

export async function restartWorker(force) {
  try {
    await api("POST", "/api/worker/restart", { force, reason: "from the Console" });
    toast("Worker restarting…", "ok");
    return true;
  } catch (err) {
    if (err.body?.needsConfirm && !force) {
      const ok = await confirmDialog("The worker is busy", `<p>${esc(err.message)}</p>`, { ok: "Restart anyway", danger: true });
      if (ok) return restartWorker(true);
      return null;
    }
    return attempt(() => Promise.reject(err));
  }
}

// ---------- rendering (from bot/public/dashboard.html)
const PHASE = { recording: "converting live", finishing: "finishing", transcribed: "transcribed", summarizing: "summarizing", failed: "failed", interrupted: "interrupted" };
const SHUTDOWN = { safe: ["ok", "safe to shut down"], wait: ["warn", "busy"], no: ["err", "recording"] };
const stat = (value, label, title = "") => `<div class="stat" title="${esc(title)}"><b>${value}</b><span>${esc(label)}</span></div>`;

function qualityCell(q) {
  if (!q) return `<span class="muted">–</span>`;
  const repeats = q.topRepeats.map((r) => `${r.count}× “${r.text}”`).join("\n");
  return `<span title="${esc(`${q.noise} of ${q.clips} converted clips gave nothing usable (dropped as noise).\n` +
    `${q.hallucinations} look like hallucinations: stock silence phrases or only hotword names.` + (repeats ? `\n\nMost repeated:\n${repeats}` : ""))}">
    ${q.noisePct}% noise · <span class="${q.hallucinationPct >= 15 ? "warn-text" : ""}">${q.hallucinationPct}% suspect</span></span>`;
}

function renderPipeline(p, s) {
  if (!p) { $("m-pipeline").innerHTML = ""; return; }
  const sd = p.shutdown;
  const [cls, label] = SHUTDOWN[sd.state] ?? ["info", sd.state];
  const banner = `<div class="shutdown ${cls}"><b>${esc(sd.title)}</b>${sd.reasons.length ? `<ul>${sd.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}</div>`;
  const alerts = p.alerts.length ? `<div class="stack" style="margin-bottom:12px">${p.alerts.map((a) => `<div class="notice ${a.level}">${esc(a.text)}</div>`).join("")}</div>` : "";
  const q = p.queue;
  const measuring = `<span class="muted small">measuring…</span>`;
  const trend = q.trendPerMin == null ? measuring
    : q.trendPerMin > 0.5 ? `<span class="warn-text">+${q.trendPerMin}/min</span>`
    : q.trendPerMin < -0.5 ? `<span class="ok-text">${q.trendPerMin}/min</span>` : "steady";
  // A measured rate of 0 isn't "measuring": the worker is either partway through a clip or not converting.
  const eta = !q.pendingClips ? "–" : q.etaSec != null ? dur(q.etaSec) : q.ratePerMin == null ? measuring
    : q.paused ? `<span class="warn-text">paused</span>`
    : q.busy ? `<span class="muted small">converting…</span>`
    : `<span class="${q.stalled ? "err-text" : "warn-text"}">not converting</span>`;
  const idle = q.waiting ? (q.stalled ? `<span class="err-text">${dur(q.noProgressSec)}</span>` : dur(q.noProgressSec)) : "–";
  const ws = q.worker;
  const timing = ws && ws.clips
    ? stat(`${ws.avgSeconds}s`, "per clip (worker)", `Last ${dur(ws.windowSec)}: ${ws.clips} model calls, p95 ${ws.p95Seconds}s, ` +
        `${ws.skippedByVad} skipped by VAD, ${ws.fillerDropped ?? 0} filler phrases dropped, ${ws.keptPct}% with usable text, real-time factor ${ws.realTimeFactor ?? "–"}`)
    : "";
  const head = `<div class="stats">
    ${stat(q.paused ? `<span class="warn-text">paused</span>` : (q.depth ?? "–"),
      q.paused ? `${q.depth ?? 0} queued` : q.busy ? "queue depth · 1 converting" : "queue depth",
      q.paused ? `Paused${q.pausedReason ? `: ${q.pausedReason}` : ""}`
        : `Clips and jobs waiting in the transcription worker${q.busy ? `, plus the one it has been converting for ${dur(q.busySec ?? 0)}` : ""}`)}
    ${timing}
    ${stat(q.pendingClips, "not yet converted", "Recorded clips without text yet, across active sessions")}
    ${stat(q.ratePerMin == null ? measuring : `${q.ratePerMin}/min`, "conversion rate", `Clips turned into text per minute of working time, so silence at the table doesn't lower it (${dur(q.activeSec ?? 0)} of the last ${dur(q.windowSec)}; with none, the last measured rate)`)}
    ${stat(trend, "queue trend", "Positive: clips arrive faster than they are converted")}
    ${stat(eta, "time to catch up", "Clips not yet converted ÷ conversion rate (recording adds more)")}
    ${stat(idle, "since last conversion", "How long since a clip was last converted, while clips are queued, converting or not yet sent")}
  </div>`;
  const rowsHtml = p.conversions.map((c) => {
    const pct = Math.round(c.fraction * 100);
    const tone = c.phase === "failed" ? (c.pending ? "warn" : "err") : c.pending ? "info" : "ok";
    return `<tr><td>${esc(c.number)}</td><td>${pill(tone, PHASE[c.phase] ?? c.phase)}</td><td>${c.converted} / ${c.clips}</td><td>${c.pending}</td>
      <td><div class="bar ${c.pending ? "" : "p-done"}" style="width:100%;min-width:120px;height:6px" title="${pct}%"><i style="width:${pct}%"></i></div></td>
      <td>${qualityCell(c.quality)}</td></tr>`;
  }).join("");
  const table = p.conversions.length
    ? `<div class="table-wrap"><table><thead><tr><th>Session</th><th>Phase</th><th>Converted</th><th>Left</th><th>Progress</th><th>Quality</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`
    : `<p class="muted" style="margin:8px 0 0">No session is recording or being converted.</p>`;
  const w = s.worker || {};
  const controls = w.reachable
    ? `<span class="spacer"></span>${q.paused ? `<button data-worker="resume">Resume worker</button>` : `<button data-worker="pause">Pause worker</button>`}
       <button data-worker="restart">Restart worker</button>` : "";
  $("m-pipeline").innerHTML = `<section class="card"><div class="card-head"><h2>Transcription pipeline</h2>${pill(cls, label)}${controls}</div>${banner}${alerts}${head}${table}</section>`;
}

function renderRecordings(s) {
  $("m-recordings").innerHTML = (s.recordings || []).map((r) => {
    const speaking = new Set(r.speakingNow);
    const speakers = r.speakers.length ? r.speakers.map((p) => {
      const role = p.isGm ? "GM" : p.character ? esc(p.character) : `<span class="err-text">unmapped</span>`;
      return `<div class="speaker ${speaking.has(p.discordId) ? "talking" : ""}">${esc(p.displayName)}<small>${role}</small></div>`;
    }).join("") : `<span class="muted">Nobody has spoken yet.</span>`;
    const conn = r.connection === "reconnecting" ? pill("warn", "rejoining voice…") : r.connection === "lost" ? pill("err", "voice lost, retrying") : pill("err", "live");
    return `<section class="card rec"><h2><span class="dot"></span>Recording session ${r.number}${conn}</h2>
      <div class="stats">
        <div class="stat"><b data-elapsed="${esc(r.startedAt)}">${clock((Date.now() - Date.parse(r.startedAt)) / 1000)}</b><span>elapsed</span></div>
        <div class="stat"><b>${r.clips}</b><span>clips</span></div>
        <div class="stat"><b>${r.speakers.length}</b><span>speakers</span></div>
        <div class="stat"><b style="font-size:15px">${esc(r.channel)}</b><span>${esc(r.guild)}</span></div>
      </div><div class="chips">${speakers}</div></section>`;
  }).join("");
}

function headlessText(h) {
  const who = `<span class="muted">as ${esc(h.user)}, ${esc(h.mode)}</span>`;
  const pending = h.pendingImports.length ? `<br><span class="muted">${h.pendingImports.length} import(s) waiting for a GM</span>` : "";
  if (h.state === "connected") return `joined ${esc(h.world ?? "")} ${esc(ago(h.since))} ${who}${pending}`;
  if (h.state === "joining") return `joining… ${who}${pending}`;
  if (!h.url && h.state !== "connected") return `<span class="warn-text">no Foundry address for ${esc(h.campaign ?? "this campaign")}</span> ${who}${pending}`;
  if (h.state === "retrying") return `<span class="error-text">can't join: ${esc(h.error ?? "")}</span> ${who}${pending}`;
  return `idle${h.mode === "session" ? ' <span class="muted">(joins when recording starts)</span>' : ""} ${who}${pending}`;
}

const card = (title, status, body) => `<section class="card"><h2>${esc(title)}<span class="spacer"></span>${status}</h2>${body}</section>`;

function renderComponents(s) {
  const d = s.discord;
  const discord = card("Discord", !d ? pill("warn", "unknown") : d.ready ? pill("ok", "connected") : pill("err", "offline"),
    d ? rows([["Bot", esc(d.tag ?? "–")], ["Gateway ping", d.pingMs == null ? "–" : `${d.pingMs} ms`], ["Servers", d.guilds], ["Connected since", esc(when(d.readySince))]])
      : `<p class="muted">Needs the bot.</p>`);
  const w = s.worker || {};
  const live = w.liveClips;
  const worker = card("Transcription worker", w.reachable ? (w.queued ? pill("info", `${w.queued} queued`) : pill("ok", "ready")) : pill("err", "unreachable"),
    w.reachable ? rows([["Model", esc(w.model)], ["Device", esc(w.device)], ["Language", esc(w.language)], ["Queue", w.queued ?? "–"],
      ["Live clips", live ? `${live.done} done${live.failed ? `, <span class="error-text">${live.failed} failed</span>` : ""}` : "–"],
      ["Latency", `${w.latencyMs} ms`]]) : `${rows([["URL", esc(w.url)]])}<p class="error-text">${esc(w.error)}</p>`);
  const l = s.llm || {};
  const manual = l.autoSummarize === false;
  // Ready: a summary could run now. AUTO_SUMMARIZE only decides when it runs (the Runs row), so a
  // working setup in manual mode is ready too; unset in manual mode isn't an error, as nothing fails.
  const ready = Boolean(l.credentials && l.model && !l.optionsError);
  const llm = card("Summarizer", ready ? pill("ok", "ready") : manual ? pill("info", "not set up") : pill("err", "not configured"),
    rows([["Runs", manual ? "only when asked" : "after every session"], ["Provider", esc(l.provider)], ["Model", esc(l.model ?? "not set")],
      ["Credentials", l.credentials ? esc(l.credentials) : manual ? `<span class="muted">none</span>` : `<span class="error-text">missing</span>`],
      ...(l.optionsError ? [["API options", `<span class="error-text">${esc(l.optionsError)}</span>`]] : []),
      ["Chunk size", `${l.chunkMinutes} min`]]));
  const f = s.foundry || {};
  const foundry = card("Foundry module", f.sockets ? pill("ok", f.sockets > 1 ? `${f.sockets} connected` : "connected") : pill("warn", "not connected"),
    rows([["World", esc(f.lastRosterWorld ?? "–")],
      ["Speakers mapped", f.speakers && f.speakers.total
        ? `${f.speakers.mapped} of ${f.speakers.total} <span class="muted">(session ${f.speakers.session})</span>` +
          (f.speakers.unmapped.length ? `<br><span class="error-text">unmapped: ${esc(f.speakers.unmapped.join(", "))}</span>` : "")
        : `<span class="muted">–</span>`],
      ["Roster users", f.rosterUsers ?? 0], ["Discord IDs in Foundry", `${f.rosterLinked ?? 0} <span class="muted">of ${f.rosterUsers ?? 0}</span>`],
      ["Last roster sync", esc(ago(f.lastRosterAt))], ["Last chat log", esc(ago(f.lastChatlogAt))],
      ...(f.headless && f.headless.mode !== "off" ? [["Headless client", headlessText(f.headless)]] : [])]));
  const p = s.process || {}, k = s.disk || {};
  const lowDisk = k.freeBytes != null && k.freeBytes < 1024 ** 3;
  const host = card("Host", lowDisk ? pill("warn", "low disk") : pill("ok", "ok"),
    rows([["Bot uptime", dur(p.uptimeSec)], ["Bot memory", bytes(p.rssBytes)], ["Node", esc(p.node)],
      ["Disk free", k.freeBytes == null ? "?" : `${bytes(k.freeBytes)} <span class="muted">of ${bytes(k.totalBytes)}</span>`],
      ["Audio", s.config?.deleteAudioAfterTranscribe ? "deleted live" : s.config?.audioRetentionDays ? `kept ${s.config.audioRetentionDays} days` : "kept forever"]]));
  $("m-components").innerHTML = discord + worker + llm + foundry + host;
}

// ---------- activity log: the bot's /logs while it runs, else the Console's copy of it
async function pollLogs() {
  clearTimeout(logTimer);
  if (!root || root.hidden || document.visibilityState === "hidden") {
    logTimer = setTimeout(pollLogs, 3000);
    return;
  }
  try {
    const r = await api("GET", `/api/logs?after=${lastSeq}`);
    if (r.online) {
      const fresh = r.entries || [];
      if (fresh.length) {
        if (fresh[0].seq <= lastSeq) logs = []; // the bot restarted: its sequence numbers start over
        logs = logs.concat(fresh).slice(-1000);
        lastSeq = fresh[fresh.length - 1].seq;
      }
      $("m-log-note").textContent = "";
    } else {
      const tail = await api("GET", "/monitor/recent-log");
      logs = (tail.lines || []).map((line, i) => ({ seq: i, t: line.slice(0, 24), level: /\b(ERROR)\b/.test(line) ? "error" : /\bWARN\b/.test(line) ? "warn" : "info", msg: line.slice(25) }));
      lastSeq = 0;
      $("m-log-note").textContent = tail.enabled ? `The bot isn't running: its last lines, from ${tail.folder}.` : "The bot isn't running and the log copy is off (--no-log-file).";
    }
    renderLogs();
  } catch {
    /* next time */
  }
  logTimer = setTimeout(pollLogs, 3000);
}

function renderLogs() {
  const level = $("m-log-level").value;
  const q = $("m-log-search").value.toLowerCase();
  const show = logs.filter((e) => (level === "all" || (level === "warn" ? e.level === "warn" || e.level === "error" : e.level === level)) &&
    (!q || e.msg.toLowerCase().includes(q)));
  const el = $("m-log");
  el.innerHTML = show.length
    ? show.map((e) => `<div class="l-${e.level}"><time>${esc(isNaN(Date.parse(e.t)) ? e.t : new Date(e.t).toLocaleTimeString())}</time>${esc(e.msg)}</div>`).join("")
    : `<span class="muted">No activity yet.</span>`;
  if ($("m-log-follow").checked) el.scrollTop = el.scrollHeight;
}

export const lastStatus = () => last;
