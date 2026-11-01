import path from "node:path";
import { config } from "../config.js";
import { HeadlessFoundry } from "./client.js";
import { playwrightLauncher } from "./playwright.js";

/** The bot's headless Foundry client, configured from .env (FOUNDRY_HEADLESS=off makes it a no-op). */
export function createHeadlessFoundry() {
  const f = config.foundry;
  return new HeadlessFoundry({
    mode: f.headless,
    url: f.url,
    user: f.user,
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
