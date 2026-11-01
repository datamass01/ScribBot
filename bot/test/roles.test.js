// Tests the Foundry module's role logic (foundry-module/scripts/roles.js): who connects to
// the bot, who acts on its events, and where the journal entry gets created.
import { describe, expect, it } from "vitest";
import { bridgeRole, journalTarget, planDiscordLinks, shouldExportMessage } from "../../foundry-module/scripts/roles.js";

describe("bridgeRole", () => {
  describe("with no bridge user (default)", () => {
    it("connects every GM but only the active GM acts", () => {
      expect(bridgeRole({ bridgeUserId: null, userId: "gm1", isGM: true, activeGMId: "gm1" })).toEqual({ connect: true, act: true });
      expect(bridgeRole({ bridgeUserId: null, userId: "gm2", isGM: true, activeGMId: "gm1" })).toEqual({ connect: true, act: false });
    });

    it("never connects a player", () => {
      expect(bridgeRole({ bridgeUserId: "", userId: "p1", isGM: false, activeGMId: "gm1" })).toEqual({ connect: false, act: false });
    });

    it("lets a GM act when Foundry reports no active GM yet", () => {
      expect(bridgeRole({ bridgeUserId: null, userId: "gm1", isGM: true, activeGMId: null })).toEqual({ connect: true, act: true });
    });
  });

  describe("with a bridge user", () => {
    it("connects and acts only on that user's client, even a player's", () => {
      expect(bridgeRole({ bridgeUserId: "p1", userId: "p1", isGM: false, activeGMId: "gm1" })).toEqual({ connect: true, act: true });
    });

    it("keeps the GMs and other players off the bot", () => {
      expect(bridgeRole({ bridgeUserId: "p1", userId: "gm1", isGM: true, activeGMId: "gm1" })).toEqual({ connect: false, act: false });
      expect(bridgeRole({ bridgeUserId: "p1", userId: "p2", isGM: false, activeGMId: "gm1" })).toEqual({ connect: false, act: false });
    });
  });
});

describe("journalTarget", () => {
  it("has a GM create the journal directly", () => {
    expect(journalTarget({ isGM: true, activeGMId: "gm1", canCreate: true })).toBe("self");
    expect(journalTarget({ isGM: true, activeGMId: null, canCreate: true })).toBe("self");
  });

  it("hands a player's import to the active GM, even if the player could create it", () => {
    expect(journalTarget({ isGM: false, activeGMId: "gm1", canCreate: true })).toBe("gm");
    expect(journalTarget({ isGM: false, activeGMId: "gm1", canCreate: false })).toBe("gm");
  });

  it("falls back to the player when no GM is online, if Foundry allows it", () => {
    expect(journalTarget({ isGM: false, activeGMId: null, canCreate: true })).toBe("self");
    expect(journalTarget({ isGM: false, activeGMId: null, canCreate: false })).toBe("none");
  });
});

describe("shouldExportMessage", () => {
  it("exports everything from a GM", () => {
    expect(shouldExportMessage({ whisper: true }, true)).toBe(true);
    expect(shouldExportMessage({ whisper: false }, true)).toBe(true);
  });

  it("drops whispers and blind rolls when a player exports", () => {
    expect(shouldExportMessage({ whisper: true }, false)).toBe(false);
    expect(shouldExportMessage({ whisper: false }, false)).toBe(true);
  });
});

// roster.link from the bot (docs/assessment/05 C11): which "Discord ID" flags the GM's client changes.
describe("planDiscordLinks (module)", () => {
  const users = [
    { id: "fu1", discordId: null },
    { id: "fu2", discordId: "222222" },
    { id: "fu3", discordId: "999999" },
  ];

  it("sets missing or different flags and skips ones already right", () => {
    expect(
      planDiscordLinks(
        [
          { foundryUserId: "fu1", discordId: "111111" },
          { foundryUserId: "fu2", discordId: "222222" },
          { foundryUserId: "fu3", discordId: "333333" },
        ],
        users,
      ),
    ).toEqual([
      { userId: "fu1", discordId: "111111", previous: null },
      { userId: "fu3", discordId: "333333", previous: "999999" },
    ]);
  });

  it("clears a flag only if it still holds the unmapped Discord ID", () => {
    expect(planDiscordLinks([{ foundryUserId: "fu2", discordId: null, ifDiscordId: "222222" }], users)).toEqual([{ userId: "fu2", discordId: null, previous: "222222" }]);
    expect(planDiscordLinks([{ foundryUserId: "fu3", discordId: null, ifDiscordId: "222222" }], users)).toEqual([]);
    expect(planDiscordLinks([{ foundryUserId: "fu1", discordId: null, ifDiscordId: "222222" }], users)).toEqual([]);
  });

  it("ignores unknown users and malformed entries", () => {
    expect(
      planDiscordLinks(
        [{ foundryUserId: "nobody", discordId: "111111" }, { foundryUserId: "fu1", discordId: "<script>" }, null, { discordId: "1" }],
        users,
      ),
    ).toEqual([]);
    expect(planDiscordLinks("nope", users)).toEqual([]);
  });
});
