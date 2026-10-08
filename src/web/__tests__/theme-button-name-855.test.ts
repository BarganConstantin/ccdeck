// #855: the theme button was named "Toggle theme" whatever the theme was.
//
// Its `aria-label` said what the control is for in general, and it overrode the
// one sentence that says what a press will do — the title, "Switch to light
// mode (T)" — so a screen reader never heard which theme was on or which one
// the press would bring. A button that changes one thing to another is named
// by where it goes; the title already was, and the name now says the same
// words without the key hint.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const app = read("../App.tsx");
/** Where the gear is defined since the panel toggles left for the window's
 *  edges (2026-10-08): its name, its key and what it opens, in rail-items.tsx;
 *  its glyph in components/rail-glyphs.tsx; and the topbar's UtilityRun in
 *  components/EdgeRails.tsx, which draws it. */
const items = read("../rail-items.tsx");
const glyphs = read("../components/rail-glyphs.tsx");
const rails = read("../components/EdgeRails.tsx");
/** The theme choice, which is Settings › General's since the Appearance modal
 *  became Settings (2026-10-07). */
const themes = read("../components/ThemeSection.tsx");
const dialogs = read("../components/DeckDialogs.tsx");

/** The gear's definition, from its id to the next control's. */
const settingsItem = items.slice(items.indexOf('id: "settings"'), items.indexOf('id: "feedback"'));
/** A glyph's body, from its export to the next one. */
const glyph = (name: string) => {
  const at = glyphs.indexOf(`export const ${name}`);
  const next = glyphs.indexOf("export const", at + 1);
  return glyphs.slice(at, next === -1 ? undefined : next);
};

describe("the settings button names what it opens (#855)", () => {
  it("is no longer named for toggling", () => {
    expect(app + "\n" + items + "\n" + rails).not.toMatch(/Toggle theme/);
  });

  it("is named Settings, and the theme is an explicit choice inside it", () => {
    // It used to be the Appearance button, named for the theme and the
    // character it opened. It opens every setting now, so its name says that,
    // and the theme reports itself where it is chosen: one radio per theme,
    // aria-checked on the one that is set. What #855 guarded — a name that
    // says where a press goes rather than "Toggle theme" — is kept; the theme
    // and the character are no longer read out on the button.
    // The title "Settings (⌘,)" is the hint now: the name and the chord's
    // keycap, in the spelling of the keyboard in front of the reader.
    expect(settingsItem).toMatch(/ariaLabel: "Settings"/);
    expect(settingsItem).toMatch(/kind: "dialog"/);
    expect(settingsItem).toMatch(/key: \{ cap: settingsCap, aria: "Control\+, Meta\+,", single: false \}/);
    expect(items).toContain("const settingsCap = settingsChordLabel(platformName());");
    // A modal, so the button says what kind of thing opens and holds no state.
    expect(rails).toMatch(/aria-haspopup=\{disclosure \? undefined : "dialog"\}/);
    expect(app).toMatch(/<UtilityRun items=\{rails\.utilities\}/);
    expect(dialogs).toMatch(/<SettingsModal\b[\s\S]*?appearance=\{appearance\}/);
    expect(themes).toMatch(/role="radiogroup"/);
    expect(themes).toMatch(/onClick=\{\(\) => onTheme\(choice\)\}/);
  });
});

describe("the settings button reads as settings, not as a theme switch", () => {
  const gear = glyph("SettingsGlyph");

  it("draws one gear that does not follow the theme", () => {
    expect(settingsItem).toMatch(/glyph: <SettingsGlyph \/>/);
    expect(gear).not.toMatch(/theme\s*===/);
    expect(gear).not.toMatch(/M11\.8 8\.4A5 5 0 1 1 5\.6 2\.2/);
    expect(gear).not.toMatch(/M7 1\.5v1\.2M7 11\.3v1\.2/);
    // A toothed wheel round a hub: one closed outline and one circle.
    expect(gear.match(/<path\b/g)).toHaveLength(1);
    expect(gear.match(/<circle\b/g)).toHaveLength(1);
    expect(gear).toMatch(/<path d="M5\.4 2\.9L5\.6 1\.1L8\.4 1\.1[^"]*Z" \/>/);
  });

  it("stays apart from the Machine button's processor", () => {
    // The processor is a square with straight pins off it; the gear has no
    // square and its teeth are one outline, so the two never read as one shape.
    expect(glyph("MachineGlyph")).toMatch(/<rect\b/);
    expect(gear).not.toMatch(/<rect\b/);
  });

  it("keeps the chrome's one icon spec", () => {
    // Drawn through the set's one frame, which carries the spec (#837).
    expect(gear).toMatch(/<Glyph>/);
    expect(glyphs).toMatch(/width="13" height="13" viewBox="0 0 14 14" fill="none"\s+stroke="currentColor" strokeWidth="1\.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden/);
  });
});
