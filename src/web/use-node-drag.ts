// A drag on the canvas: a card, or a whole session by its box.
//
// Lifted out of App.tsx's markup, where the three handlers were ninety lines
// of arrows inline on <ReactFlow>, unchanged. They are rebuilt every render,
// as the arrows were, so they read the same values the arrows did. What a drag
// leaves behind is the pin and the stored layout, or a removal when the card,
// or the session's box, is let go over the trash zone. The session-drag
// snapshot is this file's alone:
// nothing outside a gesture reads it.
import { useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Node, NodeDragHandler } from "reactflow";

import { hidePeek } from "./components/SessionPeek";
import { saveLayout } from "./layout-storage";
import type { GraphState } from "./reducer";
import type { AgentNodeData } from "./types";
import type { useDragTrash } from "./use-drag-trash";

type Point = { x: number; y: number };
type Trash = ReturnType<typeof useDragTrash>;

export function useNodeDrag({
  nodes, stateRef, pinnedRef, positionsRef, draggingRef, dragPatchRef,
  setDragging, setDragMoveTick, setDragTick, endBubble, markInteract, disableAutoFit,
  beginTrashDrag, trackTrashDrag, endTrashDrag, removeNode,
}: {
  /** The nodes on the canvas this render, for a session drag's members. */
  nodes: Node[];
  stateRef: MutableRefObject<GraphState>;
  pinnedRef: MutableRefObject<Map<string, Point>>;
  positionsRef: MutableRefObject<Map<string, Point>>;
  /** True for the length of the gesture, for the measurement pass to skip it. */
  draggingRef: MutableRefObject<boolean>;
  /** The positions the gesture has moved, patched onto the board each frame. */
  dragPatchRef: MutableRefObject<Map<string, Point> | null>;
  setDragging: Dispatch<SetStateAction<boolean>>;
  setDragMoveTick: Dispatch<SetStateAction<number>>;
  setDragTick: Dispatch<SetStateAction<number>>;
  endBubble: () => void;
  markInteract: () => void;
  disableAutoFit: () => void;
  beginTrashDrag: Trash["beginTrashDrag"];
  trackTrashDrag: Trash["trackTrashDrag"];
  endTrashDrag: Trash["endTrashDrag"];
  removeNode: (id: string) => void;
}) {
  /** Active session group-drag: the session, the handle node's start position,
   *  each member's start position and the pin it had before the gesture, so a
   *  drop on the trash can put the members back as it found them. */
  const groupDragRef = useRef<{
    sessionId: string | undefined;
    start: Point;
    members: Map<string, Point>;
    pinsBefore: Map<string, Point | undefined>;
  } | null>(null);

  const onNodeDragStart: NodeDragHandler = (_, n) => {
    // React Flow resolves the dragged ID against its current controlled nodes.
    // That lookup can miss after a live graph update, despite the handler type.
    if (!n) return;
    hidePeek();
    // A drag must never inherit the push animation. The node under the
    // cursor is excluded by CSS, but a session drag moves its members
    // through state instead of the drag itself, and those would follow
    // the cursor 420ms late. Ending the animation outright is simpler
    // than enumerating which nodes a gesture will end up moving.
    endBubble();
    draggingRef.current = true;
    dragPatchRef.current = new Map();
    setDragging(true);
    markInteract();
    disableAutoFit();
    if (n.type === "sessionGroup") {
      // Snapshot every member's start position so each move applies the
      // gesture delta to a fixed origin (the group node's own start).
      const sid = (n.data as { sessionId?: string })?.sessionId;
      const members = new Map<string, Point>();
      const pinsBefore = new Map<string, Point | undefined>();
      if (sid) {
        for (const m of nodes) {
          const d = m.data as AgentNodeData | undefined;
          if (d?.sessionId !== sid) continue;
          members.set(m.id, { x: m.position.x, y: m.position.y });
          pinsBefore.set(m.id, pinnedRef.current.get(m.id));
        }
      }
      groupDragRef.current = { sessionId: sid, start: { x: n.position.x, y: n.position.y }, members, pinsBefore };
      // The box carries the whole session, and the session's root card has the
      // session's id, so the trash takes the box by that card's name.
      const root = sid ? stateRef.current.agents.get(sid) : undefined;
      beginTrashDrag(root ? root.label : null);
      return;
    }
    beginTrashDrag(n.type === "agent" ? (stateRef.current.agents.get(n.id)?.label ?? "") : null);
    pinnedRef.current.set(n.id, { x: n.position.x, y: n.position.y });
  };
  const onNodeDrag: NodeDragHandler = (event, n) => {
    if (!n) return;
    markInteract();
    if (n.type === "agent" || n.type === "sessionGroup") trackTrashDrag(event);
    if (n.type === "sessionGroup") {
      const g = groupDragRef.current;
      if (!g) return;
      const dx = n.position.x - g.start.x;
      const dy = n.position.y - g.start.y;
      // Move every member by the delta. Writing pinned/positions is the
      // source of truth snapshotToFlow reads; the nonce forces an
      // immediate recompute so the nodes follow this frame.
      for (const [id, p0] of g.members) {
        const p = { x: p0.x + dx, y: p0.y + dy };
        pinnedRef.current.set(id, p);
        positionsRef.current.set(id, p);
      }
      // Patch the members and the box itself, rather than rebuilding
      // the whole graph on every pointer move as this used to.
      const patch = dragPatchRef.current;
      if (patch) {
        for (const [id, p0] of g.members) patch.set(id, { x: p0.x + dx, y: p0.y + dy });
        patch.set(n.id, { x: n.position.x, y: n.position.y });
      }
      setDragMoveTick(t => t + 1);
      return;
    }
    // Live-pin during drag so an incoming event re-render doesn't
    // snap the node back to its dagre slot mid-motion.
    pinnedRef.current.set(n.id, { x: n.position.x, y: n.position.y });
    positionsRef.current.set(n.id, { x: n.position.x, y: n.position.y });
    // And render it now, rather than whenever the next rebuild happens.
    dragPatchRef.current?.set(n.id, { x: n.position.x, y: n.position.y });
    setDragMoveTick(t => t + 1);
  };
  const onNodeDragStop: NodeDragHandler = (event, n) => {
    markInteract();
    const droppedOnTrash = endTrashDrag(event, n?.type === "agent" || n?.type === "sessionGroup");
    draggingRef.current = false;
    dragPatchRef.current = null;
    setDragging(false);
    setDragTick(t => t + 1);   // one rebuild, from the refs, at the end
    if (!n) {
      // Still finish an interrupted gesture. Returning before cleanup would
      // leave measurements paused, the trash raised and a group snapshot live.
      groupDragRef.current = null;
      saveLayout(positionsRef.current, pinnedRef.current);
      return;
    }
    if (n.type === "sessionGroup") {
      const g = groupDragRef.current;
      if (g && droppedOnTrash && g.sessionId) {
        // Taken off the board where it was picked up, not beside the trash:
        // the session list brings it back, and it should come back there.
        for (const [id, p0] of g.members) {
          const pin = g.pinsBefore.get(id);
          if (pin) pinnedRef.current.set(id, pin);
          else pinnedRef.current.delete(id);
          positionsRef.current.set(id, p0);
        }
        groupDragRef.current = null;
        removeNode(g.sessionId);
        return;
      }
      if (g) {
        const dx = n.position.x - g.start.x;
        const dy = n.position.y - g.start.y;
        for (const [id, p0] of g.members) {
          const p = { x: p0.x + dx, y: p0.y + dy };
          pinnedRef.current.set(id, p);
          positionsRef.current.set(id, p);
        }
      }
      groupDragRef.current = null;
      saveLayout(positionsRef.current, pinnedRef.current);
      setDragTick(t => t + 1);
      return;
    }
    pinnedRef.current.set(n.id, { x: n.position.x, y: n.position.y });
    positionsRef.current.set(n.id, { x: n.position.x, y: n.position.y });
    if (droppedOnTrash) {
      removeNode(n.id);
      return;
    }
    saveLayout(positionsRef.current, pinnedRef.current);
  };

  return { onNodeDragStart, onNodeDrag, onNodeDragStop };
}
