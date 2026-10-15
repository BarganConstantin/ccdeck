// The drop target that appears while a card is dragged, and removes the card
// from the board when it is let go over it.
//
// Moved out of App.tsx's markup unchanged. Where the drag is and whether it is
// over the zone are use-drag-trash's; CanvasMain.tsx mounts this for as long
// as that hook's phase says the zone is on screen, leaving included.
import type { useDragTrash } from "../use-drag-trash";
import { withKey } from "../single-key-shortcuts";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";

type DragTrash = ReturnType<typeof useDragTrash>;

export default function DragTrashZone({ trashZoneRef, trashState, trashPhase, trashLabel }: {
  trashZoneRef: DragTrash["trashZoneRef"];
  trashState: DragTrash["trashState"];
  trashPhase: DragTrash["trashPhase"];
  /** The dragged card's name, said while it is over the zone. */
  trashLabel: DragTrash["trashLabel"];
}) {
  const singleKeys = useSingleKeyShortcuts();
  return (
    <div
      ref={trashZoneRef}
      className={`drag-trash-zone ${trashState}${trashPhase === "leaving" ? " leaving" : ""}`}
      role="status"
    >
      <svg className="drag-trash-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 7V5.8C8 4.8 8.8 4 9.8 4h4.4c1 0 1.8.8 1.8 1.8V7m-10 0h12M8 10v8m4-8v8m4-8v8M7 7l.7 13h8.6L17 7" />
      </svg>
      <span className="drag-trash-copy">
        <span className="drag-trash-text">
          {trashState === "over"
            ? <>Release to remove <strong className="drag-trash-name">{trashLabel || "this card"}</strong></>
            : "Drop here to remove from the board"}
        </span>
        <span className="drag-trash-hint">
          {trashState === "over" ? `${withKey("The session list", "L", singleKeys)} brings it back` : "The session keeps running"}
        </span>
      </span>
    </div>
  );
}
