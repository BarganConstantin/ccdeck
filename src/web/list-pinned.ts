// Sessions pinned to the top of the Sessions list, the way Claude's desktop
// app pins a conversation: a group of their own, Pinned, above Needs you, in
// the order they were pinned.
//
// A PIN MOVES THE ROW AND NOTHING ELSE. The row keeps its own state: its glyph,
// its clock and its second line are the ones its usual group would draw
// (SessionList.tsx draws every row with rank(), not with the group it sits
// in), so a pinned session that starts waiting on you still says so, in the
// warn tone. It is listed once, in Pinned, never in its state's group as well
// (rail-model.ts railSlots). Going into Pinned or out of it is a group change
// like any other: held while the pointer or the keyboard is on the list, and
// played when they leave (rail-model.ts holdOrder).
//
// A PINNED ROW CANNOT BE HIDDEN. The two acts pull opposite ways, so a pinned
// row has no Hide from list: no crossed eye, and Delete on it is not the
// row's (RailParts.tsx hideOnDelete only answers a row that offers a hide).
// Delete does not unpin either: it is the key that takes things away, and a
// pin is taken off by the same press that put it on. A hidden mark another tab
// left on a pinned session loses to the pin.
//
// IT GOES WITH ITS SESSION. When the session leaves the board (the cap on
// finished sessions or on agents evicts it, or the board is cleared), its row
// leaves Pinned and the pin is dropped from storage, once the deck has heard
// its whole history: a session that comes back later under the same id comes
// back as a new one, not pinned.
//
// STORED as an array of ids, oldest pin first, under one agent-dag.* key beside
// the hidden marks (list-hidden.ts), capped. A store that is missing, blocked
// or holds anything else reads as nothing pinned.
import { isApplePlatform } from "./platform";

export const LIST_PINNED_KEY = "agent-dag.listPinned";

/** How many pins are kept. Pins go with their sessions, so a list never comes
 *  near it; the cap is for a store that is never pruned, and drops the oldest. */
export const LIST_PINNED_CAP = 100;

/** The pinned sessions' ids, oldest pin first. */
export type PinnedIds = readonly string[];

function capped(ids: string[]): string[] {
  return ids.length <= LIST_PINNED_CAP ? ids : ids.slice(ids.length - LIST_PINNED_CAP);
}

export function readListPinned(store: Pick<Storage, "getItem"> | null): PinnedIds {
  try {
    const value: unknown = JSON.parse(store?.getItem(LIST_PINNED_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    const ids: string[] = [];
    for (const id of value) {
      // A repeated id keeps its first place: the order is when it was pinned.
      if (typeof id === "string" && id !== "" && !ids.includes(id)) ids.push(id);
    }
    return capped(ids);
  } catch { return []; }
}

export function saveListPinned(store: Pick<Storage, "setItem"> | null, ids: PinnedIds): void {
  try { store?.setItem(LIST_PINNED_KEY, JSON.stringify(ids)); } catch { /* disabled storage, full quota */ }
}

/** The pins with `id` added as the newest: the SAME array when it is pinned
 *  already, so a caller can tell a change from nothing. */
export function withPinned(ids: PinnedIds, id: string): PinnedIds {
  return ids.includes(id) ? ids : capped([...ids, id]);
}

/** The pins without `drop`: the SAME array when none of them was pinned. */
export function withoutPinned(ids: PinnedIds, drop: Iterable<string>): PinnedIds {
  const gone = new Set(drop);
  return ids.some(id => gone.has(id)) ? ids.filter(id => !gone.has(id)) : ids;
}

/** Pinned if it was not, not pinned if it was. */
export function togglePinned(ids: PinnedIds, id: string): PinnedIds {
  return ids.includes(id) ? withoutPinned(ids, [id]) : withPinned(ids, id);
}

/** The pins without the sessions the deck no longer knows. Asked only once the
 *  deck has heard its whole history, when a session it does not know is one
 *  that has left the board. The SAME array when nothing goes. */
export function prunedPinned(ids: PinnedIds, knows: (id: string) => boolean): PinnedIds {
  return withoutPinned(ids, ids.filter(id => !knows(id)));
}

/**
 * THE PIN KEY: Alt+P (⌥P on a Mac), on a focused row, pins it or takes the
 * pin off.
 *
 * P is pin's letter, but a bare P is the deck's peek, and so is Shift+P (the
 * deck reads "P" as P whatever Shift says, use-deck-shortcuts.ts); N, Shift+N
 * and L are taken too, and the few letters left free say nothing about a pin.
 * With Alt the letter is nobody's: the deck hands every Alt chord to the
 * browser before it reads a letter (shortcuts.ts isBrowserChord), and no
 * browser binds Alt+P. A chord is not a single-key shortcut, so like Delete
 * (hide) and F2 (rename) on the same row it keeps working with Settings ›
 * Keyboard's single-key switch off, and dictation never types it.
 *
 * Read as the release chord reads its X (terminal-keys.ts): by the letter where
 * the layout types a Latin one, else by the key's place. Option+P types π on a
 * Mac, and a Cyrillic layout types з on that key.
 */
export function isPinChord(e: { key: string; code?: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; repeat: boolean }): boolean {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return false;
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase() === "p";
  return e.key === "π" || e.code === "KeyP";
}

/** The pin key as the keys in front of the reader label it, for its tooltip. */
export function pinChordLabel(platform: string): string {
  return isApplePlatform(platform) ? "⌥P" : "Alt+P";
}
