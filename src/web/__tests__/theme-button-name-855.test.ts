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
const menu = readFileSync(fileURLToPath(new URL("../components/AppearanceMenu.tsx", import.meta.url)), "utf8");

const APPEARANCE_BUTTON =
  /title="Appearance settings"\s*aria-label=\{`([^`]*)`\}[\s\S]*?aria-haspopup="dialog"/;

describe("the appearance button names the settings it opens (#855)", () => {
  it("is no longer named for toggling", () => {
    expect(app).not.toMatch(/aria-label="Toggle theme"/);
  });

  it("reports the current appearance and opens explicit theme choices", () => {
    const m = APPEARANCE_BUTTON.exec(app);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('Appearance settings, ${theme} theme, character ${characterEnabled ? "shown" : "hidden"}');
    expect(menu).toMatch(/role="radiogroup"/);
    expect(menu).toMatch(/onClick=\{\(\) => onTheme\(choice\)\}/);
  });
});
