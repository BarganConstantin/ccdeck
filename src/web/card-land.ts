// LAND on a card (V4's motion spec: n, a notification and ⌘K that go to a
// session). The camera brings the card into view; once it is there the card
// takes the session's accent at 16% and lets it go over Base, once.
//
// A colour, so reduced motion keeps it as it is. A transition, not a keyframe:
// styles/agent-node.css puts the wash on `.agent-node::after` at opacity 0 with
// the fade as its transition, and `data-land` holds it at 1 with none. Setting
// the attribute, reading the style so it is taken, and removing it a frame
// later is the whole of "once", and a second Land turns round from wherever
// the first one has got to.
import { shouldAnimateViewport, CAMERA_SLOW_MS } from "./viewport-motion";

/** The card of a session's root (or any agent) on the board, or null. */
function cardOf(id: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const nodes = document.querySelectorAll<HTMLElement>(".react-flow__node");
  for (const node of Array.from(nodes)) {
    if (node.dataset.id === id) return node.querySelector<HTMLElement>(".agent-node");
  }
  return null;
}

/** Wash the card now. */
export function landOnCard(id: string): void {
  const card = cardOf(id);
  if (!card) return;
  card.setAttribute("data-land", "");
  // Read it, so the held state is the one the fade starts from.
  void card.offsetWidth;
  requestAnimationFrame(() => card.removeAttribute("data-land"));
}

/** How long to wait before washing the card: until the camera that is taking
 *  it into view has arrived, or no wait when the camera jumps. */
export function landDelayMs(cameraMs: number = CAMERA_SLOW_MS): number {
  const hidden = typeof document !== "undefined" && document.hidden;
  return shouldAnimateViewport({ durationMs: cameraMs, documentHidden: hidden }) ? cameraMs : 0;
}
