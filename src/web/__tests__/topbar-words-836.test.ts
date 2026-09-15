// #836: the topbar was eight icon-only buttons whose meaning lived in hover
// titles, which a first-timer or a touch user cannot learn, and three of them
// filled with the accent when their panel was open, so the bar at rest read as
// "three things are on" rather than "three panels are open". Where the bar has
// room each button now says its name, and an open panel is marked by a line
// under its content.
// The critique of that change took the frame off the open state (frame and
// foot drew a raised key), the ellipses off the dialog openers (they read as
// clipped words), the word off the theme button ("Dark" read as the current
// mode), moved History beside Usage, and gave amber back to the alarm.
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

/** The first rule written with exactly this selector, up to its closing brace. */
function body(sel: string): string {
  const at = css.indexOf(`${sel} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
}

/** The body of the first `@media (<query>)` block. */
function media(query: string): string {
  const at = css.indexOf(`@media (${query}) {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("\n}", at));
}

// Each word, and the accessible name it has to be found in (2.5.3).
const WORDS: Array<[word: string, name: RegExp]> = [
  ["Session list", /aria-label="Toggle session list"/],
  ["Usage", /aria-label="Toggle usage panel"/],
  ["History", /aria-label="Open usage history"/],
  ["Accounts", /aria-label="Toggle accounts panel"/],
  ["Machine", /aria-label="Toggle machine detail"/],
  ["Browser watch", /aria-label=\{`Browser watch, /],
  ["Sound", /aria-label=\{`Sound settings, /],
];

describe("each topbar button can say its name (#836)", () => {
  it("gives seven a word, inside the accessible name they already have", () => {
    for (const [word, name] of WORDS) {
      const button = buttonOf(word);
      expect(button, word).toMatch(/className=\{?[`"]btn icon-btn/);
      expect(button, word).toMatch(name);
      // The word is part of the name, so voice control can say what the eye reads.
      const label = /aria-label=(?:"([^"]+)"|\{`([^`]+)`)/.exec(button)!;
      expect((label[1] ?? label[2]).toLowerCase(), word).toContain(word.toLowerCase());
    }
    expect(app.match(/className="tb-word"/g)).toHaveLength(WORDS.length);
  });

  it("leaves the theme button without one, since a sun and a moon need no caption", () => {
    const at = app.indexOf("aria-label={`Switch to ${theme");
    expect(at).toBeGreaterThan(-1);
    expect(app.slice(at, app.indexOf("</button>", at))).not.toMatch(/tb-word/);
  });

  it("ends no word in an ellipsis", () => {
    for (const [, word] of app.matchAll(/className="tb-word">([^<]*)</g)) {
      expect(word).not.toMatch(/…|\.\.\./);
    }
  });

  it("orders the first run by subject, with History beside Usage", () => {
    const names = [
      'aria-label="Toggle session list"',
      'aria-label="Toggle usage panel"',
      'aria-label="Open usage history"',
      'aria-label="Toggle accounts panel"',
      'aria-label="Toggle machine detail"',
      "aria-label={`Browser watch, ",
    ];
    const at = names.map(n => app.indexOf(n));
    for (const [i, n] of names.entries()) expect(at[i], n).toBeGreaterThan(-1);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("shows the words only where the bar has room, and lets those buttons grow to hold them", () => {
    expect(css).toMatch(/\n\.tb-word \{ display: none; \}/);
    const wide = media("min-width: 1440px");
    expect(wide).toMatch(/\.topbar \.tb-word \{ display: inline; font-size: 12px; line-height: 1; \}/);
    expect(wide).toMatch(/\.topbar button\.btn\.icon-btn:has\(\.tb-word\) \{ width: auto; gap: 6px; padding: 0 10px; \}/);
    // The height is still the one control height (line-height is the word's).
    expect(wide).not.toMatch(/(?<!line-)height/);
  });
});

describe("an open panel is underlined, and only underlined", () => {
  it("draws a disclosed region as a line under the button's content", () => {
    const line = body('button.btn.icon-btn[aria-expanded="true"]:not([aria-haspopup])::after');
    expect(line).toMatch(/background: var\(--accent\);/);
    expect(line).toMatch(/height: 2px;/);
    // Inside the padding, clear of the border: a line, not a thicker edge.
    expect(line).toMatch(/left: 10px;/);
    expect(line).toMatch(/right: 10px;/);
    expect(line).toMatch(/bottom: 3px;/);
    expect(body("button.btn.icon-btn")).toMatch(/position: relative;/);
    // No accent frame and no foot inside it: together they drew a raised key.
    expect(css).not.toMatch(/button\.btn\.icon-btn\[aria-expanded="true"\] \{/);
    expect(css).not.toMatch(/inset 0 -2px 0 var\(--accent\)/);
  });

  it("leaves the popover opener out of the line, and holds it while its menu is out", () => {
    expect(app).toMatch(/aria-haspopup="dialog"\s+aria-expanded=\{soundMenuOpen\}/);
    const held = body('button.btn.icon-btn[aria-haspopup][aria-expanded="true"]');
    expect(held).toMatch(/background: var\(--ctl-fill\);/);
    expect(held).toMatch(/border-color: var\(--text\);/);
  });

  it("gives the narrow dollar sign back the air its box adds", () => {
    expect(app).toMatch(/<svg className="tb-glyph-narrow" width="13" height="13" viewBox="0 0 14 14"/);
    expect(app.match(/className="tb-glyph-narrow"/g)).toHaveLength(1);
    // Both sides at once, so a square button still centres it.
    expect(css).toMatch(/\.topbar \.tb-glyph-narrow \{ margin-inline: -2px; \}/);
  });

  it("keeps the fill for a setting that is on, which is what pressed means", () => {
    expect(body('button.btn.icon-btn[aria-pressed="true"]')).toMatch(/background: var\(--accent\);/);
  });

  it("stands the focus ring off the button, so focused does not read as open", () => {
    expect(css).toMatch(/\.topbar button\.btn:focus-visible \{ outline-offset: 3px; \}/);
  });
});

describe("the bar keeps amber for the alarm", () => {
  it("draws Browser watch's unread count as a count, not an alarm", () => {
    expect(body(".bw-badge")).toMatch(/background: var\(--muted\);/);
    // Cut out of the corner it overlaps, not laid over the button's edge.
    expect(body(".bw-badge")).toMatch(/box-shadow: 0 0 0 2px var\(--panel\);/);
    expect(css).not.toMatch(/\.bw-btn\.(?:has-findings|watching)/);
    expect(app).toMatch(/className="btn icon-btn bw-btn"/);
  });

  it("keeps the alarm when the readout gives, and draws no gap for an empty strip", () => {
    // The readout clips from the left, so the wordmark goes before the chip.
    expect(body(".topbar .readout")).toMatch(/justify-content: flex-end;/);
    expect(css).toMatch(/\.topbar \.status:empty \{ display: none; \}/);
    // The ribbon's share of the bar that lets the words start at 1440px.
    expect(body(".selected-ribbon")).toMatch(/max-width: min\(380px, 24vw\);/);
  });

  it("gives the waiting chip the readout on a narrow screen", () => {
    const narrow = media("max-width: 640px");
    // The wordmark leaves the screen but stays the page's <h1>.
    expect(narrow).toMatch(/\.topbar \.brand h1 \{[^}]*clip-path: inset\(50%\);/);
    expect(narrow).not.toMatch(/\.topbar \.brand h1[^{]*\{[^}]*display: none/);
    // An up-to-date version chip goes; a stale one is a warning and stays.
    expect(narrow).toMatch(/\.topbar \.brand button\.v:not\(\.stale\),/);
    // The chip keeps its number, and its name keeps the whole sentence.
    expect(narrow).toMatch(/\.topbar \.waiting-stat \.ws-word \{ display: none; \}/);
    expect(app).toMatch(/<b>\{waitingSessions\.length\}<\/b> <span className="ws-word">waiting<\/span>/);
    expect(app).toMatch(/aria-label=\{`\$\{waitingSessions\.length\} session/);
  });
});
