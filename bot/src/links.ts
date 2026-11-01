/**
 * Write `/scrib map` links into Foundry (docs/assessment/05 C11): the bot tells the module which
 * Foundry user each mapped Discord user is, and the GM's client stores it as the user's
 * "Discord ID" flag. `/scrib map` wins over a flag that differs.
 */
import type { MappingRow, RosterRow } from "./db.js";

export interface RosterLink {
  foundryUserId: string;
  /** The Discord ID to store, or null to clear the flag. */
  discordId: string | null;
  /** Clear only if the flag still holds this ID (so an unmap never removes someone else's link). */
  ifDiscordId?: string;
}

/**
 * Links needed to bring the Foundry flags in line with the mappings: mapped Foundry users whose
 * reported flag is missing or different, plus the GM if the world has exactly one GM user.
 * Free-text mappings (no Foundry user) can't be written. Names are never matched.
 */
export function linksToWrite(mappings: MappingRow[], roster: RosterRow[]): RosterLink[] {
  const byUser = new Map(roster.map((r) => [r.foundry_user_id, r]));
  const out = new Map<string, RosterLink>();
  for (const m of mappings) {
    if (!m.foundry_user_id) continue;
    const r = byUser.get(m.foundry_user_id);
    if (r && r.discord_id !== m.discord_id && !out.has(r.foundry_user_id)) {
      out.set(r.foundry_user_id, { foundryUserId: r.foundry_user_id, discordId: m.discord_id });
    }
  }
  const gms = roster.filter((r) => r.is_gm);
  const gmMappings = mappings.filter((m) => m.is_gm && !m.foundry_user_id);
  const gm = gms[0];
  if (gms.length === 1 && gmMappings.length === 1 && gm && !out.has(gm.foundry_user_id)) {
    const discordId = gmMappings[0]!.discord_id;
    const mappedElsewhere = mappings.some((m) => m.foundry_user_id === gm.foundry_user_id);
    if (gm.discord_id !== discordId && !mappedElsewhere) out.set(gm.foundry_user_id, { foundryUserId: gm.foundry_user_id, discordId });
  }
  return [...out.values()];
}

/** Clear the flag a removed or replaced mapping had written. */
export function unlink(foundryUserId: string, discordId: string): RosterLink {
  return { foundryUserId, discordId: null, ifDiscordId: discordId };
}
