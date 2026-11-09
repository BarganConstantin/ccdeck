// What the strip across the top of the board says (V4's Figma board
// header): two figures, worked out here and drawn by
// components/BoardHeader.tsx.
//
// CHANGED ON PURPOSE (design recommendations, 2026-11-09): the strip opened
// with Waiting on you, Working and Done on this board, the three counts the top
// bar already shows a line above it ("1 waiting · 1 working · 1 done"), and its
// Done counted a different set of sessions from the top bar's. The strip keeps
// what only it says: the longest wait and the board's spend.
//
// Everything comes from the agents map the page already holds and the clock App
// already ticks. Nothing here polls, fetches or keeps a tally: the map forgets
// finished sessions (ambient-counts.ts says why that matters), so a figure
// kept on the side would go on reporting sessions that are gone.
//
// Pure, and importing nothing but other pure modules, because the suite runs in
// bare node (the way ambient-counts.ts is written): the derivations are what
// can be wrong, and a component cannot be called from there.
import { blockedSessions, type BlockedSession } from "./ambient-counts";
import { boardModelTable, boardScopeTitle, boardTotals } from "./board-usage";
import { elapsed } from "./duration";
import { fmtCost } from "./pricing";
import { MISSING_PRICE_NOTE } from "./reported-cost";
import type { AgentNodeData } from "./types";
import { anyUnpriced, worthALine } from "./usage-panel-rules";

/** The class the strip wears, read by the canvas-size observer to take the
 *  strip's height off the board it reports (use-canvas-size.ts). */
export const BOARD_HEAD_CLASS = "board-head";

/** The labels' keys, in the order they are drawn, each read with `t` where it
 *  is drawn. "Spent on this board" where Figma says "today": the figure is the
 *  board's, which forgets finished sessions a couple of minutes after they end
 *  (board-limits.ts DONE_SESSION_GRACE_MS, board-usage.ts
 *  BOARD_SPEND_LABEL_MSG), not the calendar day's, and the code's wording wins
 *  over the drawing's. */
export const BOARD_HEAD_LABEL_MSGS = [
  "board.header.longest",
  "board.header.spent",
] as const;

/** The dash a figure with nothing to say prints, in --muted. The same dash
 *  fmtCost prints for a known zero. */
export const BOARD_HEAD_NONE = "—";

/**
 * Is the strip drawn at all?
 *
 * Not on an empty board, where the hero says everything and two dashes would
 * be noise above it; not on a phone, which Phase 4 redoes. The stage covering
 * the canvas is the stylesheet's call (stage-shell.css), not this function's,
 * so the strip keeps its height and the board does not resize mid-morph.
 */
export function boardHeadShown(agentCount: number, phone: boolean): boolean {
  return agentCount > 0 && !phone;
}

/** The figures as the component takes them: short strings only, so a memo over
 *  them re-renders when something on screen changes and not when App's clock
 *  ticks past it. */
export interface BoardHeadFigures {
  /** "6m 42s", or null with nobody waiting. */
  longestWait: string | null;
  /** The money figure as printed, or null where there is none to print. */
  spent: string | null;
  /** Spent's tooltip: the board's scope, and the unpriced note when it is owed. */
  spentTitle: string;
}

/** Everything but the longest wait: the figures that do not read the clock. */
export type BoardHeadBase = Omit<BoardHeadFigures, "longestWait">;

/**
 * The figures that hold still between two changes of the agents map: App keeps
 * them in a memo on the map's revision, so only the longest wait (below) is
 * worked out on its clock. `now` reaches the price table, which moves far
 * slower than a frame.
 *
 * Spent is the usage panel's board figure, formatted by the same `fmtCost`. A
 * session on a model with no published rate makes the figure a floor, "$4.20+",
 * as the panel does; a board of nothing but such models has no figure at all
 * and prints the dash, with the panel's note about unpriced models as its
 * tooltip. Whether the note is owed is the panel's own question, asked of the
 * panel's own rows (usage-panel-rules.ts): a session that has not spent
 * anything yet is not a line there and so is not an unpriced one here.
 */
export function boardHeadBase(
  agents: Iterable<AgentNodeData>,
  now: number,
  singleKeys: boolean,
): BoardHeadBase {
  const list = [...agents];
  const total = boardTotals(list).cost.total;
  const unpriced = anyUnpriced(false, [], boardModelTable(list, now).filter(worthALine));
  const scopeTitle = boardScopeTitle(singleKeys);
  return {
    spent: total > 0 ? fmtCost(total) + (unpriced ? "+" : "") : null,
    spentTitle: unpriced ? `${scopeTitle}\n${MISSING_PRICE_NOTE}` : scopeTitle,
  };
}

/**
 * Longest wait is the oldest `waiting.since` among the alarming blocks
 * (`blockedSessions` sorts oldest first), in the card's own clock format
 * (`elapsed`, "6m 42s"), which is what the Figma prints and what the card
 * beside it says for the same span.
 */
export function boardHeadLongest(waiting: readonly BlockedSession[], now: number): string | null {
  return waiting.length > 0 ? elapsed(waiting[0].waiting.since, undefined, now) : null;
}

/** The two figures in one go, over exactly the agents handed in. */
export function boardHeadFigures(
  agents: Iterable<AgentNodeData>,
  now: number,
  singleKeys: boolean,
  waiting?: readonly BlockedSession[],
): BoardHeadFigures {
  const list = [...agents];
  const blocked = waiting ?? blockedSessions(list);
  return { ...boardHeadBase(list, now, singleKeys), longestWait: boardHeadLongest(blocked, now) };
}
