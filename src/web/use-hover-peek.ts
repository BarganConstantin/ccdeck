// The peek's timing: a card that opens when a pointer rests on a row or a
// keyboard lands on it, and outlives the pointer leaving by long enough to
// cross the gap between the two.
//
// Lifted out of LanSyncSection.tsx unchanged — whether the card is showing,
// the one timer that decides it, and the four verbs the way-in row and its card
// call. The section only draws the row and the card. OtherAccounts reads the
// two timings too, for the card beside its own fold.
import { useEffect, useRef, useState } from "react";

/** How long the pointer has to stay on the way-in row before the peek opens.
 *  A pointer crossing the foot of the panel on its way to something else is not
 *  asking a question, and a card that flashes at every crossing is noise. */
export const PEEK_DELAY_MS = 160;
/** How long the card outlives the pointer leaving it, or the row. Enough to
 *  cross the 4px between the two and to leave by the shortest way without the
 *  card blinking; short enough that a card nobody wants is gone before it is
 *  noticed. */
export const PEEK_GRACE_MS = 140;

export function useHoverPeek() {
  /** Whether the peek is showing — who is on, beside the way-in row. Only the
   *  accounts view has that row; in this section's own view the list is the
   *  answer and the card would be saying it twice. */
  const [peek, setPeek] = useState(false);
  /** The hover's delay, held so a pointer that leaves before it fires cancels
   *  it rather than opening a card behind the pointer. */
  const peekTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);
  // The peek's verbs. One timer does all three, because only one of them can
  // be pending at a time: a pointer arriving cancels a shut, a pointer
  // leaving cancels an open.
  const openPeek = (delay: number) => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setPeek(true), delay);
  };
  // NOT AT ONCE. The card opens 4px from the row, and a pointer moving onto
  // it crosses those 4px of nothing — an immediate shut there closed the card
  // under a pointer that was on its way into it, which is the one move a
  // reader makes after seeing a list appear. The grace is what makes the gap
  // crossable; it is also what lets the pointer leave by the shortest way
  // without the card flickering behind it.
  const shutPeek = () => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => setPeek(false), PEEK_GRACE_MS);
  };
  // The pointer is on the card: whatever was pending, it is not wanted.
  const holdPeek = () => window.clearTimeout(peekTimer.current);
  // The press is leaving this view for the section's own. No grace: the card
  // would outlive the view it belongs to.
  const dropPeek = () => { window.clearTimeout(peekTimer.current); setPeek(false); };
  return { peek, openPeek, shutPeek, holdPeek, dropPeek };
}
