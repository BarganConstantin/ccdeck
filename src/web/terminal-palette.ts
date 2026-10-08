// The terminal's colours, taken from the deck's own tokens in both themes.
//
// WHY NOT XTERM'S DEFAULTS. xterm 6 ships a pure black terminal with the Tango
// ANSI colours, and the panel sits beside a board whose every surface is a
// token. A black slab next to a white board reads as a foreign object, and on
// that black the default red is 3.57:1, blue 3.54:1 and magenta 3.19:1 — a
// terminal harder to read than the board it belongs to.
//
// SO EVERY SLOT IS A TOKEN, never a new hex value. The tokens are already
// measured against the surfaces they land on (contrast-floors.test.ts), already
// tuned per theme, and already kept off --inflight, the one hue that means "a
// tool call is running right now" (DESIGN.md, State hues are exclusive) — which
// is why magenta is --cat-agent and not the pink-purple closest to hand.
//
// READ THROUGH THE PALETTE SNAPSHOT, NOT THE DOCUMENT. JavaScript reads a
// token only from the per-theme snapshot use-appearance.ts takes after each
// theme flip; a getComputedStyle anywhere else is a style resolution on a path
// that runs per render (#613), and render-path-cost-612-613.test.ts holds the
// callers to two. `terminalTheme` therefore takes a reader — what
// `paletteReader(palette)` returns — and the tokens it asks for are listed in
// TERMINAL_TOKENS so they can join CANVAS_TOKENS and ride the same snapshot.
//
// THE BACKGROUND IS --panel, NOT --bg. The panel is a panel. And on light the
// canvas's #eef1f6 takes --cat-shell to 4.44:1 — under the floor — where white
// leaves it at 5.02.
//
// EVERY ANSI SLOT CLEARS 4.5:1 ON THAT BACKGROUND, in both themes, including
// the two that conventionally do not: black on a dark terminal and white on a
// light one. A slot below the floor would not be drawn as written anyway —
// xterm's minimumContrastRatio rewrites any foreground under it at render time —
// so declaring one would only mean the colour on screen is a computed one
// rather than a token. Each of those "paper-end" slots takes the lowest readable
// grey its theme has instead: --muted on dark (4.70:1, and DESIGN.md says there
// is no readable tier below it), --text-dim on light (5.78:1).
//
// THE BRIGHT HUES ARE THE NORMAL HUES. Inventing a lighter red would be a new
// colour no sweep has measured, and bold already reads as bold. Only the greys
// step, because black, bright black, white and bright white are four different
// jobs (bright black is the "dim" colour most CLIs print secondary text in).
//
// minimumContrastRatio is still set, for what the 16 slots do not cover: Claude
// Code paints most of its UI in 24-bit colour chosen by its own /theme, so a
// session set to a dark theme draws light-on-light inside the deck's light
// theme unless xterm lifts it.
//
// Only a type is imported from xterm. This module is cheap and DOM-free, and it
// must not be what pulls xterm into the chunk every visit loads.
import type { ITheme } from "@xterm/xterm";

/** The contrast xterm holds every foreground to (WCAG 1.4.3 body text). */
export const MINIMUM_CONTRAST_RATIO = 4.5;

/** Every token the terminal reads. The contract with the palette snapshot:
 *  each of these has to be in CANVAS_TOKENS for the reader to answer it. */
export const TERMINAL_TOKENS = [
  "--panel",
  "--text",
  "--text-secondary",
  "--muted",
  "--text-dim",
  "--accent",
  "--accent-dim",
  "--err",
  "--ok",
  "--cat-shell",
  "--cat-agent",
  "--cat-web",
] as const;

export type TerminalToken = (typeof TERMINAL_TOKENS)[number];

/** Which end of the ramp the background sits at. */
export type Paper = "dark" | "light";

export const ANSI_SLOTS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

export type AnsiSlot = (typeof ANSI_SLOTS)[number];

/** A token per slot per paper. Where the two papers agree it is one token
 *  because the token itself is already theme-tuned; they differ only on the
 *  greys, whose ink end and paper end swap with the theme. */
const ANSI: Record<AnsiSlot, Record<Paper, TerminalToken>> = {
  black: { dark: "--muted", light: "--text" },
  red: { dark: "--err", light: "--err" },
  green: { dark: "--ok", light: "--ok" },
  yellow: { dark: "--cat-shell", light: "--cat-shell" },
  blue: { dark: "--accent", light: "--accent" },
  magenta: { dark: "--cat-agent", light: "--cat-agent" },
  cyan: { dark: "--cat-web", light: "--cat-web" },
  white: { dark: "--text-secondary", light: "--text-dim" },
  brightBlack: { dark: "--muted", light: "--muted" },
  brightRed: { dark: "--err", light: "--err" },
  brightGreen: { dark: "--ok", light: "--ok" },
  brightYellow: { dark: "--cat-shell", light: "--cat-shell" },
  brightBlue: { dark: "--accent", light: "--accent" },
  brightMagenta: { dark: "--cat-agent", light: "--cat-agent" },
  brightCyan: { dark: "--cat-web", light: "--cat-web" },
  brightWhite: { dark: "--text", light: "--text-dim" },
};

/** Which token each ANSI slot reads on `paper` — the mapping itself, for the
 *  tests that sweep it and for anyone asking why a colour came out as it did. */
export function ansiToken(slot: AnsiSlot, paper: Paper): TerminalToken {
  return ANSI[slot][paper];
}

/** #rgb, #rgba, #rrggbb, #rrggbbaa and rgb()/rgba(): what a token resolves to.
 *  Null for anything else. */
function rgbOf(value: string): [number, number, number] | null {
  const s = value.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    const h = hex[1].length <= 4 ? hex[1].replace(/./g, c => c + c) : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)/i.exec(s);
  return fn ? [+fn[1], +fn[2], +fn[3]] : null;
}

/**
 * Whether `background` is a dark paper or a light one.
 *
 * Read off the colour rather than handed the theme name, so the answer can
 * never belong to a different moment than the colours it is used with: the
 * theme flips during a render and the snapshot is replaced in the effect after,
 * and a function given both would have one frame where they disagree. Dark is
 * whichever paper white text reads better on than black text does — the WCAG
 * luminance crossover. A colour this cannot parse is dark, which is what the
 * stylesheet itself falls back to when no theme is set.
 */
export function paperOf(background: string): Paper {
  const rgb = rgbOf(background);
  if (!rgb) return "dark";
  const [r, g, b] = rgb.map(v => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (luminance + 0.05) > (luminance + 0.05) / 0.05 ? "dark" : "light";
}

/**
 * xterm's theme, out of the palette snapshot.
 *
 * `read` is a token lookup — `paletteReader(palette)`. A token it answers with
 * the empty string (one that never made it into the snapshot) leaves its slot
 * unset rather than set to "", so xterm falls back to its own default for that
 * one colour instead of failing to parse it.
 */
export function terminalTheme(read: (token: TerminalToken) => string): ITheme {
  const theme: ITheme = {};
  const set = (slot: keyof ITheme, token: TerminalToken) => {
    const value = read(token).trim();
    if (value) (theme as Record<string, string>)[slot] = value;
  };
  const paper = paperOf(read("--panel"));
  set("background", "--panel");
  set("foreground", "--text");
  // The cursor is the accent, which is the deck's "focused, live" colour —
  // and the glyph under a block cursor is drawn in the background colour, which
  // the accent clears 4.5:1 against in both themes.
  set("cursor", "--accent");
  set("cursorAccent", "--panel");
  set("selectionBackground", "--accent-dim");
  for (const slot of ANSI_SLOTS) set(slot, ANSI[slot][paper]);
  return theme;
}
