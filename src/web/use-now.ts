// A clock a component can subscribe to, shared by everything on the same beat
// (#873).
//
// The canvas used to hand `now` down from one 250ms `setNow` in App, through the
// node data, to every card — so every card and every sparkline re-rendered four
// times a second whether or not anything on it had changed. The few things that
// actually print a duration subscribe here instead, at the rate they need, and
// one interval per rate serves all of them: a hundred clocks on one board are
// one timer, not a hundred. The timer starts with the first subscriber and
// stops with the last.
import { useSyncExternalStore } from "react";

interface Beat {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const beats = new Map<number, Beat>();

function beat(intervalMs: number): Beat {
  let b = beats.get(intervalMs);
  if (!b) {
    b = { now: Date.now(), listeners: new Set(), timer: null };
    beats.set(intervalMs, b);
  }
  return b;
}

/** Subscribe to the beat of `intervalMs`; returns the unsubscribe. */
export function subscribeNow(intervalMs: number, listener: () => void): () => void {
  const b = beat(intervalMs);
  b.listeners.add(listener);
  if (b.timer === null) {
    b.now = Date.now();
    b.timer = setInterval(() => {
      b.now = Date.now();
      for (const l of b.listeners) l();
    }, intervalMs);
  }
  return () => {
    b.listeners.delete(listener);
    if (b.listeners.size === 0 && b.timer !== null) {
      clearInterval(b.timer);
      b.timer = null;
    }
  };
}

/** The time as of the last beat of `intervalMs`. */
export function nowAt(intervalMs: number): number {
  return beat(intervalMs).now;
}

// One subscribe and one snapshot function per rate, so useSyncExternalStore sees
// the same identities on every render and does not resubscribe each time.
const subscribers = new Map<number, (listener: () => void) => () => void>();
const snapshots = new Map<number, () => number>();

/** The current time, updated every `intervalMs` and shared by every caller at
 *  that rate. */
export function useNow(intervalMs = 1000): number {
  let subscribe = subscribers.get(intervalMs);
  if (!subscribe) {
    subscribe = listener => subscribeNow(intervalMs, listener);
    subscribers.set(intervalMs, subscribe);
  }
  let snapshot = snapshots.get(intervalMs);
  if (!snapshot) {
    snapshot = () => nowAt(intervalMs);
    snapshots.set(intervalMs, snapshot);
  }
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
