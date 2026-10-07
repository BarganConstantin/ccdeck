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
import { sheetText } from "./sheet-source";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
// The topbar's three action runs moved to components/TopbarRuns.tsx and its readouts to
// components/TopbarReadouts.tsx; App.tsx and they are read as one.
const app = read("../App.tsx") + "\n" + read("../components/TopbarRuns.tsx") + "\n" + read("../components/TopbarReadouts.tsx");
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

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
];

describe("each topbar button can say its name (#836)", () => {
  it("gives six a word, inside the accessible name they already have", () => {
    // Seven until the speaker left the bar (2026-10-07), its "Sound" with it.
    expect(app).not.toMatch(/className="tb-word">Sound</);
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

  it("gives the gear its word only from the width the busiest bar holds it, not with these six", () => {
    // The Appearance button stood here glyph-only; the gear that replaced it
    // says "Settings", but on its own later tier (`tb-word-wider`), measured
    // below, rather than from 1440 with the seven: at 1440 the busiest bar has
    // no room for one more word.
    const at = app.indexOf('aria-label="Settings"');
    expect(at).toBeGreaterThan(-1);
    const button = app.slice(app.lastIndexOf("<button", at), app.indexOf("</button>", at));
    expect(button).not.toMatch(/className="tb-word"/);
    expect(button).toMatch(/<span className="tb-word-wider">Settings<\/span>/);
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

// FEEDBACK'S WORD AGAINST THE BUSIEST BAR (#1853). The busiest bar is #737's
// case (topbar-status.css): a blocked session, "this month" at its widest and a
// selected node whose name fills any cap, with the ribbon's cap taking the
// rest of the bar. #737's reserve for it no longer holds — measured on the
// owner's deck in Chromium at 1440 on 2026-09-30, everything but the ribbon
// comes to 1302px (the brand with its version chip 142, "this month 19.05B
// tokens · $12.4k" 209, "1 waiting" 84, the controls with Feedback as a glyph
// 735, gaps and padding 84), where the reserve assumes 1213 — so a word added
// to the bar is held to the measured figure, not to the reserve. Feedback's
// word is 62 of it: the button is 92px with the word and a 30px square
// without. The 40px of headroom is #737's, for faces wider than the one
// measured.
// The speaker left the controls on 2026-10-07. Measured in Chromium on a demo
// deck at 1440 before and after, the controls came down from 735.3px to
// 658.1px — the speaker's button with its word, 73.1, and the 4px gap after
// it — so the bar is 77px narrower, everything else in it unchanged.
const SOUND_BUTTON_PX = 77;
const BUSIEST_BAR_PX = 1302 - SOUND_BUTTON_PX;
const FEEDBACK_WORD_PX = 62;
const HEADROOM_PX = 40;

describe("Feedback says its word only where the busiest bar still fits", () => {
  const wordClass = /<span className="(tb-word[\w-]*)">Feedback<\/span>/.exec(app)?.[1];
  /** Where the word is drawn from: the min-width of the block that shows it. */
  const shownFrom = (() => {
    const at = [...css.matchAll(/@media \(min-width: (\d+)px\) \{([^@]*)/g)]
      .find(m => m[2].includes(`.topbar .${wordClass} { display: inline;`));
    return at ? Number(at[1]) : null;
  })();
  const reserve = Number(/@media \(min-width: 1440px\) \{\s*\.selected-ribbon \{ max-width: min\(380px, calc\(100vw - (\d+)px\)\); \}/.exec(css)?.[1]);

  it("never draws the word where it would push the busiest bar past its width", () => {
    expect(wordClass, "the Feedback button's word").toBeTruthy();
    expect(shownFrom, "the breakpoint that shows it").not.toBeNull();
    expect(reserve).toBeGreaterThan(1000);
    for (let w = shownFrom!; w <= 2560; w++) {
      const ribbon = Math.min(380, w - reserve);
      expect(BUSIEST_BAR_PX + FEEDBACK_WORD_PX + ribbon + HEADROOM_PX, `at ${w}px`).toBeLessThanOrEqual(w);
    }
  });

  it("draws it from the first width that holds it, and no later", () => {
    // It was drawn with the seven from 1440, where the busiest bar had no room
    // for it. The first width that holds it is the measured bar, its own
    // width, the ribbon's full cap and the headroom; a later breakpoint would
    // hide the word for nothing.
    expect(wordClass).toBe("tb-word-wide");
    expect(shownFrom).toBe(BUSIEST_BAR_PX + FEEDBACK_WORD_PX + 380 + HEADROOM_PX);
    expect(css).toMatch(/\n\.tb-word-wide \{ display: none; \}/);
    const wide = media(`min-width: ${shownFrom}px`);
    expect(wide).toMatch(/\.topbar \.tb-word-wide \{ display: inline; font-size: 12px; line-height: 1; \}/);
    expect(wide).toMatch(/\.topbar button\.btn\.icon-btn:has\(\.tb-word-wide\) \{ width: auto; gap: 6px; padding: 0 8px; \}/);
    // Its own class, so the seven's 1440 rule never draws it early.
    expect(app.match(/className="tb-word-wide"/g)).toHaveLength(1);
  });

  it("says a word its accessible name contains, and a tooltip that says the same", () => {
    const at = app.indexOf('<span className="tb-word-wide">Feedback</span>');
    const button = app.slice(app.lastIndexOf("<button", at), at);
    expect(button).toMatch(/aria-label="Send feedback"/);
    expect(button).toMatch(/title="Send feedback/);
  });

  it("rests, without its word, at the tone the labelled controls rest at, never a fainter one", () => {
    // The glyph alone could not be found beside the words. Under 1707 it is
    // the glyph alone again, so what it may not do is sink below them: it is
    // the toolbar's own button, drawn by the rule that draws the seven, and
    // nothing in the sheet quietens it.
    const at = app.indexOf('<span className="tb-word-wide">Feedback</span>');
    const button = app.slice(app.lastIndexOf("<button", at), at);
    // `tb-fold` only folds it into the ⋯ at a phone's width (TopbarMore.tsx).
    expect(button).toMatch(/^<button\s+className="btn icon-btn tb-fold"\s/);
    expect(button).not.toMatch(/style=/);
    expect(body(".topbar button.btn.icon-btn")).toMatch(/color: var\(--muted\);/);
    const aimed = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, sel]) => /tb-word-wide|Send feedback/.test(sel));
    expect(aimed.length).toBeGreaterThan(0);
    for (const [, sel, decls] of aimed) {
      expect(decls, sel.trim()).not.toMatch(/(?:^|;)\s*(?:color|opacity|filter|visibility)\s*:/);
    }
  });
});

/** The word "Settings" on the gear, measured in Chromium on a live deck: the
 *  gear's button with the word less the button with the glyph alone. */
const SETTINGS_WORD_PX = 54;

describe("Settings says its word only where the busiest bar still fits it, beside Feedback's", () => {
  /** Where the word is drawn from: the min-width of the block that shows it. */
  const shownFrom = (() => {
    const at = [...css.matchAll(/@media \(min-width: (\d+)px\) \{([^@]*)/g)]
      .find(m => m[2].includes(".topbar .tb-word-wider { display: inline;"));
    return at ? Number(at[1]) : null;
  })();
  const feedbackFrom = BUSIEST_BAR_PX + FEEDBACK_WORD_PX + 380 + HEADROOM_PX;
  const reserve = Number(/@media \(min-width: 1440px\) \{\s*\.selected-ribbon \{ max-width: min\(380px, calc\(100vw - (\d+)px\)\); \}/.exec(css)?.[1]);

  it("never draws it where both words would push the busiest bar past its width", () => {
    expect(shownFrom, "the breakpoint that shows it").not.toBeNull();
    // Feedback's word is up from its own width, so this one counts both.
    expect(shownFrom!).toBeGreaterThanOrEqual(feedbackFrom);
    for (let w = shownFrom!; w <= 2560; w++) {
      const ribbon = Math.min(380, w - reserve);
      expect(BUSIEST_BAR_PX + FEEDBACK_WORD_PX + SETTINGS_WORD_PX + ribbon + HEADROOM_PX, `at ${w}px`).toBeLessThanOrEqual(w);
    }
  });

  it("draws it from the first width that holds it, and no later", () => {
    expect(shownFrom).toBe(BUSIEST_BAR_PX + FEEDBACK_WORD_PX + SETTINGS_WORD_PX + 380 + HEADROOM_PX);
    expect(css).toMatch(/\n\.tb-word-wider \{ display: none; \}/);
    const wide = media(`min-width: ${shownFrom}px`);
    expect(wide).toMatch(/\.topbar button\.btn\.icon-btn:has\(\.tb-word-wider\) \{ width: auto; gap: 6px; padding: 0 8px; \}/);
    expect(app.match(/className="tb-word-wider"/g)).toHaveLength(1);
  });

  it("says a word its accessible name is, and rests at the labelled controls' tone without it", () => {
    const at = app.indexOf('<span className="tb-word-wider">Settings</span>');
    const button = app.slice(app.lastIndexOf("<button", at), at);
    expect(button).toMatch(/aria-label="Settings"/);
    expect(button).toMatch(/^<button\s+className="btn icon-btn"\s/);
    expect(button).not.toMatch(/style=/);
    const aimed = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, sel]) => /tb-word-wider/.test(sel));
    expect(aimed.length).toBeGreaterThan(0);
    for (const [, sel, decls] of aimed) {
      expect(decls, sel.trim()).not.toMatch(/(?:^|;)\s*(?:color|opacity|filter|visibility)\s*:/);
    }
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

  it("draws an open panel as pressed: fill, edge, foreground", () => {
    const open = body('.topbar button.btn.icon-btn[aria-expanded="true"]');
    expect(open).toMatch(/border-color: var\(--ctl-edge\);/);
    expect(open).toMatch(/background: var\(--ctl-fill\);/);
    expect(open).toMatch(/color: var\(--text\);/);
    // No cyan line under it, and no second look for a popover's opener — the
    // phone bar's ⋯ is one, as the speaker was until it left the bar.
    expect(css).not.toMatch(/aria-expanded="true"\][^{]*::after/);
    expect(css).not.toMatch(/\[aria-haspopup\]\[aria-expanded="true"\]/);
  });

  it("groups the panels in two runs and stands the settings apart, by spacing alone", () => {
    // The three runs are components/TopbarRuns.tsx's, and App.tsx draws them
    // in order.
    const runs = read("../components/TopbarRuns.tsx");
    const appOnly = read("../App.tsx");
    expect(runs.match(/<div className="action-run">/g)).toHaveLength(2);
    expect(appOnly.match(/<div className="action-run">/g)).toBeNull();
    expect(runs.match(/<div className="action-run action-run-utility">/g)).toHaveLength(1);
    expect(appOnly.match(/<div className="action-run action-run-utility">/g)).toBeNull();
    expect(body(".topbar .action-run")).toMatch(/gap: 4px;/);
    expect(body(".topbar .actions")).toMatch(/gap: 12px;/);
    expect(css).toMatch(/\.topbar \.action-run-utility \{ margin-left: 12px; \}/);
    // The runs are Session list, Usage, History | Accounts, Machine, Browser
    // watch | Settings, Feedback.
    const second = runs.indexOf('<div className="action-run">', runs.indexOf('<div className="action-run">') + 1);
    expect(runs.indexOf('aria-label="Open usage history"')).toBeLessThan(second);
    expect(runs.indexOf('aria-label="Toggle accounts panel"')).toBeGreaterThan(second);
    expect(runs.indexOf("aria-label={`Browser watch, ")).toBeGreaterThan(second);
    const actions = appOnly.slice(appOnly.indexOf('<div className="actions">'));
    expect(actions.indexOf("<SessionRun")).toBeGreaterThan(-1);
    expect(actions.indexOf("<SessionRun")).toBeLessThan(actions.indexOf("<SourceRun"));
    expect(actions.indexOf("<SourceRun")).toBeLessThan(actions.indexOf("<SettingsRun"));
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
    expect(app).toMatch(/className="btn icon-btn bw-btn tb-fold"/);
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
