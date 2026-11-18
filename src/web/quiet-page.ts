// Nothing else on the page moves while the terminal pane has the keys.
//
// Measured with trusted input: a key's echo took 26 ms to reach the screen
// (p50) with the deck's always-running animations on the page, and 2.5 ms with
// them paused. The cost is not drawing — the main thread sat idle on the echo's
// path — but scheduling: a page that keeps producing frames makes Chrome hold
// each WebSocket message until after the next frame, and the deck has several
// animations that never stop (live edges on the board under the stage, the
// navigator's trunk, the topbar's dots). Typing into a terminal is the one
// moment a delay that size is felt on every key, so for exactly that moment
// they are paused, and they resume, from where they stood, when the pane gives
// the keys back.
//
// Only animations that never end are paused — one-shot entrances run their
// course, so nothing is left frozen half-way in — and never the stage's own:
// its motion is composited (terminal-stage.css) and is how the pane says it is
// streaming. Through the Web Animations API rather than a stylesheet rule,
// because a rule would have to outrank every animation shorthand in the sheet
// with !important, and would freeze entrances along with loops.

const paused = new Set<Animation>();

type Animated = { getAnimations?: () => Animation[] };

/** Pause the page's endless animations outside the stage, or resume the ones
 *  this paused. Safe to call again while on: it pauses what started since. */
export function quietPage(on: boolean, doc: Animated | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!on) {
    for (const a of paused) {
      try { a.play(); } catch { /* gone with its element */ }
    }
    paused.clear();
    return;
  }
  if (typeof doc?.getAnimations !== "function") return;
  let all: Animation[];
  try { all = doc.getAnimations(); } catch { return; }
  for (const a of all) {
    if (a.playState !== "running" || paused.has(a)) continue;
    const effect = a.effect as (AnimationEffect & { target?: Element | null }) | null;
    if (effect?.getTiming?.().iterations !== Infinity) continue;
    if (effect.target?.closest?.(".stage-dock")) continue;
    try {
      a.pause();
      paused.add(a);
    } catch { /* already finished */ }
  }
}

/** How often the pause looks again for loops that started meanwhile — a new
 *  session's live edge, a dot that lit up. */
export const QUIET_RESCAN_MS = 2000;
