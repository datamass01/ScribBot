import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EnvSchema, REPO_ROOT } from "../src/config.js";
import { GROUPS, LEGACY_KEYS, SETTINGS } from "../src/settings-catalog.js";

/** KEY=value lines of .env.example (commented-out lines aren't variables). */
function exampleKeys() {
  const text = fs.readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
  return [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
}

describe("settings catalog", () => {
  it("describes every variable in .env.example exactly once, and nothing else", () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...exampleKeys()].filter((k) => !LEGACY_KEYS.includes(k)).sort());
  });

  it("covers every variable the bot reads, with the bot's own default", () => {
    const parsed = EnvSchema.parse({}) as Record<string, unknown>;
    const byKey = new Map(SETTINGS.map((s) => [s.key, s]));
    for (const [key, value] of Object.entries(parsed)) {
      const s = byKey.get(key);
      expect(s, key).toBeDefined();
      expect(s!.readBy, key).toContain("bot");
      expect(s!.default, key).toBe(value === undefined ? "" : String(value));
    }
    for (const key of Object.keys(EnvSchema.shape)) expect(byKey.has(key), key).toBe(true);
  });

  it("is well formed", () => {
    for (const s of SETTINGS) {
      expect(GROUPS, s.key).toContain(s.group);
      expect(s.readBy.length, s.key).toBeGreaterThan(0);
      if (s.type === "enum" || s.type === "bool") expect(s.options?.map((o) => o.value), s.key).toContain(s.default);
      if (s.showIf) expect(SETTINGS.some((o) => o.key === s.showIf!.key), s.key).toBe(true);
      if (s.kindPicker) {
        // Every option sits under exactly one listed kind, and no kind is empty.
        const kinds = s.kindPicker.kinds.map((k) => k.value);
        for (const o of s.options ?? []) expect(kinds, `${s.key}=${o.value}`).toContain(o.kind);
        for (const k of kinds) expect(s.options?.some((o) => o.kind === k), `${s.key} kind ${k}`).toBe(true);
      }
    }
  });

  it("sorts every summary provider under API or CLI, as the providers themselves work", () => {
    const provider = SETTINGS.find((s) => s.key === "LLM_PROVIDER")!;
    const kind = (v: string) => provider.options!.find((o) => o.value === v)!.kind;
    const cliPath = SETTINGS.find((s) => s.key === "LLM_CLI_PATH")!.showIf!.values;
    for (const o of provider.options!) expect(kind(o.value), o.value).toBe(cliPath.includes(o.value) ? "cli" : "api");
  });

  it("matches the generated shared/schemas/settings.json (run npm run schemas)", () => {
    const file = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "shared", "schemas", "settings.json"), "utf8"));
    expect(file.settings).toEqual(JSON.parse(JSON.stringify(SETTINGS)));
  });
});
