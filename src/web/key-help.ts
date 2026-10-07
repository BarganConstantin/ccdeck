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
}

export interface KeyHelpGroup {
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
    title: "Canvas",
    rows: [
      { cap: "Space", action: "pause or resume the stream", binds: [" "] },
      { cap: "J", action: "next agent", binds: ["j", "J"] },
      { cap: "K", action: "previous agent", binds: ["k", "K"] },
      { cap: "W", action: "the session waiting on you — oldest first, again for the next", binds: ["w", "W"] },
      { cap: "F", action: "fit every agent on screen", binds: ["f", "F"] },
      { cap: "Z", action: "zoom to the selected agent and its session", binds: ["z", "Z"] },
      { cap: "Delete", action: "take the selected card off the board — the session list (L) brings it back", binds: ["Delete"] },
      { cap: "R", action: "re-arrange the canvas and drop the pins", binds: ["r", "R"] },
      { cap: "C", action: "clear the canvas and the event log — asks first", binds: ["c", "C"] },
    ],
  },
  {
    title: "Panels and dialogs",
    rows: [
      { cap: "U", action: "usage panel", binds: ["u", "U"] },
      { cap: "L", action: "session list", binds: ["l", "L"] },
      { cap: "D", action: "detail panel", binds: ["d", "D"] },
      { cap: "H", action: "usage history", binds: ["h", "H"] },
      // Drawn only where Claude Code is, so the key is guarded the same way —
      // see the handler in App.tsx, which checks `providers.claude` first.
      { cap: "A", action: "Claude accounts, where Claude Code is installed", binds: ["a", "A"] },
      // #826: the three topbar panels that were pointer-only.
      { cap: "S", action: "this machine — cores, memory, temperature", binds: ["s", "S"] },
      { cap: "B", action: "Browser Watch", binds: ["b", "B"] },
      // Over the right of the canvas; Esc steps back out of it one layer at a time.
      { cap: "G", action: "git view for the selected agent — its commits, files and diffs", binds: ["g", "G"] },
      { cap: "N", action: "in the git view, the newest diff of the open file", binds: ["n", "N"] },
      { cap: "?", action: "this sheet", binds: ["?"] },
    ],
  },
  {
    title: "Settings",
    rows: [
      // The chord every desktop app opens its settings with, and the one
      // chord the deck claims for itself (use-deck-shortcuts.ts). Both
      // spellings work on every platform; the sheet prints the one on the
      // keyboard in front of the reader.
      { cap: "Ctrl + ,", macCap: "⌘ ,", action: "all settings", binds: [","] },
      // Settings at its Sounds section, on every machine. V opened the topbar
      // speaker's quick popover (#826) until the speaker left the bar
      // (2026-10-07); everything that popover held is in this section.
      { cap: "V", action: "sound settings — the switch, and each tone's volume and sound", binds: ["v", "V"] },
      // The one-press route to silence from anywhere, and the only one with no
      // dialog in the way: the switch it flips is in Settings › Sounds, the
      // row above.
      { cap: "M", action: "sound on or off", binds: ["m", "M"] },
      { cap: "T", action: "light or dark theme", binds: ["t", "T"] },
    ],
  },
  {
    title: "Focus and selection",
    rows: [
      // Tab binds no key of the deck's: it is the browser's, and it is here
      // because reaching a card is the step every row under it depends on.
      { cap: "Tab", action: "reach the agent cards", binds: [] },
      { cap: "Enter", action: "select the focused card", binds: ["Enter"] },
      { cap: "Shift + Enter", action: "add the focused card to the selection", binds: ["Enter"] },
      { cap: "Esc", action: "close what is open, deselect, release focus", binds: ["Escape"] },
    ],
  },
  {
    title: "Mouse",
    rows: [
      { cap: "drag", action: "move a node, and pin it where you dropped it", binds: [] },
      { cap: "shift-click", action: "add an agent to the selection", binds: [] },
      { cap: "click", action: "a card: go to it and its session", binds: [] },
      { cap: "double-click", action: "a card: its prompt, every tool call, tokens and timing", binds: [] },
      { cap: "hover", action: "zoomed out, a card's name, state and numbers", binds: [] },
    ],
  },
];

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
  return out;
}
