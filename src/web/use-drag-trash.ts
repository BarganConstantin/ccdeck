// The drop zone a card is dragged onto to take it off the board.
//
// Lifted out of App.tsx's `Inner`, where it was three state variables, a ref,
// a presence phase and a hit test, written from three drag handlers a hundred
// lines apart: the start named the card and raised the zone, every move asked
// how close the pointer was, and the stop asked once more and lowered it. Those
// three are now the operations here, and the setters are private. The start is
// the one that decides what the zone shows: a card raises it under its own
// name, and a session's box, which carries every card in the session, raises it
// under the name of the session's root card.
import { useCallback, useRef, useState } from "react";

import { usePanelPresence } from "./panel-exit";
import { clientPointOf, trashProximity, type TrashProximity } from "./trash-zone";

type DragEvent = Parameters<typeof clientPointOf>[0];

export function useDragTrash() {
  const [trashDragging, setTrashDragging] = useState(false);
  const [trashLabel, setTrashLabel] = useState("");
  const [trashState, setTrashState] = useState<TrashProximity>("far");
  const trashZoneRef = useRef<HTMLDivElement>(null);
  const trashPhase = usePanelPresence(trashDragging, 140);
  const trashProximityOf = useCallback((event: DragEvent): TrashProximity => {
    const rect = trashZoneRef.current?.getBoundingClientRect();
    const point = clientPointOf(event);
    return rect && point ? trashProximity(point, rect) : "far";
  }, []);

  /** A drag began. `cardLabel` is the name for the zone to show, a card's or
   *  a session's, or null for anything that cannot be removed, which leaves
   *  the zone down. */
  const beginTrashDrag = useCallback((cardLabel: string | null) => {
    if (cardLabel !== null) {
      setTrashLabel(cardLabel);
      setTrashDragging(true);
    }
    setTrashState("far");
  }, []);

  /** The dragged card moved: how close it is to the zone, for the zone to say. */
  const trackTrashDrag = useCallback((event: DragEvent) => {
    setTrashState(trashProximityOf(event));
  }, [trashProximityOf]);

  /** The drag ended. Returns whether a card or a session's box was let go over
   *  the zone — asked before the zone is lowered, while its rectangle is still
   *  there to hit. */
  const endTrashDrag = useCallback((event: DragEvent, removable: boolean): boolean => {
    const dropped = removable && trashProximityOf(event) === "over";
    setTrashDragging(false);
    return dropped;
  }, [trashProximityOf]);

  return { trashDragging, trashLabel, trashState, trashZoneRef, trashPhase, beginTrashDrag, trackTrashDrag, endTrashDrag };
}
