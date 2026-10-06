// The git view owns its keys.
//
// While focus is inside the view, nothing typed there reaches the deck's
// single-key shortcuts: the deck's R re-arranges the canvas and drops every pin
// with no undo, C clears the event log, Delete takes a card off the board — and
// a reader moving through a diff presses letters. So the view's root carries
// `data-key-scope="git"`, the deck's handler leaves any keystroke from inside
// such a region alone (use-deck-shortcuts.ts), and the view's own handler
// answers the few keys it has and stops every other one where it is, Tab
// excepted so focus can still leave.
//
// The panes answer their own arrows (the history and the files are listboxes
// that move their selection themselves); what is decided here is what is left
// for the view: g, Esc one layer at a time, n for the newest diff, and the way
// between panes when a pane did not take the key itself.

/** The attribute a key-owning region carries, and its value for the git view. */
export const KEY_SCOPE_ATTR = "data-key-scope";
export const GIT_KEY_SCOPE = "git";

type Closest = { closest?: (selector: string) => unknown } | null | undefined;

/** Whether a keystroke's target sits inside a region that owns its keys. */
export function inKeyScope(el: Closest): boolean {
  return typeof el?.closest === "function" && el.closest(`[${KEY_SCOPE_ATTR}]`) != null;
}

/** Whether `g` on the deck may open the git view: something is selected, the
 *  view is switched on in Settings, and no dialog is in front of the canvas. */
export function gitKeyAllowed({ selected, gitOn, dialogOpen }: { selected: boolean; gitOn: boolean; dialogOpen: boolean }): boolean {
  return selected && gitOn && !dialogOpen;
}

/** The three panes of the view, top to bottom, left to right. */
export type GitViewPane = "graph" | "files" | "diff";

/** Where inside the view a keystroke landed. */
export interface ViewKeyWhere {
  /** The pane holding focus, or null for the header, a divider or a button outside the panes. */
  pane: GitViewPane | null;
  /** Focus is in a text field, which keeps every key but Esc. */
  typing: boolean;
  /** The pane already answered this key (it called preventDefault). */
  handled: boolean;
}

export type ViewKeyIntent =
  /** Let it travel: Tab, and the browser's chords. */
  | { kind: "pass" }
  /** Stop it here and do nothing else: every key the view has no use for. */
  | { kind: "swallow" }
  | { kind: "close" }
  | { kind: "focus"; pane: GitViewPane }
  | { kind: "newest" };

/** What the view does with a keystroke that reached its root. */
export function viewKeyIntent(
  e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  where: ViewKeyWhere,
): ViewKeyIntent {
  if (e.key === "Tab") return { kind: "pass" };
  if (e.ctrlKey || e.metaKey || e.altKey) return { kind: "pass" };
  if (e.key === "Escape") {
    // One layer back: diff → files → history → the view closes. A text field
    // gives its Esc to the view too: there is nothing in one to back out of.
    if (where.pane === "diff") return { kind: "focus", pane: "files" };
    if (where.pane === "files") return { kind: "focus", pane: "graph" };
    return { kind: "close" };
  }
  if (where.typing || where.handled) return { kind: "swallow" };
  if (e.key === "g" || e.key === "G") return { kind: "close" };
  if (e.key === "n" || e.key === "N") return { kind: "newest" };
  if (where.pane === "graph" && (e.key === "ArrowRight" || e.key === "Enter")) return { kind: "focus", pane: "files" };
  if (where.pane === "files" && e.key === "ArrowLeft") return { kind: "focus", pane: "graph" };
  if (where.pane === "files" && (e.key === "Enter" || e.key === "ArrowRight")) return { kind: "focus", pane: "diff" };
  if (where.pane === "diff" && e.key === "ArrowLeft") return { kind: "focus", pane: "files" };
  return { kind: "swallow" };
}

/** Where focus goes back to when what held it inside the view has left the
 *  page with its data — a file row whose file was committed or put back, a
 *  commit row amended away, the Uncommitted row of a detached HEAD gone
 *  clean. Focus would otherwise fall to the page, where every deck key acts
 *  again. Null when nothing was lost: the holder is still on the page (a
 *  click on the canvas, another window), or something else has focus. */
export function paneForLostFocus(lost: { connected: boolean; pane: GitViewPane | null } | null, onPage: boolean): GitViewPane | null {
  if (!lost || lost.connected || !onPage) return null;
  return lost.pane ?? "graph";
}

/** What a key does to a divider (the WAI-ARIA window splitter): a step in
 *  pixels along its axis, a jump to one end, or back to the default. */
export type SplitterMove = { step: number } | { to: "min" | "max" | "reset" };

/** Arrows move a divider 16px, Page keys 64px; Home and End go to the ends;
 *  Enter puts it back. A vertical divider (between left and right) answers
 *  ← →, a horizontal one ↑ ↓, and nothing else. Steps are signed in screen
 *  terms: right and down are positive. */
export function splitterMove(key: string, orientation: "vertical" | "horizontal"): SplitterMove | null {
  if (key === "Enter") return { to: "reset" };
  if (key === "Home") return { to: "min" };
  if (key === "End") return { to: "max" };
  if (key === "PageUp") return { step: -64 };
  if (key === "PageDown") return { step: 64 };
  if (orientation === "vertical") {
    if (key === "ArrowLeft") return { step: -16 };
    if (key === "ArrowRight") return { step: 16 };
  } else {
    if (key === "ArrowUp") return { step: -16 };
    if (key === "ArrowDown") return { step: 16 };
  }
  return null;
}
