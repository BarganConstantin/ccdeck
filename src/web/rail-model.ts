// The rail's rules that need no DOM: how the groups fold, what an order held
// under the pointer does with a session that joins or changes group, and which
// motion each change gets. Pure, so a bare-node suite can call all of it.
//
// The four groups are SessionList.tsx's rank(): 0 Needs you, 1 Working,
// 2 Done · unseen, 3 Idle.

export type RailGroup = 0 | 1 | 2 | 3;
export const RAIL_GROUPS: readonly RailGroup[] = [0, 1, 2, 3];
export const RAIL_GROUP_LABELS = ["Needs you", "Working", "Done · unseen", "Idle"] as const;

/** Rows drawn before the rail folds. Needs you and Working are never part of
 *  the budget's cut: nobody waiting on you is ever hidden. */
export const RAIL_FOLD_AT = 8;
/** Inside a group opened or folded, or in the whole list, above this a change
 *  is made at once: a parade of twenty rows is not news. */
export const RAIL_LONG_LIST = 20;
/** More rows than this moving on one release crossfade as a list instead of
 *  each travelling to its place. */
export const RAIL_CROSSFADE_AT = 12;

export interface Slot { id: string; group: RailGroup }

/** How many of a group's rows are drawn before its fold, and how many wait
 *  behind it. `counts` is rows per group, in group order. */
export function foldPlan(counts: readonly [number, number, number, number]): { shown: number; rest: number }[] {
  let budget = Math.max(0, RAIL_FOLD_AT - counts[0] - counts[1]);
  return counts.map((n, g) => {
    if (g < 2) return { shown: n, rest: 0 };
    const shown = Math.min(n, budget);
    budget -= shown;
    return { shown, rest: n - shown };
  });
}

/** The longest run of `seq` that only goes up: the rows that can stay where
 *  they are while the rest move. */
function longestRising(seq: readonly number[]): number {
  const tails: number[] = [];
  for (const v of seq) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < v) lo = mid + 1; else hi = mid; }
    tails[lo] = v;
  }
  return tails.length;
}

/** The drawn order while the pointer or focus is on the rail. Every row keeps
 *  its place and its group; a session that has joined takes the end of its
 *  group, so news is never hidden; one that has gone is dropped. `moves` is
 *  how many rows would travel if the hold were let go: the ones whose group
 *  changed, and the ones the shortest set of moves has to take out of line.
 *  `held` is what was drawn, `fresh` what the rules say now. */
export function holdOrder(held: readonly Slot[], fresh: readonly Slot[]): { order: Slot[]; moves: number } {
  const freshAt = new Map(fresh.map((s, i) => [s.id, i]));
  const freshGroup = new Map(fresh.map(s => [s.id, s.group]));
  const heldIds = new Set(held.map(s => s.id));
  const order: Slot[] = held.filter(s => freshAt.has(s.id));
  for (const s of fresh) {
    if (heldIds.has(s.id)) continue;
    let at = order.length;
    while (at > 0 && order[at - 1].group > s.group) at--;
    order.splice(at, 0, { id: s.id, group: s.group });
  }
  let moves = 0;
  const stayers: number[] = [];
  for (const s of order) {
    if (!heldIds.has(s.id)) continue;
    if (freshGroup.get(s.id) !== s.group) moves++;
    else stayers.push(freshAt.get(s.id)!);
  }
  moves += stayers.length - longestRising(stayers);
  return { order, moves };
}

/** The Order held line: what waits, in the words the card uses. */
export function heldLine(moves: number): string {
  return moves === 1 ? "1 move waits until you leave the list" : `${moves} moves wait until you leave the list`;
}

/** The quiet line that takes the place of an empty Needs you. */
export function nobodyWaitingText(working: number): string {
  return working > 0 ? `Nobody’s waiting · ${working} working` : "Nobody’s waiting";
}

/** What opening or folding a group does: the space and the chevron travelling
 *  ("animate"), the content fading alone ("fade": over 20 rows inside, or
 *  reduced motion), or nothing at all ("instant": by key). */
export function foldMotion({ rowsInside, byKey, reduced }: { rowsInside: number; byKey: boolean; reduced: boolean }): "animate" | "fade" | "instant" {
  if (byKey) return "instant";
  if (reduced || rowsInside > RAIL_LONG_LIST) return "fade";
  return "animate";
}

/** What the rail does when the hold is let go and `moved` rows have a new
 *  place: each row travels ("flip"), the list crossfades as one, or, reduced,
 *  the rows jump and only the ones that moved fade in. */
export function releaseMotion({ moved, reduced }: { moved: number; reduced: boolean }): "none" | "flip" | "crossfade" | "fade-moved" {
  if (moved === 0) return "none";
  if (reduced) return "fade-moved";
  return moved > RAIL_CROSSFADE_AT ? "crossfade" : "flip";
}

/** What a row joining or leaving does: its space and its opacity ("animate"),
 *  the opacity alone (reduced), or nothing, in a long list. */
export function joinMotion({ rows, reduced }: { rows: number; reduced: boolean }): "animate" | "fade" | "instant" {
  if (rows > RAIL_LONG_LIST) return "instant";
  return reduced ? "fade" : "animate";
}

/** Whether the order is held. The pointer over the rail holds it; keyboard
 *  focus holds it only when it is inside the list AND shows a focus ring
 *  (:focus-visible), so a mouse click never does. Asked when needed, from the
 *  document, not remembered from focus events: a focused element that is then
 *  removed, made inert or unmounted simply stops answering yes. */
export function railHeld({ pointerInside, focusInside, focusVisible }: { pointerInside: boolean; focusInside: boolean; focusVisible: boolean }): boolean {
  return pointerInside || (focusInside && focusVisible);
}

/** Which rows are really new and really gone between two renders of the list,
 *  by id. A row that only moved (into a fold body, out of a ghost, to another
 *  group) is in both sets and neither list, so nothing plays for it. A null
 *  `prev` is the first render: nothing joins on it. */
export function membershipChange(prev: ReadonlySet<string> | null, next: ReadonlySet<string>): { joined: string[]; left: string[] } {
  if (!prev) return { joined: [], left: [] };
  return { joined: [...next].filter(id => !prev.has(id)), left: [...prev].filter(id => !next.has(id)) };
}

/** Lets a measurement through only when the drawn order or the hold changed
 *  since the last one, so the rail does not read every row's place on each of
 *  the clock's renders. `reads` counts what it let through. */
export function measureGate(): { check: (signature: string, held: boolean) => boolean; reads: number } {
  let last: { signature: string; held: boolean } | null = null;
  const gate = {
    reads: 0,
    check(signature: string, held: boolean): boolean {
      if (last && last.signature === signature && last.held === held) return false;
      last = { signature, held };
      gate.reads++;
      return true;
    },
  };
  return gate;
}
