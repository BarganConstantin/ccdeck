// Whether the deck answers its single-key shortcuts — WCAG 2.1.4, Character
// Key Shortcuts (Level A).
//
// Every shortcut on the canvas is one character: L, U and M, `?`, Space. That
// suits a keyboard and fails a voice: speech input that lands on the page
// rather than in a field arrives as keystrokes, so a dictated sentence opens
// panels, flips the theme and, with an R in it, drops every pin. 2.1.4 asks
// for one of three ways out, and this is the first — a switch that turns them
// off. On by default, so nobody's deck changes until they ask.
//
// What "single-key" means here is what the criterion means: a key that types a
// character — a letter, a digit, punctuation or a symbol — plus Space, which
// dictation sends between every two words. A chord (Cmd/Ctrl+,) is not one,
// nor is a named key: Escape, Enter, Tab, Delete and the arrows keep working
// whichever way the switch is set.
//
// One value for the whole page. The window's keydown handler reads it at the
// moment a key arrives (singleKeyShortcutsOn), and every surface that names a
// key subscribes to it (use-single-key-shortcuts.ts), so a flip in Settings
// reaches the next keystroke and every tooltip at once, and another tab of the
// deck follows through the storage event.
import { readStored, writeStored } from "./storage";

/** Where the switch is kept: "0" off, anything else (or nothing) on. */
export const SINGLE_KEY_SHORTCUTS_KEY = "agent-dag.single-key-shortcuts";

/** On unless it was turned off: a deck that never saw the switch keeps its keys. */
export function resolveSingleKeyShortcuts(stored: string | null | undefined): boolean {
  return stored !== "0";
}

/** A key that types one character — the keys the switch turns off. `e.key` is
 *  the character itself for those ("l", "?", " ") and a name for every other
 *  ("Escape", "Enter", "ArrowUp", "Delete"). */
export function isCharacterKey(key: string): boolean {
  return key.length === 1;
}

/** Whether this keystroke is one the switch has silenced. */
export function characterKeyMuted(key: string, singleKeys: boolean): boolean {
  return !singleKeys && isCharacterKey(key);
}

/** A tooltip with its key, while the key does something; the tooltip alone
 *  once the switch is off, so no control advertises a dead key. */
export function withKey(text: string, cap: string, singleKeys: boolean): string {
  return singleKeys ? `${text} (${cap})` : text;
}

let current: boolean | null = null;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

/** The switch as it stands now. Read once from storage, then held here. */
export function singleKeyShortcutsOn(): boolean {
  if (current === null) current = resolveSingleKeyShortcuts(readStored(SINGLE_KEY_SHORTCUTS_KEY));
  return current;
}

/** Flip the switch: remembered for the next load, and told to every reader. */
export function setSingleKeyShortcuts(on: boolean): void {
  if (current === on) return;
  current = on;
  writeStored(SINGLE_KEY_SHORTCUTS_KEY, on ? "1" : "0");
  announce();
}

/** Another tab flipped it. */
function onStorage(event: StorageEvent): void {
  if (event.key !== SINGLE_KEY_SHORTCUTS_KEY) return;
  const next = resolveSingleKeyShortcuts(event.newValue);
  if (next === current) return;
  current = next;
  announce();
}

/** Hear every flip; returns the unsubscribe. The storage listener lives while
 *  anybody is listening. */
export function subscribeSingleKeyShortcuts(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener?.("storage", onStorage);
  };
}
