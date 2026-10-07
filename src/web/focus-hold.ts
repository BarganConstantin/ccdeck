// The camera jump a click on a card makes under reduced motion, held until a
// double-click can no longer follow it.
//
// A click on a card goes to its session (focusAgent) and a double-click opens
// the card's details: two presses, and the camera moves on the first.
// Animated, that costs nothing — the move has barely begun when the second
// press lands, so the card is still under the pointer. Under reduced motion
// the camera does not travel, it jumps (viewport-motion.ts), and it jumped on
// the first press: the second press of a double-click landed on the empty
// canvas, or on another card, and no panel opened.
//
// So under reduced motion the click selects at once and holds its jump for
// the length of a double-click; a double-click takes it over, a click on the
// empty canvas drops it, and a newer click replaces it. A single click's jump
// lands at about the moment the animated move would have finished arriving.

/** How long a double-click's second press can follow its first. No page can
 *  read the system's setting; this is Windows' default and the longest of the
 *  common ones (GNOME's is 400 ms), and about as long as an animated focus
 *  takes to arrive (FOCUS_MS, 450 ms), so the jump a single click makes lands
 *  when the move it stands for would have. */
export const DOUBLE_CLICK_MS = 500;

export interface FocusHold {
  /** Bring this card into view once a double-click can no longer follow the
   *  click that asked for it. A newer hold replaces an older one. */
  hold(id: string): void;
  /** Drop the jump being held, if there is one. */
  cancel(): void;
}

/** Every hold with a jump still waiting, so a camera move the deck makes on
 *  purpose in the meantime can drop them all (cancelHeldFocus). */
const waiting = new Set<FocusHold>();

/**
 * Drop every jump a click is still holding. Animated, a camera move the deck
 * makes after the click — the git view framing for the card just selected, or
 * giving the camera back as it closes — cuts the click's move short and is
 * where the camera ends; held, the click's jump would land after it and undo
 * it. So that move drops it, and both settings end on the same camera.
 */
export function cancelHeldFocus(): void {
  for (const h of [...waiting]) h.cancel();
}

export function createFocusHold({ focus, setTimeout, clearTimeout, ms = DOUBLE_CLICK_MS }: {
  focus: (id: string) => void;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  ms?: number;
}): FocusHold {
  let held: number | null = null;
  const cancel = () => {
    waiting.delete(api);
    if (held === null) return;
    clearTimeout(held);
    held = null;
  };
  const api: FocusHold = {
    hold(id) {
      cancel();
      waiting.add(api);
      held = setTimeout(() => {
        held = null;
        waiting.delete(api);
        // Late, from a timer: a card that has left the board since is not a
        // reason to throw out of one.
        try { focus(id); } catch { /* nothing to bring into view */ }
      }, ms);
    },
    cancel,
  };
  return api;
}
