// Board <-> Workspace, as one frame and a crossfade (V4's motion spec).
//
// BY POINTER the browser keeps a picture of the view that was and fades it into
// the live one on Fast (View Transitions): the list, the pane and the Inspector
// are laid out at their final places and sizes before the fade starts, so none
// of them travels, and there is no frame with neither view in it. BY KEY it is
// the same update with no fade: one frame. Reduced motion keeps the pointer's
// fade, which moves nothing. A browser without View Transitions switches at
// once, which is the key's answer.
//
// THE BOARD NEVER NARROWS. Workspace gives the canvas's cell to the pane, so
// the Board's canvas used to be squeezed to the pane's width and back (the
// cards re-fitted over several frames, and the camera with them). It is pinned
// instead: on the way in, the canvas keeps the box it had (a fixed box at the
// same place and size, hidden), and on the way out it is released into the
// cell that gives the same box. The pane measures its own cell (.ws-cell).
//
// NO TRANSITION RUNS ACROSS THE SWITCH. The left column eases its width and a
// panel arrives with its own motion; across a switch they are in their final
// state at once (workspace.css, data-view-switch on the root), or the picture
// of the new view would show them travelling.
import { flushSync } from "react-dom";

/** On the root while a switch is being drawn (workspace.css). */
export const SWITCH_ATTR = "data-view-switch";
/** On the app root while the Board's canvas is held at its box. */
export const PIN_ATTR = "data-pin";

const PIN_VARS = ["--board-l", "--board-t", "--board-w", "--board-h"] as const;

/** Holds the canvas at the box it has now, for the length of Workspace. */
export function pinBoard(app: HTMLElement | null, canvas: HTMLElement | null): void {
  if (!app || !canvas) return;
  const r = canvas.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return;
  app.style.setProperty("--board-l", `${r.left}px`);
  app.style.setProperty("--board-t", `${r.top}px`);
  app.style.setProperty("--board-w", `${r.width}px`);
  app.style.setProperty("--board-h", `${r.height}px`);
  app.setAttribute(PIN_ATTR, "");
}

/** Gives the canvas back to the grid. */
export function unpinBoard(app: HTMLElement | null): void {
  if (!app) return;
  app.removeAttribute(PIN_ATTR);
  for (const name of PIN_VARS) app.style.removeProperty(name);
}

/** Whether the page can keep a picture of the view that was and fade it away. */
export function canCrossfade(doc: Document = document): boolean {
  return typeof (doc as Document & { startViewTransition?: unknown }).startViewTransition === "function" && !doc.hidden;
}

/**
 * Runs `update` (the state change that switches the view) as one frame: now,
 * rendered before it returns. By pointer the old view is faded into the new on
 * Fast when the page can; by key, or where it cannot, there is no fade.
 */
export function runSwitch(how: "pointer" | "key", update: () => void, doc: Document = document): void {
  const root = doc.documentElement;
  root.setAttribute(SWITCH_ATTR, "");
  const clear = () => root.removeAttribute(SWITCH_ATTR);
  if (how === "pointer" && canCrossfade(doc)) {
    const start = (doc as Document & { startViewTransition: (cb: () => void) => { finished: Promise<unknown> } }).startViewTransition;
    const transition = start.call(doc, () => { flushSync(update); });
    transition.finished.then(clear, clear);
    return;
  }
  flushSync(update);
  // The effects that follow the commit (the list taking the column) have run
  // by now; the attribute is kept a beat for the frames they land in.
  setTimeout(clear, 60);
}
