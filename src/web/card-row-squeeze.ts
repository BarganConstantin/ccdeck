// What a card's head gives up when it is tight (#2155, #2169, V4's Agent / Card).
//
// The head reads "<name> <model> · <effort>" and a busy card has little room for
// it. The model is plain text after the name; when the head is tight the model
// text gives way first, with its own ellipsis and a 6ch floor (CSS), then the
// name, down to its own floor. The one thing the card drops by measurement is
// the effort, and only when dropping it can uncut the name OR the model text:
// that element's overflow is no larger than the effort part's width. One cut by
// more than that stays cut either way, so the effort stays and the ellipsis
// handles the rest. The kind word is not in the head any more (it leads a
// subagent's task line), so there is no notch for it: the squeeze is 0 (effort
// kept) or 1 (effort dropped), and the model is never dropped. The effort stays
// in the chip's tooltip, the session list, the peek and the details panel.

/** How far the head may step down: one notch, and only with an effort to drop. */
export function maxSqueeze(a: { model?: string | null; effort?: string | null }): number {
  return a.model && a.effort ? 1 : 0;
}

/** Whether dropping the effort can uncut the name: the name is cut, and by no
 *  more than the effort part is wide. */
export function effortWillUncut(overflow: number, effortWidth: number): boolean {
  return overflow > 0 && overflow <= effortWidth;
}

/** The next notch, given what the last paint measured. */
export function nextSqueeze(
  squeeze: number,
  measured: { overflow: number; modelOverflow?: number; effortWidth: number; max: number },
): number {
  const uncuts = effortWillUncut(measured.overflow, measured.effortWidth)
    || effortWillUncut(measured.modelOverflow ?? 0, measured.effortWidth);
  return squeeze < measured.max && uncuts ? squeeze + 1 : squeeze;
}

/** What the head draws at a notch. */
export function rowAt(squeeze: number): { effort: boolean } {
  return { effort: squeeze < 1 };
}

/** The squeeze after the name's box changed width. A wider name means room came
 *  back (a tag, the recap button or the model text went away), so start again
 *  from the top and measure. The widening that dropping the effort itself causes
 *  is not that: `selfInflicted` says so, or the effort would come back and go
 *  again every frame. A narrower name keeps its notch (it is measured again by
 *  the render the change causes). */
export function squeezeOnResize(
  squeeze: number,
  change: { from: number; to: number; selfInflicted: boolean },
): number {
  return change.to > change.from && !change.selfInflicted ? 0 : squeeze;
}

// THE FOOT'S SQUEEZE (V4's Agent / Card): Figma's foot is one line, cost · time,
// a spacer, the sub-agent count. The deck adds meta items, so while the foot
// overflows it drops them in this order: tokens, then the in-flight count, then
// the tool count. Cost, time, the failed count and the sub-agent count never
// drop. Same shape as the head's: a notch, measured after paint, reset when the
// card gets wider or what the foot holds changes.

export type FootItem = "tokens" | "inflight" | "tools";
export const FOOT_DROP_ORDER: readonly FootItem[] = ["tokens", "inflight", "tools"];

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
