import type { StateMarkKind } from "../node-face";

/**
 * A card's state, drawn small enough for the faces the canvas uses at a
 * distance and the peek that answers them.
 *
 * Three SHAPES, not three colours of one dot: a filled disc for live, a tick for
 * done, a cross for err. The full card says the same thing in a pill with the
 * word in it, and at 10px there is no room for the word — so the shape carries
 * it, and the colour, the same --inflight / --ok / --err the pill uses, only
 * agrees with it. Still, no motion: the live pill pulses, and forty of them
 * pulsing in overview would be the whole canvas blinking.
 *
 * Drawn rather than typed, for the reason RecapMark gives: a glyph from the
 * body face comes out at whatever weight each platform's fallback chose.
 * Decoration beside words that say it, so hidden from assistive technology.
 */
export function StateMark({ kind }: { kind: StateMarkKind }) {
  return (
    <svg className="state-mark" data-kind={kind} viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
      {kind === "live" && <circle cx="5" cy="5" r="3.2" fill="currentColor" />}
      {kind === "done" && <path d="M2.2 5.3l1.9 1.9 3.8-4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />}
      {kind === "err" && <path d="M2.8 2.8l4.4 4.4M7.2 2.8l-4.4 4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />}
    </svg>
  );
}

/**
 * The session is stopped until a human answers — the one state a face at a
 * distance must not lose. A warning triangle rather than a fourth disc: it
 * stands beside the state mark instead of replacing it, because a permission
 * prompt lands on a session that is still live and the reader needs both.
 */
export function AlertMark() {
  return (
    <svg className="alert-mark" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M6 1.4l4.7 8.3H1.3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" fill="none" />
      <path d="M6 4.6v2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="6" cy="8.35" r="0.72" fill="currentColor" />
    </svg>
  );
}
