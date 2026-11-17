// KEYS UNTIL LEARNED. The status bar named the same keys on every load, to a
// reader who pressed j a thousand times. So each key it names is counted when
// the deck's own handler answers it from the keyboard (use-deck-shortcuts.ts),
// and a key used LEARNED_AFTER times is learned: the bar stops naming it. Once
// every key of a layer is learned the bar keeps one quiet "? Keys", the way to
// the keyboard sheet that lists them all (StatusBar.tsx).
//
// Per browser, in one JSON key of storage.ts (KEY_USES_KEY): counts by hint id.
// A press of a button is not a use of its key, so nothing here hears the
// mouse. A held key is one use: the handler notes a press, not its repeats.
// Counting stops at LEARNED_AFTER, so a learned key writes nothing again.
//
// Where the store refuses (a private window, blocked site data), the counts
// live in this tab and are forgotten with it: the bar names the keys again on
// the next load, which is where it started.
import { useSyncExternalStore } from "react";
import { KEY_USES_KEY, readStored, writeStored } from "./storage";

/** The keys the status bar names and the deck counts (status-hints.ts). One id
 *  per hint, not per letter: j and k walk cards on the board and sessions on
 *  the deck, two different things to learn. n is the same move in both. */
export type LearnedKey =
  | "cards" | "select" | "peek" | "nextWaiting" | "pause"
  | "sessions" | "openAndType" | "view";

/** Uses after which a key is learned. */
export const LEARNED_AFTER = 3;

export type KeyUses = Readonly<Partial<Record<LearnedKey, number>>>;

/** What a stored value says, or nothing for anything that is not an object of
 *  counts: a value an earlier build or a hand wrote is not worth failing on. */
function parse(raw: string | null): KeyUses {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Partial<Record<LearnedKey, number>> = {};
    for (const [id, n] of Object.entries(value)) {
      if (typeof n === "number" && Number.isFinite(n) && n > 0) out[id as LearnedKey] = Math.min(LEARNED_AFTER, Math.floor(n));
    }
    return out;
  } catch { return {}; }
}

/** This tab's counts. Read from the store once, then kept: one object until a
 *  use changes it, which is what useSyncExternalStore needs from a snapshot. */
let uses: KeyUses | null = null;
const listeners = new Set<() => void>();

/** The counts now. */
export function keyUses(): KeyUses {
  if (uses === null) uses = parse(readStored(KEY_USES_KEY));
  return uses;
}

/** Whether the key has been used enough to stop naming it. */
export function isLearned(id: LearnedKey, counts: KeyUses = keyUses()): boolean {
  return (counts[id] ?? 0) >= LEARNED_AFTER;
}

/** One use of a key the bar names, from the keyboard. Asks the store first, so
 *  another tab's uses are not written over; a learned key writes nothing. */
export function noteKeyUse(id: LearnedKey): void {
  const mine = keyUses();
  if (isLearned(id, mine)) return;
  // Each key at the higher of the two counts: this tab's, and what the store
  // holds now, which another tab may have moved on.
  const merged: Partial<Record<LearnedKey, number>> = { ...mine };
  for (const [key, n] of Object.entries(parse(readStored(KEY_USES_KEY))) as [LearnedKey, number][]) {
    merged[key] = Math.max(merged[key] ?? 0, n);
  }
  merged[id] = Math.min(LEARNED_AFTER, (merged[id] ?? 0) + 1);
  uses = merged;
  writeStored(KEY_USES_KEY, JSON.stringify(merged));
  emit();
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab's uses reach this one through the store.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY_USES_KEY && e.key !== null) return;
    uses = parse(readStored(KEY_USES_KEY));
    listener();
  };
  if (typeof window !== "undefined") window.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener?.("storage", onStorage);
  };
}

/** The counts, kept current: re-renders whoever asks when a key is used. */
export function useLearnedKeys(): KeyUses {
  return useSyncExternalStore(subscribe, keyUses, keyUses);
}
