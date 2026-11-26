// The Decision card's keys, as data and as the functions that read them.
//
// FREE KEYS ONLY. 1 to 9 pick and send (after the prompt is re-read), Esc
// picks the prompt's No (a permission prompt's, as Esc answers it in Term),
// the arrows and Tab move the ring, Enter sends the focused answer. On the
// card itself Esc with no No to pick closes it and never answers. The card
// never takes focus on arrival.
//
// FROM THE PANE TOO (paneKeyEvent). While the card is up, the digits and Esc
// reach it from anywhere in its Chat pane that is not a text field, and from
// the reply box while that is empty, the way herdr's chat answers a prompt:
// never in the first ARM_MS after the card came (answer-keys.ts), so a key
// meant for something else does not answer a question nobody has read, and
// never with a word in the box. The digits are character keys, so they follow
// Settings › Keyboard's single-key switch; the arrows, Tab, Enter and Esc stay.
//
// THE TABLES LIVE HERE, NOT IN key-help.ts OR status-hints.ts, so that with the
// flags off neither the keyboard sheet nor the status bar can name a Decision
// key: the card hands them to the deck only while it is on screen
// (screen-keys.ts; KeyboardHelp `extraGroups`, StatusBar `extra`).
// v4-decision-keys.test.ts holds them against `decisionEventFor`, so a row
// cannot outlive its key.
import { t } from "../../i18n";
import type { KeyHelpGroup } from "../../key-help";
import type { StatusHint } from "../../status-hints";
import { isCharacterKey } from "../../single-key-shortcuts";
import { cancelRow, type DecisionEvent } from "./decision-machine";
import type { DecisionModel } from "./decision-model";

/** The digit keys: one for each of up to nine rows. */
export const DIGIT_BINDS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export const DECISION_KEY_GROUP: KeyHelpGroup = {
  id: "decision",
  get title() { return t("board.chat.compose.keys.title"); },
  rows: [
    { cap: "1 – 9", get action() { return t("board.chat.compose.keys.pick"); }, binds: DIGIT_BINDS },
    { cap: "Esc", get action() { return t("board.chat.compose.keys.no"); }, binds: ["Escape"] },
    { cap: "↑ ↓ Tab", get action() { return t("board.chat.compose.keys.move"); }, binds: ["ArrowUp", "ArrowDown", "Tab"] },
    { cap: "↵", get action() { return t("board.chat.compose.keys.send"); }, binds: ["Enter"] },
  ],
};

const cap = (text: string, spoken?: string) => ({ text, spoken });

export const DECISION_HINTS: readonly StatusHint[] = [
  { get caps() { return [cap("1–9", t("board.chat.compose.keys.spoken", { first: 1, last: 9 }))]; }, get word() { return t("board.chat.compose.keys.word.pick"); }, binds: DIGIT_BINDS },
  { caps: [cap("Esc", "Escape")], get word() { return t("board.chat.compose.keys.word.no"); }, binds: ["Escape"] },
  { caps: [cap("↑"), cap("↓"), cap("Tab")], get word() { return t("board.chat.compose.keys.word.move"); }, binds: ["ArrowUp", "ArrowDown", "Tab"] },
  { caps: [cap("↵", "Enter")], get word() { return t("board.chat.compose.keys.word.send"); }, binds: ["Enter"] },
];

/** The layer the status bar shows while the keys are in the card's pane. */
export function decisionStatusView(singleKeys: boolean): { layer: "decision"; label: string; hints: readonly StatusHint[] } {
  return {
    layer: "decision",
    get label() { return t("board.chat.compose.keys.status"); },
    hints: DECISION_HINTS.filter(h => singleKeys || !h.binds.some(isCharacterKey)),
  };
}

/** The sheet's group, less the digits' row while the single keys are off. */
export function decisionKeyGroup(singleKeys: boolean): KeyHelpGroup {
  return {
    id: DECISION_KEY_GROUP.id,
    get title() { return DECISION_KEY_GROUP.title; },
    rows: DECISION_KEY_GROUP.rows.filter(r => singleKeys || !r.binds.some(isCharacterKey)),
  };
}

/** Where a key was pressed inside the card: on an answer row, in the free
 *  field, or on anything else (a link or button of the outcome panel). */
export type KeyTarget = "row" | "field" | "other";

export function keyTargetOf(el: { closest?(selector: string): unknown } | null | undefined): KeyTarget {
  if (!el || typeof el.closest !== "function") return "other";
  if (el.closest(".dc-input")) return "field";
  if (el.closest(".dc-opt")) return "row";
  return "other";
}

/** The card's keys are for its rows and its field. A link or a button keeps its
 *  own Enter and Tab; the field keeps all but Enter and Esc. */
export function cardKeyEvent(
  e: KeyLike,
  target: KeyTarget,
  singleKeys: boolean,
  rows: number,
  box?: { multi: boolean; focus: number | null },
): DecisionEvent | null {
  if (target === "other") return null;
  if (target === "field" && e.key !== "Enter" && e.key !== "Escape") return null;
  return decisionEventFor(e, singleKeys, rows, box);
}

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** The event a key means for the card, or null when it is not the card's. A
 *  chord is never the card's (Ctrl+1 is the browser's). Esc is read here too;
 *  the machine decides whether it closes the field or the card. */
export function decisionEventFor(
  e: KeyLike,
  singleKeys: boolean,
  rows: number,
  /** The several-answers card and the row the ring is on: Space checks it. */
  box?: { multi: boolean; focus: number | null },
): DecisionEvent | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    // A checkbox is checked by Space, whatever the single-key switch says.
    case " ": return box?.multi && box.focus != null && box.focus < rows ? { type: "toggle", index: box.focus } : null;
    case "ArrowDown": return { type: "move", by: 1 };
    case "ArrowUp": return { type: "move", by: -1 };
    case "Tab": return { type: "move", by: e.shiftKey ? -1 : 1 };
    case "Enter": return { type: "submit" };
    case "Escape": return { type: "escape" };
    default: {
      if (!singleKeys || !/^[1-9]$/.test(e.key)) return null;
      const index = Number(e.key) - 1;
      return index < rows ? { type: "pick", index } : null;
    }
  }
}

/** What a key pressed in the card's pane, outside the card, means for it: a
 *  digit picks its row, Esc picks the prompt's No; anything else, a chord, or
 *  a digit with the single keys off or no row to pick, is not the card's. */
export function paneKeyEvent(e: KeyLike, singleKeys: boolean, model: DecisionModel): DecisionEvent | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === "Escape") {
    const at = cancelRow(model);
    return at < 0 ? null : { type: "pick", index: at };
  }
  if (!singleKeys || !/^[1-9]$/.test(e.key)) return null;
  const index = Number(e.key) - 1;
  return index < model.options.length ? { type: "pick", index } : null;
}
