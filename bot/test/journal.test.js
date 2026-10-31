// Tests the Foundry module's pure journal builder (foundry-module/scripts/journal.js).
import { describe, expect, it } from "vitest";
import { buildJournalPages, makeLinker, markdownToHtml } from "../../foundry-module/scripts/journal.js";

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
