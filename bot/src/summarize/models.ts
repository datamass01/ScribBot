import { spawn } from "node:child_process";
import { childEnv, isCliProvider, resolveCli, type CliAgentKind } from "./cli-agent.js";

/**
 * Which model ids each summary provider accepts in LLM_MODEL, for the Console's "Which models?"
 * box. The CLIs are asked for their own list (it depends on the account they're signed in with):
 * `codex debug models`, `agy models`, `grok models`. Claude Code has no list command, so it gets a
 * fixed list of its aliases and current ids, as do the API providers.
 */

export interface ModelInfo {
  id: string;
  label?: string;
  note?: string;
  isDefault?: boolean;
}

export interface ModelList {
  provider: string;
  /** "cli": asked the CLI just now (or within the cache time); "fixed": built into ScribBot. */
  source: "cli" | "fixed";
  /** The command that produced the list, for the user to run themselves. */
  command?: string;
  models: ModelInfo[];
  /** What a blank Model means, and other hints for this provider. */
  notes: string[];
  /** Why the CLI's list couldn't be read (the fixed notes are still given). */
  error?: string;
}

const LIST_TIMEOUT_MS = 30_000;
const CACHE_MS = 10 * 60_000;

interface CliSource {
  args: string[];
  parse(stdout: string): ModelInfo[];
  notes: string[];
}

const CLI_SOURCES: Record<Exclude<CliAgentKind, "claude-code">, CliSource> = {
  codex: {
    args: ["debug", "models"],
    parse(stdout) {
      const json = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1)) as {
        models?: { slug?: string; display_name?: string; description?: string; visibility?: string; priority?: number }[];
      };
      return (json.models ?? [])
        .filter((m) => m.slug && m.visibility !== "hide")
        .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
        .map((m) => ({ id: m.slug!, label: m.display_name, note: m.description }));
    },
    notes: ["Blank: the model set in Codex's own config (~/.codex/config.toml)."],
  },
  antigravity: {
    args: ["models"],
    parse(stdout) {
      return stdout
        .split(/\r?\n/)
        .map((line) => /^(\S+)\t+(.+)$/.exec(line.trim()))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ id: m[1]!, label: m[2]!.trim() }));
    },
    notes: [
      "Blank: gemini-3.8-flash, with the reasoning level ScribBot asks for.",
      "An id ending in -low, -medium or -high fixes the reasoning level; ScribBot then doesn't set one.",
    ],
  },
  "grok-cli": {
    args: ["models"],
    parse(stdout) {
      return stdout
        .split(/\r?\n/)
        .map((line) => /^\s*([*-])\s+(\S+)(\s+\(default\))?\s*$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ id: m[2]!, isDefault: m[1] === "*" || Boolean(m[3]) }));
    },
    notes: ["Blank: the Grok CLI's default model."],
  },
};

const FIXED: Record<string, { models: ModelInfo[]; notes: string[] }> = {
  "claude-code": {
    models: [
      { id: "opus", note: "alias: the newest Opus" },
      { id: "sonnet", note: "alias: the newest Sonnet" },
      { id: "haiku", note: "alias: the newest Haiku" },
      { id: "fable", note: "alias: the newest Fable" },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    ],
    notes: [
      "Blank: the model set in Claude Code's own settings.",
      "An alias follows the newest model of that family; a full id stays on one model. What you can use depends on your Claude plan.",
    ],
  },
  anthropic: {
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", isDefault: true },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    ],
    notes: ["Blank: claude-opus-5-5. Any model id from Anthropic's models list works."],
  },
  xai: {
    models: [{ id: "grok-4", isDefault: true }],
    notes: ["Blank: grok-4. Any model id from xAI's model list works."],
  },
  gemini: {
    models: [{ id: "gemini-3.8-flash", isDefault: true }],
    notes: [
      "Blank: gemini-3.8-flash. Any model id from Google AI Studio's model list works (ai.google.dev, 'Models').",
      "Thinking can be set in Extra request options, e.g. {\"thinkingConfig\": {\"thinkingLevel\": \"high\"}}.",
    ],
  },
  "vertex-ai": {
    models: [{ id: "gemini-3.8-flash", isDefault: true }],
    notes: [
      "Blank: gemini-3.8-flash. Any Gemini model id from Vertex AI's Model Garden that is available in your location; partner models (Claude, Llama) on Vertex AI use their own APIs and aren't supported here.",
    ],
  },
  "azure-openai": {
    models: [],
    notes: [
      "Required: your deployment name (Azure AI Foundry, 'Deployments'), not the model name. The deployment's model must support structured output (gpt-4o 2024-08-06 or later).",
    ],
  },
  bedrock: {
    models: [],
    notes: [
      "Required: a model id or inference profile id enabled in your region, e.g. an id from `aws bedrock list-foundation-models` or a cross-region profile from `aws bedrock list-inference-profiles` (they start with us., eu., apac. or global.). An ARN works too.",
      "Models without native structured output are asked through a forced tool call instead.",
    ],
  },
  "openai-compatible": {
    models: [],
    notes: [
      "Required: the model name your server knows, e.g. what `ollama list` shows for Ollama, or the model id for OpenAI, Mistral, DeepSeek, Groq or OpenRouter.",
    ],
  },
};

const cache = new Map<string, { at: number; list: ModelList }>();

/**
 * The models for `provider`. `cliPath` (LLM_CLI_PATH) is used only for the provider it was saved
 * with; any other CLI is looked up on PATH, so this never starts a program the user didn't configure.
 */
export async function listModels(provider: string, opts: { cliPath?: string; refresh?: boolean } = {}): Promise<ModelList> {
  if (!isCliProvider(provider) || provider === "claude-code") {
    const fixed = FIXED[provider];
    if (!fixed) throw new Error(`unknown provider '${provider}'`);
    return { provider, source: "fixed", models: fixed.models, notes: fixed.notes };
  }
  const key = `${provider}\0${opts.cliPath ?? ""}`;
  const hit = cache.get(key);
  if (hit && !opts.refresh && Date.now() - hit.at < CACHE_MS) return hit.list;

  const source = CLI_SOURCES[provider];
  const resolved = resolveCli(provider, opts.cliPath);
  const command = `${opts.cliPath || (provider === "codex" ? "codex" : provider === "grok-cli" ? "grok" : "agy")} ${source.args.join(" ")}`;
  const list: ModelList = { provider, source: "cli", command, models: [], notes: source.notes };
  if (!resolved.launch) {
    list.error = resolved.error;
    return list; // not cached: installing the CLI should show up at once
  }
  try {
    const stdout = await run(resolved.launch.file, [...resolved.launch.args, ...source.args]);
    list.models = source.parse(stdout);
    if (!list.models.length) list.error = `${command} listed no models`;
  } catch (err) {
    list.error = err instanceof Error ? err.message : String(err);
  }
  if (!list.error) cache.set(key, { at: Date.now(), list });
  return list;
}

/** Runs a CLI's list command: no shell, none of our secrets, no stdin, and a time limit. */
function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, { env: childEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no answer within ${LIST_TIMEOUT_MS / 1000} s`));
    }, LIST_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-2000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).at(-1)}` : ""}`));
    });
  });
}

/** For tests: the parsers, applied to a CLI's real output. */
export const parseModelList = (provider: Exclude<CliAgentKind, "claude-code">, stdout: string) => CLI_SOURCES[provider].parse(stdout);
