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

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
/** The topbar's settings run, where the button is since it left App.tsx's markup. */
const run = readFileSync(fileURLToPath(new URL("../components/TopbarRuns.tsx", import.meta.url)), "utf8");
/** The theme choice, which is Settings › General's since the Appearance modal
 *  became Settings (2026-10-07). */
const themes = readFileSync(fileURLToPath(new URL("../components/ThemeSection.tsx", import.meta.url)), "utf8");
const dialogs = readFileSync(fileURLToPath(new URL("../components/DeckDialogs.tsx", import.meta.url)), "utf8");

/** The gear's opening tag, from its first attribute to its glyph. */
const SETTINGS_BUTTON = /title=\{settingsTitle\}\s*aria-label="([^"]*)"\s*aria-haspopup="dialog"/;

describe("the settings button names what it opens (#855)", () => {
  it("is no longer named for toggling", () => {
    expect(app + "\n" + run).not.toMatch(/aria-label="Toggle theme"/);
  });

  it("is named Settings, and the theme is an explicit choice inside it", () => {
    // It used to be the Appearance button, named for the theme and the
    // character it opened. It opens every setting now, so its name says that,
    // and the theme reports itself where it is chosen: one radio per theme,
    // aria-checked on the one that is set. What #855 guarded — a name that
    // says where a press goes rather than "Toggle theme" — is kept; the theme
    // and the character are no longer read out on the button.
    const m = SETTINGS_BUTTON.exec(run);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("Settings");
    expect(run).toContain("const settingsTitle = `Settings (${settingsChordLabel(platformName())})`;");
    expect(dialogs).toMatch(/<SettingsModal\b[\s\S]*?appearance=\{appearance\}/);
    expect(themes).toMatch(/role="radiogroup"/);
    expect(themes).toMatch(/onClick=\{\(\) => onTheme\(choice\)\}/);
  });
});

describe("the settings button reads as settings, not as a theme switch", () => {
  const at = run.indexOf("title={settingsTitle}");
  const button = run.slice(run.lastIndexOf("<button", at), run.indexOf("</button>", at));

  it("draws one gear that does not follow the theme", () => {
    expect(button.match(/<svg/g)).toHaveLength(1);
    expect(button).not.toMatch(/theme\s*===/);
    expect(button).not.toMatch(/M11\.8 8\.4A5 5 0 1 1 5\.6 2\.2/);
    expect(button).not.toMatch(/M7 1\.5v1\.2M7 11\.3v1\.2/);
    // A toothed wheel round a hub: one closed outline and one circle.
    expect(button.match(/<path\b/g)).toHaveLength(1);
    expect(button.match(/<circle\b/g)).toHaveLength(1);
    expect(button).toMatch(/<path d="M5\.4 2\.9L5\.6 1\.1L8\.4 1\.1[^"]*Z" \/>/);
  });

  it("stays apart from the Machine button's processor", () => {
    // The processor is a square with straight pins off it; the gear has no
    // square and its teeth are one outline, so the two never read as one shape.
    const machineAt = run.indexOf('aria-label="Toggle machine detail"');
    const machine = run.slice(machineAt, run.indexOf("</button>", machineAt));
    expect(machine).toMatch(/<rect\b/);
    expect(button).not.toMatch(/<rect\b/);
  });

  it("keeps the topbar's one icon spec", () => {
    expect(button).toMatch(/width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1\.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden/);
  });
});
