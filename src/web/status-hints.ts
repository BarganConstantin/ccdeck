// What the status bar says, as data: who has the keys, and the keys that work.
//
// V4's `Shell / Status bar` names the keys of the layer that has them. The bar
// is only worth its 24px if every key it names works, so the words live here as
// a table beside key-help.ts and each hint carries the literal `e.key` values
// it relies on (`binds`, the way a KEY_HELP row does). v4-status-bar.test.ts
// holds the table against the handler and the sheet, so a hint cannot outlive
// its key.
//
// THREE LAYERS, decided by where the keys are:
//  - board: the board has them, the Command Panel stage is closed;
//  - deck: the stage is open and the board around it has them;
//  - terminal: focus is inside the pane, where every key is the session's.
//
// Pure, and first-load: no stage code is imported, only the helpers of
// terminal-keys.ts that the shortcuts handler already carries.
import { isCharacterKey } from "./single-key-shortcuts";
import { releaseChordLabel, RELEASE_CHORD_SPOKEN } from "./terminal-keys";

/** One key cap: what is printed, and what a screen reader says for it when
 *  the print is a symbol or a chord. */
export interface StatusCap {
  text: string;
  spoken?: string;
}

export interface StatusHint {
  caps: readonly StatusCap[];
  word: string;
  /** The literal `e.key` values the hint relies on. A hint with a character
   *  key in it goes when Settings › Keyboard turns the single keys off;
   *  Enter, a named key, stays. Empty for the release chord. */
  binds: readonly string[];
  /** Only while the keyboard is on a card: the board's Enter is the focused
   *  card's (canvas-keys.ts, "activate"), and with focus anywhere else no
   *  handler answers it. */
  onCard?: true;
  /** Only while the board is zoomed out past the detail distance: a peek never
   *  opens where the card already says it all (SessionPeek), by key or hover. */
  zoomedOut?: true;
}

export type StatusLayer = "board" | "deck" | "terminal";

const cap = (text: string, spoken?: string): StatusCap => ({ text, spoken });
const ENTER = cap("↵", "Enter");

/** The board's layer. Figma's last item here, Ctrl+` → workspace, is not drawn:
 *  Ctrl+` only works in Phase 3, and the bar names only keys that work. */
export const BOARD_HINTS: readonly StatusHint[] = [
  { caps: [cap("j"), cap("k")], word: "cards", binds: ["j", "k"] },
  { caps: [ENTER], word: "select", binds: ["Enter"], onCard: true },
  { caps: [cap("p")], word: "peek", binds: ["p"], zoomedOut: true },
  { caps: [cap("n")], word: "next waiting", binds: ["n"] },
];

/** The deck's layer (the stage open, the board around it with the keys). No
 *  `p → peek`: the stage hides the canvas the peek would hang off (see P in
 *  use-deck-shortcuts.ts). Figma's ` → chat / term and Ctrl+` → board are
 *  Phase 3. */
export const DECK_HINTS: readonly StatusHint[] = [
  { caps: [cap("j"), cap("k")], word: "sessions", binds: ["j", "k"] },
  { caps: [ENTER], word: "open and type", binds: ["Enter"] },
  { caps: [cap("n")], word: "next waiting", binds: ["n"] },
];

export const BOARD_LABEL = "Keys on the board";
export const DECK_LABEL = "Keys on the deck";
export const TERMINAL_WORD = "keys back to the deck";

/** What the bar draws now. */
export interface StatusView {
  layer: StatusLayer;
  label: string;
  hints: readonly StatusHint[];
}

export interface StatusInput {
  /** The Command Panel stage is open. */
  stageOpen: boolean;
  /** The name of the session whose pane holds focus (terminal-keys.ts,
   *  paneNameOf), or null when focus is outside every pane. */
  pane: string | null;
  /** The keyboard is on a card on the board (canvas-node-element.ts). */
  onCard: boolean;
  /** The board is zoomed out past the detail distance (use-zoom-lod.ts). */
  zoomedOut: boolean;
  /** Settings › Keyboard's switch. */
  singleKeys: boolean;
  platform: string;
}

/** The layer, its label and the hints that work with focus and the switch as
 *  they stand. Focus in a pane is the terminal's layer whatever the stage's
 *  phase: the handler gives a pane every key while it holds focus, closing
 *  included (use-deck-shortcuts.ts, inTerminalPanel). */
export function statusViewFor({ stageOpen, pane, onCard, zoomedOut, singleKeys, platform }: StatusInput): StatusView {
  if (pane != null) {
    return {
      layer: "terminal",
      label: `Keys in ${pane || "the session"}`,
      // A chord, so it stays with the single keys off.
      hints: [{ caps: [cap(releaseChordLabel(platform), RELEASE_CHORD_SPOKEN)], word: TERMINAL_WORD, binds: [] }],
    };
  }
  const deck = stageOpen;
  const table = deck ? DECK_HINTS : BOARD_HINTS;
  return {
    layer: deck ? "deck" : "board",
    label: deck ? DECK_LABEL : BOARD_LABEL,
    hints: table.filter(h => (singleKeys || !h.binds.some(isCharacterKey)) && (onCard || !h.onCard) && (zoomedOut || !h.zoomedOut)),
  };
}
