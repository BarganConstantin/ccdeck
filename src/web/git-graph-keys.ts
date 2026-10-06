// What a key means on the history list.
//
// The list is one stop in the tab order (its selected row) and owns the keys a
// list owns: the arrows, Home and End, the page keys, Enter and → to move into
// the commit's files, and `i` for the agent card of a commit an agent made.
// Everything else falls through untouched — Tab, which is how focus leaves the
// list, and Escape, `g` and `n`, which belong to the view around it. A chord
// with Ctrl, Cmd or Alt is the browser's. Moving never animates: nothing
// triggered from the keyboard does.
import { isBrowserChord, type ChordModifiers } from "./shortcuts";

export interface HistoryKey extends ChordModifiers {
  key: string;
}

export type HistoryMove =
  | { kind: "pass" }
  | { kind: "select"; index: number }
  | { kind: "open" }
  | { kind: "card" };

/**
 * @param at    the selected row's index, or -1 for none
 * @param count how many rows there are
 * @param page  how many rows a page key moves
 */
export function historyKey(e: HistoryKey, at: number, count: number, page: number): HistoryMove {
  if (isBrowserChord(e) || count === 0) return { kind: "pass" };
  const last = count - 1;
  const step = Math.max(1, page);
  switch (e.key) {
    case "ArrowDown": return { kind: "select", index: at < 0 ? 0 : Math.min(last, at + 1) };
    case "ArrowUp": return { kind: "select", index: at < 0 ? 0 : Math.max(0, at - 1) };
    case "Home": return { kind: "select", index: 0 };
    case "End": return { kind: "select", index: last };
    case "PageDown": return { kind: "select", index: at < 0 ? 0 : Math.min(last, at + step) };
    case "PageUp": return { kind: "select", index: at < 0 ? 0 : Math.max(0, at - step) };
    case "Enter":
    case "ArrowRight": return at < 0 ? { kind: "pass" } : { kind: "open" };
    case "i": return at < 0 ? { kind: "pass" } : { kind: "card" };
    default: return { kind: "pass" };
  }
}

/** Whether a key takes a showing hover card away before anything else hears
 *  it: Escape, as content shown on hover or focus must be dismissible without
 *  moving the pointer or the focus. */
export function dismissesCard(e: HistoryKey): boolean {
  return e.key === "Escape" && !isBrowserChord(e);
}
