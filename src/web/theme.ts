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
 * The theme a stored value asks for, and what no choice falls back to.
 *
 * "light" and "dark" are choices, and a choice wins whatever the OS says.
 * Anything else — absent, null from a store the browser refused, or a value a
 * future version might have written — is no choice at all, and the deck
 * follows the OS (#885): a first run on a light desktop used to open dark.
 * `prefersLight` is the OS's answer, passed in rather than asked for so this
 * stays pure and the bootstrap can be held against it input for input. Its
 * default is dark, the one the stylesheet already paints with no attribute.
 */
export function resolveTheme(stored: string | null | undefined, prefersLight = false): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersLight ? "light" : "dark";
}

/** Does the OS ask for light? `window` is absent in bare node and `matchMedia`
 *  can be missing in a locked-down embed; neither may cost the mount, so both
 *  read as "no", which is dark. */
export function prefersLight(): boolean {
  try { return window.matchMedia("(prefers-color-scheme: light)").matches; } catch { return false; }
}

/** The theme this tab boots with. `readStored` swallows the SecurityError a
 *  blocked profile raises on the `localStorage` getter itself, so a store the
 *  browser will not hand over costs a preference and never the mount. */
export function storedTheme(): Theme {
  return resolveTheme(readStored(THEME_KEY), prefersLight());
}
