// Taking the reader to another agent's card from a git surface — a card's
// collision mark, the glance's collision line — so it looks the same from
// everywhere: the other agent is selected and brought into the part of the
// pane nothing covers (focusAgentFrom, focus-camera.ts). From a pointer its
// card is then lit once (card-flash.ts); from the keyboard the keyboard goes
// with the reader, onto that card, whose ring is the answer, and nothing
// animates.
import { focusCanvasNode } from "./canvas-node-element";
import { flashCard } from "./card-flash";
import { focusAgentFrom } from "./git-view-request";

export type PressHow = "pointer" | "key";

/** How a click was made: `detail` is 0 for a press made with Enter or Space. */
export const pressHow = (e: { detail: number }): PressHow => (e.detail === 0 ? "key" : "pointer");

export function goToAgentCard(target: string, how: PressHow): void {
  focusAgentFrom(target);
  if (how === "key") requestAnimationFrame(() => requestAnimationFrame(() => focusCanvasNode(target)));
  else requestAnimationFrame(() => flashCard(target));
}
