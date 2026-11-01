// Tests the Foundry module's character/NPC detail extraction (foundry-module/scripts/actors.js),
// which feeds "Characters in Session" and the character details in the session write-up.
import { describe, expect, it } from "vitest";
import { actorDetails, changesDetails, hasDetails, isDetailItem, text } from "../../foundry-module/scripts/actors.js";

const item = (name, system, type = "class") => ({ name, type, system });
const blank = { race: null, gender: null, age: null, height: null, weight: null, hpMax: null };

describe("actorDetails", () => {
  it("reads a PF1 character: multiclass levels without racial hit dice, race item, bio fields, max HP", () => {
    const actor = {
      system: {
        details: { level: { value: 9 }, gender: "Female", age: "27", height: "5 ft. 4 in.", weight: "120 lbs." },
        attributes: { hp: { value: 12, max: 61 } },
      },
      items: [
        item("Half-Elf", {}, "race"),
        item("Rogue", { level: 5, subType: "base" }),
        item("Shadowdancer", { level: 4, subType: "prestige" }),
        item("Humanoid", { level: 2, subType: "racial" }),
        item("Short Sword", {}, "weapon"),
      ],
    };
    expect(actorDetails(actor)).toEqual({
      classes: [{ name: "Rogue", level: 5 }, { name: "Shadowdancer", level: 4 }],
      level: 9,
      race: "Half-Elf",
      gender: "Female",
      age: "27",
      height: "5 ft. 4 in.",
      weight: "120 lbs.",
      hpMax: 61,
    });
  });

  it("reads a PF1 NPC with class levels and no bio", () => {
    const actor = { type: "npc", system: { attributes: { hp: { max: 22 } } }, items: [item("Warrior", { level: 3, subType: "npc" })] };
    expect(actorDetails(actor)).toEqual({ ...blank, classes: [{ name: "Warrior", level: 3 }], level: 3, hpMax: 22 });
  });

  it("labels PF1 mythic tiers and keeps them out of the summed level", () => {
    const actor = { items: [item("Fighter", { level: 6, subType: "base" }), item("Champion", { level: 2, subType: "mythic" })] };
    expect(actorDetails(actor)).toMatchObject({
      classes: [{ name: "Fighter", level: 6 }, { name: "Champion (mythic tier)", level: 2 }],
      level: 6,
    });
  });

  it("reads dnd5e: class levels, race stored by item id, weight with units", () => {
    const actor = {
      system: {
        details: { level: 7, race: "abcdefghij123456", gender: "he/him", age: 140, height: "6'1\"", weight: { value: 180, units: "lb" } },
        attributes: { hp: { max: 52 } },
      },
      items: [{ id: "abcdefghij123456", ...item("Hill Dwarf", {}, "race") }, item("Wizard", { levels: 5 }), item("Cleric", { levels: 2 })],
    };
    expect(actorDetails(actor)).toEqual({
      classes: [{ name: "Wizard", level: 5 }, { name: "Cleric", level: 2 }],
      level: 7,
      race: "Hill Dwarf",
      gender: "he/him",
      age: "140",
      height: "6'1\"",
      weight: "180 lb",
      hpMax: 52,
    });
  });

  it("gives a dnd5e NPC with no race its creature type", () => {
    const actor = { type: "npc", system: { details: { type: { value: "fiend", subtype: "devil" } }, attributes: { hp: { max: 110 } } }, items: [] };
    expect(actorDetails(actor)).toMatchObject({ race: "fiend (devil)", hpMax: 110 });
  });

  it("reads pf2e: one class at the character's level, ancestry, { value } bio fields", () => {
    const actor = {
      system: {
        details: { level: { value: 4 }, gender: { value: "Male" }, age: { value: "31" }, height: { value: "" }, weight: { value: "" } },
        attributes: { hp: { max: 58 } },
      },
      items: [item("Champion", {}), item("Dwarf", {}, "ancestry")],
    };
    expect(actorDetails(actor)).toEqual({ ...blank, classes: [{ name: "Champion", level: 4 }], level: 4, race: "Dwarf", gender: "Male", age: "31", hpMax: 58 });
  });

  it("copes with an actor that has nothing on its sheet", () => {
    expect(actorDetails({ items: [] })).toEqual({ ...blank, classes: [], level: null });
    expect(actorDetails(undefined)).toEqual({ ...blank, classes: [], level: null });
  });
});

describe("text", () => {
  it("flattens sheet fields to plain text", () => {
    expect(text("  <p>Tall   and</p> thin ")).toBe("Tall and thin");
    expect(text("")).toBeNull();
    expect(text(12)).toBe("12");
    expect(text({ value: 5, units: "ft" })).toBe("5 ft");
    expect(text({ name: "Elf" })).toBe("Elf");
    expect(text(null)).toBeNull();
  });
});

describe("sync triggers", () => {
  it("sends details for characters and NPCs only", () => {
    expect(hasDetails({ type: "character" })).toBe(true);
    expect(hasDetails({ type: "npc" })).toBe(true);
    expect(hasDetails({ type: "trap" })).toBe(false);
    expect(hasDetails({ type: "basic", hasPlayerOwner: true })).toBe(true);
  });

  it("resyncs for class and race items owned by an actor", () => {
    const owned = { documentName: "Actor" };
    expect(isDetailItem({ type: "class", parent: owned })).toBe(true);
    expect(isDetailItem({ type: "race", parent: owned })).toBe(true);
    expect(isDetailItem({ type: "ancestry", parent: owned })).toBe(true);
    expect(isDetailItem({ type: "class", parent: null })).toBe(false);
    expect(isDetailItem({ type: "weapon", parent: owned })).toBe(false);
  });

  it("resyncs on name, details or max HP changes, not on damage", () => {
    expect(changesDetails({ name: "New" })).toBe(true);
    expect(changesDetails({ system: { details: { age: "30" } } })).toBe(true);
    expect(changesDetails({ system: { attributes: { hp: { max: 40 } } } })).toBe(true);
    expect(changesDetails({ system: { attributes: { hp: { value: 3 } } } })).toBe(false);
  });
});
