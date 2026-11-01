import fs from "node:fs";
import path from "node:path";
import type { BotEvent } from "../events.js";
import { writeFileAtomic } from "../fsutil.js";

/**
 * A headless Foundry client the bot runs itself, logged in as the module's bridge user, so
 * nobody has to keep a browser open for the roster, chat log and journal import
 * (docs/design.md §3.2).
 *
 * This file is the lifecycle only; the browser lives behind `FoundryLauncher` (playwright.ts)
 * so the lifecycle can be tested without one.
 */

export type HeadlessMode = "off" | "session" | "always";

/** What the joined page reports about itself (see `api.status()` in foundry-module/scripts/main.js). */
export interface PageStatus {
  /** `game.ready` and Foundry's own socket is connected. */
  ready: boolean;
  /** The module's WebSocket to the bot is open. */
  botSocket: boolean;
  world: string | null;
  user: string | null;
  gmOnline: boolean;
}

export type ImportResult = { imported: true; name: string } | { imported: false; reason: "no-gm" | "auto-import-off" };

export interface FoundryPage {
  status(): Promise<PageStatus | null>;
  importSummary(sessionId: string): Promise<ImportResult>;
  /** Imports a story write-up (module 0.6.0+). Never skipped by the auto-import setting: it was asked for. */
  importStory(sessionId: string): Promise<ImportResult>;
  /** Has the module upload a session's chat and combat log (it normally does so on session.stopped). */
  exportChatlog(sessionId: string): Promise<void>;
  /** Called once if the browser or page goes away on its own. */
  onClosed(fn: (reason: string) => void): void;
  close(): Promise<void>;
}

/** Joins the world (throws `JoinError`) and returns once the module is connected to the bot. */
export type FoundryLauncher = () => Promise<FoundryPage>;

export type JoinErrorKind =
  | "not-installed" // playwright-core or the browser is missing
  | "unreachable" // Foundry didn't answer
  | "no-world" // Foundry is on the setup screen
  | "no-such-user"
  | "user-busy" // someone is already logged in as this user
  | "login-failed"
  | "module" // module inactive, or the user isn't the configured bridge user
  | "timeout";

export class JoinError extends Error {
  constructor(
    readonly kind: JoinErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "JoinError";
  }
}

/** Configuration problems a retry won't fix soon: wait longer between attempts. */
const SLOW_RETRY: JoinErrorKind[] = ["not-installed", "no-such-user", "login-failed", "module"];

export type HeadlessState = "off" | "idle" | "joining" | "connected" | "retrying";

export interface HeadlessStatus {
  mode: HeadlessMode;
  state: HeadlessState;
  url: string;
  user: string;
  world: string | null;
  since: string | null;
  error: string | null;
  /** Why it is joined (or trying to be): "always", "session 12", "import". */
  reasons: string[];
  pendingImports: string[];
}

export interface ClientOptions {
  mode: HeadlessMode;
  url: string;
  user: string;
  launch: FoundryLauncher;
  /** How long to keep the client after `/scrib stop` while the chat log hasn't arrived. */
  chatlogWaitMs: number;
  /** Imports still to do, kept across restarts: summary session ids, and "story:<id>" for stories. Omit to keep them in memory only. */
  stateFile?: string;
  log?: (msg: string) => void;
  /** Overridable for tests. */
  healthCheckMs?: number;
  retryMs?: (attempt: number, kind: JoinErrorKind | null) => number;
}

/** Pending-import keys for stories; summaries are keyed by the bare session id (older state files too). */
const STORY_PREFIX = "story:";

const defaultRetry = (attempt: number, kind: JoinErrorKind | null) =>
  kind && SLOW_RETRY.includes(kind) ? 5 * 60_000 : Math.min(15_000 * 2 ** attempt, 5 * 60_000);

export class HeadlessFoundry {
  private page: FoundryPage | null = null;
  private state: HeadlessState;
  private since: string | null = null;
  private world: string | null = null;
  private error: string | null = null;
  private readonly reasons = new Set<string>();
  private readonly pending: Set<string>;
  /** Sessions stopped whose chat log hasn't arrived: resolves the wait, and drops the session reason. */
  private readonly awaiting = new Map<string, { promise: Promise<void>; done: () => void }>();
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private unhealthy = 0;
  /** Serializes join/close/import so two never overlap. */
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: ClientOptions) {
    this.log = opts.log ?? ((m) => console.log(`[foundry] ${m}`));
    this.state = opts.mode === "off" ? "off" : "idle";
    this.pending = new Set(this.loadPending());
  }

  /** Starts the client in "always" mode and imports summaries left from a previous run. */
  start() {
    if (this.opts.mode === "off") return;
    if (this.opts.mode === "always") this.reasons.add("always");
    if (this.pending.size) this.reasons.add("import");
    this.reconcile();
  }

  /** Bus events from the bot (session.started, session.stopped, chatlog.received, summary.ready). */
  onEvent(e: BotEvent) {
    if (this.opts.mode === "off" || this.stopped) return;
    switch (e.type) {
      case "session.started":
        this.reasons.add(`session ${e.number}`);
        this.reconcile();
        break;
      case "session.stopped": {
        // The module answers session.stopped with the chat log; stay until it lands (or give up).
        const reason = `session ${e.number}`;
        if (!this.reasons.has(reason)) break;
        let done!: () => void;
        const promise = new Promise<void>((resolve) => (done = resolve));
        const timer = setTimeout(() => finish(), this.opts.chatlogWaitMs);
        const finish = () => {
          clearTimeout(timer);
          if (this.awaiting.get(e.sessionId)?.promise !== promise) return;
          this.awaiting.delete(e.sessionId);
          this.reasons.delete(reason);
          done();
          this.reconcile();
        };
        this.awaiting.set(e.sessionId, { promise, done: finish });
        // Not joined at all: nothing will upload, so don't hold anything up.
        if (this.state !== "connected" && this.state !== "joining") finish();
        break;
      }
      case "chatlog.received":
        this.awaiting.get(e.sessionId)?.done();
        break;
      case "summary.ready":
      case "story.ready":
        // While joined, the module hears the event itself and imports it.
        if (this.state === "connected") break;
        this.pending.add(e.type === "story.ready" ? `${STORY_PREFIX}${e.sessionId}` : e.sessionId);
        this.savePending();
        this.reasons.add("import");
        this.reconcile();
        break;
    }
  }

  /**
   * Resolves once the chat log of a just-stopped session has arrived, or the wait ran out.
   * Resolves at once for any other session, so `/scrib summarize` later never waits.
   */
  awaitChatlog(sessionId: string): Promise<void> {
    return this.awaiting.get(sessionId)?.promise ?? Promise.resolve();
  }

  status(): HeadlessStatus {
    return {
      mode: this.opts.mode,
      state: this.state,
      url: this.opts.url,
      user: this.opts.user,
      world: this.world,
      since: this.since,
      error: this.error,
      reasons: [...this.reasons],
      pendingImports: [...this.pending],
    };
  }

  /** Bot shutdown: log out and stop retrying. */
  async stop() {
    this.stopped = true;
    this.reasons.clear();
    for (const a of [...this.awaiting.values()]) a.done();
    this.clearTimers();
    await this.enqueue(() => this.closePage("bot shutting down"));
  }

  // ---------- internals ----------

  private reconcile() {
    if (this.stopped) return;
    const want = this.reasons.size > 0;
    if (want && !this.page && this.state !== "joining" && !this.retryTimer) {
      void this.enqueue(() => this.join());
    } else if (!want) {
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.state = "idle";
        this.error = null;
      }
      if (this.page) void this.enqueue(() => this.closePage("no longer needed"));
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const next = this.queue.then(fn).catch((err) => {
      this.log(`unexpected error: ${err instanceof Error ? err.stack : err}`);
      return undefined;
    });
    this.queue = next;
    return next;
  }

  private async join() {
    if (this.page || this.stopped || !this.reasons.size) return;
    this.state = "joining";
    this.log(`joining ${this.opts.url} as ${this.opts.user} (${[...this.reasons].join(", ")})`);
    const t0 = Date.now();
    let page: FoundryPage;
    try {
      page = await this.opts.launch();
    } catch (err) {
      const kind = err instanceof JoinError ? err.kind : null;
      this.error = err instanceof Error ? err.message : String(err);
      const delay = (this.opts.retryMs ?? defaultRetry)(this.attempt++, kind);
      this.log(`could not join: ${this.error}. Retrying in ${Math.round(delay / 1000)} s`);
      this.state = "retrying";
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.reconcile();
      }, delay);
      this.retryTimer.unref?.();
      return;
    }
    if (this.stopped || !this.reasons.size) {
      await page.close().catch(() => {});
      this.state = this.stopped ? "off" : "idle";
      return;
    }
    this.page = page;
    this.attempt = 0;
    this.error = null;
    this.unhealthy = 0;
    this.state = "connected";
    this.since = new Date().toISOString();
    const st = await page.status().catch(() => null);
    this.world = st?.world ?? null;
    this.log(`joined world ${this.world ?? "?"} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    page.onClosed((reason) => void this.enqueue(() => this.lost(page, reason)));
    this.healthTimer = setInterval(() => void this.enqueue(() => this.checkHealth(page)), this.opts.healthCheckMs ?? 30_000);
    this.healthTimer.unref?.();
    // Sessions stopped while we were still joining: the module missed session.stopped.
    for (const sessionId of [...this.awaiting.keys()]) {
      this.log(`uploading the chat log of ${sessionId}, which stopped while joining`);
      await page.exportChatlog(sessionId).catch((err) => this.log(`chat log upload failed: ${err instanceof Error ? err.message : err}`));
    }
    await this.importPending(page);
  }

  private async importPending(page: FoundryPage) {
    if (!this.pending.size) {
      this.reasons.delete("import");
      this.reconcile();
      return;
    }
    for (const key of [...this.pending]) {
      const isStory = key.startsWith(STORY_PREFIX);
      const sessionId = isStory ? key.slice(STORY_PREFIX.length) : key;
      const what = isStory ? "story" : "summary";
      try {
        const r = isStory ? await page.importStory(sessionId) : await page.importSummary(sessionId);
        if (r.imported) this.log(`imported the ${what} of ${sessionId} as "${r.name}"`);
        else if (r.reason === "auto-import-off") this.log(`summary ${sessionId} is ready; auto-import is off in Foundry, so import it from the Journal sidebar`);
        if (r.imported || r.reason === "auto-import-off") this.pending.delete(key);
        else this.log(`${what} ${sessionId} is waiting for a GM to be online; it will be imported next time ScribBot joins`);
      } catch (err) {
        this.log(`importing ${what} ${sessionId} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.savePending();
    // Done for now: anything left waits for the next join (or, while joined, the module's own GM hook).
    this.reasons.delete("import");
    this.reconcile();
  }

  private async checkHealth(page: FoundryPage) {
    if (this.page !== page) return;
    const st = await page.status().catch(() => null);
    if (st?.ready && st.botSocket) {
      this.unhealthy = 0;
      this.world = st.world;
      return;
    }
    // Two misses in a row (Foundry restarting, the world shut down, the bot socket stuck): rejoin.
    if (++this.unhealthy >= 2) await this.lost(page, st ? (st.ready ? "the module lost its connection to the bot" : "Foundry disconnected") : "the page stopped responding");
  }

  private async lost(page: FoundryPage, reason: string) {
    if (this.page !== page) return;
    this.log(`lost the Foundry session: ${reason}`);
    await this.closePage(reason);
    this.error = reason;
    this.reconcile();
  }

  private async closePage(reason: string) {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    const page = this.page;
    this.page = null;
    this.state = this.stopped ? "off" : "idle";
    this.since = null;
    if (!page) return;
    this.log(`logging out (${reason})`);
    await page.close().catch((err) => this.log(`closing the browser failed: ${err}`));
  }

  private clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.retryTimer = null;
    this.healthTimer = null;
  }

  private loadPending(): string[] {
    if (!this.opts.stateFile) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.opts.stateFile, "utf8")) as { pendingImports?: unknown };
      return Array.isArray(data.pendingImports) ? data.pendingImports.filter((s): s is string => typeof s === "string") : [];
    } catch {
      return [];
    }
  }

  private savePending() {
    if (!this.opts.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.opts.stateFile), { recursive: true });
      writeFileAtomic(this.opts.stateFile, JSON.stringify({ pendingImports: [...this.pending] }, null, 2));
    } catch (err) {
      this.log(`could not save pending imports: ${err}`);
    }
  }
}
