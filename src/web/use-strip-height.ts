// The banner strip's height, written on the page as --rating-h for as long as a
// banner is up (the name is the rating row's, who first needed it; the rail
// panels, the Inspector and sessions sheets and panel-place.css read it).
//
// A banner takes the whole width under the top bar, so its dismiss sits at the
// window's right edge where V4 draws it. The rail's two panels are fixed rather
// than in the grid, so this is how they know where the banner ends and start a
// row lower (rating.css). The height follows the strip through a ResizeObserver:
// the two-row update, the rating row wrapping, a resized window.
import { useLayoutEffect, useRef } from "react";

/** The strip's holder while it holds a banner with a mark or the question (DeckBanner.tsx), and
 *  for as long as it is leaving: its height eases, and the panels under it follow. The phone's
 *  "Can't reach your computer" card is not a strip, so it moves nothing. */
export const STRIP_SELECTOR = ".app > .banner-strip:has(.ver-banner, .conn-banner > .banner-mark)";

interface StripEl { getBoundingClientRect(): { height: number }; closest(sel: string): unknown }
interface PageEl { style: { setProperty(k: string, v: string): void; removeProperty(k: string): void } }

/** What is bound right now: one strip, its observer, and the page it writes to.
 *  `sync` is called after every render and does nothing while the strip is the
 *  same element; it rebinds when the strip changes and lets go when none is left. */
export function createStripBinder() {
  let row: StripEl | null = null;
  let page: PageEl | null = null;
  let ro: { disconnect(): void } | null = null;
  const release = () => {
    ro?.disconnect();
    ro = null;
    page?.style.removeProperty("--rating-h");
    row = null;
    page = null;
  };
  return {
    sync(next: StripEl | null) {
      if (next === row) return;
      release();
      const host = (next?.closest(".app") ?? null) as PageEl | null;
      if (!next || !host) return;
      row = next;
      page = host;
      const measure = () => host.style.setProperty("--rating-h", `${Math.ceil(next.getBoundingClientRect().height)}px`);
      measure();
      ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
      (ro as { observe?(el: unknown): void } | null)?.observe?.(next);
    },
    release,
  };
}

/** Runs after every render of the one component that mounts the banners, so it
 *  follows whichever banner is up (or none) without knowing which. */
export function useStripHeight(): void {
  const binder = useRef<ReturnType<typeof createStripBinder> | null>(null);
  if (!binder.current) binder.current = createStripBinder();
  useLayoutEffect(() => {
    binder.current!.sync(document.querySelector<HTMLElement>(STRIP_SELECTOR));
  });
  useLayoutEffect(() => () => binder.current?.release(), []);
}

/** The hook as a component of its own, so the banners' parent does not need to
 *  render it from its own body. */
export function StripHeight(): null {
  useStripHeight();
  return null;
}
