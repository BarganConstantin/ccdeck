// Which finished turns you have looked at.
//
// The rail's "Done · unseen" group is the one thing the deck cannot know from
// its stream: a turn ends, and whether you were there is a fact about you, not
// about the session. So the deck remembers it here, on this browser only. No
// route, no account, nothing another deck is told.
//
// What is kept is the turn's END, per session: the moment of the last turn you
// looked at. A session is unseen while its latest turn ended after that, so a
// new finished turn makes it unseen again without anything clearing a flag.
//
// "Looked at" is the session selected, the session open on the stage, and a
// press on its row (use-mark-seen.ts, the rail's own click), and only while the
// tab is the one on screen: a turn that ends under a selection in a hidden tab
// is still news when you come back. Pointing at a row does not count.
//
// Two more rules keep the group honest. A first run has no memory at all, which
// would put every session the deck already knew about in Done · unseen, so the
// first state to arrive is taken as a baseline (baselineSeen). And several tabs
// share one key: each write re-reads the stored map and merges, the later turn
// end winning per session, and a `storage` event from another tab merges in
// too, so one tab never drops another's marks.
import { useSyncExternalStore } from "react";
import { readStored, writeStored } from "./storage";
import type { WaitingBlock } from "./types";

const SEEN_KEY = "agent-dag.sessionsSeen";
/** The bound the recap list keeps, for the same reason: sessions do not stop
 *  coming and this lives in localStorage. The oldest looks go first. */
export const SEEN_CAP = 200;

/** The stored map, or an empty one where it is absent, unreadable or not a map. */
export function parseSeen(raw: string | null): Map<string, number> {
  const seen = new Map<string, number>();
  if (!raw) return seen;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [id, at] of Object.entries(obj)) if (typeof at === "number" && Number.isFinite(at)) seen.set(id, at);
    }
  } catch { /* unreadable: start empty, as a first run does */ }
  return seen;
}

/** Two tabs' maps as one: per session the later turn end wins, and the cap
 *  drops the oldest looks. Sorted by the time looked at, so which tab wrote a
 *  mark does not decide what the cap keeps (the sort is stable: ties keep the
 *  order they were given). */
export function mergeSeen(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): Map<string, number> {
  const all = new Map(a);
  for (const [id, at] of b) if (at > (all.get(id) ?? -Infinity)) all.set(id, at);
  const kept = [...all].sort((x, y) => x[1] - y[1]).slice(-SEEN_CAP);
  return new Map(kept);
}

let seen = parseSeen(readStored(SEEN_KEY));
/** The key was never written (as opposed to written empty): the next state to
 *  arrive is a baseline. Absent, not empty, so a deck that has marked nothing
 *  yet is not mistaken for a first run once something has been stored. */
let firstRun = readStored(SEEN_KEY) === null;
const listeners = new Set<() => void>();
/** Moves on every change, for the rail to rebuild its groups on. */
let version = 0;

function changed(): void {
  version++;
  for (const listener of listeners) listener();
}

/** Another tab wrote the key: merge what it knows. Exported for the suite, which
 *  has no second tab to fire the event from. */
export function syncSeenFromStorage(): void {
  const raw = readStored(SEEN_KEY);
  if (raw !== null) firstRun = false;
  const merged = mergeSeen(seen, parseSeen(raw));
  if (merged.size === seen.size && [...merged].every(([id, at]) => seen.get(id) === at)) return;
  seen = merged;
  changed();
}

function onStorage(e: StorageEvent): void {
  if (e.key === SEEN_KEY || e.key === null) syncSeenFromStorage();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

/** Re-reads the store, folds this tab's map into it, applies `update`, and
 *  writes the result: no write is made from a map that has not seen the
 *  other tabs' latest. A store that refuses remembers it for this page, not
 *  the next. */
function commit(update: (map: Map<string, number>) => void): void {
  const next = mergeSeen(seen, parseSeen(readStored(SEEN_KEY)));
  update(next);
  seen = mergeSeen(next, new Map());
  firstRun = false;
  changed();
  writeStored(SEEN_KEY, JSON.stringify(Object.fromEntries(seen)));
}

/** When a session's latest turn ended, or null while one is running. The
 *  reducer keeps `endedAt` on the root from its Stop to its next prompt; the
 *  idle block's `since` is the fallback for a session that only the notification
 *  says is waiting on its next prompt. `endedAt` first, because the idle block
 *  lands about a minute AFTER the turn ended: reading `since` once it exists
 *  would move the end later than a look taken in that minute, and mark a
 *  session you were watching as unseen. */
export function turnEndedAt(a: { state: string; endedAt?: number; waiting?: WaitingBlock | null }): number | null {
  const idle = a.waiting?.kind === "idle" ? a.waiting.since : null;
  if (a.state === "active" && idle == null) return null;
  return a.endedAt ?? idle;
}

/** Whether the turn that ended at `endedAt` is one you have not looked at. */
export function isUnseen(sessionId: string, endedAt: number | null | undefined): boolean {
  return endedAt != null && endedAt > (seen.get(sessionId) ?? 0);
}

/** You looked at this session's turn that ended at `endedAt`. Does nothing
 *  while the tab is hidden, for a turn still running, or for one already seen. */
export function markSeen(sessionId: string, endedAt: number | null | undefined): void {
  if (endedAt == null) return;
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  if ((seen.get(sessionId) ?? 0) >= endedAt) return;
  commit(map => { map.set(sessionId, Math.max(endedAt, map.get(sessionId) ?? 0)); });
}

/** The first state of the board to arrive, on a first run: every turn that has
 *  already ended is marked seen, once, so only turns that end after this are
 *  news. "Arrived" is the first time the board holds any session at all (an
 *  empty `ends` is a state that has not come yet and does nothing), so a deck
 *  that connects before its snapshot is applied does not baseline an empty
 *  board and then call the whole snapshot unseen. Not a look, so it does not
 *  ask whether the tab is visible. Returns whether it took the baseline. */
export function baselineSeen(ends: Iterable<readonly [string, number | null]>): boolean {
  if (!firstRun) return false;
  const list = [...ends];
  if (list.length === 0) return false;
  commit(map => {
    for (const [id, at] of list) if (at != null && at > (map.get(id) ?? 0)) map.set(id, at);
  });
  return true;
}

/** A number that moves whenever a session is marked seen, for a memo to rebuild on. */
export function useSessionsSeenVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

/** The suite's way back to a first run (`firstRun: true`) or to a deck that has
 *  been used before (the default). */
export function resetSessionsSeen(opts: { firstRun?: boolean } = {}): void {
  seen = new Map();
  firstRun = opts.firstRun === true;
  changed();
}
