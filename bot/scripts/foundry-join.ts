/**
 * Joins Foundry once as the headless bridge user and reports what happened, using the same
 * settings as the bot: the Foundry server of the campaign being played (the Console's Campaign
 * tab), else FOUNDRY_URL, FOUNDRY_USER and FOUNDRY_PASSWORD; FOUNDRY_BROWSER, FOUNDRY_BOT_URL.
 *
 *   npm run foundry                 # join, print status, log out
 *   npm run foundry -- --stay       # stay joined until Ctrl+C (status every 30 s)
 *   npm run foundry -- --headed     # show the browser window
 *
 * The bot's API must be running for the module's connection check to pass. Don't run this
 * while the bot itself is joined: Foundry allows one login per user.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "../src/config.js";
import { Store } from "../src/db.js";
import { JoinError } from "../src/foundry/client.js";
import { foundryTarget } from "../src/foundry/index.js";
import { playwrightLauncher } from "../src/foundry/playwright.js";

const args = new Set(process.argv.slice(2));
const f = config.foundry;
const log = (m: string) => console.log(`[foundry] ${m}`);
const target = foundryTarget(new Store());
if (!target.url) {
  console.error(`[foundry] ${target.campaign ?? "The campaign being played"} has no Foundry address. Set it in the Console's Campaign tab.`);
  process.exit(1);
}

log(`joining ${target.url} as ${target.user}${target.campaign ? ` for ${target.campaign}` : ""} with ${f.browser}; the module will use ${f.botUrl}`);
const t0 = Date.now();
const launch = playwrightLauncher({
  url: target.url,
  user: target.user,
  password: target.password ?? f.password,
  browser: f.browser,
  botUrl: f.botUrl,
  apiToken: config.api.token,
  headed: args.has("--headed"),
  log,
});

let page;
try {
  page = await launch();
} catch (err) {
  const kind = err instanceof JoinError ? ` (${err.kind})` : "";
  console.error(`[foundry] could not join${kind}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
log(`joined in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(await page.status());

if (args.has("--stay")) {
  let closed = false;
  page.onClosed((reason) => {
    log(`session ended: ${reason}`);
    closed = true;
  });
  const quit = async () => {
    await page.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void quit());
  process.on("SIGBREAK", () => void quit());
  log("staying joined; Ctrl+C to log out");
  while (!closed) {
    await sleep(30_000);
    if (!closed) console.log(new Date().toLocaleTimeString(), await page.status());
  }
  process.exit(1);
}
await page.close();
log("logged out");
