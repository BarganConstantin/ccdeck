// A session's accent hue, from its id alone — the same in every tab and after
// every reload, since nothing on the board decides it or stores it.

/** Deterministic per-session hue (0–360). Used to give each session a calm accent. */
export function sessionHue(sessionId: string): number {
  let h = 5381;
  for (let i = 0; i < sessionId.length; i++) h = ((h << 5) + h) ^ sessionId.charCodeAt(i);
  return Math.abs(h) % 360;
}
