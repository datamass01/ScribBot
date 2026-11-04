import path from "node:path";
import { config } from "../config.js";
import { UNASSIGNED_FOLDER, campaignName, type Store } from "../db.js";
import { HeadlessFoundry, type FoundryTarget } from "./client.js";
import { playwrightLauncher } from "./playwright.js";
import { foundryBaseUrl } from "./url.js";

/**
 * Where ScribBot joins Foundry: the Foundry server set for the campaign being played (the Campaign
 * tab). A campaign without an address joins nothing: its address never falls back to .env, so one
 * campaign's server is never used for another. The user and password fall back to FOUNDRY_USER and
 * FOUNDRY_PASSWORD. FOUNDRY_URL is used only while no campaign is being played (none known yet).
 */
export function foundryTarget(store: Store): FoundryTarget {
  const f = config.foundry;
  const c = store.defaultCampaign({ create: false });
  const own = c && c.folder !== UNASSIGNED_FOLDER ? c : null;
  const url = own ? own.foundry_url : f.url;
  return {
    url: url ? foundryBaseUrl(url) : url,
    user: own?.foundry_user || f.user,
    password: own?.foundry_password || f.password,
    campaignId: own?.id ?? null,
    campaign: own ? campaignName(own) : null,
    world: own?.world_id ?? null,
  };
}

/** The bot's headless Foundry client, configured from .env and the campaign being played (FOUNDRY_HEADLESS=off makes it a no-op). */
export function createHeadlessFoundry(store: Store) {
  const f = config.foundry;
  return new HeadlessFoundry({
    mode: f.headless,
    url: f.url,
    user: f.user,
    target: () => foundryTarget(store),
    // A journal goes only into its own campaign's world; sessions of a campaign without a known world go anywhere.
    belongs: (sessionId, world) => {
      const s = store.getSession(sessionId);
      const expected = s?.campaign_id == null ? null : (store.getCampaign(s.campaign_id)?.world_id ?? null);
      return !expected || !world || expected === world;
    },
    chatlogWaitMs: f.chatlogWaitMs,
    announce: f.announce,
    stateFile: path.join(config.dataDir, "foundry-headless.json"),
    launch: playwrightLauncher({
      url: f.url,
      user: f.user,
      password: f.password,
      browser: f.browser,
      botUrl: f.botUrl,
      apiToken: config.api.token,
    }),
  });
}
