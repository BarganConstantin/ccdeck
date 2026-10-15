// The single-key shortcuts switch, for a component: whether the keys are on,
// re-rendering whoever asks when it flips. The value and its rules are
// single-key-shortcuts.ts's; this is only the subscription.
import { useSyncExternalStore } from "react";
import { singleKeyShortcutsOn, subscribeSingleKeyShortcuts } from "./single-key-shortcuts";

/** True while the deck answers its single-key shortcuts (Settings › General). */
export function useSingleKeyShortcuts(): boolean {
  return useSyncExternalStore(subscribeSingleKeyShortcuts, singleKeyShortcutsOn, singleKeyShortcutsOn);
}
