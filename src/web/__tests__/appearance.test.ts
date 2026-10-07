import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CHARACTER_ENABLED_KEY, FM_SOURCE_OPTIONS, resolveCharacterEnabled } from "../appearance";
import { clientText } from "./client-source";
import { sheetText } from "./sheet-source";

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

  it("keeps the station labels in the shared appearance metadata", () => {
    expect(FM_SOURCE_OPTIONS.map(source => source.value)).toEqual([
      "claude-fm", "lofi-relax", "lofi-game", "lofi-vibe", "lofi-sleep",
      "radio-mix", "best-of-nostalgia", "good-life-radio", "cafe-music-bgm",
    ]);
  });

  it("gates the character at its App mount and persists the chosen state", () => {
    // The state and its storage are in use-appearance.ts; the mount is
    // components/BoardFlow.tsx's. Every match is positive, so this reads the client.
    const app = clientText();
    expect(app).toContain("useState(storedCharacterEnabled)");
    expect(app).toContain('writeStored(CHARACTER_ENABLED_KEY, characterEnabled ? "1" : "0")');
    expect(app).toContain("{characterEnabled && (");
    expect(app).toContain("<ClaudeFm");
    expect(app).toContain("muted={fmMuted}");
    expect(app).toContain("source={fmSource}");
  });

  // The Appearance modal became two sections of Settings (2026-10-07): the
  // theme is General's (ThemeSection.tsx), Claude FM and the character are
  // Music & character's (MusicSection.tsx), and the dialog round them is
  // SettingsModal.tsx. Each guarantee below is the one these three cases held
  // the Appearance modal to, read where the code now lives.
  const modal = () => read("components/SettingsModal.tsx");
  const themes = () => read("components/ThemeSection.tsx");
  const music = () => read("components/MusicSection.tsx");

  it("uses a dismissible, accessible centered modal for the appearance settings", () => {
    const styles = sheetText();
    expect(modal()).toContain("useModalDismiss");
    expect(modal()).toContain('role="dialog"');
    expect(modal()).toContain('aria-modal="true"');
    expect(modal()).toContain('className="modal-backdrop"');
    expect(modal()).toContain('className="modal settings-modal"');
    expect(music()).toContain('aria-haspopup="listbox"');
    expect(music()).toContain('role="listbox"');
    expect(music()).toContain('role="option"');
    expect(modal()).toContain('aria-labelledby="settings-title"');
    expect(themes()).toContain('role="radiogroup"');
    expect(themes()).toContain('role="radio"');
    expect(music()).toContain('role="switch"');
    expect(modal()).toContain("onClick={onClose}");
    // Inside the viewport, and the section scrolls rather than the page.
    expect(styles).toContain(".modal.settings-modal");
    expect(styles).toContain("height: min(640px, calc(100vh - 32px))");
    expect(styles).toMatch(/\.settings-pane \{[^}]*overflow-y: auto;/);
    expect(themes()).toContain("onKeyDown={moveTheme}");
    expect(themes()).toContain('"ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"');
  });

  it("is titled, and names each control from the words on screen", () => {
    expect(modal()).toContain('<span id="settings-title" className="modal-tool-name">Settings</span>');
    // The pair is named by its visible caption, and the key that switches it
    // from anywhere is declared on it.
    expect(themes()).toMatch(/role="radiogroup"\s+aria-labelledby="appearance-theme-caption"\s+aria-keyshortcuts="T"/);
    // One tab stop in the pair, on the theme that is set; the arrows walk it.
    expect(themes()).toContain("tabIndex={theme === choice ? 0 : -1}");
    // The previews are pictures; the name is the word under each.
    expect(themes()).toMatch(/<svg viewBox="0 0 112 56" aria-hidden focusable="false">/);
    expect(music()).toContain('aria-labelledby="appearance-character-label"');
    expect(music()).toContain('aria-describedby="appearance-character-note"');
    expect(music()).toContain('aria-describedby="appearance-fm-source-note"');
    expect(music()).toContain('aria-describedby="appearance-fm-volume-note"');
    expect(music()).toContain(">Show character on minimap<");
    // Its own group now, not a row under the music source.
    expect(music()).toMatch(/<h3 id="appearance-character-caption">Character<\/h3>[\s\S]*?>Show character on minimap</);
  });

  it("keeps the whole Claude FM row one control, and Space and T working inside Settings", () => {
    const styles = sheetText();
    expect(music()).toContain('aria-haspopup="listbox"');
    expect(music()).toContain("aria-activedescendant");
    expect(music()).toContain('role="listbox"');
    expect(music()).toContain('role="option"');
    expect(music()).toContain('role="combobox"');
    expect(music()).toContain("scrollIntoView");
    expect(styles).toContain(".appearance-source-list");
    expect(styles).toContain("max-height: min(196px, 24vh)");
    expect(styles).toContain("overflow-y: auto");
    expect(styles).toContain("overscroll-behavior: auto");
    // The row is a <label> round the switch: a press anywhere in it reaches the
    // switch once, and there is still one tab stop.
    expect(music()).toMatch(/<label className="appearance-row">[\s\S]*?role="switch"[\s\S]*?<\/label>/);
    // React Flow cancels Space on the document; Settings keeps it for its own
    // controls. T switches the theme here too, and only without a modifier.
    expect(modal()).toContain('if (event.key === " ") { event.stopPropagation(); return; }');
    expect(modal()).toContain('event.ctrlKey || event.metaKey || event.altKey) return;');
  });
});
