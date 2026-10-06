// A card the reader was just taken to, lit once so the eye lands on it: a halo
// in the session's own colour round the card, held while the camera arrives and
// then let go (agent-node.css, `card-flash`). Asked for by a press on a
// collision mark, after the camera has been told where to go.
//
// The attribute goes on React Flow's node wrapper, which the sheet reads for
// both the full card and the zoomed-out face, and comes off when the halo's
// animation ends — no timer. Pressing again restarts it. Under reduced motion
// the halo is simply on and then off.
import { RF_NODE_CLASS } from "./canvas-node-element";

export const FLASH_ATTR = "data-flash";

export function flashCard(id: string): void {
  let el: HTMLElement | null = null;
  try {
    el = document.querySelector<HTMLElement>(`.${RF_NODE_CLASS}[data-id="${CSS.escape(id)}"]`);
  } catch {}
  if (!el) return;
  const node = el;
  node.removeAttribute(FLASH_ATTR);
  // Read a layout value between the two writes so a second press starts the
  // halo again instead of continuing the first.
  void node.offsetWidth;
  node.setAttribute(FLASH_ATTR, "");
  const done = (e: AnimationEvent) => {
    if (!e.animationName.startsWith("card-flash")) return;
    node.removeAttribute(FLASH_ATTR);
    node.removeEventListener("animationend", done);
  };
  node.addEventListener("animationend", done);
}
