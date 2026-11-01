// The Decision card's keys, as data and as the one function that reads them.
//
// FREE KEYS ONLY. 1 to 3 pick and send (after the prompt is re-read), the
// arrows and Tab move the ring, Enter sends the focused answer, Esc closes and
// never answers. They act only while focus is inside
// the card: the card never takes focus on arrival, and a digit pressed with
// focus elsewhere does nothing, because "a stray 1 must never approve something
// nobody has read" (KeysBar.tsx). The digits are character keys, so they follow
// Settings › Keyboard's single-key switch; the arrows, Tab, Enter and Esc stay.
//
// THE TABLES LIVE HERE, NOT IN key-help.ts OR status-hints.ts, so that with the
// flags off neither the keyboard sheet nor the status bar can name a Decision
// key: the host passes these in as props only when a card is on screen
// (KeyboardHelp `extraGroups`, StatusBar `extra`). v4-decision-keys.test.ts holds
// them against `decisionEventFor`, so a row cannot outlive its key.
import type { KeyHelpGroup } from "../../key-help";
import type { StatusHint } from "../../status-hints";
import { isCharacterKey } from "../../single-key-shortcuts";
import type { DecisionEvent } from "./decision-machine";

export const DECISION_GROUP_TITLE = "Decision";
export const DECISION_STATUS_LABEL = "Keys on the question";

export const DECISION_KEY_GROUP: KeyHelpGroup = {
  title: DECISION_GROUP_TITLE,
  rows: [
    { cap: "1 – 3", action: "Pick an answer and send it, after the prompt is read again", binds: ["1", "2", "3"] },
    { cap: "↑ ↓ Tab", action: "Move the ring along the answers", binds: ["ArrowUp", "ArrowDown", "Tab"] },
    { cap: "↵", action: "Send the answer the ring is on", binds: ["Enter"] },
    { cap: "Esc", action: "Close the question. It never answers", binds: ["Escape"] },
  ],
};

const cap = (text: string, spoken?: string) => ({ text, spoken });

export const DECISION_HINTS: readonly StatusHint[] = [
  { caps: [cap("1–3", "1 to 3")], word: "pick and send", binds: ["1", "2", "3"] },
  { caps: [cap("↑"), cap("↓"), cap("Tab")], word: "move", binds: ["ArrowUp", "ArrowDown", "Tab"] },
  { caps: [cap("↵", "Enter")], word: "send", binds: ["Enter"] },
  { caps: [cap("Esc", "Escape")], word: "close", binds: ["Escape"] },
];

/** The layer the status bar shows while a card has the keys. */
export function decisionStatusView(singleKeys: boolean): { layer: "decision"; label: string; hints: readonly StatusHint[] } {
  return {
    layer: "decision",
    label: DECISION_STATUS_LABEL,
    hints: DECISION_HINTS.filter(h => singleKeys || !h.binds.some(isCharacterKey)),
  };
}

/** The sheet's group, less the digits' row while the single keys are off. */
export function decisionKeyGroup(singleKeys: boolean): KeyHelpGroup {
  return {
    title: DECISION_GROUP_TITLE,
    rows: DECISION_KEY_GROUP.rows.filter(r => singleKeys || !r.binds.some(isCharacterKey)),
  };
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
export function decisionEventFor(e: KeyLike, singleKeys: boolean, rows: number): DecisionEvent | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case "ArrowDown": return { type: "move", by: 1 };
    case "ArrowUp": return { type: "move", by: -1 };
    case "Tab": return { type: "move", by: e.shiftKey ? -1 : 1 };
    case "Enter": return { type: "submit" };
    case "Escape": return { type: "escape" };
    default: {
      if (!singleKeys || !/^[1-3]$/.test(e.key)) return null;
      const index = Number(e.key) - 1;
      return index < rows ? { type: "pick", index } : null;
    }
  }
}
