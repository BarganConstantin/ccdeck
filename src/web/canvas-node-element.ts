// The node wrappers React Flow draws on the canvas, as the DOM sees them.
//
// Lifted out of App.tsx, where these sat at module scope for its keyboard
// handling: which element is a card's wrapper, and how to put the keyboard on
// one. The keydown handler, j/k traversal and the peek all ask the first; the
// traversal uses the second.

/** The class React Flow puts on the wrapper it renders around every node — the
 *  element it makes tabbable, not the .agent-node card AgentNode draws inside
 *  it. That distinction is the whole reason the keyboard handling listens on
 *  window: a keydown fires on the focused wrapper and bubbles UP, so an
 *  onKeyDown on AgentNode's own root would never see it. */
export const RF_NODE_CLASS = "react-flow__node";

/** True when this element IS a node wrapper. Deliberately not a `closest()`
 *  walk: the context donut inside a card is a real <button> with its own
 *  Enter, and matching an ancestor would have answered the donut's keys too. */
export function isCanvasNodeElement(el: Element | null | undefined): boolean {
  return !!el && el.classList?.contains?.(RF_NODE_CLASS) === true;
}

/** Move the keyboard onto an agent card. Used when j/k traverses while the
 *  keyboard is already on the canvas, so the card the selection moved to is
 *  also the card Enter and Tab now speak about.
 *
 *  preventScroll because the canvas is a transformed plane inside a fixed-size
 *  box: the browser's own "scroll it into view" would shove the whole layer
 *  sideways behind the panels, and focusAgent is already bringing the node on
 *  screen properly. CSS.escape because an agent id is a session id and has
 *  never been promised to be a bare identifier. */
export function focusCanvasNode(id: string): void {
  try {
    const el = document.querySelector(`.${RF_NODE_CLASS}[data-id="${CSS.escape(id)}"]`);
    (el as HTMLElement | null)?.focus({ preventScroll: true });
  } catch {}
}
