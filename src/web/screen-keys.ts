// The keys a screen adds to the deck's while it is on: the Decision card's
// and the question card's, handed here by the card itself (screens chunk) and
// read by the keyboard sheet (KeyboardHelp `extraGroups`) and the status bar
// (StatusBar `extra`). Imports no screen: the deck learns a card's keys only
// while one is drawn, so with Chat off neither names them.
import { useSyncExternalStore } from "react";
import type { KeyHelpGroup } from "./key-help";
import type { StatusHint } from "./status-hints";

export interface ScreenKeys {
  /** The sheet's group for the card. */
  group: KeyHelpGroup;
  /** The status bar's layer, while the focus is in the card's pane; else none. */
  status?: { layer: string; label: string; hints: readonly StatusHint[] };
}

const shown = new Map<object, ScreenKeys>();
const listeners = new Set<() => void>();
let current: ScreenKeys | null = null;

/** Says what keys `owner` adds, or that it adds none any more (null). The
 *  last one said wins; one with the focus in its pane before any other. */
export function showScreenKeys(owner: object, keys: ScreenKeys | null): void {
  if (keys) {
    shown.delete(owner);
    shown.set(owner, keys);
  } else if (!shown.delete(owner)) {
    return;
  }
  const all = [...shown.values()];
  current = all.filter(k => k.status).at(-1) ?? all.at(-1) ?? null;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const read = () => current;
const none = () => null;

/** The keys the screens on now add, or null. A component called as a plain
 *  function (as some tests do) has no React to subscribe with: it reads once. */
export function useScreenKeys(): ScreenKeys | null {
  try {
    return useSyncExternalStore(subscribe, read, none);
  } catch {
    return current;
  }
}
