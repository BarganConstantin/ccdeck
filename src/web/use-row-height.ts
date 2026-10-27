// A row in the strip under the topbar that spans the window, saying how tall it
// is. The rail's two panels are fixed rather than in the grid, so a custom
// property on the page is how they know where such a row ends: --rating-h for
// the rating question (rating.css), --cli-banner-h for the out-of-date
// terminal (terminal-cli-banner.css).
import { useLayoutEffect, useRef } from "react";

/** Writes the row's height on `.app` as `name` while the row is up, measured
 *  again whenever it wraps differently — a resized window, a new phase — and
 *  takes it off with the row. `key` re-runs it when the row's content changes. */
export function useRowHeight(name: string, key: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = ref.current;
    const page = row?.closest<HTMLElement>(".app");
    if (!row || !page) return;
    const measure = () => page.style.setProperty(name, `${Math.ceil(row.getBoundingClientRect().height)}px`);
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(row);
    return () => { ro?.disconnect(); page.style.removeProperty(name); };
  }, [name, key]);
  return ref;
}
