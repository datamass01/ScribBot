// `/scrib map` links written into Foundry (docs/assessment/05 C11): which links the bot sends.
// The module side (which flags to change) is in roles.test.js.
import { describe, expect, it } from "vitest";
import type { MappingRow, RosterRow } from "../src/db.js";
import { linksToWrite } from "../src/links.js";

const mapping = (discordId: string, over: Partial<MappingRow> = {}): MappingRow => ({
  guild_id: "g", discord_id: discordId, foundry_user_id: null, actor_id: null, character_name: null, is_gm: 0, ...over,
});
const user = (id: string, over: Partial<RosterRow> = {}): RosterRow => ({
  foundry_user_id: id, user_name: id, is_gm: 0, actor_id: null, actor_name: null, actor_img: null, discord_id: null, ...over,
});

describe("linksToWrite (bot)", () => {
  it("links mapped Foundry users whose flag is missing or different, and nothing else", () => {
    const mappings = [
      mapping("111111", { foundry_user_id: "fu1", character_name: "Thorin" }), // flag missing
      mapping("222222", { foundry_user_id: "fu2" }), // flag already right
      mapping("333333", { foundry_user_id: "fu3" }), // flag holds someone else: /scrib map wins
      mapping("444444", { character_name: "Elara" }), // free text: can't be written
      mapping("555555", { foundry_user_id: "gone" }), // not in the roster
    ];
    const roster = [user("fu1"), user("fu2", { discord_id: "222222" }), user("fu3", { discord_id: "999999" }), user("fu4")];
    expect(linksToWrite(mappings, roster)).toEqual([
      { foundryUserId: "fu1", discordId: "111111" },
      { foundryUserId: "fu3", discordId: "333333" },
    ]);
  });

  it("links the /scrib gm user only when the world has exactly one GM", () => {
    const gm = mapping("777777", { is_gm: 1 });
    expect(linksToWrite([gm], [user("gm1", { is_gm: 1 }), user("p1")])).toEqual([{ foundryUserId: "gm1", discordId: "777777" }]);
    expect(linksToWrite([gm], [user("gm1", { is_gm: 1 }), user("gm2", { is_gm: 1 })])).toEqual([]);
    expect(linksToWrite([gm], [user("gm1", { is_gm: 1, discord_id: "777777" })])).toEqual([]);
  });
});
