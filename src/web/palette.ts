// The handful of CSS custom properties the canvas has to read from JavaScript,
// snapshotted once per theme instead of once per node per frame.
//
// Everything else in this UI takes its colour from the stylesheet, where a
// theme flip is a single attribute on :root and the browser repaints for free.
// Four values cannot go that way: React Flow's <Background> takes its grid
// colour as a prop, and <MiniMap> takes its mask, its container style and — one
// call per node, per render — the fill for every rect it paints. Those all went
// through `getComputedStyle(document.documentElement).getPropertyValue(...)`,
// which is a real style resolution every time it is asked, and they were asked
// on the render path.
//
// So the tokens are read together, into a plain object, and the object is
// rebuilt only when the theme changes. minimapNodeColor keeps taking a
// `cssVar`-shaped function — see minimap.ts — and what it is handed is now a
// lookup into one of these rather than a live read of the document.
//
// Kept out of App.tsx for the same reason minimap.ts is: it can then be tested
// without a DOM, by handing `readPalette` a reader that answers from a plain
// object and counting what it asked for.

/** Every custom property the canvas reads through JS. The list is the contract:
 *  `readPalette` reads exactly these, and `Palette` is keyed by exactly these,
 *  so a token added here without a reader is a type error rather than a colour
 *  that silently comes back empty. */
export const CANVAS_TOKENS = [
  // minimapNodeColor: the three agent states it paints a rect for.
  "--err",
  "--inflight",
  "--ok",
  // <Background color>.
  "--grid-line",
  // <MiniMap maskColor> and the container style beside it.
  "--minimap-mask",
  "--panel",
  "--line",
] as const;

export type CanvasToken = (typeof CANVAS_TOKENS)[number];

/** The snapshot itself: one string per token, all read at the same moment and
 *  therefore all from the same theme. */
export type Palette = Readonly<Record<CanvasToken, string>>;

/**
 * Read every canvas token through `cssVar`, once each.
 *
 * The reader is injected rather than imported so this is callable from a test
 * with no `document` — and so the one place that does touch `getComputedStyle`
 * stays in App.tsx, where the comment about it lives.
 */
export function readPalette(cssVar: (name: string) => string): Palette {
  const out = {} as Record<CanvasToken, string>;
  for (const token of CANVAS_TOKENS) out[token] = cssVar(token);
  return out;
}

/**
 * A `cssVar`-shaped reader that answers out of an already-read palette.
 *
 * This is what minimapNodeColor gets handed, so its signature — and the tests
 * written against it — do not change, while the per-node cost stops being a
 * style resolution and becomes a property read. An unknown token answers with
 * the empty string, which is what `cssVar` itself returns for a property the
 * sheet does not define.
 */
export function paletteReader(palette: Palette): (name: string) => string {
  return name => palette[name as CanvasToken] ?? "";
}

/**
 * Whether two snapshots say the same thing.
 *
 * The palette is re-read in an effect after `data-theme` is written, and on the
 * very first run that effect re-asserts the attribute the inline bootstrap in
 * index.html had already set — so it reads back exactly what mount read. Without
 * this comparison that identical answer would still be a new object, a new
 * `nodeColor` and a new `style`, and the mount would cost the extra render this
 * whole change exists to remove.
 */
export function samePalette(a: Palette, b: Palette): boolean {
  return CANVAS_TOKENS.every(token => a[token] === b[token]);
}
