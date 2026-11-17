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

import { sessionOfNode } from "./layout-geometry";
import { hidePeek } from "./components/SessionPeek";
import { saveLayout } from "./layout-storage";
import type { Squeeze } from "./packed-board";
import type { GraphState } from "./reducer";
import type { AgentNodeData } from "./types";
import type { useDragTrash } from "./use-drag-trash";

type Point = { x: number; y: number };
type Trash = ReturnType<typeof useDragTrash>;

export function useNodeDrag({
  nodes, shown = nodes, squeeze = null, stateRef, pinnedRef, positionsRef, draggingRef, dragPatchRef,
  setDragging, setDragMoveTick, setDragTick, endBubble, markInteract, disableAutoFit,
  beginTrashDrag, trackTrashDrag, endTrashDrag, removeNode,
}: {
  /** The nodes on the canvas this render, at the board's places, for a session drag's members. */
  nodes: Node[];
  /** The same nodes where they are drawn, and the map between the two, while
   *  the faces draw the board packed (packed-board.ts). React Flow reports a
   *  drag in drawn places and the board keeps its own. Absent, they agree. */
  shown?: Node[];
  squeeze?: Squeeze | null;
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
    /** Where each member is drawn at the start, for the patch that follows the pointer. */
    drawn: Map<string, Point>;
    /** The drawn x the session's leftmost card started at: where a move
     *  across a closed band is carried back to the board from. */
    anchor: number;
    pinsBefore: Map<string, Point | undefined>;
  } | null>(null);

  /** The board's place for a drawn one. Only x is packed. */
  const toBoard = (p: Point): Point => (squeeze ? { x: squeeze.back(p.x), y: p.y } : { x: p.x, y: p.y });
  /** How far the board moves a session whose drawn cards moved `dx` from `anchor`. */
  const boardDx = (anchor: number, dx: number) => (squeeze ? squeeze.back(anchor + dx) - squeeze.back(anchor) : dx);

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
      const drawn = new Map<string, Point>();
      const pinsBefore = new Map<string, Point | undefined>();
      let anchor = Infinity;
      if (sid) {
        for (const m of nodes) {
          const d = m.data as AgentNodeData | undefined;
          if (!d || sessionOfNode(m) !== sid) continue;
          members.set(m.id, { x: m.position.x, y: m.position.y });
          pinsBefore.set(m.id, pinnedRef.current.get(m.id));
        }
        for (const m of shown) {
          if (!members.has(m.id)) continue;
          drawn.set(m.id, { x: m.position.x, y: m.position.y });
          if (m.type === "agent") anchor = Math.min(anchor, m.position.x);
        }
      }
      groupDragRef.current = {
        sessionId: sid, start: { x: n.position.x, y: n.position.y }, members, drawn,
        anchor: Number.isFinite(anchor) ? anchor : n.position.x, pinsBefore,
      };
      // The box carries the whole session, and the session's root card has the
      // session's id, so the trash takes the box by that card's name.
      const root = sid ? stateRef.current.agents.get(sid) : undefined;
      beginTrashDrag(root ? root.label : null);
      return;
    }
    beginTrashDrag(n.type === "agent" ? (stateRef.current.agents.get(n.id)?.label ?? "") : null);
    pinnedRef.current.set(n.id, toBoard(n.position));
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
      const bx = boardDx(g.anchor, dx);
      for (const [id, p0] of g.members) {
        const p = { x: p0.x + bx, y: p0.y + dy };
        pinnedRef.current.set(id, p);
        positionsRef.current.set(id, p);
      }
      // Patch the members and the box itself, rather than rebuilding
      // the whole graph on every pointer move as this used to. The patch
      // is what is drawn: the drawn places, moved by the pointer's delta.
      const patch = dragPatchRef.current;
      if (patch) {
        for (const [id, p0] of g.members) {
          const at = g.drawn.get(id) ?? p0;
          patch.set(id, { x: at.x + dx, y: at.y + dy });
        }
        patch.set(n.id, { x: n.position.x, y: n.position.y });
      }
      setDragMoveTick(t => t + 1);
      return;
    }
    // Live-pin during drag so an incoming event re-render doesn't
    // snap the node back to its dagre slot mid-motion.
    pinnedRef.current.set(n.id, toBoard(n.position));
    positionsRef.current.set(n.id, toBoard(n.position));
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
        const bx = boardDx(g.anchor, dx);
        for (const [id, p0] of g.members) {
          const p = { x: p0.x + bx, y: p0.y + dy };
          pinnedRef.current.set(id, p);
          positionsRef.current.set(id, p);
        }
      }
      groupDragRef.current = null;
      saveLayout(positionsRef.current, pinnedRef.current);
      setDragTick(t => t + 1);
      return;
    }
    pinnedRef.current.set(n.id, toBoard(n.position));
    positionsRef.current.set(n.id, toBoard(n.position));
    if (droppedOnTrash) {
      removeNode(n.id);
      return;
    }
    saveLayout(positionsRef.current, pinnedRef.current);
  };

  return { onNodeDragStart, onNodeDrag, onNodeDragStop };
}
