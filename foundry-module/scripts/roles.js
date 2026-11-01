/**
 * Decides which Foundry client talks to ScribBot and which one writes to the world.
 * Pure functions (no Foundry globals) so they can be unit-tested.
 */

/**
 * The "bridge" is the client that holds the bot URL/token and its WebSocket.
 * With no designated bridge user, every GM connects and only the active GM acts (the
 * original behavior). With one, only that user's client connects and acts, even if it
 * belongs to a player.
 *
 * @param {{ bridgeUserId?: string|null, userId: string, isGM: boolean, activeGMId?: string|null }} p
 * @returns {{ connect: boolean, act: boolean }}
 */
export function bridgeRole({ bridgeUserId, userId, isGM, activeGMId }) {
  if (bridgeUserId) {
    const me = userId === bridgeUserId;
    return { connect: me, act: me };
  }
  return { connect: isGM, act: isGM && (activeGMId ?? userId) === userId };
}

/**
 * Where a summary journal gets created. A GM creates it directly; a player hands it to
 * the active GM's client; with no GM online, a player creates it only if Foundry lets
 * them create journal entries.
 *
 * @param {{ isGM: boolean, activeGMId?: string|null, canCreate: boolean }} p
 * @returns {"self" | "gm" | "none"}
 */
export function journalTarget({ isGM, activeGMId, canCreate }) {
  if (isGM) return "self";
  if (activeGMId) return "gm";
  return canCreate ? "self" : "none";
}

/**
 * A non-GM client may still hold whispers or blind rolls it shouldn't share. When the
 * bridge is a player, only messages everyone at the table could see are exported.
 *
 * @param {{ whisper: boolean }} message an exported chat message
 * @param {boolean} exporterIsGM
 */
export function shouldExportMessage(message, exporterIsGM) {
  return exporterIsGM || !message.whisper;
}
