// Tests the Foundry module's pure journal builder (foundry-module/scripts/journal.js).
import { describe, expect, it } from "vitest";
import { buildJournalPages, buildStoryPages, makeLinker, markdownToHtml, parseStory } from "../../foundry-module/scripts/journal.js";

const actors = [
  { id: "a1", name: "Thorin", img: "thorin.png" },
  { id: "a2", name: "Grubnak the Vile", img: null },
  { id: "a3", name: "Al", img: null }, // too short to auto-link
];

const file = {
  sessionId: "s1",
  sessionNumber: 4,
  startedAt: "2026-01-01T18:00:00Z",
  participants: [
    { discordId: "1", displayName: "Alice", character: "Thorin", actorId: "a1", isGm: false },
    { discordId: "2", displayName: "Bob", character: null, actorId: null, isGm: true },
  ],
  summary: {
    title: "Blood on the Bridge",
    recap: "Thorin met **Grubnak the Vile** at the bridge.\n\nThorin <won>.",
    scenes: [{ title: "The Bridge", location: null, summary: "Thorin and Grubnak the Vile argued." }],
    combats: [],
    quotes: [{ t: "00:00:12", seconds: 12, character: "Thorin", text: "Taste my axe!", context: "facing Grubnak the Vile" }],
    characterHighlights: [{ character: "Thorin", highlights: ["Cleaved Grubnak the Vile"] }],
    npcs: [{ name: "Grubnak the Vile", description: "A goblin chief." }],
    loot: [],
    hooks: ["Who sent Grubnak the Vile?"],
  },
};

describe("journal builder", () => {
  it("links only the first mention of each actor per page", () => {
    const html = makeLinker(actors)()("Thorin hits Thorin. Al waves. Grubnak the Vile flees.");
    expect(html).toBe("@UUID[Actor.a1]{Thorin} hits Thorin. Al waves. @UUID[Actor.a2]{Grubnak the Vile} flees.");
  });

  it("never links inside tags", () => {
    const html = makeLinker(actors)()('<img alt="Thorin"> Thorin');
    expect(html).toBe('<img alt="Thorin"> @UUID[Actor.a1]{Thorin}');
  });

  it("escapes HTML in the model's Markdown", () => {
    expect(markdownToHtml("Hi **there** <script>")).toBe("<p>Hi <strong>there</strong> &lt;script&gt;</p>");
  });

  it("builds pages, skipping empty sections, with portraits on quotes", () => {
    const pages = buildJournalPages(file, null, actors);
    expect(pages.map((p) => p.name)).toEqual(["Recap", "Scenes", "Quotes", "Characters", "NPCs, Loot & Threads"]);
    const recap = pages[0].text.content;
    expect(recap).toContain("Party: @UUID[Actor.a1]{Thorin} (Alice)");
    expect(recap).toContain("@UUID[Actor.a2]{Grubnak the Vile}");
    expect(recap).toContain("&lt;won&gt;");
    const quotes = pages.find((p) => p.name === "Quotes").text.content;
    expect(quotes).toContain('<img src="thorin.png"');
    expect(quotes).not.toContain("@UUID");
    expect(pages.every((p) => p.type === "text" && p.text.format === 1)).toBe(true);
  });

  it("adds a transcript page when given one", () => {
    const transcript = { lines: [{ t: 5, isGm: true, speaker: "Bob", character: null, text: "Roll initiative." }] };
    const pages = buildJournalPages(file, transcript, actors);
    expect(pages.at(-1).name).toBe("Transcript");
    expect(pages.at(-1).text.content).toContain("<strong>GM:</strong> Roll initiative.");
  });
});

const story = `# The Eye and the Diamond

![Thorin at the bridge](banner.png)

*Session 12 + 13 · 2026-10-31 · Thorin*

## High level summary

Thorin faced **Grubnak the Vile** at the bridge.

## Characters in Session

| Character | Class(es) | Level | Player |
|---|---|---|---|
| Thorin | Fighter 5 | 5 | Alice |

## Battles

### Ambush at the Bridge
- **Foes:** goblins
- **Outcome:** Grubnak fled.

## Memorable quotes

> “Taste my axe!”
> — Thorin, [00:00:12]

## Loose threads

- Who sent <Grubnak the Vile>?

---

## At the table

- Alice was late.
`;

describe("story journal builder", () => {
  it("renders tables, blockquotes, rules and a heading followed by a list", () => {
    const html = markdownToHtml("### Fight\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | x \\| y |\n\n> “Hi”\n> — Thorin\n\n---");
    expect(html).toContain("<h4>Fight</h4>\n<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>x | y</td></tr></tbody></table>");
    expect(html).toContain("<blockquote><p>“Hi”<br>— Thorin</p></blockquote>");
    expect(html).toContain("<hr>");
  });

  it("escapes HTML inside tables and quotes", () => {
    expect(markdownToHtml("| <b>x</b> |\n|---|\n| <img onerror=1> |")).not.toMatch(/<b>|<img/);
    expect(markdownToHtml("> <script>")).toBe("<blockquote><p>&lt;script&gt;</p></blockquote>");
  });

  it("splits a story into title, byline and sections, dropping the story/table separator", () => {
    const parsed = parseStory(story);
    expect(parsed.title).toBe("The Eye and the Diamond");
    expect(parsed.byline).toBe("Session 12 + 13 · 2026-10-31 · Thorin");
    expect(parsed.banners).toEqual([{ alt: "Thorin at the bridge", src: "banner.png" }]);
    expect(parsed.sections.map((x) => x.heading)).toEqual([
      "High level summary", "Characters in Session", "Battles", "Memorable quotes", "Loose threads", "At the table",
    ]);
    expect(parsed.sections.find((x) => x.heading === "Loose threads").body).not.toContain("---");
  });

  it("puts the banner on the first page only once it was uploaded, and never renders other images", () => {
    const withImage = buildStoryPages({ markdown: story }, actors, { "banner.png": "scribbot/s1/banner.png" });
    expect(withImage[0].text.content).toContain('<img class="scribbot-banner" src="scribbot/s1/banner.png" alt="Thorin at the bridge"');
    expect(withImage[0].text.content.indexOf("<img")).toBeLessThan(withImage[0].text.content.indexOf("<em>Session"));
    const without = buildStoryPages({ markdown: story }, actors);
    expect(without[0].text.content).not.toContain("<img");
    expect(without[0].text.content).not.toContain("banner.png");
    expect(markdownToHtml("![x](http://evil.example/t.png)")).toBe("");
    expect(markdownToHtml('![a"><script>](b.png)', { images: { "b.png": "scribbot/s/b.png" } })).not.toContain("<script>");
  });

  it("builds one page per section, with the byline first and no actor links in quotes", () => {
    const pages = buildStoryPages({ markdown: story }, actors);
    expect(pages.map((p) => p.name)).toEqual([
      "High level summary", "Characters in Session", "Battles", "Memorable quotes", "Loose threads", "At the table",
    ]);
    expect(pages[0].text.content).toContain("<em>Session 12 + 13 · 2026-10-31 · Thorin</em>");
    expect(pages[0].text.content).toContain("@UUID[Actor.a2]{Grubnak the Vile}");
    expect(pages[1].text.content).toContain("<td>@UUID[Actor.a1]{Thorin}</td>");
    expect(pages[3].text.content).not.toContain("@UUID");
    expect(pages[4].text.content).toContain("&lt;@UUID[Actor.a2]{Grubnak the Vile}&gt;"); // escaped, then linked
    expect(pages[4].text.content).not.toContain("<Grubnak");
    expect(pages.every((p) => p.text.content.startsWith('<div class="scribbot-story">'))).toBe(true);
    expect(pages.map((p) => p.sort)).toEqual([100, 200, 300, 400, 500, 600]);
  });
});
