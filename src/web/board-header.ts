// What the strip across the top of the board says (V4's Board header, Figma
// Board › bhead 22:14910): five figures, worked out here and drawn by
// components/BoardHeader.tsx.
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

/** The labels, in the order they are drawn. "Done on this board" and "Spent on
 *  this board" where Figma says "today": both figures are the board's, which
 *  forgets finished sessions a couple of minutes after they end
 *  (board-limits.ts DONE_SESSION_GRACE_MS, board-usage.ts BOARD_SPEND_LABEL),
 *  not the calendar day's, and the code's wording wins over the drawing's. */
export const BOARD_HEAD_LABELS = [
  "Waiting on you",
  "Working",
  "Done on this board",
  "Longest wait",
  "Spent on this board",
] as const;

/** The dash a figure with nothing to say prints, in --muted. The same dash
 *  fmtCost prints for a known zero. */
export const BOARD_HEAD_NONE = "—";

/**
 * Is the strip drawn at all?
 *
 * Not on an empty board, where the hero says everything and five zeros would
 * be noise above it; not on a phone, which Phase 4 redoes. The stage covering
 * the canvas is the stylesheet's call (stage-shell.css), not this function's,
 * so the strip keeps its height and the board does not resize mid-morph.
 */
export function boardHeadShown(agentCount: number, phone: boolean): boolean {
  return agentCount > 0 && !phone;
}

/** Midnight at the start of `now`'s local calendar day. */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Root sessions on the board whose last turn ended today, local time.
 *
 * `endedAt` on a root is "the last turn finished" (types.ts): a Stop writes it,
 * once per turn, for both providers. That is the thing a reader means by
 * "done": a session sitting at its prompt with the answer delivered. A session
 * that is still `done` from yesterday has an `endedAt` before midnight and is
 * not counted; one that went on to a new turn is `active` and is not either.
 * Roots only, so a fan-out of subagents is one session.
 */
export function doneToday(agents: Iterable<AgentNodeData>, now: number): number {
  const from = startOfLocalDay(now);
  let n = 0;
  for (const a of agents) {
    if (a.kind === "root" && a.state === "done" && a.endedAt != null && a.endedAt >= from) n++;
  }
  return n;
}

/**
 * Sessions with an agent at work that are not waiting on the reader.
 *
 * A session blocked on a permission is `active` too, and it is already counted
 * under Waiting on you; counting it again made the two figures add up to more
 * sessions than the board holds. Sessions, not agents, as the tab strip counts
 * them (ambient-counts.ts runningSessionCount).
 */
export function workingSessions(agents: readonly AgentNodeData[], waiting: readonly BlockedSession[]): number {
  const blockedIds = new Set(waiting.map(w => w.id));
  const blockedSessionIds = new Set<string>();
  for (const a of agents) if (blockedIds.has(a.id)) blockedSessionIds.add(a.sessionId);
  const live = new Set<string>();
  for (const a of agents) if (a.state === "active" && !blockedSessionIds.has(a.sessionId)) live.add(a.sessionId);
  return live.size;
}

/** The figures as the component takes them: numbers and short strings only, so
 *  a memo over them re-renders when something on screen changes and not when
 *  App's clock ticks past it. */
export interface BoardHeadFigures {
  waiting: number;
  working: number;
  done: number;
  /** "6m 42s", or null with nobody waiting. */
  longestWait: string | null;
  /** The money figure as printed, or null where there is none to print. */
  spent: string | null;
  /** The tooltip of the two board-scoped figures (Done, Spent). */
  scopeTitle: string;
  /** Spent's own tooltip: the scope, and the unpriced note when it is owed. */
  spentTitle: string;
}

/** Everything but the longest wait: the figures that do not read the clock. */
export type BoardHeadBase = Omit<BoardHeadFigures, "longestWait">;

/**
 * The figures that hold still between two changes of the agents map: App keeps
 * them in a memo on the map's revision, so only the longest wait (below) is
 * worked out on its clock. `now` reaches the price table and the day's start,
 * both of which move far slower than a frame.
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
  waiting: readonly BlockedSession[],
): BoardHeadBase {
  const list = [...agents];
  const total = boardTotals(list).cost.total;
  const unpriced = anyUnpriced(false, [], boardModelTable(list, now).filter(worthALine));
  const scopeTitle = boardScopeTitle(singleKeys);
  return {
    waiting: waiting.length,
    working: workingSessions(list, waiting),
    done: doneToday(list, now),
    spent: total > 0 ? fmtCost(total) + (unpriced ? "+" : "") : null,
    scopeTitle,
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

/** The five figures in one go, over exactly the agents handed in. */
export function boardHeadFigures(
  agents: Iterable<AgentNodeData>,
  now: number,
  singleKeys: boolean,
  waiting?: readonly BlockedSession[],
): BoardHeadFigures {
  const list = [...agents];
  const blocked = waiting ?? blockedSessions(list);
  return { ...boardHeadBase(list, now, singleKeys, blocked), longestWait: boardHeadLongest(blocked, now) };
}
