/** Which web pages may call the bot (CORS): FOUNDRY_ORIGINS plus each campaign's Foundry server. */
import { config } from "../config.js";
import type { Store } from "../db.js";

/** "https://foundry.example.com" from any URL, or null. */
export function originOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Web origins whose pages may call the bot: FOUNDRY_ORIGINS and every campaign's Foundry server. */
export function allowedOrigins(store: Store) {
  const out = new Set<string>();
  for (const o of config.api.origins) out.add(originOf(o) ?? o);
  for (const c of store.listCampaigns()) {
    const o = c.foundry_url ? originOf(c.foundry_url) : null;
    if (o) out.add(o);
  }
  return out;
}
