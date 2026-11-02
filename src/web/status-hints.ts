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
import { releaseChordLabel, RELEASE_CHORD_SPOKEN_MSG, VIEW_CHORD_LABEL } from "./terminal-keys";
import { t } from "./i18n";

/** The view chord in words, for a screen reader: a backtick is read as nothing. */
const viewChordSpoken = () => t("board.status.controlBacktick");

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
  /** Only while the keyboard is NOT on a card: on a card Space is the card's
   *  own (canvas-keys.ts, "activate"), so it pauses nothing there. */
  offCard?: true;
  /** Only while the board is zoomed out past the detail distance: a peek never
   *  opens where the card already says it all (SessionPeek), by key or hover. */
  zoomedOut?: true;
  /** Only while a session waits on an answer: with an empty queue the key
   *  goes nowhere (nextWaiting, and the stage's next ask, find nothing). */
  waiting?: true;
}

export type StatusLayer = "board" | "deck" | "terminal";

const cap = (text: string, spoken?: string): StatusCap => ({ text, spoken });
// A getter, so a screen reader hears the language on show when the bar is drawn.
const ENTER: StatusCap = { text: "↵", get spoken() { return t("board.keys.enterSpoken"); } };

/** The board's layer. Figma's last item here, Ctrl + backtick → workspace, is added
 *  by statusViewFor only where the chord works (the Command Panel is on): the
 *  bar names only keys that work. Space → pause is the keyboard sheet's, which
 *  the frame leaves out; it goes before the chord. */
export const BOARD_HINTS: readonly StatusHint[] = [
  { caps: [cap("j"), cap("k")], get word() { return t("board.status.cards"); }, binds: ["j", "k"] },
  { caps: [ENTER], get word() { return t("board.status.select"); }, binds: ["Enter"], onCard: true },
  { caps: [cap("p")], get word() { return t("board.status.peek"); }, binds: ["p"], zoomedOut: true },
  { caps: [cap("n")], get word() { return t("board.status.nextWaiting"); }, binds: ["n"], waiting: true },
  { caps: [cap("Space")], get word() { return t("board.status.pause"); }, binds: [" "], offCard: true },
];

/** The deck's layer (the stage open, the board around it with the keys). No
 *  `p → peek`: the stage hides the canvas the peek would hang off (see P in
 *  use-deck-shortcuts.ts). Figma's chat / term key is not built (Chat is a
 *  later phase); its Ctrl + backtick → board is added by statusViewFor, where
 *  the chord works. */
export const DECK_HINTS: readonly StatusHint[] = [
  { caps: [cap("j"), cap("k")], get word() { return t("board.status.sessions"); }, binds: ["j", "k"] },
  { caps: [ENTER], get word() { return t("board.status.openAndType"); }, binds: ["Enter"] },
  { caps: [cap("n")], get word() { return t("board.status.nextWaiting"); }, binds: ["n"], waiting: true },
];

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
  /** Where Ctrl + backtick goes from here, when it is the deck's at all: "workspace"
   *  from the Board, "board" from Workspace. Null or left out where the
   *  Command Panel is off (or on a phone), and the bar names no such key. */
  viewChord?: "workspace" | "board" | null;
  /** A session waits on an answer (blockedSessions, the queue n walks). Left
   *  out, the bar takes it that one does, as it did before it was told. */
  waiting?: boolean;
}

/** The layer, its label and the hints that work with focus and the switch as
 *  they stand. Focus in a pane is the terminal's layer whatever the stage's
 *  phase: the handler gives a pane every key while it holds focus, closing
 *  included (use-deck-shortcuts.ts, inTerminalPanel). */
export function statusViewFor({ stageOpen, pane, onCard, zoomedOut, singleKeys, platform, viewChord = null, waiting = true }: StatusInput): StatusView {
  // Ctrl + backtick, last, a chord: it stays with the single keys off. The
  // pane catches it too (terminal-keys.ts answers "view" before the session
  // sees it), so the terminal layer names it after the release chord.
  const view: readonly StatusHint[] = viewChord
    ? [{ caps: [cap(VIEW_CHORD_LABEL, viewChordSpoken())], word: t(viewChord === "workspace" ? "board.status.viewWorkspace" : "board.status.viewBoard"), binds: [] }]
    : [];
  if (pane != null) {
    return {
      layer: "terminal",
      label: pane ? t("board.status.keysIn", { name: pane }) : t("board.status.keysInSession"),
      // A chord, so it stays with the single keys off.
      hints: [{ caps: [cap(releaseChordLabel(platform), t(RELEASE_CHORD_SPOKEN_MSG))], word: t("board.status.keysBack"), binds: [] }, ...view],
    };
  }
  const deck = stageOpen;
  const table = deck ? DECK_HINTS : BOARD_HINTS;
  return {
    layer: deck ? "deck" : "board",
    label: deck ? t("board.status.deckLabel") : t("board.status.boardLabel"),
    hints: [
      ...table.filter(h => (singleKeys || !h.binds.some(isCharacterKey))
        && (onCard || !h.onCard) && (!onCard || !h.offCard)
        && (zoomedOut || !h.zoomedOut) && (waiting || !h.waiting)),
      ...view,
    ],
  };
}
