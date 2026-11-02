import type { StateMarkKind } from "../node-face";
import { KitStateGlyph, type KitStateName } from "./kit-icons";

const KIT_STATE: Record<StateMarkKind, KitStateName> = { live: "working", done: "done", idle: "idle", err: "error" };

/**
 * A card's state, drawn on V4's kit grid: a ring with an arc for live, a tick
 * for done, a ring with a cross for err, a hollow ring for idle. Shapes, not
 * three colours of one dot: the full card says the same thing in a pill with the
 * word in it, and where there is no room for the word the shape carries it, and
 * the colour, the same --inflight / --ok / --err the pill uses, only agrees with
 * it. Still, no motion of its own: the live pill pulses, and forty of them
 * pulsing in overview would be the whole canvas blinking.
 *
 * Drawn rather than typed, for the reason RecapMark gives: a glyph from the
 * body face comes out at whatever weight each platform's fallback chose.
 * Decoration beside words that say it, so hidden from assistive technology.
 * `size` is the box, 14 like the kit's own.
 */
export function StateMark({ kind, size = 14 }: { kind: StateMarkKind; size?: number }) {
  return <KitStateGlyph name={KIT_STATE[kind]} className="state-mark" kind={kind} size={size} />;
}

/**
 * The session is stopped until a human answers — the one state a face at a
 * distance must not lose. The kit's Waiting: a ring with a bang. On the
 * zoomed-out face, which has no word, it stands BESIDE the state mark, because
 * a permission prompt lands on a session that is still live and the reader
 * needs both. On the detail card the word "Waiting" names the state, so it
 * REPLACES the mark there (cardState, node-face.ts).
 */
export function AlertMark({ size = 14 }: { size?: number }) {
  return <KitStateGlyph name="waiting" className="alert-mark" size={size} />;
}
