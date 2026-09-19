import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CHARACTER_ENABLED_KEY, resolveCharacterEnabled } from "../appearance";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, "..", name), "utf8");

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

  it("gates the character at its App mount and persists the chosen state", () => {
    const app = read("App.tsx");
    expect(app).toContain("useState(storedCharacterEnabled)");
    expect(app).toContain('localStorage.setItem(CHARACTER_ENABLED_KEY, characterEnabled ? "1" : "0")');
    expect(app).toContain("{characterEnabled && <ClaudeFm />}");
  });

  it("uses a dismissible, accessible popover for the two appearance settings", () => {
    const menu = read("components/AppearanceMenu.tsx");
    expect(menu).toContain("useModalDismiss");
    expect(menu).toContain('role="dialog" aria-label="Appearance settings"');
    expect(menu).toContain('role="radiogroup"');
    expect(menu).toContain('role="radio"');
    expect(menu).toContain('role="switch"');
    expect(menu).toContain('addEventListener("pointerdown", onDown, true)');
    expect(menu).toContain("onKeyDown={moveTheme}");
    expect(menu).toContain('"ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"');
  });
});
