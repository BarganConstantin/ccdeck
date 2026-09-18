import { describe, expect, it } from "vitest";
import { CHARACTER_ENABLED_KEY, resolveCharacterEnabled } from "../appearance";

describe("character appearance preference", () => {
  it("shows the character until a user explicitly turns it off", () => {
    expect(resolveCharacterEnabled(null)).toBe(true);
    expect(resolveCharacterEnabled(undefined)).toBe(true);
    expect(resolveCharacterEnabled("1")).toBe(true);
    expect(resolveCharacterEnabled("0")).toBe(false);
  });

  it("uses a stable, namespaced preference key", () => {
    expect(CHARACTER_ENABLED_KEY).toBe("agent-dag.character-enabled");
  });
});
