import { describe, expect, it } from "vitest";
import { buildEventStream, chunkStream, fmtTime, parseTime, renderStream, stripHtml } from "../src/summarize/format.js";
import { coverage, verifyQuotes } from "../src/summarize/quotes.js";
import type { ChatLog, Participant, Transcript, TranscriptLine } from "../src/types.js";

const participants: Participant[] = [
  { discordId: "1", displayName: "Alice", character: "Thorin", actorId: "a1", isGm: false },
  { discordId: "2", displayName: "Bob", character: null, actorId: null, isGm: true },
];

const line = (t: number, discordId: string, text: string): TranscriptLine => {
  const p = participants.find((x) => x.discordId === discordId)!;
  return { t, end: t + 2, discordId, speaker: p.displayName, character: p.character, isGm: p.isGm, text };
};

const transcript: Transcript = {
  sessionId: "s",
  model: "large-v3",
  language: "en",
  createdAt: "2026-01-01T00:00:00Z",
  lines: [
    line(5, "2", "The goblin snarls at you from the bridge."),
    line(12, "1", "Stand aside, little one, or taste my axe!"),
    line(15, "1", "I swing at it."),
    line(3700, "2", "You reach the city gates at dusk."),
  ],
};

describe("time formatting", () => {
  it("round-trips HH:MM:SS", () => {
    expect(fmtTime(3725.9)).toBe("01:02:05");
    expect(parseTime("01:02:05")).toBe(3725);
    expect(parseTime("02:05")).toBe(125);
    expect(parseTime("soon")).toBeNull();
  });
});

describe("buildEventStream", () => {
  const start = Date.parse("2026-01-01T18:00:00Z");
  const chatlog: ChatLog = {
    world: "w",
    system: null,
    messages: [
      {
        id: "m1", timestamp: start + 14_000, alias: "Thorin", actorId: "a1", userName: "Alice",
        inCharacter: false, isRoll: true, whisper: false, flavor: "Greataxe - Attack Roll", content: "",
        rolls: [{ formula: "1d20+5", total: 19, flavor: null }],
      },
      {
        id: "m2", timestamp: start + 20_000, alias: "Bob", actorId: null, userName: "Bob",
        inCharacter: false, isRoll: false, whisper: true, flavor: null, content: "secret trap", rolls: [],
      },
      {
        id: "m3", timestamp: start + 1_000, alias: "ScribBot", actorId: null, userName: "ScribBot",
        inCharacter: false, isRoll: false, whisper: false, flavor: null,
        content: '<p class="scribbot-announce"><i class="fas fa-feather-pointed"></i> ScribBot joined to record session 4.</p>', rolls: [],
      },
    ],
    combats: [
      {
        id: "c1", name: "Bridge Fight", scene: null, round: 3, startedAt: start + 10_000, endedAt: start + 60_000,
        combatants: [
          { name: "Thorin", actorId: "a1", isNPC: false, defeated: false, hidden: false },
          { name: "Goblin", actorId: null, isNPC: true, defeated: true, hidden: false },
        ],
      },
    ],
  };

  it("labels speakers by character and merges Foundry events in time order", () => {
    const text = renderStream(buildEventStream(transcript, chatlog, start, participants));
    const lines = text.split("\n");
    expect(lines[0]).toBe("[00:00:05] GM (Bob): The goblin snarls at you from the bridge.");
    expect(lines[1]).toContain("[FOUNDRY COMBAT START] Bridge Fight. Party: Thorin. Opponents: Goblin.");
    expect(lines[2]).toBe("[00:00:12] Thorin (Alice): Stand aside, little one, or taste my axe!");
    expect(text).toContain("[00:00:14] [FOUNDRY ROLL] Thorin: Greataxe - Attack Roll (1d20+5 = 19)");
    expect(text).toContain("after 3 round(s). Defeated: Goblin.");
    expect(text).not.toContain("secret trap"); // whispers are excluded
    expect(text).not.toContain("ScribBot joined"); // its own join/leave notices too
  });

  it("chunks by elapsed time", () => {
    const chunks = chunkStream(buildEventStream(transcript, null, start, participants), 25);
    expect(chunks.map((c) => c.length)).toEqual([3, 1]);
  });
});

describe("stripHtml", () => {
  it("removes tags and decodes entities", () => {
    expect(stripHtml("<p>Hello&nbsp;<b>there</b></p><p>Tom &amp; Jerry</p>")).toBe("Hello there\nTom & Jerry");
  });
});

describe("quote verification", () => {
  it("scores in-order word coverage", () => {
    expect(coverage("taste my axe", "Stand aside, or taste my axe!")).toBe(1);
    expect(coverage("axe my taste", "taste my axe")).toBeLessThan(1);
  });

  it("keeps real quotes (even lightly cleaned) and drops invented ones", () => {
    const { kept, dropped } = verifyQuotes(
      [
        { t: "00:00:12", character: "Thorin", text: "Stand aside, little one, or taste my axe!", context: "" },
        { t: "00:00:12", character: "Thorin", text: "Stand aside little one or taste my axe", context: "" },
        { t: "00:00:13", character: "Thorin", text: "Stand aside, or taste my axe! I swing at it.", context: "" },
        { t: "00:00:40", character: "Thorin", text: "For the mountain king and all his halls!", context: "" },
      ],
      transcript.lines,
    );
    expect(kept).toHaveLength(3);
    expect(kept[2]!.seconds).toBe(12); // spans two consecutive lines
    expect(dropped.map((d) => d.text)).toEqual(["For the mountain king and all his halls!"]);
  });
});
