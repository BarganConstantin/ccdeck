// What a card's foot gives up when it is tight (V4's Agent / Card).
//
// The head used to have a squeeze of its own (#2155, #2169): it read
// "<name> <model> · <effort>", and the effort stepped off the model text when
// that could uncut the name. The model left the card (V4 top-10 #2), so the
// head is the name and the state alone, the name ellipsizes in CSS, and there
// is nothing left there to measure.
//
// THE FOOT'S SQUEEZE: Figma's foot is one line, cost · time, a spacer, the
// sub-agent count. The deck adds two meta items, so while the foot overflows it
// drops them in this order: tokens, then the in-flight count. The tool icons,
// cost, time and the sub-agent count never drop. A notch, measured after
// paint, reset when the card gets wider or what the foot holds changes.

export type FootItem = "tokens" | "inflight";
export const FOOT_DROP_ORDER: readonly FootItem[] = ["tokens", "inflight"];

/** The droppable items the foot holds right now, in drop order. */
export function footDroppable(present: Record<FootItem, boolean>): FootItem[] {
  return FOOT_DROP_ORDER.filter(i => present[i]);
}

/** The next notch, given what the last paint measured: one more item goes while
 *  the foot overflows and something is left to drop. */
export function nextFootNotch(notch: number, measured: { overflow: number; max: number }): number {
  return measured.overflow > 0 && notch < measured.max ? notch + 1 : notch;
}

/** The items a notch has dropped: the first `notch` of the droppable ones. */
export function footDropped(notch: number, present: Record<FootItem, boolean>): Set<FootItem> {
  return new Set(footDroppable(present).slice(0, notch));
}

/** The notch after the foot's box changed width: wider means room came back, so
 *  start again from the top and measure; narrower keeps it (the render that
 *  follows measures again). Dropping an item does not change the foot's own
 *  width, so there is no self-inflicted case. */
export function footNotchOnResize(notch: number, change: { from: number; to: number }): number {
  return change.to > change.from ? 0 : notch;
}
