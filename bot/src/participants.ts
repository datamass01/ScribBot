import type { MappingRow, RosterRow } from "./db.js";
import type { Participant } from "./types.js";

/**
 * Work out who a Discord user is in Foundry. Precedence:
 * 1. an explicit /scrib map (character name or actor) for this guild
 * 2. the Foundry user they are mapped to, and that user's assigned character
 * 3. a Foundry user whose "Discord ID" flag matches them
 * 4. nothing: they appear under their Discord display name
 */
export function resolveParticipant(
  discordId: string,
  displayName: string,
  mappings: MappingRow[],
  roster: RosterRow[],
): Participant {
  const mapping = mappings.find((m) => m.discord_id === discordId);
  const rosterUser =
    (mapping?.foundry_user_id && roster.find((r) => r.foundry_user_id === mapping.foundry_user_id)) ||
    roster.find((r) => r.discord_id === discordId);

  const isGm = Boolean(mapping?.is_gm) || Boolean(rosterUser?.is_gm);
  const character = mapping?.character_name ?? rosterUser?.actor_name ?? null;
  const actorId = mapping?.actor_id ?? rosterUser?.actor_id ?? null;

  return {
    discordId,
    displayName,
    character: isGm && !mapping?.character_name ? null : character,
    actorId: isGm && !mapping?.actor_id ? null : actorId,
    isGm,
  };
}

/** "Character (Player)", "GM (Player)" or just "Player". */
export function speakerLabel(p: Pick<Participant, "displayName" | "character" | "isGm">) {
  if (p.isGm) return `GM (${p.displayName})`;
  return p.character ? `${p.character} (${p.displayName})` : p.displayName;
}
