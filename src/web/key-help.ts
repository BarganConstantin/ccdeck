// Every keystroke and gesture the deck answers, written down once.
//
// The deck spent three releases getting quieter — the search box went in
// 1.38.0, the sessions counter in 1.39.0, the sessions-list button in 1.41.0 —
// and each of those removals was right on its own. Together they moved the
// product from "several ways to find things, plus shortcuts" to "shortcuts,
// plus a sheet listing them", which is a coherent design and a much less
// forgiving one: the sheet stops being a reminder and becomes the only place a
// feature exists.
//
// Three keys had never reached it. F fits the view, J and K walk the canvas
// agent by agent, and with the search gone J and K are the ONLY way to visit a
// forty-node canvas one agent at a time — undiscoverable, on a deck that had
// just removed the alternatives. The finish sound had a control and no key at
// all, and shift-clicking that control put the user's own parked hooks back,
// which is a recovery action that existed in exactly one place: the source.
//
// So the list lives here rather than inside a component. Three things follow
// from that and all three are the reason:
//
//  - the sheet and the detail rail's short list are rendered from one table, so
//    they cannot drift into disagreeing about what a key does;
//  - a plain-node test can hold the table against App.tsx's keydown handler and
//    fail when a key is bound and not written down (see key-help.test.ts) —
//    which is the check that would have caught F, J and K the day they landed;
//  - the mouse-only gestures get written down at all. A gesture with no key, no
//    control and no documentation is not a feature that shipped; it is one
//    remembered by whoever wrote it.
//
// `binds` is the honest half. It is the literal `e.key` values App.tsx compares
// against, not a pretty spelling, because the test that keeps this table
// complete has to compare like with like.
import type { IntegrationKind } from "./integrations/types";
import { isCharacterKey } from "./single-key-shortcuts";
import { t } from "./i18n";

/** One line of the sheet: what you press, and what happens. */
export interface KeyHelpRow {
  /** What the user presses or does, spelled the way it is printed on the cap.
   *  A mouse gesture goes here too — the sheet is about reaching a feature, and
   *  the hand does not care which device the deck listens on. */
  cap: string;
  /** The cap on a Mac, where a chord is spelled with ⌘ rather than Ctrl. Only
   *  a row whose keys differ by platform carries one; the sheet draws it in
   *  place of `cap` on an Apple keyboard (platform.ts). */
  macCap?: string;
  /** What it does, as an action rather than as a promise about the key. The
   *  distinction matters: `ownsKeystroke()` in shortcuts.ts hands every bare
   *  key to whichever control has focus, so "Re-layout (R)" read while focus
   *  sits in a dialog is a small lie. A two-column table of bindings, with the
   *  note the sheet opens on, says the true thing instead. */
  action: string;
  /** The literal `e.key` values the app answers, so a test can hold this table
   *  against the handler rather than against somebody's memory of it. Empty for
   *  a mouse gesture, which binds no key by definition. */
  binds: readonly string[];
  /** True for a row whose key is pressed with Ctrl or Cmd. Its bind is still a
   *  character (","), but a chord is not a single-key shortcut, so the row
   *  stays on the sheet when those are turned off. */
  chord?: boolean;
  /** The integration a row opens. The row is on the sheet only where the deck
   *  offers that kind (integrations/client.ts, kindOffered): a deck that
   *  offers none answers no such key. */
  integration?: IntegrationKind;
}

export interface KeyHelpGroup {
  /** A stable name for the group, whatever language its title is in. */
  id: string;
  title: string;
  rows: readonly KeyHelpRow[];
}

/** The one line under the keys (#852).
 *
 *  It used to open the sheet as a paragraph about focus internals, which put a
 *  limitation ahead of the reference the reader came for. #851 removed most of
 *  the cause: a control the pointer just pressed no longer keeps the letter
 *  keys. What is left is a control the KEYBOARD put focus on, which still owns
 *  its keys (a bare "c" from a focused dropdown used to truncate the event
 *  log), and this sheet, which takes focus while it is open. Esc is the way out
 *  of both, and it is the last row of the fourth group — so that is all the
 *  line says. */
export const KEY_HELP_NOTE = "Press Esc first if a key does nothing.";

export const KEY_HELP: readonly KeyHelpGroup[] = [
  {
    id: "canvas",
    get title() { return t("settings.key.group.canvas"); },
    rows: [
      { cap: "Space", get action() { return t("settings.key.pause"); }, binds: [" "] },
      { cap: "J", get action() { return t("settings.key.next"); }, binds: ["j", "J"] },
      { cap: "K", get action() { return t("settings.key.prev"); }, binds: ["k", "K"] },
      { cap: "W", get action() { return t("settings.key.waiting"); }, binds: ["w", "W"] },
      // New in 4.0. N walks the same queue as W (one cursor), and Shift+N goes
      // the other way, so the row binds the letter and the sheet says Shift
      // the way it does for Shift + Enter. With the Command Panel open both
      // are its "next ask" (terminal-keys.ts), as n was before 4.0.
      { cap: "N", action: "the next one waiting on you — W does the same", binds: ["n", "N"] },
      { cap: "Shift + N", action: "the previous one waiting, on the board", binds: ["N"] },
      { cap: "P", action: "peek at the selected card without opening it", binds: ["p", "P"] },
      { cap: "F", get action() { return t("settings.key.fit"); }, binds: ["f", "F"] },
      { cap: "Z", get action() { return t("settings.key.zoom"); }, binds: ["z", "Z"] },
      { cap: "Delete", get action() { return t("settings.key.delete"); }, binds: ["Delete"] },
      { cap: "R", get action() { return t("settings.key.rearrange"); }, binds: ["r", "R"] },
      // Re-arrange's way back, for the few seconds the canvas offers it, after
      // R or the stack's button alike. A chord, so it stays on the sheet with
      // the single-key shortcuts off, where the button still re-arranges.
      { cap: "Ctrl + Z", macCap: "⌘ Z", get action() { return t("settings.key.undo"); }, binds: ["z", "Z"], chord: true },
      { cap: "C", get action() { return t("settings.key.clear"); }, binds: ["c", "C"] },
    ],
  },
  {
    id: "panels-and-dialogs",
    get title() { return t("settings.key.group.panels"); },
    rows: [
      // Quick open (quick-open.ts): every row below, and the sessions, the
      // settings and the themes, by name. A chord, so it stays on the sheet
      // with the single-key shortcuts off; ⌘ on a Mac, where Ctrl+K belongs
      // to the text field.
      { cap: "Ctrl + K", macCap: "⌘ K", get action() { return t("settings.key.quick"); }, binds: ["k", "K"], chord: true },
      { cap: "U", get action() { return t("settings.key.usage"); }, binds: ["u", "U"] },
      { cap: "L", get action() { return t("settings.key.sessions"); }, binds: ["l", "L"] },
      { cap: "D", get action() { return t("settings.key.detail"); }, binds: ["d", "D"] },
      { cap: "H", get action() { return t("settings.key.history"); }, binds: ["h", "H"] },
      // Drawn where a CLI with accounts is, and the key is guarded the same way:
      // see the handler in use-deck-shortcuts.ts.
      { cap: "A", get action() { return t("settings.key.accounts"); }, binds: ["a", "A"] },
      // #826: the three topbar panels that were pointer-only.
      { cap: "S", get action() { return t("settings.key.machine"); }, binds: ["s", "S"] },
      { cap: "B", get action() { return t("settings.key.bw"); }, binds: ["b", "B"] },
      // Drawn once a Jira connection exists (#2178); the key does nothing before.
      // On the sheet only where the deck offers Jira (keyHelpFor).
      { cap: "I", get action() { return t("settings.key.jira"); }, binds: ["i", "I"], integration: "jira" },
      { cap: "?", get action() { return t("settings.key.sheet"); }, binds: ["?"] },
    ],
  },
  {
    id: "settings",
    get title() { return t("settings.key.group.settings"); },
    rows: [
      // The chord every desktop app opens its settings with, and the one
      // chord the deck claims for itself (use-deck-shortcuts.ts). Both
      // spellings work on every platform; the sheet prints the one on the
      // keyboard in front of the reader.
      { cap: "Ctrl + ,", macCap: "⌘ ,", get action() { return t("settings.key.all"); }, binds: [","], chord: true },
      // Settings at its Sounds section, on every machine. V opened the topbar
      // speaker's quick popover (#826) until the speaker left the bar
      // (2026-10-07); everything that popover held is in this section.
      { cap: "V", get action() { return t("settings.key.sound"); }, binds: ["v", "V"] },
      // The one-press route to silence from anywhere, and the only one with no
      // dialog in the way: the switch it flips is in Settings › Sounds, the
      // row above.
      { cap: "M", get action() { return t("settings.key.mute"); }, binds: ["m", "M"] },
      // Every theme in turn, in Settings › Appearance's order, not a
      // light/dark pair — and from inside a dialog too, the one letter that
      // goes through one (use-deck-shortcuts.ts).
      { cap: "T", get action() { return t("settings.key.theme"); }, binds: ["t", "T"] },
    ],
  },
  {
    id: "focus-and-selection",
    get title() { return t("settings.key.group.focus"); },
    rows: [
      // Tab binds no key of the deck's: it is the browser's, and it is here
      // because reaching a card is the step every row under it depends on.
      { cap: "Tab", get action() { return t("settings.key.tab"); }, binds: [] },
      { cap: "Enter", get action() { return t("settings.key.enter"); }, binds: ["Enter"] },
      { cap: "Shift + Enter", get action() { return t("settings.key.shiftEnter"); }, binds: ["Enter"] },
      { cap: "Esc", get action() { return t("settings.key.esc"); }, binds: ["Escape"] },
    ],
  },
  {
    id: "mouse",
    get title() { return t("settings.key.group.mouse"); },
    rows: [
      { get cap() { return t("settings.key.cap.drag"); }, get action() { return t("settings.key.drag"); }, binds: [] },
      { get cap() { return t("settings.key.cap.shiftClick"); }, get action() { return t("settings.key.shiftClick"); }, binds: [] },
      { get cap() { return t("settings.key.cap.click"); }, get action() { return t("settings.key.click"); }, binds: [] },
      { get cap() { return t("settings.key.cap.doubleClick"); }, get action() { return t("settings.key.doubleClick"); }, binds: [] },
      { get cap() { return t("settings.key.cap.hover"); }, get action() { return t("settings.key.hover"); }, binds: [] },
    ],
  },
];

/** Ctrl + backtick, Board or Workspace. Kept out of KEY_HELP itself: it is on the sheet
 *  only where the Command Panel is on (keyHelpFor's `workspace`), and with it
 *  off the sheet is the table above, unchanged. A chord, so it stays with the
 *  single keys off; Control on a Mac too (Cmd + backtick is the OS's window switch). */
export const WORKSPACE_KEY_ROW: KeyHelpRow = {
  cap: "Ctrl + `",
  action: "switch between the Board and the Workspace — also with the keys in the terminal",
  binds: ["`"],
  chord: true,
};

/** The table with Ctrl + backtick after Quick open's row. */
function withWorkspaceRow(groups: readonly KeyHelpGroup[]): readonly KeyHelpGroup[] {
  return groups.map(group => {
    if (group.id !== "panels-and-dialogs") return group;
    const rows = [...group.rows];
    rows.splice(1, 0, WORKSPACE_KEY_ROW);
    return { ...group, rows };
  });
}

/** An action naming another row's letter in passing — Delete's "the session
 *  list (L)" — which would point at a dead key with the shortcuts off. */
const SINGLE_KEY_ASIDE = / ?\([A-Z?]\)/g;

/** The sheet as it stands with the single-key shortcuts off (Settings ›
 *  Keyboard, WCAG 2.1.4): only the rows that still do something — the chord,
 *  the named keys and the mouse — with a group that loses every row left out
 *  rather than drawn as an empty heading. With them on, the whole table.
 *  Either way less an integration's row where the deck does not offer its
 *  kind (`offered`; every kind when it is not said). */
export function keyHelpFor(
  singleKeys: boolean,
  offered: (kind: IntegrationKind) => boolean = () => true,
  /** The Command Panel is on, so Ctrl + backtick is the deck's and the sheet says so. */
  workspace = false,
): readonly KeyHelpGroup[] {
  const drawn = (row: KeyHelpRow) => row.integration === undefined || offered(row.integration);
  if (singleKeys && !workspace && KEY_HELP.every(group => group.rows.every(drawn))) return KEY_HELP;
  return (workspace ? withWorkspaceRow(KEY_HELP) : KEY_HELP)
    .map(group => ({
      ...group,
      rows: group.rows
        .filter(drawn)
        .filter(row => singleKeys || row.chord || !row.binds.some(isCharacterKey))
        .map(row => (singleKeys ? row : { ...row, action: row.action.replace(SINGLE_KEY_ASIDE, "") })),
    }))
    .filter(group => group.rows.length > 0);
}

/** What the sheet says first while the single-key shortcuts are off: that they
 *  are, and where they are turned back on. The place is its own string so the
 *  sheet can keep "Settings › Keyboard" on one line. */
export const KEY_HELP_OFF_TITLE = "Single-key shortcuts are off.";
export const SINGLE_KEYS_PLACE = "Settings › Keyboard";

/** The footnote's second sentence while they are on: where the reader whose
 *  letters fire by accident — dictation, a stray hand — turns them off. */
export const KEY_HELP_SWITCH_NOTE = `Single-key shortcuts can be turned off in ${SINGLE_KEYS_PLACE}.`;

/** Every `e.key` value the table claims the deck answers, lower-cased so a
 *  test can compare it with the handler's own literals without caring which
 *  case each one is written in. */
export function documentedKeys(): Set<string> {
  const out = new Set<string>();
  for (const group of KEY_HELP) {
    for (const row of group.rows) {
      for (const key of row.binds) out.add(key.toLowerCase());
    }
  }
  // Ctrl + backtick, which the sheet adds where the Command Panel is on.
  for (const key of WORKSPACE_KEY_ROW.binds) out.add(key);
  return out;
}
