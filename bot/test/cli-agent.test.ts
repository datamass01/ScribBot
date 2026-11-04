import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CliAgentProvider, childEnv, findCli, npmShimTarget, resolveCli, type CliAgentKind } from "../src/summarize/cli-agent.js";

// A stand-in for `codex` and `agy`: records how it was called, then answers like the real CLI.
// It reads where to log and how to answer from fake-config.json beside it, since it gets none of our
// environment variables and may be started through an npm .cmd wrapper. reply: ok, prose, bad, fail.
const dir = mkdtempSync(path.join(tmpdir(), "scribbot-cli-test-"));
const fake = path.join(dir, "fake-cli.mjs");
const setFake = (log: string, reply: string) => writeFileSync(path.join(dir, "fake-config.json"), JSON.stringify({ log, reply }));
writeFileSync(
  fake,
  `
import { readFileSync, writeFileSync } from "node:fs";
const { log, reply } = JSON.parse(readFileSync(new URL("./fake-config.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const stdin = readFileSync(0, "utf8");
const isClaude = args[0] === "-p";
const isGrok = args[0] === "--prompt-file";
// claude and grok take the schema itself as an argument, the others a file
const schemaArg = args[args.indexOf(args.includes("exec") ? "--output-schema" : "--json-schema") + 1];
const schema = JSON.parse(isClaude || isGrok ? schemaArg : readFileSync(schemaArg, "utf8"));
const prompt = isGrok ? readFileSync(args[1], "utf8") : stdin;
writeFileSync(log, JSON.stringify({ args, stdin, prompt, schema, cwd: process.cwd(), env: process.env }));
const answer = reply === "bad" ? { answer: 42 } : { answer: "hello" };
if (isGrok) {
  if (reply === "fail") {
    console.log(JSON.stringify({ type: "error", message: "Couldn't set model 'x': unknown model id" }));
    process.exit(1);
  }
  console.log(JSON.stringify({ text: JSON.stringify(answer), stopReason: "end_turn", structuredOutput: answer }, null, 2));
} else if (isClaude) {
  const out = reply === "fail"
    ? { type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 429, result: "rate limited" }
    : { type: "result", subtype: "success", is_error: false, result: JSON.stringify(answer), structured_output: answer };
  console.log(JSON.stringify(out));
  if (reply === "fail") process.exit(1);
} else if (args.includes("exec")) {
  if (reply === "fail") { console.error("Error: not logged in"); process.exit(1); }
  const text = reply === "prose" ? "Here you go:\\n\`\`\`json\\n" + JSON.stringify(answer) + "\\n\`\`\`" : JSON.stringify(answer);
  writeFileSync(args[args.indexOf("-o") + 1], text);
  console.log(text);
} else {
  console.log(JSON.stringify({ event: "init", init: {} }));
  const result = reply === "fail"
    ? { status: "ERROR", error: "quota exhausted", finished_reason: "error" }
    : { status: "SUCCESS", response: JSON.stringify(answer), structured_output: answer };
  console.log(JSON.stringify({ event: "result", result }));
  if (reply === "fail") process.exit(1);
}
`,
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const Answer = z.object({ answer: z.string() });
const request = { system: "You are a scribe.", prompt: "Say hello.", schema: Answer, schemaName: "answer", effort: "low" as const };

async function call(kind: CliAgentKind, reply = "ok", model?: string, command?: string) {
  const log = path.join(dir, `${kind}-${reply}.json`);
  setFake(log, reply);
  const launch = command ? undefined : { file: process.execPath, args: [fake] };
  const provider = new CliAgentProvider(kind, { model, command, launch });
  const read = () =>
    JSON.parse(readFileSync(log, "utf8")) as {
      args: string[];
      stdin: string;
      schema: Record<string, unknown>;
      cwd: string;
      env: Record<string, string>;
      prompt: string;
    };
  return { provider, run: () => provider.generateJson(request), read };
}

describe("CliAgentProvider: codex", () => {
  it("runs codex exec read-only with the schema and the prompt on stdin", async () => {
    const { run, read, provider } = await call("codex");
    expect(await run()).toEqual({ answer: "hello" });
    const { args, stdin, schema, cwd } = read();
    expect(args.slice(0, 1)).toEqual(["exec"]);
    expect(args).toEqual(expect.arrayContaining(["--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "-"]));
    expect(args).toContain('model_reasoning_effort="low"');
    expect(args).not.toContain("-m"); // blank LLM_MODEL: Codex's own default
    expect(provider.model).toBe("codex default");
    expect(stdin).toContain("You are a scribe.");
    expect(stdin).toContain("Say hello.");
    expect(schema).toMatchObject({ type: "object", required: ["answer"] });
    expect(schema).not.toHaveProperty("$schema");
    expect(path.basename(cwd)).toMatch(/^scribbot-codex-/); // an empty temp folder, not the repo
  });

  it("passes LLM_MODEL and tolerates code fences", async () => {
    const { run, read } = await call("codex", "prose", "gpt-6.1-sol");
    expect(await run()).toEqual({ answer: "hello" });
    expect(read().args).toEqual(expect.arrayContaining(["-m", "gpt-6.1-sol"]));
  });

  it("rejects output that doesn't match the schema", async () => {
    await expect((await call("codex", "bad")).run()).rejects.toThrow(/did not match the schema/);
  });

  it("reports the exit code and stderr", async () => {
    await expect((await call("codex", "fail")).run()).rejects.toThrow(/exited with code 1: Error: not logged in/);
  });

  it("explains a missing CLI", async () => {
    const provider = new CliAgentProvider("codex", { command: path.join(dir, "no-such-codex.exe") });
    await expect(provider.generateJson(request)).rejects.toThrow(/not found.*LLM_CLI_PATH/);
  });
});

describe("CliAgentProvider: antigravity", () => {
  it("sends the prompt as a stream-json user message and reads structured_output", async () => {
    const { run, read, provider } = await call("antigravity");
    expect(await run()).toEqual({ answer: "hello" });
    const { args, stdin } = read();
    expect(args[0]).toBe("-p=");
    expect(args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--sandbox", "--model", "gemini-3.8-flash"]));
    expect(args).toEqual(expect.arrayContaining(["--effort", "low"]));
    expect(provider.model).toBe("gemini-3.8-flash");
    const msg = JSON.parse(stdin.trim());
    expect(msg.event).toBe("user");
    expect(msg.message.content).toContain("Say hello.");
  });

  it("leaves out --effort when the model id fixes the level", async () => {
    const { run, read } = await call("antigravity", "ok", "gemini-3.8-flash-high");
    await run();
    expect(read().args).not.toContain("--effort");
  });

  it("reports the result's error", async () => {
    await expect((await call("antigravity", "fail")).run()).rejects.toThrow(/antigravity failed: quota exhausted/);
  });
});

describe("CliAgentProvider: claude-code", () => {
  it("runs claude -p with no tools, MCP, skills or settings, the schema inline and the prompt on stdin", async () => {
    const { run, read, provider } = await call("claude-code");
    expect(await run()).toEqual({ answer: "hello" });
    const { args, stdin, schema } = read();
    expect(args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(args).not.toContain("--bare"); // --bare would ignore the Claude sign-in
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]));
    expect(args).toEqual(expect.arrayContaining(["--effort", "low"]));
    expect(args).not.toContain("--model");
    expect(provider.model).toBe("Claude Code default");
    expect(schema).toMatchObject({ type: "object", required: ["answer"] });
    expect(stdin).toContain("Say hello.");
  });

  it("passes LLM_MODEL", async () => {
    const { run, read } = await call("claude-code", "ok", "claude-opus-5-5");
    await run();
    expect(read().args).toEqual(expect.arrayContaining(["--model", "claude-opus-5-5"]));
  });

  it("reports the result's error, not just the exit code", async () => {
    await expect((await call("claude-code", "fail")).run()).rejects.toThrow(/claude failed: error_during_execution: 429: rate limited/);
  });

  it("rejects output that doesn't match the schema", async () => {
    await expect((await call("claude-code", "bad")).run()).rejects.toThrow(/did not match the schema/);
  });

  it("gets no ANTHROPIC_API_KEY, so it uses the Claude sign-in", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    try {
      const { run, read } = await call("claude-code");
      await run();
      expect(read().env).not.toHaveProperty("ANTHROPIC_API_KEY");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe("CliAgentProvider: grok-cli", () => {
  it("runs grok with the prompt in a file, the schema inline and no tools", async () => {
    const { run, read, provider } = await call("grok-cli");
    expect(await run()).toEqual({ answer: "hello" });
    const { args, prompt, schema, cwd } = read();
    expect(args[0]).toBe("--prompt-file");
    expect(path.dirname(args[1]!)).toBe(cwd); // in the empty temp folder, deleted afterwards
    expect(prompt).toContain("You are a scribe.");
    expect(prompt).toContain("Say hello.");
    expect(args).toEqual(expect.arrayContaining(["--output-format", "json", "--tools=", "--disable-web-search", "--no-subagents"]));
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "dontAsk", "--effort", "low"]));
    expect(args).not.toContain("--always-approve");
    expect(args).not.toContain("-m");
    expect(provider.model).toBe("Grok CLI default");
    expect(schema).toMatchObject({ type: "object", required: ["answer"] });
  });

  it("passes LLM_MODEL", async () => {
    const { run, read } = await call("grok-cli", "ok", "grok-4.7");
    await run();
    expect(read().args).toEqual(expect.arrayContaining(["-m", "grok-4.7"]));
  });

  it("reports grok's own error message", async () => {
    await expect((await call("grok-cli", "fail")).run()).rejects.toThrow(/grok failed: Couldn't set model 'x': unknown model id/);
  });

  it("rejects output that doesn't match the schema", async () => {
    await expect((await call("grok-cli", "bad")).run()).rejects.toThrow(/did not match the schema/);
  });
});

describe("the CLI's environment", () => {
  it("gets none of ScribBot's secrets, but keeps what it needs to run and sign in", async () => {
    const secrets = { DISCORD_TOKEN: "discord-secret", API_TOKEN: "api-secret", FOUNDRY_PASSWORD: "pw", ANTHROPIC_API_KEY: "sk" };
    Object.assign(process.env, secrets, { HTTPS_PROXY: "http://proxy:8080", CODEX_HOME: "/codex-home", LC_ALL: "C" });
    try {
      const { run, read } = await call("codex");
      await run();
      const { env } = read();
      for (const key of Object.keys(secrets)) expect(env).not.toHaveProperty(key);
      expect(JSON.stringify(env)).not.toMatch(/discord-secret|api-secret/);
      expect(env).toMatchObject({ HTTPS_PROXY: "http://proxy:8080", CODEX_HOME: "/codex-home", LC_ALL: "C" });
      const keys = Object.keys(env).map((k) => k.toUpperCase());
      expect(keys).toContain("PATH");
      expect(keys).toContain(process.platform === "win32" ? "USERPROFILE" : "HOME");
    } finally {
      for (const key of [...Object.keys(secrets), "HTTPS_PROXY", "CODEX_HOME", "LC_ALL"]) delete process.env[key];
    }
  });

  it("matches names case-insensitively, as Windows does", () => {
    expect(childEnv({ Path: "C:/bin", SystemRoot: "C:/Windows", Discord_Token: "x", xdg_config_home: "/c" })).toEqual({
      Path: "C:/bin",
      SystemRoot: "C:/Windows",
      xdg_config_home: "/c",
    });
  });
});

describe("findCli", () => {
  it("finds an explicit path only if it exists", () => {
    expect(findCli("codex", fake)).toBe(fake);
    expect(findCli("codex", path.join(dir, "missing.exe"))).toBeNull();
  });

  it("searches PATH for the CLI's command", () => {
    const bin = path.join(dir, "bin");
    rmSync(bin, { recursive: true, force: true });
    const exe = path.join(bin, process.platform === "win32" ? "agy.exe" : "agy");
    mkdirSync(bin);
    writeFileSync(exe, "");
    expect(findCli("antigravity", undefined, { PATH: bin })).toBe(exe);
    expect(findCli("codex", undefined, { PATH: bin })).toBeNull();
  });

  it("prefers a Windows .exe to an npm .cmd wrapper, and reads Path in any case", () => {
    const bin = path.join(dir, "winbin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "codex.cmd"), "");
    expect(findCli("codex", undefined, { Path: bin }, "win32")).toBe(path.join(bin, "codex.cmd"));
    writeFileSync(path.join(bin, "codex.exe"), "");
    expect(findCli("codex", undefined, { Path: bin }, "win32")).toBe(path.join(bin, "codex.exe"));
    expect(findCli("codex", undefined, { Path: bin }, "linux")).toBeNull(); // no extensions off Windows
  });
});

// What `npm install -g @openai/codex` writes on Windows (cmd-shim), with the script path swapped in.
const npmShim = (rel: string) => `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*
`;

describe("resolveCli", () => {
  it("reads the script out of an npm .cmd wrapper", () => {
    const shim = path.join("C:", "npm", "codex.cmd");
    expect(npmShimTarget(npmShim("node_modules\\@openai\\codex\\bin\\codex.js"), shim)).toBe(
      path.join(path.dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js"),
    );
    expect(npmShimTarget('@echo off\r\n"%~dp0\\real.exe" %*\r\n', shim)).toBeNull(); // not npm's
    expect(npmShimTarget(npmShim("x").replace('SET "_prog=node"', 'SET "_prog=/bin/sh"'), shim)).toBeNull();
  });

  it("starts a .js file with the bot's own Node", () => {
    expect(resolveCli("codex", fake)).toEqual({ launch: { file: process.execPath, args: [fake] } });
  });

  it("starts a program directly", () => {
    const exe = path.join(dir, process.platform === "win32" ? "direct.exe" : "direct");
    writeFileSync(exe, "");
    expect(resolveCli("codex", exe)).toEqual({ launch: { file: exe, args: [] } });
  });

  it("reports a missing CLI", () => {
    expect(resolveCli("antigravity", undefined, { PATH: path.join(dir, "empty") })).toEqual({ error: "agy not found" });
  });

  it("refuses Windows scripts that aren't npm wrappers", () => {
    const bat = path.join(dir, "codex.bat");
    writeFileSync(bat, '@echo off\r\n"C:\\Tools\\codex.exe" %*\r\n');
    expect(resolveCli("codex", bat, process.env, "win32").error).toMatch(/can't start safely.*LLM_CLI_PATH/);
    const ps1 = path.join(dir, "codex.ps1");
    writeFileSync(ps1, "& codex.exe @args");
    expect(resolveCli("codex", ps1, process.env, "win32").error).toMatch(/can't start safely/);
  });

  // End to end: an npm wrapper whose script is the fake CLI, run as `node fake-cli.mjs`, never via cmd.exe.
  it.runIf(process.platform === "win32")("runs a CLI installed by npm on Windows", async () => {
    const shim = path.join(dir, "codex.cmd");
    writeFileSync(shim, npmShim("fake-cli.mjs").replace(/\n/g, "\r\n"));
    expect(resolveCli("codex", shim)).toEqual({ launch: { file: process.execPath, args: [fake] } });
    const { run, read } = await call("codex", "ok", undefined, shim);
    expect(await run()).toEqual({ answer: "hello" });
    expect(read().args[0]).toBe("exec");
  });
});
