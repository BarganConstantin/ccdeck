// Sessions hidden from the Sessions list, and the way back.
//
// A finished conversation stays a row of the list for as long as the deck
// knows the session, and Remove from board takes only its card away: the row
// stays, saying "off the board". Hide from list takes the ROW away, and only
// the row. The session keeps its history, its process, its open pane and its
// card; quick open, the Board and a pane still reach it, and the list's last
// line, Hidden · n, lists it with a way back.
//
// WHAT CAN BE HIDDEN. A row that wants nothing now: finished (Done, and Done ·
// new) or never prompted (Ready). A working row and one waiting on a person
// have no hide, because the list is where they ask for you.
//
// IT COMES BACK BY ITSELF when the session works again (a new prompt, a tool
// call, a block of output, a subagent: the stamps remove-node.ts lastWorkedAt
// reads) or when its row stops being one that could be hidden (it is working
// or needs you). Its mark goes then, so the next finished turn shows the row.
// A session the deck has never seen is never hidden.
//
// WHEN THE WORK COUNTS FROM. Each mark keeps a stamp the session's own work has
// to pass: the newer of its last work when it was hidden, which is the server's
// clock, and the page's clock at the press. The first keeps a phone whose clock
// runs behind from bringing a row straight back; the second keeps a late
// transcript read of output written before the press from doing it. A reload
// replays history with the stamps it was received with, so it brings nothing
// back that had not worked since.
//
// STORED as [id, since] pairs, oldest first, under one agent-dag.* key, capped,
// and pruned of the sessions the deck no longer knows once it has heard its
// whole history. A store that is missing, blocked or holds anything else reads
// as nothing hidden.
import { lastWorkedAt } from "./remove-node";
import type { RailGroup } from "./rail-model";

export const LIST_HIDDEN_KEY = "agent-dag.listHidden";

/** How many marks are kept. A session the deck forgets is pruned on the next
 *  load; the cap is for a deck that never forgets, and drops the oldest. */
export const LIST_HIDDEN_CAP = 300;

/** Session id → the stamp its work has to pass to bring the row back, in the
 *  order the rows were hidden (oldest first). */
export type HiddenMarks = ReadonlyMap<string, number>;

/** What an agent is read for: its session, and the stamps only work writes. */
export type HiddenWorker = Parameters<typeof lastWorkedAt>[0];

/** Whether a row in this group can be hidden: Done · new, Done and Ready. Not
 *  Needs you (0) and not Working (2). */
export function canHideRow(group: RailGroup): boolean {
  return group === 1 || group === 3 || group === 4;
}

function capped(marks: Map<string, number>): Map<string, number> {
  if (marks.size <= LIST_HIDDEN_CAP) return marks;
  return new Map([...marks].slice(marks.size - LIST_HIDDEN_CAP));
}

export function readListHidden(store: Pick<Storage, "getItem"> | null): HiddenMarks {
  try {
    const value: unknown = JSON.parse(store?.getItem(LIST_HIDDEN_KEY) ?? "[]");
    const marks = new Map<string, number>();
    if (!Array.isArray(value)) return marks;
    for (const entry of value) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, since] = entry as unknown[];
      if (typeof id !== "string" || id === "" || typeof since !== "number" || !Number.isFinite(since)) continue;
      // A repeated id keeps its newest place.
      marks.delete(id);
      marks.set(id, since);
    }
    return capped(marks);
  } catch { return new Map(); }
}

export function saveListHidden(store: Pick<Storage, "setItem"> | null, marks: HiddenMarks): void {
  try { store?.setItem(LIST_HIDDEN_KEY, JSON.stringify([...marks])); } catch { /* disabled storage, full quota */ }
}

/** The marks with `id` hidden from `since`, as the newest. */
export function withHidden(marks: HiddenMarks, id: string, since: number): HiddenMarks {
  const next = new Map(marks);
  next.delete(id);
  next.set(id, since);
  return capped(next);
}

/** The marks without `ids`: the SAME map when none of them was hidden, so a
 *  caller can tell a change from nothing without a write or a render. */
export function withoutHidden(marks: HiddenMarks, ids: Iterable<string>): HiddenMarks {
  let next: Map<string, number> | null = null;
  for (const id of ids) {
    if (!marks.has(id)) continue;
    next ??= new Map(marks);
    next.delete(id);
  }
  return next ?? marks;
}

/** When each session last worked, every agent of it counted (a subagent's
 *  start is work too). Only the sessions in `ids`. */
export function sessionsLastWorked(agents: Iterable<HiddenWorker>, ids: ReadonlySet<string>): Map<string, number> {
  const worked = new Map<string, number>();
  if (ids.size === 0) return worked;
  for (const agent of agents) {
    const id = agent.sessionId ?? agent.id;
    if (!ids.has(id)) continue;
    const at = lastWorkedAt(agent);
    if (at > (worked.get(id) ?? -Infinity)) worked.set(id, at);
  }
  return worked;
}

/** The stamp a mark made now keeps: the newer of the session's last work and
 *  the page's clock. */
export function hideSince(agents: Iterable<HiddenWorker>, id: string, now: number): number {
  const worked = sessionsLastWorked(agents, new Set([id])).get(id) ?? -Infinity;
  return Math.max(worked, now);
}

/** The hidden sessions whose rows come back by themselves: the ones whose row
 *  can no longer be hidden (working, or needing you), and the ones that have
 *  worked since they were hidden. A mark for a session with no row is left to
 *  the pruning. */
export function hiddenLifted(
  marks: HiddenMarks,
  groupOf: (id: string) => RailGroup | undefined,
  agents: Iterable<HiddenWorker>,
): string[] {
  if (marks.size === 0) return [];
  const worked = sessionsLastWorked(agents, new Set(marks.keys()));
  const lifted: string[] = [];
  for (const [id, since] of marks) {
    const group = groupOf(id);
    if (group === undefined) continue;
    if (!canHideRow(group) || (worked.get(id) ?? -Infinity) > since) lifted.push(id);
  }
  return lifted;
}

/** The marks without the sessions the deck no longer knows. Asked only once
 *  the deck has heard its whole history, when a session it does not know is
 *  one it has forgotten. The SAME map when nothing goes. */
export function prunedHidden(marks: HiddenMarks, knows: (id: string) => boolean): HiddenMarks {
  return withoutHidden(marks, [...marks.keys()].filter(id => !knows(id)));
}

/** Where focus goes when a row leaves the list from under it: the next row,
 *  else the one before it, else nothing (the caller's heading). `rows` are the
 *  list's rows in drawn order, `at` the one leaving. */
export function focusAfterLeaving<T>(rows: readonly T[], at: T): T | null {
  const i = rows.indexOf(at);
  if (i < 0) return rows[0] ?? null;
  return rows[i + 1] ?? rows[i - 1] ?? null;
}
