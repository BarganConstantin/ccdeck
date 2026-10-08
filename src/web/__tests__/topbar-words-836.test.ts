// #836: the topbar was eight icon-only buttons whose meaning lived in hover
// titles, which a first-timer or a touch user cannot learn, and three of them
// filled with the accent when their panel was open, so the bar at rest read as
// "three things are on" rather than "three panels are open". Where the bar had
// room each button said its name, and an open panel was marked by a fill.
// The critique of that change took the frame off the open state (frame and
// foot drew a raised key), the ellipses off the dialog openers (they read as
// clipped words), the word off the theme button ("Dark" read as the current
// mode), and gave amber back to the alarm.
//
// THE CONTROLS LEFT THE BAR FOR THE WINDOW'S EDGES (2026-10-08), and that
// settled what the width tiers were rationing. The words came from 1440px, and
// Feedback's and Settings' only from 1707 and 1761, because eight words beside
// the readout and a selected node's ribbon did not fit a narrower bar. On the
// edges a word runs down a 30px stripe and costs no width at all, so every
// control says its word at every desktop width: Session list and Accounts on
// the left stripe, Usage, Machine, History and Browser watch on the right, and
// Settings and Feedback in the topbar's corner, where two words always fit
// (the bar's budget is topbar-status.css's, held by topbar-ribbon-room and
// topbar-ribbon-cost). On a phone each says a short word under its glyph in
// the dock along the bottom. The three tiers, their measured budgets and the
// `tb-word*` classes are gone on purpose; what they protected — the bar never
// pushed past its width by a word — is now the ribbon tests' arithmetic.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";
import { railItems } from "../rail-items";
import { EdgeDock, EdgeRail, UtilityRun } from "../components/EdgeRails";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const app = read("../App.tsx");
const readouts = read("../components/TopbarReadouts.tsx");
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

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

const noop = () => {};
const ref = () => ({ current: null });
const rails = railItems({
  providers: { kind: "reported", claude: true, codex: true },
  sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
  usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
  setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop,
  openSettings: noop, onFeedback: noop, toggles: { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() },
});
const left = renderToStaticMarkup(createElement(EdgeRail, { side: "left", label: "Left column", groups: [rails.left] }));
const right = renderToStaticMarkup(createElement(EdgeRail, { side: "right", label: "Right panels", groups: rails.right }));
const corner = renderToStaticMarkup(createElement(UtilityRun, { items: rails.utilities }));
const dock = renderToStaticMarkup(createElement(EdgeDock, {
  items: [...rails.left, ...rails.right[0], rails.utilities[0]], more: [...rails.right[1], rails.utilities[1]],
}));

/** Each drawn button's accessible name and the word it shows, in order. */
function buttons(html: string): Array<{ name: string; word: string }> {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(m => ({
    name: /aria-label="([^"]*)"/.exec(m[1])?.[1] ?? "",
    word: /<span class="rail-word"[^>]*>([^<]*)<\/span>/.exec(m[2])?.[1] ?? "",
  }));
}

// Each word, and the accessible name it has to be found in (2.5.3).
const WORDS: Array<[word: string, name: string]> = [
  ["Session list", "Session list"],
  ["Accounts", "Accounts"],
  ["Usage", "Usage"],
  ["Machine", "Machine"],
  ["Usage history", "Usage history"],
  ["Browser watch", "Browser watch, not watching"],
  ["Settings", "Settings"],
  ["Feedback", "Send feedback"],
];

describe("every control in the chrome says its name (#836)", () => {
  const drawn = [...buttons(left), ...buttons(right), ...buttons(corner)];

  it("gives all eight a word, inside the accessible name they have", () => {
    expect(drawn.map(b => [b.word, b.name])).toEqual(WORDS);
    for (const { word, name } of drawn) {
      // The word is part of the name, so voice control can say what the eye reads.
      expect(name.toLowerCase(), word).toContain(word.toLowerCase());
    }
    // The speaker left the bar on 2026-10-07, its "Sound" with it.
    expect(drawn.some(b => /sound/i.test(b.word))).toBe(false);
  });

  it("says it at every desktop width: no rule hides a word on a stripe or on the bar", () => {
    // The tiers that rationed the words to 1440, 1707 and 1761 are gone, and
    // with them every rule that hid one.
    expect(css).not.toMatch(/\.tb-word/);
    const hiders = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, sel, decls]) => /rail-word/.test(sel) && /display:\s*none|visibility:\s*hidden/.test(decls));
    expect(hiders.map(([sel]) => sel.trim())).toEqual([]);
    // Drawn on the stripes and in the corner whenever the window is not a
    // phone's — the dock takes over there, in the same breakpoint.
    expect(app).toMatch(/\{!phone && <div className="actions"><UtilityRun items=\{rails\.utilities\} \/><\/div>\}/);
    expect(app).toMatch(/: <EdgeRail side="left" label="Left column" groups=\{\[rails\.left\]\} \/>\}/);
    expect(app).toMatch(/\{!phone && <EdgeRail side="right" label="Right panels" groups=\{rails\.right\} \/>\}/);
  });

  it("says a short word under each glyph in the phone's dock, and the rest by name behind More", () => {
    const words = buttons(dock).map(b => b.word);
    expect(words).toEqual(["Sessions", "Accounts", "Usage", "Machine", "Settings", "More"]);
    expect(dock).toMatch(/aria-label="More: Usage history, Browser watch, not watching, Send feedback"/);
  });

  it("ends no word in an ellipsis", () => {
    for (const { word } of [...drawn, ...buttons(dock)]) expect(word).not.toMatch(/…|\.\.\./);
  });

  it("orders each edge by what opens there: the left column's two, then the rail's panels before its records", () => {
    // Session list and Accounts share the left column and open there. On the
    // right the two panels that open beside the stripe come first and the two
    // records that open as dialogs after them, 4px apart inside a group and
    // 14px and a --line rule between the groups: spacing alone measured 26px
    // ink to ink against 22 inside one and read as a single run, so a press
    // on the third dropped a dialog where the stripe had promised a panel.
    // History was beside Usage on the bar, by subject; on the right edge it is
    // by what a press does, and it says "Usage history" whole — "History"
    // alone, over Browser watch, read as the browser's.
    expect(buttons(left).map(b => b.word)).toEqual(["Session list", "Accounts"]);
    expect(buttons(right).map(b => b.word)).toEqual(["Usage", "Machine", "Usage history", "Browser watch"]);
    expect(right.match(/<div class="rail-group">/g)).toHaveLength(2);
    expect(body(".edge-rail")).toMatch(/gap: 14px;/);
    expect(body(".rail-group")).toMatch(/gap: 4px;/);
    expect(body(".edge-rail .rail-group + .rail-group")).toMatch(/border-top: 1px solid var\(--line\);/);
  });
});

describe("the chrome is quiet: no edge at rest, a neutral look under the pointer and when open", () => {
  it("draws a closed control as its glyph and word, with no edge and no fill", () => {
    const rest = body(".rail-btn");
    expect(rest).toMatch(/border: 0;/);
    expect(rest).toMatch(/background: transparent;/);
    expect(rest).toMatch(/color: var\(--muted\);/);
  });

  it("answers the pointer with the control fill and the foreground, never the accent", () => {
    // Under a pointer that can hover only (hover: hover): a tap on the dock
    // left a fill behind.
    const hover = body(".rail-btn:hover");
    expect(hover).toMatch(/color: var\(--text\);/);
    expect(hover).toMatch(/background: var\(--ctl-fill\);/);
    expect(css).toMatch(/@media \(hover: hover\) \{\s*\.rail-btn:hover \{/);
    expect(css).not.toMatch(/\.rail-btn[^{]*:hover[^{]*\{[^}]*--accent/);
    expect(body("button.btn:hover")).not.toMatch(/--accent/);
  });

  it("draws an open panel in the foreground on a fill a step past hover's, and its line in --text, not the accent", () => {
    // Open used to be the hover's own --ctl-fill (7%), and a hovered closed
    // button beside an open one was told apart by the line alone; open is 10%
    // of the foreground now, and 14% under the pointer.
    expect(body('.rail-btn[aria-expanded="true"]')).toMatch(/color: var\(--text\);[^}]*background: color-mix\(in srgb, var\(--text\) 10%, transparent\);/);
    // The line on the stripe's inner edge, and on the dock's top edge.
    expect(body(".rail-btn-stripe::before")).toMatch(/background: var\(--text\);/);
    expect(css).toMatch(/\.rail-btn-stripe\[aria-expanded="true"\]::before \{ opacity: 1; transform: none; \}/);
    expect(css).not.toMatch(/\.rail-btn[^{]*\{[^}]*background: var\(--accent\)/);
    // No second look for a popover's opener: the dock's More is one, and it is
    // the same button.
    expect(css).not.toMatch(/\[aria-haspopup\]\[aria-expanded="true"\]/);
  });

  it("holds no aria-pressed control: each discloses a panel or opens a dialog", () => {
    // The pressed fill was for a setting that is on, and no control in the
    // chrome is one since the speaker left (2026-10-07); `.icon-btn` and its
    // pressed look left with the bar's toggles. A disclosure says
    // aria-expanded, a dialog opener aria-haspopup="dialog".
    for (const html of [left, right, corner, dock]) expect(html).not.toMatch(/aria-pressed/);
    expect(right).toMatch(/aria-label="Usage history"[^>]*aria-haspopup="dialog"|aria-haspopup="dialog"[^>]*aria-label="Usage history"/);
    expect(left).toMatch(/aria-expanded="false"/);
  });

  it("gives the narrow dollar sign back the air its box adds", () => {
    expect(read("../components/rail-glyphs.tsx")).toMatch(/export const UsageGlyph = \(\) => \(\s*<Glyph narrow>/);
    // Both sides at once, so the glyph stays centred over its word.
    expect(css).toMatch(/\.rail-btn \.glyph-narrow \{ margin-inline: -2px; \}/);
  });

  it("keeps the focus ring the sheet's own, in the accent, moving only its offset", () => {
    expect(css).toMatch(/:focus-visible \{\s*outline: 2px solid var\(--accent\);/);
    const rings = [...css.matchAll(/([^{}]*rail-btn[^{}]*:focus-visible[^{}]*)\{([^{}]*)\}/g)];
    for (const [, sel, decls] of rings) {
      expect(decls, sel.trim()).not.toMatch(/outline(?:-color)?:\s*[^;]*(?:var\(--(?!accent)|#|rgb)/);
      expect(decls, sel.trim()).not.toMatch(/outline-width/);
    }
  });
});

describe("the bar keeps amber for the alarm", () => {
  it("draws Browser watch's unread count as a count, not an alarm", () => {
    expect(body(".rail-badge")).toMatch(/background: var\(--muted\);/);
    expect(body(".rail-badge")).not.toMatch(/--warn/);
    expect(css).not.toMatch(/\.bw-btn|\.bw-badge/);
  });

  it("keeps the alarm when the readout gives, and draws no gap for an empty strip", () => {
    // The readout clips from the left, so the wordmark goes before the chip.
    expect(body(".topbar .readout")).toMatch(/justify-content: flex-end;/);
    expect(css).toMatch(/\.topbar \.status:empty \{ display: none; \}/);
    // The ribbon's usual share of the bar.
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

  it("gives the waiting chip the readout on a narrow screen, word and all", () => {
    const narrow = media("max-width: 640px");
    // The wordmark leaves the screen but stays the page's <h1>.
    expect(narrow).toMatch(/\.topbar \.brand h1 \{[^}]*clip-path: inset\(50%\);/);
    expect(narrow).not.toMatch(/\.topbar \.brand h1[^{]*\{[^}]*display: none/);
    // An up-to-date version chip goes; a stale one is a warning and stays, and
    // so does the app's ready update, the one way into it from the window.
    expect(narrow).toMatch(/\.topbar \.brand button\.v:not\(\.stale\):not\(\.ready\) \{ display: none; \}/);
    // The chip says its number and its word on a phone too: with every control
    // in the dock, the bar has the room for "2 waiting" whole, and nothing
    // hides the word. Its name keeps the whole sentence.
    expect(css).not.toMatch(/ws-word/);
    expect(readouts).toMatch(/<b>\{waitingSessions\.length\}<\/b> waiting\s*<\/button>/);
  });
});
