// The terminal's colours, measured from the stylesheet's real token values in
// both themes.
//
// There is no DOM here, so nothing can be sampled off a rendered terminal. What
// can be done is what contrast-floors.test.ts does for the rest of the deck:
// read styles/tokens.css, resolve each token in each theme the way the browser
// resolves a custom property (var() substituted all the way down), hand that to
// terminalTheme as its reader — exactly the shape paletteReader(palette) has —
// and measure what comes out against what it is drawn on.
//
// The floor is the panel's own promise: every one of the sixteen ANSI colours
// at 4.5:1 or better on the terminal's background, in BOTH themes, the black
// slot on dark and the white slots on light included. A token edit that walks
// any of them under it fails here before it ships a terminal nobody can read.
//
// The WCAG helpers are re-declared rather than imported from a sibling test,
// because importing a test file registers its suites into this one too.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ANSI_SLOTS,
  MINIMUM_CONTRAST_RATIO,
  TERMINAL_TOKENS,
  ansiToken,
  paperOf,
  terminalTheme,
  type TerminalToken,
} from "../terminal-palette";
import { withoutComments } from "./tsx-scan";

const web = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const sheet = web("styles/tokens.css").replace(/\/\*[\s\S]*?\*\//g, "");

const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

/** One theme's block of declarations, as written. */
function block(theme: Theme): Record<string, string> {
  const head = theme === "dark" ? ':root,\\s*\\n:root\\[data-theme="dark"\\]' : ':root\\[data-theme="light"\\]';
  const found = new RegExp(`${head}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(sheet);
  if (!found) throw new Error(`styles/tokens.css has no ${theme} token block`);
  const out: Record<string, string> = {};
  for (const [, name, value] of found[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

const DECLARED: Record<Theme, Record<string, string>> = { dark: block("dark"), light: block("light") };

/** A token's value in a theme with every var() substituted — what
 *  getComputedStyle hands back for a custom property, and so what the palette
 *  snapshot holds. A token the theme block does not set falls back to the dark
 *  block, which is `:root` itself and therefore the cascade's base. */
function resolved(token: string, theme: Theme, depth = 0): string {
  if (depth > 8) throw new Error(`${token} does not resolve — a var() cycle?`);
  const value = DECLARED[theme][token] ?? DECLARED.dark[token];
  if (value === undefined) throw new Error(`styles/tokens.css does not declare ${token}`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  return alias ? resolved(alias[1], theme, depth + 1) : value;
}

type Rgba = [number, number, number, number];

function parse(input: string): Rgba {
  const s = input.trim();
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) return [+fn[1], +fn[2], +fn[3], fn[4] === undefined ? 1 : +fn[4]];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (!hex) throw new Error(`unparseable colour: ${input}`);
  const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
  const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), alpha];
}

const over = (fg: Rgba, bg: Rgba): Rgba =>
  [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as Rgba;

function luminance(c: Rgba): number {
  const [r, g, b] = [c[0], c[1], c[2]].map(v => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const bed = parse(b);
  const la = luminance(over(parse(a), bed));
  const lb = luminance(bed);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The reader the panel will hand terminalTheme, answering out of the sheet
 *  instead of a snapshot, and recording every token it was asked for. */
function reader(theme: Theme) {
  const asked: string[] = [];
  const read = (token: TerminalToken) => {
    asked.push(token);
    return resolved(token, theme);
  };
  return { read, asked };
}

const themeOf = (theme: Theme) => terminalTheme(reader(theme).read);

describe("every ANSI colour reads on the terminal's background", () => {
  for (const theme of THEMES) {
    it(`clears ${MINIMUM_CONTRAST_RATIO}:1 for all sixteen slots in the ${theme} theme`, () => {
      const t = themeOf(theme);
      const failures: string[] = [];
      for (const slot of ANSI_SLOTS) {
        const colour = t[slot];
        expect(colour, `${slot} is unset in the ${theme} theme`).toBeTruthy();
        const r = ratio(colour!, t.background!);
        if (r < MINIMUM_CONTRAST_RATIO) failures.push(`${slot} (${ansiToken(slot, theme)} ${colour}) ${r.toFixed(2)}:1`);
      }
      expect(failures, `under ${MINIMUM_CONTRAST_RATIO}:1 on ${t.background} in ${theme}`).toEqual([]);
    });
  }

  it("holds that floor to the one xterm enforces, so a slot is drawn as the token it names", () => {
    // xterm rewrites any foreground under minimumContrastRatio at render time;
    // a palette held to a lower floor would be partly computed colours.
    expect(MINIMUM_CONTRAST_RATIO).toBe(4.5);
  });
});

describe("the rest of the theme", () => {
  for (const theme of THEMES) {
    it(`draws on --panel, writes in --text, and keeps the cursor and selection readable in ${theme}`, () => {
      const t = themeOf(theme);
      expect(t.background).toBe(resolved("--panel", theme));
      expect(t.foreground).toBe(resolved("--text", theme));
      expect(ratio(t.foreground!, t.background!), "body text").toBeGreaterThanOrEqual(MINIMUM_CONTRAST_RATIO);
      // The cursor is a mark you have to find (1.4.11), and the glyph under a
      // block cursor is drawn in cursorAccent on the cursor colour (1.4.3).
      expect(ratio(t.cursor!, t.background!), "cursor against the background").toBeGreaterThanOrEqual(3);
      expect(ratio(t.cursorAccent!, t.cursor!), "the glyph under a block cursor").toBeGreaterThanOrEqual(4.5);
      // Selected text stays text: the foreground over the selection wash,
      // composited onto the background the way the renderer layers them.
      const selected = over(parse(t.selectionBackground!), parse(t.background!));
      const bed = `rgb(${selected.slice(0, 3).map(Math.round).join(",")})`;
      expect(ratio(t.foreground!, bed), "text inside a selection").toBeGreaterThanOrEqual(4.5);
    });
  }

  it("draws on the panel and not on the canvas, where light's yellow would fall under the floor", () => {
    // The reason the background is --panel: --cat-shell is 4.44:1 on light's
    // #eef1f6 canvas and 5.02:1 on white.
    expect(ratio(resolved("--cat-shell", "light"), resolved("--bg", "light"))).toBeLessThan(4.5);
    expect(themeOf("light").background).toBe(resolved("--panel", "light"));
  });
});

describe("where the colours come from", () => {
  it("asks only for the tokens it declares, so the palette snapshot can be told exactly what to carry", () => {
    // Each theme reads a subset — dark has no use for light's white, and the
    // other way round — and between them they read every declared token, so
    // the list holds nothing the snapshot would carry for no one.
    const union = new Set<string>();
    for (const theme of THEMES) {
      const { read, asked } = reader(theme);
      terminalTheme(read);
      for (const token of asked) {
        expect(TERMINAL_TOKENS as readonly string[], `${theme} asked for undeclared ${token}`).toContain(token);
        union.add(token);
      }
    }
    expect([...union].sort()).toEqual([...TERMINAL_TOKENS].sort());
    expect(new Set(TERMINAL_TOKENS).size).toBe(TERMINAL_TOKENS.length);
  });

  it("invents no colour: every value is some token's value in that theme", () => {
    for (const theme of THEMES) {
      const values = new Set(TERMINAL_TOKENS.map(token => resolved(token, theme)));
      for (const [slot, value] of Object.entries(themeOf(theme))) {
        expect(values.has(value as string), `${slot} = ${value} is not a token in ${theme}`).toBe(true);
      }
    }
  });

  it("never paints with --inflight, the hue that means a tool call is running right now", () => {
    expect(TERMINAL_TOKENS as readonly string[]).not.toContain("--inflight");
    for (const theme of THEMES) {
      const inflight = resolved("--inflight", theme).toLowerCase();
      for (const [slot, value] of Object.entries(themeOf(theme))) {
        expect((value as string).toLowerCase(), `${slot} wears --inflight in ${theme}`).not.toBe(inflight);
      }
    }
  });

  it("keeps the six hues apart from each other in each theme", () => {
    for (const theme of THEMES) {
      const t = themeOf(theme);
      const hues = [t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan].map(v => v!.toLowerCase());
      expect(new Set(hues).size, `two ANSI hues share a colour in ${theme}: ${hues.join(" ")}`).toBe(6);
    }
  });

  it("steps the greys in the conventional order on each paper", () => {
    // Ink end to paper end. On dark that is bright white (brightest) down to
    // black; on light, black (darkest) up to the whites. Equal neighbours are
    // allowed — each paper runs out of readable greys at its paper end.
    const lum = (c: string) => luminance(parse(c));
    const dark = themeOf("dark");
    expect(lum(dark.brightWhite!)).toBeGreaterThanOrEqual(lum(dark.white!));
    expect(lum(dark.white!)).toBeGreaterThan(lum(dark.brightBlack!));
    expect(lum(dark.brightBlack!)).toBeGreaterThanOrEqual(lum(dark.black!));
    const light = themeOf("light");
    expect(lum(light.black!)).toBeLessThan(lum(light.brightBlack!));
    expect(lum(light.brightBlack!)).toBeLessThan(lum(light.white!));
    expect(lum(light.white!)).toBeLessThanOrEqual(lum(light.brightWhite!));
  });
});

describe("which paper it is on", () => {
  it("reads the theme off the background itself, so colours and mapping can never be from different frames", () => {
    expect(paperOf(resolved("--panel", "dark"))).toBe("dark");
    expect(paperOf(resolved("--panel", "light"))).toBe("light");
    expect(paperOf("#000")).toBe("dark");
    expect(paperOf("#fff")).toBe("light");
    expect(paperOf("rgb(250, 250, 250)")).toBe("light");
    expect(paperOf("#0b0c10cc")).toBe("dark");
  });

  it("falls back to dark, the sheet's own default, for a background it cannot read", () => {
    expect(paperOf("")).toBe("dark");
    expect(paperOf("color-mix(in srgb, white 50%, black)")).toBe("dark");
  });

  it("maps the greys by paper and the hues the same on both", () => {
    expect(themeOf("dark").black).toBe(resolved("--muted", "dark"));
    expect(themeOf("light").black).toBe(resolved("--text", "light"));
    expect(themeOf("light").brightWhite).toBe(resolved("--text-dim", "light"));
    for (const slot of ["red", "green", "yellow", "blue", "magenta", "cyan"] as const) {
      expect(ansiToken(slot, "dark"), slot).toBe(ansiToken(slot, "light"));
      const bright = `bright${slot[0].toUpperCase()}${slot.slice(1)}` as (typeof ANSI_SLOTS)[number];
      expect(ansiToken(bright, "dark"), `${bright} invents a lighter hue`).toBe(ansiToken(slot, "dark"));
    }
  });
});

describe("a snapshot that does not carry the tokens yet", () => {
  it("leaves every slot unset rather than handing xterm an empty colour", () => {
    // paletteReader answers a token outside CANVAS_TOKENS with "". An empty
    // slot makes xterm use its own default for that one colour; an empty
    // string would be a colour it has to parse.
    expect(terminalTheme(() => "")).toEqual({});
    // With only --text answered, on a background that reads as nothing (so
    // dark): the foreground and dark's bright white, which is --text too.
    const partial = terminalTheme(t => (t === "--text" ? " #ffffff " : ""));
    expect(partial).toEqual({ foreground: "#ffffff", brightWhite: "#ffffff" });
  });
});

describe("the module's footprint", () => {
  it("imports only a type from xterm, never the library, and reads no style off the document", () => {
    const src = withoutComments(web("terminal-palette.ts"));
    const imports = [...src.matchAll(/^\s*import\b[^;]*;/gm)].map(m => m[0].trim());
    expect(imports).toEqual(['import type { ITheme } from "@xterm/xterm";']);
    expect(src).not.toMatch(/\bimport\(/);
    expect(src).not.toMatch(/getComputedStyle|getPropertyValue|document\./);
    expect(src, "a colour literal in the module is a colour no token sweep measures").not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
