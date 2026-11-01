// Details of a character or NPC actor, sent with the roster sync and saved per session so
// session write-ups know each character's class(es), level, race, gender, age, build and
// toughness. Pure (no Foundry globals), so it is unit-tested from bot/test. Works across systems:
//   pf1:   class items with system.level and system.subType (racial HD are left out);
//          total level in system.details.level.value; race item; details.gender/age/height/weight
//   dnd5e: class items with system.levels; total level in system.details.level;
//          race/species item or details.race; details.gender/age/height/weight
//   pf2e:  one class item without levels; level in system.details.level.value; ancestry item;
//          details.gender/age/height/weight as { value }
//   other: any item of type "class" with a numeric level/levels, and whatever of the above exists
// Max hit points come from system.attributes.hp.max in all three.

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A sheet field as plain text: strings, numbers, { value, units } and { name } objects; null when empty. */
export function text(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "string") {
    const s = v.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return s || null;
  }
  if (typeof v === "object") {
    if ("name" in v && typeof v.name === "string") return text(v.name);
    if ("value" in v) {
      const value = text(v.value);
      const units = typeof v.units === "string" ? v.units.trim() : "";
      return value && units ? `${value} ${units}` : value;
    }
  }
  return null;
}

const RACE_TYPES = new Set(["race", "species", "ancestry"]);

function raceOf(actor, items) {
  const item = items.find((i) => RACE_TYPES.has(i?.type));
  if (item?.name) return text(item.name);
  for (const v of [actor?.race, actor?.ancestry, actor?.system?.details?.race, actor?.system?.details?.species]) {
    if (typeof v === "string") {
      // dnd5e can store the race item's id here.
      const byId = items.find((i) => i?.id === v || i?._id === v);
      if (byId?.name) return text(byId.name);
      if (/^[A-Za-z0-9]{16}$/.test(v)) continue;
    }
    const t = text(v);
    if (t) return t;
  }
  // An NPC with no race: its creature type (dnd5e) is the nearest thing.
  const type = actor?.system?.details?.type;
  return text(type?.subtype) ? `${text(type.value) ?? ""} (${text(type.subtype)})`.trim() : text(type?.value);
}

/**
 * @returns {{ classes: { name: string, level: number | null }[], level: number | null,
 *   race: string | null, gender: string | null, age: string | null, height: string | null,
 *   weight: string | null, hpMax: number | null }}
 */
export function actorDetails(actor) {
  const items = [...(actor?.items ?? [])];
  const classItems = items.filter((i) => i?.type === "class" && i.system?.subType !== "racial");
  const classes = classItems.map((i) => ({
    name: String(i.name ?? "").trim(),
    level: num(i.system?.level) ?? num(i.system?.levels),
    mythic: i.system?.subType === "mythic",
  })).filter((c) => c.name);

  const sys = actor?.system?.details?.level;
  const summed = classes.filter((c) => !c.mythic && c.level !== null).reduce((n, c) => n + c.level, 0);
  const level = num(sys?.value) ?? num(sys) ?? num(actor?.level) ?? (summed || null);
  // A single class without its own level (pf2e) takes the character's level.
  if (classes.length === 1 && classes[0].level === null && !classes[0].mythic) classes[0].level = level;

  const d = actor?.system?.details ?? {};
  const hp = actor?.system?.attributes?.hp;
  return {
    classes: classes.map((c) => ({ name: c.mythic ? `${c.name} (mythic tier)` : c.name, level: c.level })),
    level,
    race: raceOf(actor, items),
    gender: text(d.gender) ?? text(d.sex),
    age: text(d.age),
    height: text(d.height),
    weight: text(d.weight),
    hpMax: num(hp?.max) ?? (typeof hp?.max === "string" && hp.max.trim() ? num(Number(hp.max)) : null),
  };
}

/** Actors whose details are worth sending: player characters and NPCs, not traps, vehicles or loot. */
export function hasDetails(actor) {
  return actor?.type === "character" || actor?.type === "npc" || Boolean(actor?.hasPlayerOwner);
}

/** Does this item change affect an actor's class, level or race (so the roster needs a resync)? */
export function isDetailItem(item) {
  return (item?.type === "class" || RACE_TYPES.has(item?.type)) && item.parent?.documentName === "Actor";
}

/** Does this actor update touch a synced detail (name, level, race, gender, age, height, weight, max HP)? */
export function changesDetails(changes) {
  return Boolean(changes) && ("name" in changes || changes.system?.details !== undefined || changes.system?.attributes?.hp?.max !== undefined);
}
