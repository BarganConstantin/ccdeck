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

const THEME_BUTTON =
  /onClick=\{\(\) => setTheme\(t => \(t === "dark" \? "light" : "dark"\)\)\}\s*title=\{`([^`]*)`\}\s*aria-label=\{`([^`]*)`\}/;

describe("the theme button says what a press does (#855)", () => {
  it("is no longer named for toggling", () => {
    expect(app).not.toMatch(/aria-label="Toggle theme"/);
  });

  it("names the theme a press switches to, in the words its title uses", () => {
    const m = THEME_BUTTON.exec(app);
    expect(m).not.toBeNull();
    const [, title, label] = m!;
    expect(label).toBe(title.replace(/ \(T\)$/, ""));
    expect(label).toBe('Switch to ${theme === "dark" ? "light" : "dark"} mode');
  });
});
