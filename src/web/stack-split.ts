// The height Sessions and Accounts share in the left column, the reader's to
// drag (StackSplit.tsx).
//
// With both open they stand one under the other (left-column.css): Sessions
// on top took what was left and kept at least half, and Accounts under it
// took its content's height up to the rest. A short list then sat over empty
// room while Accounts scrolled its roster under it. The line between the two
// is now a split, as the one between Usage and This machine is in Workspace's
// side column (side-column.ts): dragged, it gives one more height and the
// other less, and the share is kept in this browser.
//
// WHAT IS KEPT is Sessions' share of the height the two have between them, 0
// to 1, so a taller or shorter window keeps the same proportion. Nothing kept
// is the layout as it was, which is where a double click or Enter on the
// split goes back to. The same column is drawn on the Board and in
// Workspace, and it keeps one share for both.
//
// THE WINDOW HAS THE LAST WORD. Each part keeps at least its own minimum: the
// list its header and a few rows, Accounts its header, a row and its foot,
// where the way into Local network is. A window too short for both shares
// what it has (left-column.css clamps the same way), and a taller one gives
// the kept share back untouched.
import { useCallback, useState } from "react";
import { readStored, removeStored, writeStored } from "./storage";

/** Where the reader's share is kept: Sessions' share, a number from 0 to 1. */
export const STACK_KEY = "agent-dag.leftColumnStack";
/** The split's own height, between the two parts. */
export const STACK_SPLIT_H = 8;
/** The least height Sessions keeps: its header and three rows. */
export const SESSIONS_MIN = 140;
/** The least height Accounts keeps: its header, a row and its foot. */
export const ACCOUNTS_MIN = 160;
/** An arrow key moves the split this far; with Shift, STACK_KEY_STEP_BIG. */
export const STACK_KEY_STEP = 8;
export const STACK_KEY_STEP_BIG = 32;

const round = (share: number) => Math.round(share * 1000) / 1000;

/** A kept share, or null for none, an older value or one that does not read. */
export function parseStackShare(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? round(n) : null;
}

/**
 * Sessions' share for a split `top` px into `room` px, the height the two
 * parts have between them: each part keeps its minimum. When the room cannot
 * hold both minimums, Sessions keeps the share of the room its own minimum is
 * of the two, so neither part is squeezed out alone.
 */
export function stackShareFor(top: number, room: number): number {
  if (!(room > 0)) return 0.5;
  if (room < SESSIONS_MIN + ACCOUNTS_MIN) return round(SESSIONS_MIN / (SESSIONS_MIN + ACCOUNTS_MIN));
  const at = Math.max(SESSIONS_MIN, Math.min(room - ACCOUNTS_MIN, top));
  return round(at / room);
}

/** The reader's kept share (null for none), and the two ways to change it. */
export function useStackShare(): { share: number | null; choose: (share: number) => void; reset: () => void } {
  const [share, setShare] = useState<number | null>(() => parseStackShare(readStored(STACK_KEY)));
  const choose = useCallback((next: number) => {
    const value = parseStackShare(String(next));
    if (value === null) return;
    setShare(value);
    writeStored(STACK_KEY, String(value));
  }, []);
  const reset = useCallback(() => {
    setShare(null);
    removeStored(STACK_KEY);
  }, []);
  return { share, choose, reset };
}
