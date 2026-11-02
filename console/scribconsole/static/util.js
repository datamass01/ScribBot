// Shared helpers for the Console's tabs.

export const $ = (id) => document.getElementById(id);
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Calls the Console. Every change carries X-Scrib-Console, which a cross-site page can't send. */
export async function api(method, path, body) {
  const headers = { "X-Scrib-Console": "1" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, cache: "no-store", body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError((data && data.error) || `${method} ${path}: HTTP ${res.status}`, res.status, data);
  return data;
}

// ---------- formatting
export const bytes = (n) => {
  if (n == null) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};
export const dur = (sec) => {
  if (sec == null || isNaN(sec)) return "–";
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
};
export const clock = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
};
export const when = (iso) => {
  if (!iso) return "–";
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
               : d.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
export const ago = (iso) => (iso ? `${dur((Date.now() - Date.parse(iso)) / 1000)} ago` : "never");
export const pill = (cls, text, title = "") => `<span class="pill ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
export const rows = (pairs) => `<dl>${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;

// ---------- toasts
export function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("toasts").append(el);
  setTimeout(() => el.remove(), kind === "err" ? 9000 : 4500);
}

/** Runs an action, toasting its error; returns the result or null. */
export async function attempt(fn, okText) {
  try {
    const r = await fn();
    if (okText) toast(typeof okText === "function" ? okText(r) : okText, "ok");
    return r ?? true;
  } catch (err) {
    toast(err.message || String(err), "err");
    return null;
  }
}

// ---------- dialogs
/**
 * Opens the shared <dialog> with `html` (which should contain a <form>). Resolves with the
 * submit button's value and the form's data, or null when cancelled.
 */
export function openDialog(html, { wide = false, onOpen } = {}) {
  const dlg = $("dialog");
  dlg.className = wide ? "wide" : "";
  dlg.innerHTML = html;
  return new Promise((resolve) => {
    const form = dlg.querySelector("form");
    let result = null;
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      if (e.submitter?.value === "cancel") { dlg.close(); return; }
      if (!form.reportValidity()) return;
      result = { action: e.submitter?.value ?? "ok", data: Object.fromEntries(new FormData(form)) };
      dlg.close();
    });
    dlg.addEventListener("close", () => resolve(result), { once: true });
    dlg.showModal();
    onOpen?.(dlg);
  });
}

export async function confirmDialog(title, bodyHtml, { ok = "OK", danger = false } = {}) {
  const r = await openDialog(`<form><h3>${esc(title)}</h3><div>${bodyHtml}</div>
    <div class="actions"><button value="cancel" formnovalidate>Cancel</button>
    <button class="primary ${danger ? "danger" : ""}" value="ok">${esc(ok)}</button></div></form>`);
  return r?.action === "ok";
}

export function showText(title, text, note = "") {
  return openDialog(`<form><h3>${esc(title)}</h3>${note ? `<p class="muted small">${esc(note)}</p>` : ""}
    <pre>${esc(text)}</pre><div class="actions"><button class="primary" value="cancel">Close</button></div></form>`, { wide: true });
}
