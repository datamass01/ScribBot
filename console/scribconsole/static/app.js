// The Console shell: tabs, the shared /status poll and the health pills in the header.
// Polling stops while the page is hidden, so an idle tab costs the bot nothing.
import { $, api, pill } from "./util.js";
import * as sessions from "./sessions.js";
import * as monitoring from "./monitoring.js";
import * as configuration from "./config.js";

const TABS = { sessions, monitoring, configuration };
const POLL_MS = 3000;
let current = null;
let timer = null;
let status = null;

function showTab(name) {
  if (!TABS[name]) name = "sessions";
  for (const [key, mod] of Object.entries(TABS)) {
    const active = key === name;
    $(`tab-${key}`).hidden = !active;
    document.querySelector(`[data-tab="${key}"]`).setAttribute("aria-selected", String(active));
    if (active && current !== key) mod.show($(`tab-${key}`), status);
  }
  if (current && current !== name) TABS[current].hide?.();
  current = name;
}

function renderHealth(s) {
  const online = s.monitor?.bot === "online";
  const w = s.worker || {};
  const f = s.foundry || {};
  const rec = (s.recordings || []).length;
  const parts = [
    online ? (s.discord?.ready === false ? pill("warn", "bot: not in Discord") : pill("ok", "bot")) : pill("err", "bot offline"),
    w.reachable ? (w.paused ? pill("warn", "worker paused") : pill("ok", w.queued ? `worker · ${w.queued} queued` : "worker")) : pill("err", "worker offline"),
    online ? (f.sockets ? pill("ok", "foundry") : pill("warn", "foundry not connected")) : "",
    rec ? pill("err", rec > 1 ? `${rec} recording` : "recording") : "",
  ];
  $("health").innerHTML = parts.join("");
  const alerts = (s.warnings || []).length;
  $("alert-count").hidden = !alerts;
  $("alert-count").textContent = alerts;
  const pending = Object.keys(s.console?.pendingRestart || {}).length;
  $("config-badge").hidden = !pending;
  $("config-badge").textContent = "restart";
}

async function poll() {
  clearTimeout(timer);
  if (document.visibilityState === "hidden") return;
  try {
    status = await api("GET", "/status");
    renderHealth(status);
    TABS[current]?.update?.(status);
  } catch {
    $("health").innerHTML = pill("err", "Console not answering");
  }
  timer = setTimeout(poll, POLL_MS);
}

window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") poll();
  else clearTimeout(timer);
});

showTab(location.hash.slice(1) || "sessions");
poll();
