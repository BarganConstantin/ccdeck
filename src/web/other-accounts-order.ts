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
//     (where to switch next), or by room, the tightest window's headroom,
//     which is how the deck already ranks where to go;
//   - which rows are OPEN, as a mode and its exceptions, so "expand all" is a
//     fact that holds for an account that arrives later rather than a list of
//     whoever was there when it was pressed;
//   - the HOLD: while the pointer or the keyboard is in the list, a poll that
//     moves the numbers does not move the rows under them.
//
// What is remembered between reloads — the order and the open rows — is
// accounts-prefs.ts's.
import type { Account, Lane } from "./claude-accounts";
import { knownLanes, laneKey, type LaneOwner } from "./lane-open";

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
 * An order this build does not offer, or one for a model no account has any
 * more, is slot order: the stored choice is whatever was in the store.
 */
export function sortAccounts<T extends Account>(accounts: readonly T[], order: string): T[] {
  const bySlot = [...accounts].sort((x, y) => x.num - y.num);
  if (order === "room") return rank(bySlot, a => a.headroom, "desc");
  const m = /^(.+):(full|empty)$/.exec(order);
  if (!m) return bySlot;
  const [, name, dir] = m;
  if (!bySlot.some(a => windowPct(a, name) != null)) return bySlot;
  return rank(bySlot, a => windowPct(a, name), dir === "full" ? "desc" : "asc");
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
 * Which of the other accounts are open.
 *
 * "some": `keys` are the rows the reader opened, one by one — how the panel
 * always worked. "all": every row is open, and `keys` are the rows the reader
 * shut since. So "expand all" keeps holding for an account signed in after it
 * was pressed, and a row's own press still works afterwards, both ways.
 * Keys are laneKey's: the account, never the slot it stands in (#542).
 */
export interface Openness {
  mode: "some" | "all";
  keys: string[];
}

export const NONE_OPEN: Openness = { mode: "some", keys: [] };

export function isOpen(state: Openness, a: LaneOwner): boolean {
  const listed = state.keys.includes(laneKey(a));
  return state.mode === "all" ? !listed : listed;
}

/** The state after one row's own press. */
export function toggleOne(state: Openness, a: LaneOwner): Openness {
  const key = laneKey(a);
  const keys = state.keys.includes(key) ? state.keys.filter(k => k !== key) : [...state.keys, key];
  return { mode: state.mode, keys };
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
  const keys = knownLanes(state.keys, roster);
  return keys === state.keys ? state : { mode: state.mode, keys };
}
