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
// THE 256-COLOUR SLOTS CLAUDE CODE PAINTS WITH ARE TOKENS TOO (v1's map, the
// graft DESIGN-UI takes from it). Claude Code draws nearly everything outside
// the sixteen: prose in 231, secondary text in 246, finished tools in 114, its
// salmon spinner in 174/180/216, a Monokai-like syntax set in
// 197/81/148/186/141/208, rules in 244, the permission box in 147, the user's
// message band in 237 and the diff bands in 22/52. Left at xterm's cube values
// those are pure white and saturated neon beside a deck whose whites are
// blue-grey and whose hues are pastel — and on the light theme 231 is white
// text on white paper. Each slot is pointed at the token doing the same job,
// by ROLE rather than by brightness: 231 is "the strongest ink", which is
// --text on either paper, so the light theme reads it as near-black.
//
// Two kinds of slot, because a TUI uses the 256 palette two ways:
//
//   ink   — a foreground. Every one clears 4.5:1 on --panel in both themes,
//           the same promise as the sixteen; the greys step from --text down
//           to the lowest readable grey and stop there.
//   band  — a background a line of text sits on (237, the diff bands, the
//           dark end of the grey ramp). A band is a stated wash of one token
//           over --panel, composited here into the opaque colour xterm needs,
//           and the promise it keeps is the other way round: --text on it
//           still clears 4.5:1. It is not a new colour so much as a known
//           alpha of two measured ones.
//
// Slots no map entry names stay at xterm's own values (an empty entry in
// extendedAnsi is xterm's default for that slot), and minimumContrastRatio is
// what keeps them readable: Claude Code also paints in 24-bit colour chosen by
// its own /theme, so a session set to a dark theme draws light-on-light inside
// the deck's light theme unless xterm lifts it.
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
  // The usage palette: pastel on dark, deep on light, already swept for
  // contrast — the syntax colours and the permission box of the 256 map.
  "--usage-indigo",
  "--usage-pink",
  "--usage-cyan",
  "--usage-lime",
  "--usage-orange",
  "--usage-purple",
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

/** A 256-colour slot drawn as text: the token per paper. */
export interface InkSlot {
  kind: "ink";
  token: Record<Paper, TerminalToken>;
}

/** A 256-colour slot drawn as a background: `wash` of `token` over --panel. */
export interface BandSlot {
  kind: "band";
  token: TerminalToken;
  wash: number;
}

export type ExtendedSlot = InkSlot | BandSlot;

const ink = (dark: TerminalToken, light: TerminalToken = dark): InkSlot => ({ kind: "ink", token: { dark, light } });
const band = (token: TerminalToken, wash: number): BandSlot => ({ kind: "band", token, wash });

/**
 * The 256-colour slots that are re-pointed, by number. v1's measured map, with
 * its literals replaced by the token each one was eased toward:
 *
 *  - the grey ramp by role, strongest ink first. 255–251 are prose and its
 *    second tier; 250–246 the secondary text Claude Code writes in 246;
 *    245–240 the dimmest ink, which stops at the lowest readable grey each
 *    paper has (--muted on dark, --text-dim on light) instead of fading past
 *    the floor. 239–232 are the ramp's paper end, which TUIs use for bands,
 *    and are washes of --text that deepen as the number rises — the same
 *    order of visibility the default ramp has on a dark terminal.
 *  - 231, xterm's pure white and Claude Code's prose colour, is --text.
 *  - the hues are the usage palette and the state tokens, as v1 chose them;
 *    the spinner's salmon is --usage-orange (Claude Code's own colour on the
 *    usage chart) shimmering toward --cat-shell, the terminal's yellow.
 *  - 22/52 and 28/88 are the diff bands, a wash of --ok and --err.
 */
const EXTENDED: ReadonlyMap<number, ExtendedSlot> = new Map<number, ExtendedSlot>([
  [231, ink("--text")],
  [255, ink("--text")], [254, ink("--text")],
  [253, ink("--text-secondary")], [252, ink("--text-secondary")], [251, ink("--text-secondary")],
  [250, ink("--text-secondary", "--muted")], [249, ink("--text-secondary", "--muted")],
  [248, ink("--text-secondary", "--muted")], [247, ink("--text-secondary", "--muted")],
  [246, ink("--text-secondary", "--muted")],
  [245, ink("--muted", "--text-dim")], [244, ink("--muted", "--text-dim")], [243, ink("--muted", "--text-dim")],
  [242, ink("--muted", "--text-dim")], [241, ink("--muted", "--text-dim")], [240, ink("--muted", "--text-dim")],
  [239, band("--text", 0.13)], [238, band("--text", 0.1)], [237, band("--text", 0.075)],
  [236, band("--text", 0.05)], [235, band("--text", 0.035)], [234, band("--text", 0.025)],
  [233, band("--text", 0.02)], [232, band("--text", 0.015)],
  // A finished tool, and the greens around it.
  [114, ink("--ok")], [120, ink("--ok")], [77, ink("--ok")], [71, ink("--ok")],
  // Links, selection and the permission dialog's chosen row.
  [153, ink("--accent")], [117, ink("--accent")], [111, ink("--accent")],
  // The permission box's blue-violet.
  [147, ink("--usage-indigo")], [105, ink("--usage-indigo")],
  // The permission-mode line, and its yellows.
  [211, ink("--usage-pink")], [220, ink("--cat-shell")], [214, ink("--cat-shell")],
  // The spinner and its shimmer.
  [174, ink("--usage-orange")], [180, ink("--cat-shell")], [216, ink("--cat-shell")],
  // The syntax set.
  [197, ink("--usage-pink")], [81, ink("--usage-cyan")], [148, ink("--usage-lime")],
  [186, ink("--usage-orange")], [141, ink("--usage-purple")], [208, ink("--usage-indigo")],
  // Diff bands: the line, then the changed words inside it.
  [22, band("--ok", 0.16)], [52, band("--err", 0.16)],
  [28, band("--ok", 0.32)], [88, band("--err", 0.32)],
]);

/** Every slot number the map re-points, ascending. */
export const EXTENDED_SLOTS: readonly number[] = [...EXTENDED.keys()].sort((a, b) => a - b);

/** What slot `n` is re-pointed to, or undefined when it keeps xterm's value. */
export function extendedSlot(n: number): ExtendedSlot | undefined {
  return EXTENDED.get(n);
}

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

/**
 * `wash` of `inkColour` composited over `paperColour`, as the opaque colour a
 * band is drawn in — null when either does not parse. Exported so the tests
 * measure the same arithmetic the terminal is given.
 */
export function washOver(inkColour: string, paperColour: string, wash: number): string | null {
  const a = rgbOf(inkColour);
  const b = rgbOf(paperColour);
  if (!a || !b) return null;
  return "#" + [0, 1, 2].map(i => hex2(a[i] * wash + b[i] * (1 - wash))).join("");
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
  // Indexed from colour 16, as xterm reads it. An entry left undefined is
  // xterm's own default for that slot, so only the slots above move.
  const extended: Array<string | undefined> = Array.from({ length: 240 }, () => undefined);
  const panel = read("--panel").trim();
  let any = false;
  for (const [n, slot] of EXTENDED) {
    const value = slot.kind === "ink"
      ? read(slot.token[paper]).trim()
      : panel ? washOver(read(slot.token), panel, slot.wash) ?? "" : "";
    if (!value) continue;
    extended[n - 16] = value;
    any = true;
  }
  if (any) theme.extendedAnsi = extended as string[];
  return theme;
}
