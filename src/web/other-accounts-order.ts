// How the accounts behind the fold are ordered and which of them are open
// (#1579).
//
// With nine or more accounts in Other accounts the list was hard to compare:
// it stood in slot order (1, 5, 8, 9, 10, …), which says nothing about which
// account is nearly spent or which has room, and each row had to be opened on
// its own to show its bars — and every one of them shut again when the panel
// was closed, because the set of open rows lived in the panel's state.
//
// Three rules live here, as functions the suite can call without a DOM:
//
//   - the ORDER: slot, or how full each account is by one window — 5h, 7d or
//     a model's — fullest first (what is about to run out) or emptiest first
//     (where to switch next), or by room, the tightest window's headroom —
//     the fold's peek's own measure of where to go;
//   - which rows are OPEN, as a mode and its exceptions, so "expand all" is a
//     fact that holds for an account that arrives later rather than a list of
//     whoever was there when it was pressed;
//   - the HOLD: while the pointer or the keyboard is in the list, a poll that
//     moves the numbers does not move the rows under them.
//
// What is remembered between reloads — the order and the open rows — is
// accounts-prefs.ts's.
import type { Account, Lane } from "./claude-accounts";
import { laneKey, toggleLane, type LaneOwner } from "./lane-open";

// ── the order ───────────────────────────────────────────────────────────────

/** One entry in the order menu. `id` is what is stored; `label` is what the
 *  menu lists, and what its closed control shows. */
export interface OrderChoice {
  id: string;
  label: string;
}

export const SLOT_ORDER = "slot";

/** The windows every account has, by the lane ids the server sends. */
const WINDOWS: { lane: string; name: string }[] = [
  { lane: "five_hour", name: "5h" },
  { lane: "seven_day", name: "7d" },
];

/** A model lane's name, which is the label the server gives it ("Opus"). */
const isModelLane = (l: Lane) => l.id.startsWith("scoped-");

/** The name an order calls a lane by: "5h", "7d", or the model's label. */
export function laneName(l: Lane): string {
  return WINDOWS.find(w => w.lane === l.id)?.name ?? l.label;
}

/**
 * What an order sorts by, for the rows to mark: a window's name, "room" for
 * the tightest window of each account, or null for slot order. A sorted list
 * that did not say what it was sorted by left the reader to work it out from
 * numbers at ragged positions in every row.
 */
export function orderKey(order: string): string | null {
  if (order === "room") return "room";
  const m = /^(.+):(full|empty)$/.exec(order);
  return m ? m[1] : null;
}

/**
 * Every order the menu offers for these accounts: slot, then fullest and
 * emptiest by 5h and by 7d, then the same for each model window any of them
 * has, then by room.
 *
 * The model entries come from the accounts in the list, so a store with no
 * Opus lane is not offered an Opus order that would sort nothing.
 */
export function orderChoices(accounts: readonly Account[]): OrderChoice[] {
  const models = [...new Set(accounts.flatMap(a => (a.lanes ?? []).filter(isModelLane).map(l => l.label)))]
    .sort((x, y) => x.localeCompare(y));
  const windows = [...WINDOWS.map(w => w.name), ...models];
  return [
    { id: SLOT_ORDER, label: "Slot" },
    ...windows.flatMap(w => [
      { id: `${w}:full`, label: `${w} · fullest` },
      { id: `${w}:empty`, label: `${w} · emptiest` },
    ]),
    { id: "room", label: "Most room" },
  ];
}

/** An account's reading of one window, or null when it has none. */
function windowPct(a: Account, name: string): number | null {
  const fixed = WINDOWS.find(w => w.name === name);
  const lane = (a.lanes ?? []).find(l => (fixed ? l.id === fixed.lane : isModelLane(l) && l.label === name));
  return lane && Number.isFinite(lane.pct) ? lane.pct : null;
}

/**
 * The accounts in the chosen order. Stable, and slot order is the tiebreak,
 * so two accounts at the same reading keep the order they always had.
 *
 * AN ACCOUNT WITH NO READING GOES LAST, in either direction. It is not empty
 * and it is not full — nothing has been collected for it — and sorting it as
 * a zero would put an unread account at the top of "emptiest first", which is
 * the list of where to switch next.
 *
 * AND THE TWO ORDERS THAT ANSWER "WHERE NEXT" PUT THE ACCOUNTS NOBODY CAN
 * SWITCH TO AFTER THE ONES THEY CAN. Emptiest first and most room are read as
 * a queue, and an account held out of rotation, or one whose login no switch
 * can get past, at the top of that queue is a row with no Switch on it where
 * the next hop should be — the fold's own peek already ranks them that way.
 * Fullest first is a list of what is about to run out, and every account is
 * part of that answer. `reachable` is account-fold.ts's.
 *
 * An order this build does not offer, or one for a model no account has any
 * more, is slot order: the stored choice is whatever was in the store.
 */
export function sortAccounts<T extends Account>(
  accounts: readonly T[], order: string, reachable: (a: T) => boolean = () => true,
): T[] {
  // "Slot" is the roster's own order — claude-swap's sequence, which the live
  // row above is drawn in too — and it is every other order's tiebreak.
  const bySlot = [...accounts];
  const reachableFirst = (sorted: T[]) => [...sorted.filter(reachable), ...sorted.filter(a => !reachable(a))];
  if (order === "room") {
    return reachableFirst(rank(bySlot, a => (Number.isFinite(a.headroom) ? a.headroom : null), "desc"));
  }
  const m = /^(.+):(full|empty)$/.exec(order);
  if (!m) return bySlot;
  const [, name, dir] = m;
  if (!bySlot.some(a => windowPct(a, name) != null)) return bySlot;
  const ranked = rank(bySlot, a => windowPct(a, name), dir === "full" ? "desc" : "asc");
  return dir === "empty" ? reachableFirst(ranked) : ranked;
}

function rank<T>(items: T[], value: (x: T) => number | null, dir: "asc" | "desc"): T[] {
  const read = items.filter(x => value(x) != null);
  const unread = items.filter(x => value(x) == null);
  // Array.prototype.sort is stable, so equal readings keep their slot order.
  read.sort((x, y) => (dir === "desc" ? value(y)! - value(x)! : value(x)! - value(y)!));
  return [...read, ...unread];
}

/** A stored order, or slot when it is not one of these accounts' choices. */
export function validOrder(order: string | null | undefined, accounts: readonly Account[]): string {
  return orderChoices(accounts).some(c => c.id === order) ? (order as string) : SLOT_ORDER;
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
