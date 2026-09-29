// How much room a session's box takes around its cards, in the three parts
// every reader of it needs: the padding on each side, the header strip above
// the cards, and the lift of the label tab above the box's top edge.
//
// Three files draw or budget that box, and each used to carry its own copy of
// the numbers: cluster-bounds.ts draws the decorative card, session-group-nodes.ts
// lays the invisible drag handle under it, and layout-geometry.ts reserves the
// space between two sessions with them. The handle has to line up with the
// card's rim and the layout has to leave room for both, so a number changed in
// one copy and not the others moved one of the three off the other two. They
// read this instead, and layout-geometry.ts folds all three into
// SESSION_CHROME, which the layout budgets the space between two stacked
// sessions with.

/** Padding on every side of a session's cards: the rim of its box, and the
 *  whole of the drag handle's margin (session-group-nodes.ts's GROUP_PAD). */
export const PAD = 18;

/** The header strip above the cards, inside the box. Deliberately NOT part of
 *  the drag handle, nor is the lift below: the strip is where the clickable
 *  fit-view label lives, and a handle over it would swallow the click (see
 *  session-group-nodes.ts). */
export const HEADER_H = 26;

/** How far the label tab sits above the box's top edge, in px at 1×. */
export const LABEL_LIFT = 12;
