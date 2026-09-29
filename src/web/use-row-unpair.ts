// The unpair on a paired row: which row is armed, since when, when it stands
// down, and what a press on it means.
//
// Lifted out of LanSyncSection.tsx unchanged. LanDeckList draws the button and
// hands every press back; the decision is made here, and a confirmed unpair
// goes through the section's own `answer`, under the busy tag the row lights.
// It is not the list's state, because the list goes with the view and an arm
// has to outlive it: a row armed a moment ago is still armed when the view
// comes back inside its four seconds.
import { useEffect, useRef, useState } from "react";

import type { DeckRow } from "./lan-roster";
import { armedPress, CONFIRM_GAP_MS } from "./panel-press";
import type { useLanSection } from "./use-lan-section";

type Section = ReturnType<typeof useLanSection>;

/** @param answer The section's verb for a request, which a confirmed unpair
 *  is sent through. */
export function useRowUnpair(answer: Section["answer"]) {
  /** Which unpair is armed. The account rows above have made an irreversible
   *  press cost a second deliberate one since the panel was written; this row
   *  is the same act against a different noun. */
  const [armed, setArmed] = useState<string | null>(null);
  /** When `armed` was set, so a double-click cannot be its own confirmation —
   *  see CONFIRM_GAP_MS. */
  const armedAt = useRef(0);
  // An armed unpair stands down on its own, four seconds after THAT arm (#1539).
  // The timer used to be set by the press and left running, and it only asked
  // whether the same row was still armed — so a row armed, left for another,
  // and armed again was stood down by the first arm's timer, a second or two
  // into its own four. Keyed on the arm, a new arm clears the old timer.
  useEffect(() => {
    if (armed == null) return;
    const t = window.setTimeout(() => setArmed(null), 4_000);
    return () => window.clearTimeout(t);
  }, [armed]);
  /** A press on a paired row's unpair. The row draws the button; the decision
   *  — arm, confirm, or a double-click that is neither — and the state it reads
   *  stay here, so a row armed a moment ago is still armed when the view comes
   *  back inside its four seconds. */
  const pressUnpair = (p: DeckRow) => {
    const now = Date.now();
    const press = armedPress({
      armedFor: armed, target: p.fp, armedAt: armedAt.current, now, gapMs: CONFIRM_GAP_MS,
    });
    if (press === "arm") {
      setArmed(p.fp);
      armedAt.current = now;
      return;
    }
    // A double-click is one decision, not two: its second
    // press lands before anybody could have read `confirm`.
    if (press === "ignore") return;
    setArmed(null);
    void answer("unpair", p.fp, "unpair that deck");
  };
  return { armed, pressUnpair };
}
