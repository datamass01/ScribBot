// FOUNDRY_HEADLESS: ScribBot joining Foundry (session) is the default; blank means the default,
// as for every setting, and true/false are accepted for session/off.
import { describe, expect, it } from "vitest";
import { EnvSchema } from "../src/config.js";

const headless = (value?: string) => EnvSchema.parse(value === undefined ? {} : { FOUNDRY_HEADLESS: value }).FOUNDRY_HEADLESS;

describe("FOUNDRY_HEADLESS", () => {
  it("defaults to session, unset or blank", () => {
    expect(headless()).toBe("session");
    expect(headless("")).toBe("session");
    expect(headless("  ")).toBe("session");
  });

  it("keeps an explicit mode, in any case", () => {
    expect(headless("off")).toBe("off");
    expect(headless("Always")).toBe("always");
    expect(headless(" session ")).toBe("session");
  });

  it("reads booleans as session and off", () => {
    expect(headless("true")).toBe("session");
    expect(headless("yes")).toBe("session");
    expect(headless("false")).toBe("off");
    expect(headless("0")).toBe("off");
  });

  it("rejects anything else", () => {
    expect(() => headless("sometimes")).toThrow();
  });
});
