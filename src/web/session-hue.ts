// A session's hue, from its id alone — the same in every tab and after every
// reload, since nothing decides it or stores it.
//
// The board no longer draws it (V4 top-10 #1): a hash is not a meaning, and on
// the board colour means state. The card, its face, the session's box and
// label, the edges, the navigator and the note are all neutral now. The Term
// stage's session and project data still carry a hue (stage-board.ts,
// project-picker.ts) that nothing paints.

/** Deterministic per-session hue (0–360). */
export function sessionHue(sessionId: string): number {
  let h = 5381;
  for (let i = 0; i < sessionId.length; i++) h = ((h << 5) + h) ^ sessionId.charCodeAt(i);
  return Math.abs(h) % 360;
}
