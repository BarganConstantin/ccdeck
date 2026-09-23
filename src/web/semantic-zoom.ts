/**
 * WHICH OF THREE CARDS THE CANVAS DRAWS, decided by what a card measures on
 * screen rather than by a zoom percentage picked by eye.
 *
 * `detail` is the card as it has always been. `compact` and `overview` are not
 * that card made smaller: they are faces drawn in screen pixels inside the same
 * box (AgentNode's `.lod-face`), so a word on them is 11px at 0.3 and at 0.6
 * alike. The box itself never changes, because a card's measured size is a
 * layout input — see the note on `data-lod` in styles.css.
 *
 * It replaces the `full` / `mid` / `far` tiers (#846), which hid rows at 0.55
 * and 0.35 and drew what they kept at the canvas's scale — the last tier kept a
 * state pill and one character of a name. Those two numbers were zooms; these
 * are the sizes the zooms were standing in for.
 */
export type LodMode = "detail" | "compact" | "overview";

/** The card's body type, in layout px: the 11px the meta row, the sub row and
 *  the waiting row are set in. Its 12px name and 10px pill sit either side, and
 *  the 9px annotations below it are the first to go. */
export const CARD_BODY_PX = 11;

/**
 * The full card is drawn while its body type renders at 7.2px or more, and
 * given up below 6.6px. Judged from screenshots of this sheet at 1× device
 * pixels, 1440x900: at 0.664 (7.3px) the name, the pill's word, the title, the
 * waiting sentence and the tool count all read, and only the 9px annotations —
 * the spark's `60s`, the `session` kind — are at the edge. At 0.63 the compact
 * face beside it reads at a glance where the card is squinted at, and by 0.6
 * (6.6px) the card's body tier is at the edge too.
 *
 * Two numbers, not one: a trackpad settles by a few hundredths either side of
 * wherever the fingers stop, and one threshold under a resting pinch swaps the
 * whole canvas's representation back and forth under the reader.
 */
export const DETAIL_ENTER_PX = 7.2;
export const DETAIL_EXIT_PX = 6.6;

/**
 * The compact face is two lines of 11-12px type and a 6px pad top and bottom:
 * 44px is the least that holds them without clipping a descender, 48 is where
 * it is drawn with the pad it was designed with. The widths are the same
 * argument across — a state mark, its gap and a dozen characters of a name. The
 * pair is the same hysteresis as the detail pair above.
 */
export const COMPACT_ENTER = { width: 104, height: 48 } as const;
export const COMPACT_EXIT = { width: 96, height: 44 } as const;

/** The card a mode has to work for: the SMALLEST one on the board. A face is
 *  drawn in every card at once, so the mode that is legible in a 103px-tall
 *  subagent card is the one that is legible everywhere. */
export interface CardSize {
  width: number;
  height: number;
}

/** A subagent card as this sheet draws it with no rows to spare: `min-width`
 *  220 and the 103 measured on a live board. Used until a card has been
 *  measured, which is also the case where guessing small is the safe side. */
export const DEFAULT_CARD: CardSize = { width: 220, height: 103 };

/**
 * The smallest card among `sizes`, per axis.
 *
 * Floored, because a card measured mid-mount can report a height of a few
 * pixels for one frame, and a reference built from that would push the whole
 * canvas into overview on a zoom where every real card is roomy.
 */
export function referenceCard(sizes: Iterable<CardSize>): CardSize {
  let width = Infinity, height = Infinity;
  for (const s of sizes) {
    if (!(s.width > 0) || !(s.height > 0)) continue;
    width = Math.min(width, s.width);
    height = Math.min(height, s.height);
  }
  if (!Number.isFinite(width) || !Number.isFinite(height)) return DEFAULT_CARD;
  return { width: Math.max(160, width), height: Math.max(72, height) };
}

function fits(card: CardSize, zoom: number, floor: { width: number; height: number }): boolean {
  return card.width * zoom >= floor.width && card.height * zoom >= floor.height;
}

/**
 * The mode for `zoom`, given the mode the canvas is in now.
 *
 * Sticky by construction: a mode is left only when the zoom crosses the far
 * edge of its band, so a zoom resting between two thresholds keeps whatever it
 * arrived with. A jump across more than one band (a fit from 1.0 to 0.25, a
 * restored viewport) lands directly on the mode that holds there — nothing is
 * stepped through.
 *
 * `prev` null is the canvas's first frame, which uses the entering thresholds:
 * there is nothing to be sticky about yet.
 */
export function nextLod(prev: LodMode | null, zoom: number, card: CardSize = DEFAULT_CARD): LodMode {
  if (!Number.isFinite(zoom) || zoom <= 0) return prev ?? "detail";
  const body = CARD_BODY_PX * zoom;
  if (prev === "detail") {
    if (body >= DETAIL_EXIT_PX) return "detail";
    return fits(card, zoom, COMPACT_EXIT) ? "compact" : "overview";
  }
  if (body >= DETAIL_ENTER_PX) return "detail";
  if (prev === "compact") return fits(card, zoom, COMPACT_EXIT) ? "compact" : "overview";
  return fits(card, zoom, COMPACT_ENTER) ? "compact" : "overview";
}

/** The same two thresholds as zooms, for the callers that choose a zoom rather
 *  than read one. Detail depends on the zoom alone — its text is in layout
 *  units — so these need no card. */
export const DETAIL_ENTER_ZOOM = DETAIL_ENTER_PX / CARD_BODY_PX;
export const DETAIL_EXIT_ZOOM = DETAIL_EXIT_PX / CARD_BODY_PX;

/**
 * THE FIT'S ZOOM, RESERVING THE BUBBLES' LANE ONLY WHERE THE BUBBLES ARE DRAWN.
 *
 * fitLeft frames the board with a 420-unit allowance beside it for the tool
 * bubbles, which are an overlay rather than nodes and so absent from what it
 * measures. Below the full card the bubbles are not drawn (styles.css,
 * `data-lod`), and the allowance was framing empty canvas: on a four-session
 * board beside the machine panel it held the fit to 0.36 where the board
 * itself fitted at 0.49, and the board sat small in the middle of the canvas
 * with a band of nothing above and below it.
 *
 * `withLanes` is the fit with the allowance and `bare` the fit without. The
 * allowance stays wherever the fit lands at the full card, since that is where
 * the bubbles are drawn and would otherwise run off the right edge. Otherwise
 * the bare fit is used, held below the zoom the full card is LEFT at — under
 * that, no mode the canvas can be in draws the bubbles — and never below the
 * fit that reserved them, which is safe at any zoom.
 */
export function fitZoomForDrawnLanes(withLanes: number, bare: number): number {
  if (withLanes >= DETAIL_ENTER_ZOOM) return withLanes;
  return Math.max(withLanes, Math.min(bare, DETAIL_EXIT_ZOOM - 0.001));
}

/** The zoom a focused card is shown at: never below the one `detail` is
 *  entered at, with room either side so a trackpad's settle cannot tip it back
 *  out, and never above 1 — the fit's own ceiling, where a card is drawn at its
 *  natural size and magnifying further only makes it coarse. */
export const FOCUS_MIN_ZOOM = 0.8;
export const FOCUS_MAX_ZOOM = 1;
