// The deck's look: the theme, the pixel character, and the palette the canvas
// reads out of the theme's tokens — with the effects that keep the page, storage
// and an installed window's title bar in step with them.
//
// Lifted out of App.tsx's `Inner`, where it was five pieces with other things
// between them: the theme and character state, then Claude FM's hook call, then
// the palette and its minimap reader, then an unrelated connection flag, then the
// three effects. The ordering that matters is inside the theme effect — write
// `data-theme`, then re-read the palette on the next line (#613) — and that is
// one function, moved whole, so it could not have been disturbed by the move.
//
// setTheme and setCharacterEnabled are handed out as they are, because the
// invariants they need are effects on the values they set: whoever changes the
// theme, the attribute, the stored choice and the palette follow. setPalette is
// private — only the theme effect ever replaces the palette.
import { useCallback, useEffect, useMemo, useState } from "react";

import { CHARACTER_ENABLED_KEY, storedCharacterEnabled } from "./appearance";
import { type MinimapNode, minimapNodeColor } from "./minimap";
import { type Palette, paletteReader, readPalette, samePalette } from "./palette";
import { THEME_KEY, type Theme, storedTheme } from "./theme";

/**
 * One custom property, resolved off the document.
 *
 * This is a real style resolution every time it is called, which is why it has
 * exactly two callers now and both of them are `readPalette` (#613). It used to
 * be reached from the JSX — including once per node, per frame, through the
 * minimap's `nodeColor` — and everything it reads only changes when the theme
 * flips. Nothing on the render path may call it; see palette.ts.
 */
function cssVar(name: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "";
}

export function useAppearance() {
  // The same call index.html's bootstrap already made before the first paint,
  // so React starts out agreeing with what is on screen. Guarded the way the
  // panel loaders are: an initialiser is the one place a store the browser
  // won't hand over blanks the deck instead of costing a preference.
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [characterEnabled, setCharacterEnabled] = useState(storedCharacterEnabled);
  /** The canvas's JS-read colours, snapshotted per theme rather than per node
   *  per frame (#613). The initialiser is safe to run during the first render:
   *  index.html's inline bootstrap stamps `data-theme` from the same stored
   *  value before the first paint — see theme.ts — so the sheet is already on
   *  the right palette by the time this asks. The effect below re-reads it
   *  whenever the theme moves. */
  const [palette, setPalette] = useState<Palette>(() => readPalette(cssVar));
  /** `nodeColor` reaches minimapNodeColor once per node per minimap render, so
   *  what it is handed has to be a lookup and not a `getComputedStyle`. Stable
   *  for as long as the palette is, which is what lets `memo(MiniMap)` bail
   *  out on the frames where nothing about the minimap changed. */
  const paletteToken = useMemo(() => paletteReader(palette), [palette]);
  const minimapNodeFill = useCallback(
    (node: MinimapNode) => minimapNodeColor(node, paletteToken),
    [paletteToken],
  );

  // On the FIRST run this is redundant and known to be: the bootstrap wrote the
  // same attribute from the same stored value before anything painted, and the
  // write-back stores the value it just read. With nothing stored yet, what it
  // stores is what the OS asked for (#885), so the deck someone first sees is
  // the one they keep until T changes it. It is left unguarded anyway,
  // because the only way to skip it is a "have we mounted yet" ref — a second
  // answer to a question the DOM already holds, and one that goes wrong the day
  // someone reorders the effects. Re-asserting an identical attribute is free.
  // Every later run is the T toggle, which is the reason the effect exists.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
    // Re-read the canvas tokens HERE, in the same effect and on the line after
    // the attribute, rather than in a `useMemo` keyed on `theme` (#613). A memo
    // runs during render, and `data-theme` is not written until this effect —
    // so on the render that flips the theme a memo would read the palette it is
    // replacing, and then never run again, and the minimap and the grid would
    // keep the old theme's colours until something else invalidated them. The
    // ordering is a statement in one function instead of a convention between
    // two of them.
    setPalette(prev => {
      const next = readPalette(cssVar);
      return samePalette(prev, next) ? prev : next;
    });
  }, [theme]);

  useEffect(() => {
    try { window.localStorage.setItem(CHARACTER_ENABLED_KEY, characterEnabled ? "1" : "0"); } catch { /* private mode */ }
  }, [characterEnabled]);

  /**
   * The window's own title bar, which only an INSTALLED deck has.
   *
   * A standalone window tints its chrome from `<meta name="theme-color">`, so a
   * deck left on the manifest's single value shows a near-black bar above a
   * white page for every light-theme user who installed it.
   *
   * WRITTEN HERE RATHER THAN AS A MEDIA-QUERIED PAIR IN THE HEAD, which is the
   * whole reason it is worth an effect: `prefers-color-scheme` is the OS, and
   * this deck's theme is a STORED CHOICE allowed to disagree with it — see the
   * bootstrap in index.html. A pair in the head would be right for everyone who
   * never pressed T and wrong for exactly the people who did.
   *
   * FROM THE PALETTE, NOT FROM cssVar. The palette is already this deck's one
   * snapshot of the theme's colours and it already holds `--panel`; calling
   * cssVar again would be a second `getComputedStyle` for a value that has just
   * been read, and render-path-cost-612-613.test.ts pins the mention count for
   * that reason. Keyed on the palette rather than on the theme so it runs after
   * the effect above has replaced it, never on the frame still holding the old
   * one. `--panel` because the top of this page is the topbar, and the topbar's
   * gradient starts there.
   */
  useEffect(() => {
    const bar = document.querySelector('meta[name="theme-color"]');
    const panel = palette["--panel"];
    if (bar && panel) bar.setAttribute("content", panel);
  }, [palette]);

  return { theme, setTheme, characterEnabled, setCharacterEnabled, palette, minimapNodeFill };
}
