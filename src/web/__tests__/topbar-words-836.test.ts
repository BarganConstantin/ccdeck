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

  it("leaves the appearance button without one, since its icon opens a compact menu", () => {
    const at = app.indexOf("aria-label={`Appearance settings");
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
    expect(wide).toMatch(/\.topbar button\.btn\.icon-btn:has\(\.tb-word\) \{ width: auto; gap: 6px; padding: 0 8px; \}/);
    // The height is still the one control height (line-height is the word's).
    expect(wide).not.toMatch(/(?<!line-)height/);
  });
});

describe("the toolbar is quiet: no chrome at rest, a neutral pressed look when open", () => {
  it("draws a closed control as its glyph and word, with no edge and no fill", () => {
    const rest = body(".topbar button.btn.icon-btn");
    expect(rest).toMatch(/border-color: transparent;/);
    expect(rest).toMatch(/color: var\(--muted\);/);
    expect(rest).not.toMatch(/background/);
  });

  it("answers the pointer with the control fill and the foreground, never the accent", () => {
    const hover = body(".topbar button.btn.icon-btn:hover");
    expect(hover).toMatch(/border-color: transparent;/);
    expect(hover).toMatch(/background: var\(--ctl-fill\);/);
    expect(hover).toMatch(/color: var\(--text\);/);
    expect(body("button.btn:hover")).not.toMatch(/--accent/);
  });

  it("draws an open panel, and Sound with its menu out, as pressed: fill, edge, foreground", () => {
    const open = body('.topbar button.btn.icon-btn[aria-expanded="true"]');
    expect(open).toMatch(/border-color: var\(--ctl-edge\);/);
    expect(open).toMatch(/background: var\(--ctl-fill\);/);
    expect(open).toMatch(/color: var\(--text\);/);
    // No cyan line under it, and no second look for the popover opener.
    expect(css).not.toMatch(/aria-expanded="true"\][^{]*::after/);
    expect(css).not.toMatch(/\[aria-haspopup\]\[aria-expanded="true"\]/);
    expect(app).toMatch(/aria-haspopup="dialog"\s+aria-expanded=\{soundMenuOpen\}/);
  });

  it("groups the panels in two runs and stands the settings apart, by spacing alone", () => {
    expect(app.match(/<div className="action-run">/g)).toHaveLength(2);
    expect(app.match(/<div className="action-run action-run-utility">/g)).toHaveLength(1);
    expect(body(".topbar .action-run")).toMatch(/gap: 4px;/);
    expect(body(".topbar .actions")).toMatch(/gap: 12px;/);
    expect(css).toMatch(/\.topbar \.action-run-utility \{ margin-left: 12px; \}/);
    // The runs are Session list, Usage, History | Accounts, Machine, Browser
    // watch | Sound, theme.
    const second = app.indexOf('<div className="action-run">', app.indexOf('<div className="action-run">') + 1);
    const utility = app.indexOf('<div className="action-run action-run-utility">');
    expect(app.indexOf('aria-label="Open usage history"')).toBeLessThan(second);
    expect(app.indexOf('aria-label="Toggle accounts panel"')).toBeGreaterThan(second);
    expect(app.indexOf("aria-label={`Browser watch, ")).toBeLessThan(utility);
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

  it("keeps the focus ring the sheet's own, in the accent, where focus has a use for it", () => {
    // No topbar override: with no accent frame left to be mistaken for, the
    // shared ring at its shared offset is the right one, and the 4px between
    // two controls keeps it clear of the next.
    expect(css).not.toMatch(/\.topbar button\.btn:focus-visible/);
    expect(css).toMatch(/:focus-visible \{\s*outline: 2px solid var\(--accent\);/);
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

  it("draws the app's ready update in the accent, not the alarm's amber", () => {
    // A download the app has verified is good news; amber is this bar's
    // warning (#1187). Same proportions as the stale chip, other colour, and a
    // dot that holds still, since nothing here needs you until you choose it.
    const ready = body(".topbar .brand button.v.ready");
    expect(ready).toMatch(/color: var\(--accent\);/);
    expect(ready).toMatch(/border-color: var\(--accent\);/);
    expect(ready).not.toMatch(/--warn/);
    expect(body(".topbar .brand button.v.ready:hover")).not.toMatch(/--warn/);
    const dot = body(".topbar .brand button.v.ready .v-dot");
    expect(dot).toMatch(/background: var\(--accent\);/);
    expect(dot).toMatch(/animation: none;/);
    // And the up-to-date chip's quiet look does not reach it.
    expect(css).toContain(".topbar .brand button.v:not(.stale):not(.ready) {");
    expect(css).not.toMatch(/button\.v:not\(\.stale\)(?!:not\(\.ready\))/);
  });

  it("gives the waiting chip the readout on a narrow screen", () => {
    const narrow = media("max-width: 640px");
    // The wordmark leaves the screen but stays the page's <h1>.
    expect(narrow).toMatch(/\.topbar \.brand h1 \{[^}]*clip-path: inset\(50%\);/);
    expect(narrow).not.toMatch(/\.topbar \.brand h1[^{]*\{[^}]*display: none/);
    // An up-to-date version chip goes; a stale one is a warning and stays, and
    // so does the app's ready update, the one way into it from the window.
    expect(narrow).toMatch(/\.topbar \.brand button\.v:not\(\.stale\):not\(\.ready\),/);
    // The chip keeps its number, and its name keeps the whole sentence.
    expect(narrow).toMatch(/\.topbar \.waiting-stat \.ws-word \{ display: none; \}/);
    expect(app).toMatch(/<b>\{waitingSessions\.length\}<\/b> <span className="ws-word">waiting<\/span>/);
    expect(app).toMatch(/aria-label=\{`\$\{waitingSessions\.length\} session/);
  });
});
