/**
 * Turns ScribBot's summary.json into JournalEntryPage data.
 * Pure functions with no Foundry globals,
 * so they can be unit-tested outside Foundry.
 */

const HTML_FORMAT = 1; // CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/**
 * Minimal Markdown → HTML for the recap (paragraphs, headings, lists, bold, italics).
 * Deliberately not showdown: everything is escaped first, so model output can't inject HTML.
 */
export function markdownToHtml(md) {
  const inline = (t) =>
    escapeHtml(t)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>");
  return String(md ?? "")
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.trim().split("\n");
      if (!lines[0]) return "";
      const heading = lines[0].match(/^(#{1,6})\s+(.*)$/);
      if (heading && lines.length === 1) return `<h${heading[1].length + 1}>${inline(heading[2])}</h${heading[1].length + 1}>`;
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
      }
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .join("\n");
}

/**
 * Link the first mention of each known actor on a page: "Thorin" → @UUID[Actor.x]{Thorin}.
 * Works on already-escaped text, outside of tags.
 */
export function makeLinker(actors) {
  const byName = new Map();
  for (const a of actors) if (a?.name && a.name.length > 2 && !byName.has(a.name)) byName.set(a.name, a.id);
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  if (!names.length) return () => (html) => html;
  const pattern = new RegExp(`(?<![\\w@{])(${names.map((n) => escapeHtml(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w}])`, "g");

  return () => {
    const linked = new Set(); // per page
    return (html) =>
      html
        .split(/(<[^>]+>)/)
        .map((part) =>
          part.startsWith("<")
            ? part
            : part.replace(pattern, (match) => {
                const name = match.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
                if (linked.has(name) || !byName.has(name)) return match;
                linked.add(name);
                return `@UUID[Actor.${byName.get(name)}]{${match}}`;
              }),
        )
        .join("");
  };
}

const list = (items) => (items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : "");

function page(name, html, sort) {
  return { name, type: "text", sort, text: { format: HTML_FORMAT, content: html } };
}

export function buildJournalPages(file, transcript, actors = []) {
  const s = file.summary;
  const newPageLinker = makeLinker(actors);
  const actorByName = new Map(actors.map((a) => [a.name, a]));
  const pages = [];
  let sort = 0;
  const add = (name, html, { link = true } = {}) => {
    if (!html) return;
    pages.push(page(name, link ? newPageLinker()(html) : html, (sort += 100)));
  };

  const date = new Date(file.startedAt).toLocaleDateString(undefined, { dateStyle: "long" });
  const cast = file.participants
    .filter((p) => !p.isGm)
    .map((p) => (p.character ? `${escapeHtml(p.character)} (${escapeHtml(p.displayName)})` : escapeHtml(p.displayName)))
    .join(", ");
  add(
    "Recap",
    `<p><em>${escapeHtml(date)}${cast ? `. Party: ${cast}` : ""}</em></p>\n${markdownToHtml(s.recap)}`,
  );

  add(
    "Scenes",
    s.scenes
      .map((sc) => `<h2>${escapeHtml(sc.title)}</h2>${sc.location ? `<p><em>${escapeHtml(sc.location)}</em></p>` : ""}<p>${escapeHtml(sc.summary)}</p>`)
      .join("\n"),
  );

  add(
    "Combats",
    s.combats
      .map(
        (c) => `<h2>${escapeHtml(c.name)}</h2>
${c.location ? `<p><em>${escapeHtml(c.location)}</em></p>` : ""}
<p><strong>Party:</strong> ${escapeHtml(c.participants.join(", "))}<br>
<strong>Enemies:</strong> ${escapeHtml(c.enemies.join(", "))}${c.rounds != null ? `<br><strong>Rounds:</strong> ${c.rounds}` : ""}</p>
${list(c.keyMoments.map(escapeHtml))}
<p><strong>Outcome:</strong> ${escapeHtml(c.outcome)}</p>`,
      )
      .join("\n"),
  );

  add(
    "Quotes",
    s.quotes
      .map((q) => {
        const img = actorByName.get(q.character)?.img;
        return `<div class="scribbot-quote">${img ? `<img src="${escapeHtml(img)}" alt="">` : ""}<blockquote><p>“${escapeHtml(q.text)}”</p><cite>— ${escapeHtml(q.character)}, ${escapeHtml(q.context)} <span class="ts">[${fmtTime(q.seconds ?? 0)}]</span></cite></blockquote></div>`;
      })
      .join("\n"),
    { link: false }, // UUID links inside quote attributions read badly
  );

  add(
    "Characters",
    s.characterHighlights.map((c) => `<h3>${escapeHtml(c.character)}</h3>${list(c.highlights.map(escapeHtml))}`).join("\n"),
  );

  const extras = [];
  if (s.npcs.length) extras.push(`<h2>NPCs</h2>${list(s.npcs.map((n) => `<strong>${escapeHtml(n.name)}</strong>: ${escapeHtml(n.description)}`))}`);
  if (s.loot.length) extras.push(`<h2>Loot</h2>${list(s.loot.map((l) => `${escapeHtml(l.item)}${l.recipient ? ` → ${escapeHtml(l.recipient)}` : ""}`))}`);
  if (s.hooks.length) extras.push(`<h2>Open Threads</h2>${list(s.hooks.map(escapeHtml))}`);
  add("NPCs, Loot & Threads", extras.join("\n"));

  if (transcript?.lines?.length) {
    const label = (l) => (l.isGm ? "GM" : (l.character ?? l.speaker));
    const body = transcript.lines
      .map((l) => `<p><span class="ts">[${fmtTime(l.t)}]</span> <strong>${escapeHtml(label(l))}:</strong> ${escapeHtml(l.text)}</p>`)
      .join("\n");
    add("Transcript", `<div class="scribbot-transcript">${body}</div>`, { link: false });
  }

  return pages;
}
