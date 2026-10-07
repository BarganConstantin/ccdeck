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
const menu = readFileSync(fileURLToPath(new URL("../components/AppearanceMenu.tsx", import.meta.url)), "utf8");

const APPEARANCE_BUTTON =
  /title="Appearance settings"\s*aria-label=\{`([^`]*)`\}[\s\S]*?aria-haspopup="dialog"/;

describe("the appearance button names the settings it opens (#855)", () => {
  it("is no longer named for toggling", () => {
    expect(app + "\n" + run).not.toMatch(/aria-label="Toggle theme"/);
  });

  it("reports the current appearance and opens explicit theme choices", () => {
    // App.tsx hands the run the appearance whole, and the run names the button.
    expect(app).toMatch(/<SettingsRun\b[^>]*\bappearance=\{appearance\}/);
    const m = APPEARANCE_BUTTON.exec(run);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('Appearance settings, ${theme} theme, character ${characterEnabled ? "shown" : "hidden"}');
    expect(menu).toMatch(/role="radiogroup"/);
    expect(menu).toMatch(/onClick=\{\(\) => onTheme\(choice\)\}/);
  });
});

describe("the appearance button reads as settings, not as a theme switch", () => {
  const at = run.indexOf('title="Appearance settings"');
  const button = run.slice(run.lastIndexOf("<button", at), run.indexOf("</button>", at));

  it("draws one sliders glyph that does not follow the theme", () => {
    expect(button.match(/<svg/g)).toHaveLength(1);
    expect(button).not.toMatch(/theme\s*===/);
    expect(button).not.toMatch(/M11\.8 8\.4A5 5 0 1 1 5\.6 2\.2/);
    expect(button).not.toMatch(/M7 1\.5v1\.2M7 11\.3v1\.2/);
    expect(button.match(/<circle\b/g)).toHaveLength(3);
    expect(button).toMatch(/M1\.5 3h4\.3M9\.2 3h3\.3M1\.5 7h1\.3M6\.2 7h6\.3M1\.5 11h6\.3M11\.2 11h1\.3/);
  });

  it("keeps the topbar's one icon spec", () => {
    expect(button).toMatch(/width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1\.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden/);
  });
});
