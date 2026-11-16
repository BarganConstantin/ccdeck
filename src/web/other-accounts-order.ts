// How the accounts behind the fold are ordered and which of them are open
// (#1579, internal #94).
//
// With nine or more accounts in Other accounts the list was hard to compare:
// it stood in slot order (1, 5, 8, 9, 10, …), which says nothing about which
// account can take over now. #1579 answered with a menu of orders — slot,
// room, fullest or emptiest by each window — and the owner then asked for the
// one answer instead of the menu (internal #94): the accounts that can be used
// now on top, the ones that cannot below them, and no sort control at all.
//
// Three rules live here, as functions the suite can call without a DOM:
//
//   - the ORDER: by availability — usable now, then not read yet, then
//     waiting on a window or a rate limit, then the week spent, then the
//     accounts no switch can reach — and slot order inside each group;
//   - which rows are OPEN, as a mode and its exceptions, so "expand all" is a
//     fact that holds for an account that arrives later rather than a list of
//     whoever was there when it was pressed;
//   - the HOLD: while the pointer or the keyboard is in the list, a poll that
//     moves an account to another group does not move the rows under them.
//
// What is remembered between reloads — the open rows — is accounts-prefs.ts's.
import type { Account, Lane } from "./claude-accounts";
import { laneKey, toggleLane, type LaneOwner } from "./lane-open";
import { lapsed } from "./lane-view";

// ── the order ───────────────────────────────────────────────────────────────

/** A model's own lane ("Opus"), which the server sends with a scoped- id. */
const isModelLane = (l: Lane) => l.id.startsWith("scoped-");

/**
 * WHERE AN ACCOUNT STANDS FOR A SWITCH NOW (internal #94). Lower is nearer
 * the top of the list:
 *
 *   0  USABLE: a switch reaches it, nothing limits it, and every window it
 *      has was read, is still running and is under 100%;
 *   1  NOT READ YET: a switch reaches it, but a window has no reading or has
 *      reset since it was read. It may well have room; nothing says so yet,
 *      and a list that put it on top on no evidence would be wrong half the
 *      time. A fresh reading moves it up;
 *   2  WAITING: rate limited, or a window short of the week is full. It
 *      clears by itself, within hours;
 *   3  WEEK SPENT: its 7-day window is full, whatever the 5-hour one says —
 *      the first of the issue's checks;
 *   4  OUT OF REACH: held out of rotation, or a login only a sign-in brings
 *      back. Its row withholds Switch.
 *
 * A model's own window (Opus) is left out: a full one stops that model, not
 * the account. `reachable` is account-fold.ts's rule and `rateLimited` the
 * row's own issue, so the list and the row never disagree about either.
 */
export type Availability = 0 | 1 | 2 | 3 | 4;

export function availability(
  a: Account, { reachable, rateLimited }: { reachable: boolean; rateLimited: boolean }, nowSec: number,
): Availability {
  if (!reachable) return 4;
  const lanes = (a.lanes ?? []).filter(l => !isModelLane(l) && Number.isFinite(l.pct));
  const running = lanes.filter(l => !lapsed(l, nowSec));
  if (running.some(l => l.id === "seven_day" && l.pct >= 100)) return 3;
  if (rateLimited || running.some(l => l.pct >= 100)) return 2;
  if (lanes.length === 0 || running.length < lanes.length) return 1;
  return 0;
}

/**
 * The accounts in availability order. Stable: inside a group the roster's own
 * order (claude-swap's slots, Codex's order of adding) holds, so a poll that
 * changes a number moves nothing until it changes a group — the issue's
 * "no unstable reshuffling among equivalent accounts".
 */
export function byAvailability<T extends Account>(
  accounts: readonly T[],
  standing: (a: T) => { reachable: boolean; rateLimited: boolean },
  nowSec: number,
): T[] {
  const ranked = accounts.map((a, i) => ({ a, i, g: availability(a, standing(a), nowSec) }));
  ranked.sort((x, y) => x.g - y.g || x.i - y.i);
  return ranked.map(r => r.a);
}

// ── the hold ────────────────────────────────────────────────────────────────

/**
 * The order to draw while the reader is in the list: the one they found it in.
 *
 * `held` is the list's order, by laneKey, at the moment the pointer or the
 * keyboard came in; null when nobody is in it. Rows keep their places under
 * the pointer through every poll, and the fresh order lands when they leave.
 * An account that arrived meanwhile goes at the end, and one that left is
 * simply not there.
 */
export function holdOrder<T extends LaneOwner>(sorted: readonly T[], held: readonly string[] | null): T[] {
  if (!held) return [...sorted];
  const at = new Map(held.map((k, i) => [k, i]));
  const kept = sorted.filter(a => at.has(laneKey(a))).sort((x, y) => at.get(laneKey(x))! - at.get(laneKey(y))!);
  const arrived = sorted.filter(a => !at.has(laneKey(a)));
  return [...kept, ...arrived];
}

// ── which rows are open ─────────────────────────────────────────────────────

/**
 * The name a row's openness is remembered by: laneKey's — the account, never
 * the slot it stands in (#542) — HASHED, because it is written to the
 * browser's store and laneKey is the address itself. The hash is enough to
 * tell a handful of accounts apart, and it keeps the list of addresses out of
 * a file anything on this origin can read. A `slot:` key, for an account with
 * no address, stays as it is and is never written down: see saveOpenness.
 */
export function rowKey(a: LaneOwner): string {
  const key = laneKey(a);
  return key.startsWith("slot:") ? key : `h:${cyrb53(key)}`;
}

/** A 53-bit string hash (cyrb53, public domain). Not a secret; a short,
 *  stable name for a longer one. */
function cyrb53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Which of the other accounts are open.
 *
 * "some": `keys` are the rows the reader opened, one by one — how the panel
 * always worked. "all": every row is open, and `keys` are the rows the reader
 * shut since. So "expand all" keeps holding for an account signed in after it
 * was pressed, and a row's own press still works afterwards, both ways.
 * Keys are rowKey's.
 */
export interface Openness {
  mode: "some" | "all";
  keys: string[];
}

export const NONE_OPEN: Openness = { mode: "some", keys: [] };

export function isOpen(state: Openness, a: LaneOwner): boolean {
  const listed = state.keys.includes(rowKey(a));
  return state.mode === "all" ? !listed : listed;
}

/** The state after one row's own press: lane-open.ts's toggle, over the
 *  mode's list of exceptions. */
export function toggleOne(state: Openness, a: LaneOwner): Openness {
  return { mode: state.mode, keys: toggleLane(state.keys, a, rowKey) };
}

/** Whether every one of these rows is open — what the expand-all control
 *  reads to say which way its next press goes. */
export function allOpen(state: Openness, rows: readonly LaneOwner[]): boolean {
  return rows.length > 0 && rows.every(a => isOpen(state, a));
}

/** The state after the expand-all control: every row shut when every row was
 *  open, and every row open otherwise — including rows opened one by one,
 *  which "expand all" does not ask the reader to shut first. */
export function toggleAll(state: Openness, rows: readonly LaneOwner[]): Openness {
  return allOpen(state, rows) ? NONE_OPEN : { mode: "all", keys: [] };
}

/**
 * The state after a fresh roster: the keys of accounts that have left are
 * dropped, for the reason knownLanes gives — a key left waiting would reopen
 * itself, or stay shut, on whoever signs that address back in. A missing
 * roster changes nothing, and neither does one nobody left.
 */
export function trimOpenness(state: Openness, roster: readonly LaneOwner[] | null | undefined): Openness {
  if (!Array.isArray(roster)) return state;
  const live = new Set(roster.map(rowKey));
  const keys = state.keys.filter(k => live.has(k));
  return keys.length === state.keys.length ? state : { mode: state.mode, keys };
}
