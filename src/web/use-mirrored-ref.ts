// A ref that always holds the current value of a piece of state.
//
// The idiom this replaces was written twelve times in App.tsx's `Inner`:
//
//     const tonePrefsRef = useRef(tonePrefs);
//     tonePrefsRef.current = tonePrefs;
//
// It exists because a long-lived listener — an SSE handler, a keydown handler, a
// chime player built once on mount — must read the CURRENT value rather than the
// one that was in scope when it was registered. Closing over the state variable
// instead is the bug this pattern prevents, and the deck has paid for that bug
// before: see pause.ts on why a gate read through a ref rather than through a
// closure, and what a toggle did when it did not.
//
// Naming it buys two things beyond the twelve duplicated lines. The assignment
// happens DURING RENDER, which React documents as something to avoid, and a
// reader meeting a bare `xRef.current = x` has no way to know whether that is
// deliberate or a mistake somebody left behind. It is deliberate, for the reason
// above, and it is safe for the narrow reason that the write is idempotent and
// derives only from this render's own props and state — so a render thrown away
// by React, or run twice in StrictMode, leaves the ref holding exactly what the
// committed render would have left. That argument is worth writing down once
// rather than being re-derived at twelve call sites, none of which stated it.
import { useRef, type MutableRefObject } from "react";

/**
 * @param value The state to mirror. Read it back as `ref.current` from anything
 *   that outlives a render — never as a way to avoid a dependency array in a
 *   hook that should simply declare one.
 */
export function useMirroredRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
