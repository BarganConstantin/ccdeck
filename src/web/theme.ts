// Which theme the deck boots into, decided in one place because two different
// pieces of code have to reach the same answer at two different moments.
//
// Every colour in styles.css hangs off `:root[data-theme=…]`, and the sheet
// treats a MISSING attribute as dark — the first selector is `:root,
// :root[data-theme="dark"]`. So a light-theme user whose preference lands late
// does not see an unstyled frame they could mistake for loading; they see a
// fully painted dark deck. `color-scheme: dark` rides along in that same block,
// which hands the browser's own scrollbars and form controls to the wrong
// palette, and those are chrome rather than CSS — they repaint on their own
// schedule and the swap is visible.
//
// The attribute therefore has to be written before the first paint, which the
// bundle cannot do: it is a module script, and module scripts are deferred, so
// the parser finishes and the browser is free to paint the stylesheet's default
// while the chunk is still being fetched. index.html carries a small inline
// bootstrap instead, running while the parser is still inside <head>, before
// any frame exists. That bootstrap cannot import this file — an import would
// make it a module and defer it again, which is the exact bug — so the rule is
// spelled out twice on purpose, and theme-first-paint.test.ts executes the
// inlined text against resolveTheme over the same inputs so the copies cannot
// drift apart.
import { readStored } from "./storage";

export type Theme = "dark" | "light";

/** Where the preference lives. Pinned by display-name.test.ts: renaming it
 *  reads as an empty store and silently discards everyone's choice. */
export const THEME_KEY = "agent-dag.theme";

/**
 * The theme a stored value asks for, and the one the machine asks for when
 * nothing is stored.
 *
 * Only the exact strings "light" and "dark" are a choice. Absent, null from a
 * store the browser refused, and anything a future version might have written
 * are all "this deck has never been told", and what answers then is the
 * operating system: `systemLight` is `(prefers-color-scheme: light)`.
 *
 * It used to be dark for all of those, which is why #885 exists — measured in
 * Firefox 155 against the built `dist/web/index.html` with the OS set to light
 * and an empty store, `(prefers-color-scheme: light)` matched, `(…: dark)` did
 * not, and the document still came up `data-theme="dark"`.
 *
 * `systemLight` defaults to false — the old answer — so a caller that cannot
 * ask the machine (a node test, a browser with no `matchMedia`) still gets a
 * theme rather than a throw, and gets the one the sheet paints with no
 * attribute at all.
 */
export function resolveTheme(stored: string | null | undefined, systemLight = false): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return systemLight ? "light" : "dark";
}

/**
 * Whether the machine has asked for a light UI.
 *
 * `(prefers-color-scheme: light)` rather than `not (… : dark)`, because those
 * are not the same question: a browser that reports no preference at all
 * matches `light`, and this is the branch that decides what "no preference"
 * means. It means light, which is what every other application on such a
 * machine does.
 *
 * Wrapped, and the `typeof` guard is inside the try with it. `matchMedia` is on
 * every browser this deck runs in, but this is called from App's useState
 * initialiser and src/web has no error boundary — a throw escaping here rejects
 * `root.render()` and leaves a blank deck, which is a far worse trade than a
 * preference.
 */
export function systemPrefersLight(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
  } catch {
    return false;
  }
}

/** The theme this tab boots with. `readStored` swallows the SecurityError a
 *  blocked profile raises on the `localStorage` getter itself, so a store the
 *  browser will not hand over costs a preference and never the mount. */
export function storedTheme(): Theme {
  return resolveTheme(readStored(THEME_KEY), systemPrefersLight());
}
