// What is being dragged into the Workspace's panes (internal #102): a session
// from the list, or a pane by its header.
//
// THE PAGE'S OWN DRAG. A drop target is told only the drag's types until the
// drop, never its data, and the panes need to know more while the pointer is
// still moving: which session it is, to say "Already open here" over the pane
// that has it. Both ends are on this page, so the drag is held here from its
// start to its end, and the data transfer carries a type of our own and the
// id, never text/plain: a terminal's textarea takes plain text dropped on it,
// and a session row dropped there would have typed its id into the session.
// A drop from anywhere else (a file from the desktop, which the pane takes as
// an attachment) carries none of these types and is left alone.
//
// No React and no stage code: the list, in the first-load chunk, starts a
// drag; the panes, in the stage's lazy chunk, read it.

export const SESSION_DRAG = "application/x-ccdeck-session";
export const PANE_DRAG = "application/x-ccdeck-pane";

export type Dragged =
  | { kind: "session"; id: string; name: string; fromTab?: boolean }
  | { kind: "pane"; id: string; name: string };

let current: Dragged | null = null;
let listening = false;

/** The drag on its way, or null. */
export function currentDrag(): Dragged | null {
  return current;
}

/** Whether a drag event carries one of ours. */
export function isOurDrag(types: ReadonlyArray<string> | DOMStringList | null | undefined): boolean {
  if (!types) return false;
  const list = Array.from(types as ArrayLike<string>);
  return list.includes(SESSION_DRAG) || list.includes(PANE_DRAG);
}

/** The drag ended, dropped or not. */
export function endDrag(): void {
  current = null;
}

interface DragStartLike {
  dataTransfer: {
    setData(type: string, data: string): void;
    effectAllowed: string;
    setDragImage?(image: Element, x: number, y: number): void;
  } | null;
}

/**
 * Starts one of ours. The image under the pointer is a chip with the name
 * (Figma "Dragging a session onto a pane"), drawn off screen for the
 * browser to copy and taken away a frame later.
 */
export function beginDrag(e: DragStartLike, dragged: Dragged, doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  const dt = e.dataTransfer;
  if (!dt) return;
  current = dragged;
  dt.setData(dragged.kind === "session" ? SESSION_DRAG : PANE_DRAG, dragged.id);
  dt.effectAllowed = "move";
  if (doc && typeof dt.setDragImage === "function") {
    try {
      const chip = doc.createElement("div");
      chip.className = "wsp-drag-chip";
      chip.textContent = dragged.name;
      doc.body.appendChild(chip);
      dt.setDragImage(chip, 12, 14);
      setTimeout(() => chip.remove(), 0);
    } catch {
      // The browser's own image of the row stands.
    }
  }
  // A source that leaves the page mid-drag (a row the list takes away) never
  // hears its dragend: the window does.
  if (!listening && typeof window !== "undefined") {
    listening = true;
    window.addEventListener("dragend", endDrag, true);
    window.addEventListener("drop", () => setTimeout(endDrag, 0), true);
  }
}
