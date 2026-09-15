// #836: the topbar was eight icon-only buttons whose meaning lived in hover
// titles, which a first-timer or a touch user cannot learn, and three of them
// filled with the accent when their panel was open, so the bar at rest read as
// "three things are on" rather than "three panels are open". Where the bar has
// room each button now says its name, dialog openers end in an ellipsis, and
// an open panel is underlined rather than filled.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const app = read("../App.tsx");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The opening tag and body of the <button> a word sits in, up to the word. */
function buttonOf(word: string): string {
  const at = app.indexOf(`<span className="tb-word">${word}</span>`);
  expect(at, word).toBeGreaterThan(-1);
  return app.slice(app.lastIndexOf("<button", at), at);
}

// Each word, and the accessible name it has to be found in (2.5.3).
const WORDS: Array<[word: string, name: RegExp, dialog: boolean]> = [
  ["Session list", /aria-label="Toggle session list"/, false],
  ["Usage", /aria-label="Toggle usage panel"/, false],
  ["Accounts", /aria-label="Toggle accounts panel"/, false],
  ["Machine", /aria-label="Toggle machine detail"/, false],
  ["History…", /aria-label="Open usage history"/, true],
  ["Watch…", /aria-label=\{`Browser watch, /, true],
  ["Sound", /aria-label="Sound settings"/, false],
];

describe("each topbar button can say its name (#836)", () => {
  it("gives all eight a word, inside the accessible name they already have", () => {
    for (const [word, name] of WORDS) {
      const button = buttonOf(word);
      expect(button, word).toMatch(/className=\{?[`"]btn icon-btn/);
      expect(button, word).toMatch(name);
      // The word, minus its ellipsis, is part of the name, so voice control
      // can say what the eye reads.
      const label = /aria-label=(?:"([^"]+)"|\{`([^`]+)`)/.exec(button)!;
      expect((label[1] ?? label[2]).toLowerCase(), word).toContain(word.replace("…", "").toLowerCase());
    }
    // The theme button's word is the mode it switches to, like its name.
    expect(app).toMatch(/<span className="tb-word">\{theme === "dark" \? "Light" : "Dark"\}<\/span>/);
    expect(app).toMatch(/aria-label=\{`Switch to \$\{theme === "dark" \? "light" : "dark"\} mode`\}/);
    expect(app.match(/className="tb-word"/g)).toHaveLength(8);
  });

  it("ends only the two dialog openers in an ellipsis", () => {
    for (const [word, , dialog] of WORDS) {
      expect(word.endsWith("…"), word).toBe(dialog);
      if (dialog) expect(buttonOf(word), word).toMatch(/aria-haspopup="dialog"/);
    }
  });

  it("shows the words only where the bar has room, and lets those buttons grow to hold them", () => {
    expect(css).toMatch(/\n\.tb-word \{ display: none; \}/);
    const wide = /@media \(min-width: 1600px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(wide).toMatch(/\.topbar \.tb-word \{ display: inline; font-size: 12px; line-height: 1; \}/);
    expect(wide).toMatch(/\.topbar button\.btn\.icon-btn:has\(\.tb-word\) \{ width: auto; gap: 6px; padding: 0 10px; \}/);
    // The height is still the one control height (line-height is the word's).
    expect(wide).not.toMatch(/(?<!line-)height/);
  });
});

describe("an open panel is underlined, not filled (#836)", () => {
  const body = (sel: string) => {
    const at = css.indexOf(`${sel} {`);
    return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  };

  it("draws a disclosed region as an accent line along the button's foot", () => {
    const open = body('button.btn.icon-btn[aria-expanded="true"]');
    expect(open).toMatch(/box-shadow: inset 0 -2px 0 var\(--accent\);/);
    expect(open).toMatch(/border-color: var\(--accent\);/);
    expect(open).not.toMatch(/background/);
  });

  it("keeps the fill for a setting that is on, which is what pressed means", () => {
    expect(body('button.btn.icon-btn[aria-pressed="true"]')).toMatch(/background: var\(--accent\);/);
    expect(css).not.toMatch(/icon-btn\[aria-pressed="true"\],\s*button\.btn\.icon-btn\[aria-expanded="true"\]/);
  });
});
