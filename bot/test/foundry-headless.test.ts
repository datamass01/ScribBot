import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type FoundryPage, HeadlessFoundry, type ImportResult, JoinError } from "../src/foundry/client.js";
import { classifyLanding, desktopUserAgent, pickUser } from "../src/foundry/playwright.js";

/** A fake browser session: records calls, and can be "kicked" like Foundry closing the page. */
function fakeLauncher(opts: { fail?: JoinError[]; importResult?: ImportResult } = {}) {
  const failures = [...(opts.fail ?? [])];
  const pages: (FoundryPage & { closed: boolean; imports: string[]; exports: string[]; kick: (r: string) => void })[] = [];
  const launch = vi.fn(async () => {
    const err = failures.shift();
    if (err) throw err;
    let closedFn: ((r: string) => void) | null = null;
    const page = {
      closed: false,
      imports: [] as string[],
      exports: [] as string[],
      exportChatlog: async (id: string) => {
        page.exports.push(id);
      },
      status: async () => ({ ready: true, botSocket: true, world: "w1", user: "ScribBot", gmOnline: true }),
      importSummary: async (id: string) => {
        page.imports.push(id);
        return opts.importResult ?? ({ imported: true, name: `Session ${id}` } as const);
      },
      onClosed: (fn: (r: string) => void) => (closedFn = fn),
      close: async () => {
        page.closed = true;
      },
      kick: (r: string) => closedFn?.(r),
    };
    pages.push(page);
    return page;
  });
  return { launch, pages };
}

const quiet = () => {};
const make = (launch: () => Promise<FoundryPage>, extra: Partial<ConstructorParameters<typeof HeadlessFoundry>[0]> = {}) =>
  new HeadlessFoundry({ mode: "session", url: "http://foundry:30000", user: "ScribBot", launch, chatlogWaitMs: 5000, log: quiet, retryMs: () => 10, ...extra });

const started = (sessionId: string, number: number) => ({ type: "session.started", sessionId, number, startedAt: "x" }) as const;
const stopped = (sessionId: string, number: number) => ({ type: "session.stopped", sessionId, number, startedAt: "x", endedAt: "y" }) as const;

describe("HeadlessFoundry lifecycle", () => {
  it("does nothing when off", async () => {
    const { launch } = fakeLauncher();
    const c = make(launch, { mode: "off" });
    c.start();
    c.onEvent(started("s1", 1));
    await new Promise((r) => setTimeout(r, 20));
    expect(launch).not.toHaveBeenCalled();
    expect(c.status().state).toBe("off");
  });

  it("joins for a recording and logs out once the chat log arrives", async () => {
    const { launch, pages } = fakeLauncher();
    const c = make(launch);
    c.start();
    expect(launch).not.toHaveBeenCalled(); // session mode waits for a recording
    c.onEvent(started("s1", 1));
    await vi.waitFor(() => expect(c.status().state).toBe("connected"));
    expect(c.status()).toMatchObject({ world: "w1", reasons: ["session 1"] });

    c.onEvent(stopped("s1", 1));
    let waited = false;
    const wait = c.awaitChatlog("s1").then(() => (waited = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(waited).toBe(false);
    expect(pages[0]!.closed).toBe(false);

    c.onEvent({ type: "chatlog.received", sessionId: "s1" });
    await wait;
    await vi.waitFor(() => expect(pages[0]!.closed).toBe(true));
    expect(c.status().state).toBe("idle");
  });

  it("asks for the chat log itself when the recording stopped while it was joining", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { launch: inner, pages } = fakeLauncher();
    const c = make(async () => {
      await gate;
      return inner();
    });
    c.onEvent(started("s1", 1));
    await vi.waitFor(() => expect(c.status().state).toBe("joining"));
    c.onEvent(stopped("s1", 1));
    release();
    await vi.waitFor(() => expect(pages[0]?.exports).toEqual(["s1"]));
    c.onEvent({ type: "chatlog.received", sessionId: "s1" });
    await c.awaitChatlog("s1");
    await vi.waitFor(() => expect(pages[0]!.closed).toBe(true));
  });

  it("stops waiting for the chat log after the timeout", async () => {
    const { launch, pages } = fakeLauncher();
    const c = make(launch, { chatlogWaitMs: 30 });
    c.onEvent(started("s1", 1));
    await vi.waitFor(() => expect(c.status().state).toBe("connected"));
    c.onEvent(stopped("s1", 1));
    await c.awaitChatlog("s1");
    await vi.waitFor(() => expect(pages[0]!.closed).toBe(true));
  });

  it("never makes other sessions (or a session it never joined for) wait", async () => {
    const { launch } = fakeLauncher();
    const c = make(launch);
    await c.awaitChatlog("unknown");
    c.onEvent(stopped("s9", 9)); // stopped without a started this run
    await c.awaitChatlog("s9");
  });

  it("retries a failed join and reports the error meanwhile", async () => {
    const { launch } = fakeLauncher({ fail: [new JoinError("no-world", "no world is running")] });
    const retry = vi.fn(() => 300);
    const c = make(launch, { retryMs: retry });
    c.onEvent(started("s1", 1));
    await vi.waitFor(() => expect(c.status().state).toBe("retrying"));
    expect(c.status().error).toBe("no world is running");
    expect(retry).toHaveBeenCalledWith(0, "no-world");
    await vi.waitFor(() => expect(c.status().state).toBe("connected"));
    expect(c.status().error).toBeNull();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("gives up retrying when the recording stops before it could join", async () => {
    const { launch } = fakeLauncher({ fail: [new JoinError("unreachable", "down")] });
    const c = make(launch, { retryMs: () => 60_000 });
    c.onEvent(started("s1", 1));
    await vi.waitFor(() => expect(c.status().state).toBe("retrying"));
    c.onEvent(stopped("s1", 1));
    await c.awaitChatlog("s1"); // nothing would upload, so no wait
    expect(c.status()).toMatchObject({ state: "idle", reasons: [] });
  });

  it("rejoins in always mode when Foundry drops the page", async () => {
    const { launch, pages } = fakeLauncher();
    const c = make(launch, { mode: "always" });
    c.start();
    await vi.waitFor(() => expect(c.status().state).toBe("connected"));
    pages[0]!.kick("Foundry navigated to /join");
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(c.status().state).toBe("connected"));
    await c.stop();
    expect(pages[1]!.closed).toBe(true);
    expect(c.status().state).toBe("off");
  });

  it("joins just to import a summary when nobody is connected", async () => {
    const { launch, pages } = fakeLauncher();
    const c = make(launch);
    c.onEvent({ type: "summary.ready", sessionId: "s1", number: 1, title: "t" });
    await vi.waitFor(() => expect(pages[0]?.closed).toBe(true));
    expect(pages[0]!.imports).toEqual(["s1"]);
    expect(c.status().pendingImports).toEqual([]);
  });

  it("leaves the import to the module while joined", async () => {
    const { launch, pages } = fakeLauncher();
    const c = make(launch, { mode: "always" });
    c.start();
    await vi.waitFor(() => expect(c.status().state).toBe("connected"));
    c.onEvent({ type: "summary.ready", sessionId: "s1", number: 1, title: "t" });
    await new Promise((r) => setTimeout(r, 20));
    expect(pages[0]!.imports).toEqual([]);
    await c.stop();
  });

  it("keeps a summary no GM could take across restarts", async () => {
    const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "scrib-headless-")), "foundry-headless.json");
    const first = fakeLauncher({ importResult: { imported: false, reason: "no-gm" } });
    const a = make(first.launch, { stateFile });
    a.onEvent({ type: "summary.ready", sessionId: "s1", number: 1, title: "t" });
    await vi.waitFor(() => expect(first.pages[0]?.closed).toBe(true));
    expect(a.status().pendingImports).toEqual(["s1"]);

    const second = fakeLauncher();
    const b = make(second.launch, { stateFile });
    expect(b.status().pendingImports).toEqual(["s1"]);
    b.start(); // a pending import is reason enough to join
    await vi.waitFor(() => expect(second.pages[0]?.closed).toBe(true));
    expect(second.pages[0]!.imports).toEqual(["s1"]);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).toEqual({ pendingImports: [] });
  });
});

describe("headless join helpers", () => {
  it("tells the join page from the setup screen", () => {
    expect(classifyLanding("http://localhost:30000/join")).toBe("join");
    expect(classifyLanding("https://x.forge-vtt.com/game")).toBe("game");
    expect(classifyLanding("http://host/foundry/join/")).toBe("join"); // routePrefix
    expect(classifyLanding("http://localhost:30000/setup")).toBe("setup");
    expect(classifyLanding("http://localhost:30000/auth")).toBe("setup");
    expect(classifyLanding("not a url")).toBe("other");
  });

  it("picks the user by name and explains a missing or busy one", () => {
    const opts = [
      { value: "", label: "", disabled: false },
      { value: "gm1", label: "Gamemaster", disabled: true },
      { value: "sb1", label: " ScribBot ", disabled: false },
    ];
    expect(pickUser(opts, "scribbot")).toBe("sb1");
    expect(() => pickUser(opts, "Gamemaster")).toThrow(/already logged in/);
    expect(() => pickUser(opts, "Nobody")).toThrow(/no user named "Nobody" \(users: Gamemaster, ScribBot\)/);
  });

  it("presents as a normal desktop browser", () => {
    const ua = desktopUserAgent("131.0.2903.70", "win32");
    expect(ua).toContain("Chrome/131.0.0.0");
    expect(ua).toContain("Windows NT 10.0");
    expect(ua).not.toMatch(/Headless/);
  });
});
