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
    expect(menu).toContain('role="dialog"');
    expect(menu).toContain('aria-labelledby="appearance-title"');
    expect(menu).toContain('role="radiogroup"');
    expect(menu).toContain('role="radio"');
    expect(menu).toContain('role="switch"');
    expect(menu).toContain('addEventListener("pointerdown", onDown, true)');
    expect(menu).toContain("onKeyDown={moveTheme}");
    expect(menu).toContain('"ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"');
  });

  it("is titled for both settings, and names each control from the words on screen", () => {
    const menu = read("components/AppearanceMenu.tsx");
    expect(menu).toContain('<h2 id="appearance-title" className="appearance-title">Appearance</h2>');
    // The pair is named by its visible caption, and the key that switches it
    // from anywhere is declared on it.
    expect(menu).toMatch(/role="radiogroup"\s+aria-labelledby="appearance-theme-caption"\s+aria-keyshortcuts="T"/);
    // One tab stop in the pair, on the theme that is set; the arrows walk it.
    expect(menu).toContain("tabIndex={theme === choice ? 0 : -1}");
    // The previews are pictures; the name is the word under each.
    expect(menu).toMatch(/<svg viewBox="0 0 112 56" aria-hidden focusable="false">/);
    expect(menu).toContain('aria-labelledby="appearance-character-label"');
    expect(menu).toContain('aria-describedby="appearance-character-note"');
    expect(menu).toContain(">Show character on minimap<");
  });

  it("keeps the whole Claude FM row one control, and Space and T working inside the menu", () => {
    const menu = read("components/AppearanceMenu.tsx");
    // The row is a <label> round the switch: a press anywhere in it reaches the
    // switch once, and there is still one tab stop.
    expect(menu).toMatch(/<label className="appearance-row">[\s\S]*?role="switch"[\s\S]*?<\/label>/);
    // React Flow cancels Space on the document; the menu keeps it for its own
    // controls. T switches the theme here too, and only without a modifier.
    expect(menu).toContain('if (event.key === " ") { event.stopPropagation(); return; }');
    expect(menu).toContain('event.ctrlKey || event.metaKey || event.altKey) return;');
  });
});
