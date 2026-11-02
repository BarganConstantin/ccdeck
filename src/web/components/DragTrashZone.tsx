// The drop target that appears while a card is dragged, and removes the card
// from the board when it is let go over it.
//
// Moved out of App.tsx's markup unchanged. Where the drag is and whether it is
// over the zone are use-drag-trash's; CanvasMain.tsx mounts this for as long
// as that hook's phase says the zone is on screen, leaving included.
import type { useDragTrash } from "../use-drag-trash";
import { withKey } from "../single-key-shortcuts";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import { useT } from "../i18n";

type DragTrash = ReturnType<typeof useDragTrash>;

export default function DragTrashZone({ trashZoneRef, trashState, trashPhase, trashLabel }: {
  trashZoneRef: DragTrash["trashZoneRef"];
  trashState: DragTrash["trashState"];
  trashPhase: DragTrash["trashPhase"];
  /** The dragged card's name, said while it is over the zone. */
  trashLabel: DragTrash["trashLabel"];
}) {
  const t = useT();
  const singleKeys = useSingleKeyShortcuts();
  return (
    <div
      ref={trashZoneRef}
      className={`drag-trash-zone ${trashState}${trashPhase === "leaving" ? " leaving" : ""}`}
      role="status"
    >
      <span className="drag-trash-copy">
        <span className="drag-trash-text">
          {trashState === "over"
            ? <>{t("board.trash.release")} <strong className="drag-trash-name">{trashLabel || t("board.trash.thisCard")}</strong></>
            : t("board.trash.drop")}
        </span>
        <span className="drag-trash-hint">
          {trashState === "over" ? t("board.trash.bringsBack", { list: withKey(t("board.detail.listUpper"), "L", singleKeys) }) : t("board.trash.keepsRunning")}
        </span>
      </span>
    </div>
  );
}
