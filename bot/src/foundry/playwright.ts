import { type FoundryLauncher, type FoundryPage, type ImportResult, JoinError, type PageStatus } from "./client.js";

/**
 * Joins a Foundry world in a headless Chromium-family browser driven by playwright-core,
 * logged in as the module's bridge user. playwright-core is an optional dependency: it is
 * imported only when FOUNDRY_HEADLESS is on, so the bot runs without it.
 */

const MODULE = "scribbot-bridge";

export interface LaunchOptions {
  /** Foundry's base URL, e.g. http://localhost:30000 */
  url: string;
  user: string;
  password: string;
  /** msedge | chrome | chromium, or a path to the browser executable. */
  browser: string;
  /** The bot's API as the browser reaches it; written to the module's client settings. */
  botUrl: string;
  apiToken: string;
  log?: (msg: string) => void;
  /** Show the browser window (debugging). */
  headed?: boolean;
}

/** Where Foundry sent us when we asked for /join. */
export function classifyLanding(url: string): "join" | "game" | "setup" | "other" {
  let p: string;
  try {
    p = new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return "other";
  }
  if (/\/join$/.test(p)) return "join";
  if (/\/game$/.test(p)) return "game";
  // No world launched: Foundry shows its setup screen, or the admin login in front of it.
  if (/\/(setup|auth|license|players)$/.test(p)) return "setup";
  return "other";
}

/** A normal desktop user agent: Foundry's browser check doesn't know "HeadlessChrome". */
export function desktopUserAgent(browserVersion: string, platform: NodeJS.Platform = process.platform) {
  const major = /^(\d+)/.exec(browserVersion)?.[1] ?? "130";
  const os =
    platform === "win32" ? "Windows NT 10.0; Win64; x64" : platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Picks the join dropdown entry for `user` by name (case-insensitive). */
export function pickUser(options: { value: string; label: string; disabled: boolean }[], user: string) {
  const want = user.trim().toLowerCase();
  const match = options.find((o) => o.value && o.label.trim().toLowerCase() === want);
  if (!match) {
    const names = options.filter((o) => o.value).map((o) => o.label.trim());
    throw new JoinError("no-such-user", `Foundry has no user named "${user}" (users: ${names.join(", ") || "none"}). Create it, or set FOUNDRY_USER.`);
  }
  // Foundry disables the entries of users who are already logged in.
  if (match.disabled) throw new JoinError("user-busy", `"${user}" is already logged in to Foundry somewhere else.`);
  return match.value;
}

/** Browser flags: a page served from the LAN or internet must still reach the bot on loopback. */
const BROWSER_ARGS = [
  "--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks",
  "--mute-audio",
  "--autoplay-policy=user-gesture-required",
];

type PW = typeof import("playwright-core");

async function loadPlaywright(): Promise<PW> {
  try {
    return await import("playwright-core");
  } catch {
    throw new JoinError("not-installed", "playwright-core isn't installed. Run `npm install` in bot/ (it is an optional dependency).");
  }
}

export function playwrightLauncher(opts: LaunchOptions): FoundryLauncher {
  const log = opts.log ?? ((m: string) => console.log(`[foundry] ${m}`));
  return async () => {
    const { chromium } = await loadPlaywright();
    const isPath = /[\\/]/.test(opts.browser);
    let browser;
    try {
      browser = await chromium.launch({
        headless: !opts.headed,
        args: BROWSER_ARGS,
        ...(isPath ? { executablePath: opts.browser } : opts.browser === "chromium" ? {} : { channel: opts.browser }),
      });
    } catch (err) {
      const hint =
        opts.browser === "chromium"
          ? "Run `npx playwright-core install chromium` in bot/, or set FOUNDRY_BROWSER=msedge or chrome."
          : `Is ${opts.browser} installed? Set FOUNDRY_BROWSER to msedge, chrome, chromium or a browser path.`;
      throw new JoinError("not-installed", `could not start the browser (${firstLine(err)}). ${hint}`);
    }
    try {
      return await joinWorld(browser, opts, log);
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  };
}

type Browser = Awaited<ReturnType<PW["chromium"]["launch"]>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

async function joinWorld(browser: Browser, opts: LaunchOptions, log: (msg: string) => void): Promise<FoundryPage> {
  const context = await browser.newContext({
    userAgent: desktopUserAgent(browser.version()),
    viewport: { width: 1280, height: 800 },
  });
  // No canvas: the bridge only needs game data, and WebGL in a headless browser burns CPU.
  // Client settings live in localStorage; this runs before Foundry's scripts on every load.
  await context.addInitScript(() => {
    try {
      localStorage.setItem("core.noCanvas", "true");
    } catch {
      // storage blocked: checked again after load
    }
  });
  const page = await context.newPage();
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.startsWith("ScribBot |")) log(`module: ${text.slice(10).trim()}`);
    else if (msg.type() === "error" && /scribbot/i.test(text)) log(`module error: ${text}`);
  });
  page.on("dialog", (d) => void d.dismiss().catch(() => {}));

  await login(page, opts);
  await waitReady(page);

  // Turn the canvas off for good if the early localStorage write didn't take.
  const reload = await page
    .evaluate(async () => {
      const g = (globalThis as any).game;
      try {
        if (g.settings.get("core", "noCanvas")) return false;
        await g.settings.set("core", "noCanvas", true);
        return true;
      } catch {
        return false;
      }
    })
    .catch(() => false);
  if (reload) {
    log("disabled the game canvas for this user; reloading");
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitReady(page);
  }

  await configureModule(page, opts);
  await waitFor(page, async () => (await readStatus(page))?.botSocket === true, 30_000).catch(() => {
    throw new JoinError(
      "module",
      `joined Foundry, but the module couldn't connect to the bot at ${opts.botUrl}. ` +
        `Check FOUNDRY_BOT_URL, API_TOKEN, and that FOUNDRY_ORIGINS includes ${new URL(opts.url).origin}.`,
    );
  });

  let closedFn: ((reason: string) => void) | null = null;
  let closed = false;
  const fireClosed = (reason: string) => {
    if (closed) return;
    closed = true;
    closedFn?.(reason);
  };
  browser.on("disconnected", () => fireClosed("the browser exited"));
  page.on("crash", () => fireClosed("the page crashed"));
  page.on("close", () => fireClosed("the page closed"));
  // Foundry sends a kicked or logged-out client back to /join.
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && classifyLanding(frame.url()) !== "game") fireClosed(`Foundry navigated to ${frame.url()}`);
  });

  return {
    status: () => readStatus(page),
    importSummary: (sessionId) => importSummary(page, sessionId),
    importStory: (sessionId) => importStory(page, sessionId),
    announce: (text) => announce(page, text),
    exportChatlog: async (sessionId) => {
      await page.evaluate(({ module, sessionId }) => (globalThis as any).game.modules.get(module).api.exportChatlog(sessionId), { module: MODULE, sessionId });
    },
    onClosed: (fn) => {
      closedFn = fn;
    },
    close: async () => {
      closed = true;
      await browser.close();
    },
  };
}

async function login(page: Page, opts: LaunchOptions) {
  const joinUrl = new URL("join", `${opts.url}/`).toString();
  try {
    await page.goto(joinUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (err) {
    throw new JoinError("unreachable", `Foundry at ${opts.url} didn't answer (${firstLine(err)}).`);
  }
  const landing = classifyLanding(page.url());
  if (landing === "setup") throw new JoinError("no-world", "no world is running in Foundry (it is on the setup screen). Launch the world.");
  if (landing !== "join") throw new JoinError("unreachable", `expected Foundry's join page, got ${page.url()}.`);

  const select = page.locator('select[name="userid"]');
  await select.waitFor({ timeout: 20_000 }).catch(() => {
    throw new JoinError("timeout", "Foundry's join page has no user list.");
  });
  const options = await select.locator("option").evaluateAll((els) =>
    els.map((o) => ({ value: (o as HTMLOptionElement).value, label: o.textContent ?? "", disabled: (o as HTMLOptionElement).disabled })),
  );
  await select.selectOption(pickUser(options, opts.user));
  await page.locator('input[name="password"]').fill(opts.password);

  const button = page.locator('button[name="join"], button[value="join"]').first();
  const submit = (await button.count()) ? button.click() : page.locator('input[name="password"]').press("Enter");
  const failed = page
    .locator("#notifications .notification.error, .notification.error")
    .first()
    .waitFor({ timeout: 30_000 })
    .then(async () => {
      const text = (await page.locator(".notification.error").first().textContent())?.trim() || "login refused";
      throw new JoinError(/already|active/i.test(text) ? "user-busy" : "login-failed", `Foundry refused the login: ${text}`);
    });
  const joined = page.waitForURL((u) => classifyLanding(u.toString()) === "game", { timeout: 30_000, waitUntil: "domcontentloaded" });
  await submit;
  await Promise.race([joined, failed]).catch((err) => {
    if (err instanceof JoinError) throw err;
    throw new JoinError("timeout", "Foundry didn't open the game after logging in.");
  });
  failed.catch(() => {}); // the loser of the race
}

async function waitReady(page: Page) {
  await page.waitForFunction(() => (globalThis as any).game?.ready === true, null, { timeout: 180_000 }).catch(() => {
    throw new JoinError("timeout", "Foundry didn't finish loading the world within 3 minutes.");
  });
}

async function configureModule(page: Page, opts: LaunchOptions) {
  const r = await page.evaluate(
    async ({ module, botUrl, apiToken }) => {
      const g = (globalThis as any).game;
      if (!g.modules.get(module)?.active) return { problem: "inactive" as const };
      const bridgeUser = g.settings.get(module, "bridgeUser");
      if (bridgeUser !== g.user.id) return { problem: "not-bridge" as const, isGM: g.user.isGM };
      // Client settings of this throwaway profile; setting them makes the module reconnect.
      if (g.settings.get(module, "botUrl") !== botUrl) await g.settings.set(module, "botUrl", botUrl);
      if (g.settings.get(module, "apiToken") !== apiToken) await g.settings.set(module, "apiToken", apiToken);
      return { problem: null };
    },
    { module: MODULE, botUrl: opts.botUrl, apiToken: opts.apiToken },
  );
  if (r.problem === "inactive") throw new JoinError("module", "the ScribBot Bridge module isn't enabled in this world.");
  if (r.problem === "not-bridge") {
    throw new JoinError(
      "module",
      `"${opts.user}" isn't the module's bridge user. As GM, open Configure Settings → ScribBot Bridge and set Bridge user to "${opts.user}".`,
    );
  }
}

async function readStatus(page: Page): Promise<PageStatus | null> {
  if (page.isClosed()) return null;
  return page
    .evaluate((module) => {
      const g = (globalThis as any).game;
      if (!g?.ready) return { ready: false, botSocket: false, world: null, user: null, gmOnline: false };
      const api = g.modules.get(module)?.api;
      return {
        ready: g.socket?.connected !== false,
        // Older module versions have no status(); assume connected while the world is.
        botSocket: typeof api?.status === "function" ? Boolean(api.status().botSocket) : true,
        world: g.world?.id ?? null,
        user: g.user?.name ?? null,
        gmOnline: Boolean(g.users?.activeGM),
      };
    }, MODULE)
    .catch(() => null);
}

async function importSummary(page: Page, sessionId: string): Promise<ImportResult> {
  return page.evaluate(
    async ({ module, sessionId }) => {
      const g = (globalThis as any).game;
      if (!g.settings.get(module, "autoImport")) return { imported: false, reason: "auto-import-off" } as const;
      const result = await g.modules.get(module).api.importSummary(sessionId);
      return result ? ({ imported: true, name: String(result.name) } as const) : ({ imported: false, reason: "no-gm" } as const);
    },
    { module: MODULE, sessionId },
  );
}

async function importStory(page: Page, sessionId: string): Promise<ImportResult> {
  return page.evaluate(
    async ({ module, sessionId }) => {
      const api = (globalThis as any).game.modules.get(module).api;
      if (typeof api.importStory !== "function") throw new Error("ScribBot Bridge in Foundry is too old to import stories; update it to 0.6.0 or later");
      const result = await api.importStory(sessionId);
      return result ? ({ imported: true, name: String(result.name) } as const) : ({ imported: false, reason: "no-gm" } as const);
    },
    { module: MODULE, sessionId },
  );
}

/** Marks ScribBot's own chat messages; the summarizer and the story skill skip them in the chat log. */
export const ANNOUNCE_CLASS = "scribbot-announce";

async function announce(page: Page, text: string) {
  if (page.isClosed()) return;
  await page.evaluate(
    async ({ text, cls }) => {
      const g = globalThis as any;
      const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
      const ooc = g.CONST?.CHAT_MESSAGE_STYLES?.OOC ?? g.CONST?.CHAT_MESSAGE_TYPES?.OOC;
      await g.ChatMessage.create({
        content: `<p class="${cls}"><i class="fas fa-feather-pointed"></i> ${esc(text)}</p>`,
        speaker: { alias: g.game.user.name },
        // v12+ calls it style; v11 and older, type
        ...(g.CONST?.CHAT_MESSAGE_STYLES ? { style: ooc } : { type: ooc }),
      });
    },
    { text, cls: ANNOUNCE_CLASS },
  );
}

async function waitFor(page: Page, check: () => Promise<boolean>, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await page.waitForTimeout(500);
  }
  throw new Error("timed out");
}

function firstLine(err: unknown) {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
}
