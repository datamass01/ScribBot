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

/** `![alt](src)` on a line of its own. */
const IMAGE_LINE = /^\s*!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?\s*\)\s*$/;

/** An image the importer uploaded into Foundry (`images` maps the Markdown src to its path), else nothing. */
function imageHtml(alt, src, images, cls = "") {
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    // keep the raw src
  }
  const path = images?.[src] ?? images?.[decoded];
  if (typeof path !== "string" || !path) return "";
  return `<p><img${cls ? ` class="${cls}"` : ""} src="${escapeHtml(path)}" alt="${escapeHtml(alt)}" title="${escapeHtml(alt)}"></p>`;
}

/** Inline Markdown on escaped text: bold, italics, code. Inline images are dropped (only image lines render). */
function inlineMd(t) {
  return escapeHtml(String(t ?? "").replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, ""))
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>");
}

/** Cells of a Markdown table row; `\|` is a literal pipe. */
function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

/**
 * Small Markdown → HTML: paragraphs (lines joined with <br>), headings, bullet and numbered
 * lists, tables, blockquotes, horizontal rules, bold, italics and code. Headings are shifted
 * down one level (a page's own title is the <h1>). An image on a line of its own renders only
 * when `images` maps its src to a path Foundry can load. Deliberately not showdown: everything
 * is escaped first, so model output can't inject HTML.
 */
export function markdownToHtml(md, { images = {} } = {}) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const take = (test) => {
    const block = [];
    while (i < lines.length && test(lines[i])) block.push(lines[i++]);
    return block;
  };
  const isBlank = (l) => !l.trim();
  const isHeading = (l) => /^#{1,6}\s+/.test(l);
  const isRule = (l) => /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l);
  const isBullet = (l) => /^\s*[-*+]\s+/.test(l);
  const isNumbered = (l) => /^\s*\d+[.)]\s+/.test(l);
  const isTable = (l) => /^\s*\|/.test(l);
  const isQuote = (l) => /^\s*>/.test(l);
  const isImage = (l) => IMAGE_LINE.test(l);
  const startsBlock = (l) => isBlank(l) || isHeading(l) || isRule(l) || isBullet(l) || isNumbered(l) || isTable(l) || isQuote(l) || isImage(l);

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
    } else if (isImage(line)) {
      const [, alt, src] = line.match(IMAGE_LINE);
      const html = imageHtml(alt, src, images);
      if (html) out.push(html);
      i++;
    } else if (isHeading(line)) {
      const [, hashes, text] = line.match(/^(#{1,6})\s+(.*)$/);
      const level = Math.min(hashes.length + 1, 6);
      out.push(`<h${level}>${inlineMd(text.trim())}</h${level}>`);
      i++;
    } else if (isRule(line)) {
      out.push("<hr>");
      i++;
    } else if (isBullet(line)) {
      const items = take(isBullet).map((l) => `<li>${inlineMd(l.replace(/^\s*[-*+]\s+/, ""))}</li>`);
      out.push(`<ul>${items.join("")}</ul>`);
    } else if (isNumbered(line)) {
      const items = take(isNumbered).map((l) => `<li>${inlineMd(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
      out.push(`<ol>${items.join("")}</ol>`);
    } else if (isTable(line)) {
      const rows = take(isTable);
      const sep = rows.length > 1 && /^\s*\|?\s*:?-{2,}/.test(rows[1]);
      const head = sep ? `<thead><tr>${tableCells(rows[0]).map((c) => `<th>${inlineMd(c)}</th>`).join("")}</tr></thead>` : "";
      const body = (sep ? rows.slice(2) : rows).map((r) => `<tr>${tableCells(r).map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`);
      out.push(`<table>${head}<tbody>${body.join("")}</tbody></table>`);
    } else if (isQuote(line)) {
      const inner = take(isQuote).map((l) => l.replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${markdownToHtml(inner.join("\n"), { images })}</blockquote>`);
    } else {
      const para = [lines[i++]];
      while (i < lines.length && !startsBlock(lines[i])) para.push(lines[i++]);
      out.push(`<p>${para.map((l) => inlineMd(l.trim())).join("<br>")}</p>`);
    }
  }
  return out.join("\n");
}

/**
 * Splits a story write-up (summary.story.md from the summarize-session skill) into its title,
 * byline, banner images (image lines before the first section) and "## " sections. The `---`
 * that separates the story from the table notes is dropped.
 */
export function parseStory(md) {
  const text = String(md ?? "").replace(/\r\n?/g, "\n");
  const title = text.match(/^#\s+(.+)$/m)?.[1].trim() ?? "Session story";
  const parts = text.split(/^##\s+/m);
  const preamble = parts.shift() ?? "";
  const byline = preamble.match(/^\*([^*\n].*?)\*\s*$/m)?.[1].trim() ?? null;
  const banners = preamble
    .split("\n")
    .map((l) => l.match(IMAGE_LINE))
    .filter(Boolean)
    .map(([, alt, src]) => ({ alt, src }));
  const sections = parts
    .map((p) => {
      const nl = p.indexOf("\n");
      const heading = (nl < 0 ? p : p.slice(0, nl)).trim();
      const body = (nl < 0 ? "" : p.slice(nl + 1)).replace(/\n\s*(?:-{3,}|\*{3,})\s*$/, "").trim();
      return { heading, body };
    })
    .filter((s) => s.heading);
  return { title, byline, banners, sections };
}

/** Sections whose text is quotes or attributions: actor links there read badly. */
const STORY_NO_LINK = /quote/i;

/**
 * JournalEntryPage data for a story write-up: one page per "## " section, in order, with the
 * banner and byline on the first page. `file`: { markdown } as served by the bot's
 * GET /sessions/:id/story. `images` maps each image's Markdown src to the path it was uploaded
 * to in Foundry; images not in it are left out.
 */
export function buildStoryPages(file, actors = [], images = {}) {
  const { byline, banners, sections } = parseStory(file.markdown);
  const newPageLinker = makeLinker(actors);
  let sort = 0;
  return sections
    .filter((s) => s.body)
    .map((s, idx) => {
      let html = markdownToHtml(s.body, { images });
      if (!STORY_NO_LINK.test(s.heading)) html = newPageLinker()(html);
      if (idx === 0) {
        // After linking, so the byline's list of names doesn't take each actor's one link.
        const top = [
          ...banners.map((b) => imageHtml(b.alt, b.src, images, "scribbot-banner")),
          byline ? `<p><em>${inlineMd(byline)}</em></p>` : "",
        ].filter(Boolean);
        if (top.length) html = `${top.join("\n")}\n${html}`;
      }
      return page(s.heading, `<div class="scribbot-story">
${html}
</div>`, (sort += 100));
    });
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
