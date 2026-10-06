// A branch name cut to the pixels it is given, measured rather than guessed.
//
// The card's branch chip (git-chip.ts) decides which spellings of a branch
// name are worth showing, longest first — `feature/bargan/VCRM-9090` →
// `feature/…/VCRM-9090` → `…/VCRM-9090` → `VCRM-9090`, a ticket never cut
// inside — and works out its room from one character's width read off its own
// label. The git view's ref chips and its header take the same spellings and
// the same way of measuring, against the box each of them is given: whatever
// the font size, one rendered character says how wide every spelling is.
import { branchCandidates } from "./git-chip";

/** Measures a string in some font, in CSS pixels. */
export type Measure = (text: string) => number;

/**
 * The longest spelling of `name` that fits in `maxPx`, or, when none does, the
 * shortest spelling there is — the ticket whole, or the last segment cut to
 * its floor — for the box's own ellipsis to finish.
 */
export function fitBranchWidth(name: string, maxPx: number, measure: Measure): string {
  const all = branchCandidates(name);
  return all.find(s => measure(s) <= maxPx) ?? all[all.length - 1];
}

/**
 * A measure for the deck's mono stack from one character's width, read off a
 * rendered label: in a monospace font every character is as wide as every
 * other, the ellipsis too, so a string is its length in characters times that
 * width. Reading one width once is what keeps this off the render path (no
 * computed style, no canvas, no layout per spelling).
 */
export function monoWidth(charPx: number): Measure {
  return text => [...text].length * charPx;
}
