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

/** The sentence the sheet opens on.
 *
 *  Not decoration. `KEY_OWNING_TAGS` in shortcuts.ts puts BUTTON on the list of
 *  elements that own their own keys, which is right — a bare "c" from a focused
 *  dropdown used to truncate the event log — and the consequence is that every
 *  single-key shortcut below is inert for as long as any control holds focus.
 *  That includes this sheet, which takes focus when it opens. Escape is the
 *  documented way back and it is the last row of the fourth group. */
export const KEY_HELP_NOTE =
  "One-key shortcuts run when nothing on the page has focus. A focused control " +
  "keeps its own keys — this sheet included, which takes the keyboard while it " +
  "is open — so Esc is the way back to the canvas.";

export const KEY_HELP: readonly KeyHelpGroup[] = [
  {
    title: "Canvas",
    rows: [
      { cap: "Space", action: "pause or resume the stream", binds: [" "] },
      { cap: "J", action: "next agent", binds: ["j", "J"] },
      { cap: "K", action: "previous agent", binds: ["k", "K"] },
      { cap: "F", action: "fit every agent on screen", binds: ["f", "F"] },
      { cap: "R", action: "re-arrange the canvas and drop the pins", binds: ["r", "R"] },
      { cap: "C", action: "clear the canvas and the event log — asks first", binds: ["c", "C"] },
    ],
  },
  {
    title: "Panels and dialogs",
    rows: [
      { cap: "U", action: "usage panel", binds: ["u", "U"] },
      { cap: "L", action: "session list", binds: ["l", "L"] },
      { cap: "H", action: "usage history", binds: ["h", "H"] },
      // Drawn only where Claude Code is, so the key is guarded the same way —
      // see the handler in App.tsx, which checks `providers.claude` first.
      { cap: "A", action: "Claude accounts, where Claude Code is installed", binds: ["a", "A"] },
      { cap: "?", action: "this sheet", binds: ["?"] },
    ],
  },
  {
    title: "Settings",
    rows: [
      // #711 gave the topbar speaker a menu, so the click stopped toggling and
      // this key became the only one-press route to silence. The action stays
      // worded as the toggle it is, and the Mouse group below says what the
      // button does now — the two gestures no longer agree, which is exactly
      // the thing that has to be written down rather than discovered.
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
      // #711. The speaker in the topbar used to toggle and now opens a menu, so
      // the click and M no longer mean the same thing. That divergence is the
      // shape #709 removed Shift+M for, and the difference is that this one is
      // written down: a gesture that exists only in the source is not a feature
      // that shipped, and this sheet is where the deck says otherwise.
      { cap: "click", action: "the topbar speaker opens volume and sound settings", binds: [] },
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
