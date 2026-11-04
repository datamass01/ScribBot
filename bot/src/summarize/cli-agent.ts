import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { CLI_DEFAULT_MODELS } from "./defaults.js";
import { LLMError, type JsonRequest, type LLMProvider } from "./provider.js";

/**
 * Summaries through a coding-agent CLI signed in with the user's own subscription: OpenAI Codex
 * (`codex exec`), Google Antigravity (`agy --print`), Anthropic Claude Code (`claude -p`) or xAI Grok
 * (`grok --prompt-file`). Each
 * request runs the CLI once, in an empty temp folder with its sandbox on (Claude Code, Grok: their tools off), with the prompt on stdin (a transcript chunk is too long
 * for a Windows command line) and the request's JSON Schema enforced by the CLI itself.
 */
export type CliAgentKind = "codex" | "antigravity" | "claude-code" | "grok-cli";
export const CLI_PROVIDERS: readonly CliAgentKind[] = ["codex", "antigravity", "claude-code", "grok-cli"];
export const isCliProvider = (p: string): p is CliAgentKind => (CLI_PROVIDERS as readonly string[]).includes(p);

/**
 * The only environment variables a CLI gets. The bot's own environment holds every secret in .env
 * (dotenv loads it into process.env): DISCORD_TOKEN, API_TOKEN, FOUNDRY_PASSWORD, API keys. These
 * CLIs are agents that can run commands, so they get what they need to find their own sign-in, reach
 * the network and run on each OS, and nothing else. Names are matched case-insensitively (Windows).
 */
const ENV_ALLOW = new Set(
  [
    // every OS
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TERM", "TMPDIR", "TEMP", "TMP",
    // Windows
    "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "OS", "USERPROFILE", "USERNAME", "USERDOMAIN",
    "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
    "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
    // Linux: the Secret Service (keyring) a CLI may keep its sign-in in
    "DBUS_SESSION_BUS_ADDRESS",
    // network: proxies and corporate CA bundles
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    // where the CLIs keep their own config and sign-in, when moved
    "CODEX_HOME", "CLAUDE_CONFIG_DIR",
  ].map((k) => k.toUpperCase()),
);
const ENV_ALLOW_PREFIXES = ["LC_", "XDG_"];

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (value !== undefined && (ENV_ALLOW.has(upper) || ENV_ALLOW_PREFIXES.some((p) => upper.startsWith(p)))) out[key] = value;
  }
  return out;
}

/** How long one request may run before the CLI is stopped. Agents start slowly; chunks are long. */
const TIMEOUT_MS = 20 * 60_000;

interface Invocation {
  args: string[];
  stdin: string;
  /** The JSON text the agent returned, from its stdout or the files it wrote. */
  result(stdout: string): Promise<string>;
}

interface Adapter {
  bin: string;
  /** Shown as the model when LLM_MODEL is blank (the CLI then picks). */
  defaultModel: string;
  /** Exits non-zero on a failed request but still prints a result object with the reason. */
  failureOnStdout?: string;
  invocation(
    req: JsonRequest<z.ZodType>,
    opts: { model?: string; schemaFile: string; schemaJson: string; dir: string; text: string },
  ): Invocation;
}

const ADAPTERS: Record<CliAgentKind, Adapter> = {
  codex: {
    bin: "codex",
    defaultModel: CLI_DEFAULT_MODELS.codex,
    invocation(req, { model, schemaFile, dir, text }) {
      const out = path.join(dir, "last-message.json");
      const args = ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never"];
      args.push("--output-schema", schemaFile, "-o", out);
      if (model) args.push("-m", model);
      if (req.effort) args.push("-c", `model_reasoning_effort="${req.effort}"`);
      args.push("-"); // prompt from stdin
      return {
        args,
        stdin: text,
        result: async () => {
          const last = await readFile(out, "utf8").catch(() => "");
          if (!last.trim()) throw new LLMError("codex wrote no final message");
          return last;
        },
      };
    },
  },
  "claude-code": {
    bin: "claude",
    defaultModel: CLI_DEFAULT_MODELS["claude-code"],
    failureOnStdout: '"type":"result"',
    invocation(req, { model, schemaJson, text }) {
      // Not --bare: that ignores the Claude sign-in and accepts only an API key.
      const args = ["-p", "--output-format", "json", "--json-schema", schemaJson];
      // No tools (so no shell, files or web), no MCP servers, skills, hooks or saved session.
      args.push("--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "");
      args.push("--no-session-persistence");
      if (model) args.push("--model", model);
      if (req.effort) args.push("--effort", req.effort);
      return {
        args,
        stdin: text,
        result: async (stdout) => {
          let out: ClaudeResult;
          try {
            out = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1)) as ClaudeResult;
          } catch {
            throw new LLMError("claude printed no result");
          }
          if (out.is_error || out.subtype !== "success") {
            const parts = [out.subtype, out.api_error_status, typeof out.result === "string" ? out.result : null];
            throw new LLMError(`claude failed: ${parts.filter(Boolean).join(": ") || "unknown error"}`);
          }
          if (out.structured_output != null) return JSON.stringify(out.structured_output);
          return out.result ?? "";
        },
      };
    },
  },
  "grok-cli": {
    bin: "grok",
    defaultModel: CLI_DEFAULT_MODELS["grok-cli"],
    failureOnStdout: '"type":"error"',
    invocation(req, { model, schemaJson, dir, text }) {
      // The prompt goes in a file: grok's single-turn mode doesn't read stdin.
      const promptFile = path.join(dir, "prompt.txt");
      writeFileSync(promptFile, text, "utf8");
      const args = ["--prompt-file", promptFile, "--output-format", "json", "--json-schema", schemaJson];
      // No tools, web search, subagents or plan mode, and nothing that asks for permission is run.
      args.push("--tools=", "--disable-web-search", "--no-subagents", "--no-plan", "--permission-mode", "dontAsk");
      if (model) args.push("-m", model);
      if (req.effort) args.push("--effort", req.effort);
      return {
        args,
        stdin: "",
        result: async (stdout) => {
          let out: GrokResult;
          try {
            out = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1)) as GrokResult;
          } catch {
            throw new LLMError("grok printed no result");
          }
          if (out.type === "error") throw new LLMError(`grok failed: ${out.message ?? "unknown error"}`);
          if (out.structuredOutput != null) return JSON.stringify(out.structuredOutput);
          if (!out.text) throw new LLMError(`grok returned no answer (${out.stopReason ?? "no stop reason"})`);
          return out.text;
        },
      };
    },
  },
  antigravity: {
    failureOnStdout: '"event":"result"',
    bin: "agy",
    defaultModel: CLI_DEFAULT_MODELS.antigravity,
    invocation(req, { model, schemaFile, text }) {
      const m = model ?? "gemini-3.8-flash";
      const args = ["-p=", "--input-format", "stream-json", "--output-format", "stream-json"];
      args.push("--json-schema", schemaFile, "--model", m, "--sandbox");
      // Model ids like gemini-3.8-flash-high fix the level; agy rejects --effort next to them.
      if (req.effort && !/-(low|medium|high|xhigh|max)$/.test(m)) args.push("--effort", req.effort);
      return {
        args,
        stdin: JSON.stringify({ event: "user", message: { content: text } }) + "\n",
        result: async (stdout) => {
          const result = stdout
            .split(/\r?\n/)
            .flatMap((line) => {
              try {
                const ev = JSON.parse(line) as { event?: string; result?: AgyResult };
                return ev.event === "result" && ev.result ? [ev.result] : [];
              } catch {
                return [];
              }
            })
            .at(-1);
          if (!result) throw new LLMError("antigravity printed no result");
          if (result.status !== "SUCCESS") {
            throw new LLMError(`antigravity failed: ${result.error || result.finished_reason || result.status}`);
          }
          if (result.structured_output != null) return JSON.stringify(result.structured_output);
          return result.response ?? "";
        },
      };
    },
  },
};

interface GrokResult {
  type?: string;
  message?: string;
  text?: string;
  stopReason?: string;
  structuredOutput?: unknown;
}

interface ClaudeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  api_error_status?: number | string | null;
  result?: string;
  structured_output?: unknown;
}

interface AgyResult {
  status?: string;
  error?: string;
  finished_reason?: string;
  response?: string;
  structured_output?: unknown;
}

export class CliAgentProvider implements LLMProvider {
  readonly name: CliAgentKind;
  readonly model: string;
  private adapter: Adapter;
  private configuredModel?: string;
  private command: string;
  private launch?: Launch;

  /**
   * `command`: LLM_CLI_PATH, or blank for `codex` / `agy` on PATH. `launch` skips that lookup and
   * starts exactly this (tests run a fake CLI as `node fake-cli.mjs`).
   */
  constructor(kind: CliAgentKind, opts: { model?: string; command?: string; launch?: Launch } = {}) {
    this.name = kind;
    this.adapter = ADAPTERS[kind];
    this.configuredModel = opts.model;
    this.model = opts.model ?? this.adapter.defaultModel;
    this.command = opts.command || this.adapter.bin;
    this.launch = opts.launch;
  }

  async generateJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<z.infer<S>> {
    // An empty folder, so the agent has nothing of ours to read or touch.
    const dir = await mkdtemp(path.join(tmpdir(), `scribbot-${this.name}-`));
    try {
      const schemaFile = path.join(dir, "schema.json");
      const { $schema: _ignored, ...schema } = z.toJSONSchema(req.schema, { target: "draft-7" }) as Record<string, unknown>;
      const schemaJson = JSON.stringify(schema);
      await writeFile(schemaFile, schemaJson);
      const text =
        `${req.system}\n\n${req.prompt}\n\n` +
        "Answer with the JSON object only. Don't run commands or open files: everything you need is above.";
      const call = this.adapter.invocation(req, { model: this.configuredModel, schemaFile, schemaJson, dir, text });
      const stdout = await this.run(call.args, call.stdin, dir);
      const raw = await call.result(stdout);
      return parseJson(raw, req.schema, `${this.name} (${req.schemaName})`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private run(args: string[], stdin: string, cwd: string): Promise<string> {
    // Resolved on every call, so installing or moving the CLI doesn't need a bot restart.
    const resolved = this.launch ? { launch: this.launch } : resolveCli(this.name, this.command);
    if (!resolved.launch) {
      const why = resolved.error.endsWith("not found")
        ? `${this.command} was not found. Install the ${this.name} CLI and sign in, or set LLM_CLI_PATH.`
        : resolved.error;
      return Promise.reject(new LLMError(why));
    }
    const { file, args: before } = resolved.launch;
    return new Promise((resolve, reject) => {
      let child;
      try {
        // An absolute path and no shell: nothing in the arguments or stdin is ever parsed as a command.
        child = spawn(file, [...before, ...args], {
          cwd,
          env: childEnv(),
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(new LLMError(`Couldn't start ${this.command}: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new LLMError(`${this.name} took longer than ${TIMEOUT_MS / 60_000} min and was stopped`));
      }, TIMEOUT_MS);
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-4000)));
      child.stdin.on("error", () => {}); // the CLI may exit before reading all of stdin
      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new LLMError(
            err.code === "ENOENT"
              ? `${this.command} was not found. Install the ${this.name} CLI and sign in, or set LLM_CLI_PATH.`
              : `${this.command} failed to start: ${err.message}`,
          ),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        // agy and claude report their own failures in the result object, so let the adapter read it.
        const failure = this.adapter.failureOnStdout;
        if (code !== 0 && !(failure && stdout.includes(failure))) {
          const tail = stderr.trim().split(/\r?\n/).slice(-5).join(" | ");
          reject(new LLMError(`${this.name} exited with code ${code}${tail ? `: ${tail}` : ""}`));
          return;
        }
        resolve(stdout);
      });
      child.stdin.end(stdin, "utf8");
    });
  }
}

function parseJson<S extends z.ZodType>(raw: string, schema: S, what: string): z.infer<S> {
  // Tolerate prose or code fences around the object.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new LLMError(`${what} returned no JSON object`);
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw new LLMError(`${what} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new LLMError(`${what} output did not match the schema: ${parsed.error.message}`);
  return parsed.data;
}

/**
 * Where the CLI would be started from, or null when it can't be found. Used by /status to say
 * whether summaries can work; it doesn't start the CLI, so it can't tell whether it's signed in.
 */
export function findCli(
  kind: CliAgentKind,
  command?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const cmd = command || ADAPTERS[kind].bin;
  if (/[\\/]/.test(cmd)) return existsSync(cmd) ? path.resolve(cmd) : null;
  // Windows: the CLI's own .exe, else an npm install's .cmd wrapper (resolveCli runs that through node).
  const exts = platform === "win32" && !path.extname(cmd) ? [".exe", ".cmd"] : [""];
  const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";
  for (const ext of exts) {
    for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** What to start: `file` (an absolute path), with `args` before the CLI's own arguments. */
export interface Launch {
  file: string;
  args: string[];
}

/**
 * How to start the CLI without a shell, on every OS. A program starts directly. A .js file, and an
 * npm install's Windows .cmd wrapper (which only runs `node <its script>`), start as `node <script>`
 * with the bot's own Node, so no argument ever passes through cmd.exe's quoting (the 2024
 * "BatBadBut" bug class, CVE-2024-27980). Any other .cmd, .bat or .ps1 is refused.
 */
export function resolveCli(
  kind: CliAgentKind,
  command?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { launch: Launch; error?: undefined } | { launch?: undefined; error: string } {
  const found = findCli(kind, command, env, platform);
  const name = command || ADAPTERS[kind].bin;
  if (!found) return { error: `${name} not found` };
  const ext = path.extname(found).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(ext)) return { launch: { file: process.execPath, args: [found] } };
  if (platform === "win32" && [".cmd", ".bat", ".ps1"].includes(ext)) {
    let script: string | null = null;
    try {
      script = ext === ".ps1" ? null : npmShimTarget(readFileSync(found, "utf8"), found);
    } catch {
      script = null;
    }
    if (script && existsSync(script)) return { launch: { file: process.execPath, args: [script] } };
    return {
      error:
        `${found} is a script ScribBot can't start safely (only npm's own .cmd wrappers are understood). ` +
        "Set LLM_CLI_PATH to the CLI's .exe or .js file.",
    };
  }
  return { launch: { file: found, args: [] } };
}

/**
 * The script an npm (cmd-shim) wrapper runs with node, e.g. `"%dp0%\node_modules\@openai\codex\bin\codex.js" %*`,
 * or null when the file isn't such a wrapper.
 */
export function npmShimTarget(text: string, shimPath: string): string | null {
  if (!/SET "_prog=node"/i.test(text)) return null; // a node wrapper, not one for sh or another program
  const matches = [...text.matchAll(/"%dp0%\\([^"%]+)"\s+%\*/gi)];
  const rel = matches.at(-1)?.[1];
  if (!rel || rel.toLowerCase().endsWith("node.exe")) return null;
  return path.join(path.dirname(shimPath), ...rel.split("\\"));
}

export function cliDefaultModel(kind: CliAgentKind): string {
  return ADAPTERS[kind].defaultModel;
}
