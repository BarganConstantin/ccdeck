// The Jira panel's own colours, in every theme, read out of the sheet the way
// the browser cascades them. The panel draws an issue type itself when Jira's
// icon cannot be shown: a coloured tile with a mark on it. The mark was
// written white, which reads on a light theme's deep tiles and vanishes on a
// dark theme's pastel ones (1.4:1 on a story in the dark themes), and the
// epic tile was a fixed purple no theme had chosen. So the ratios are
// computed here from each theme's tokens, and a palette or rule edit that
// walks one back under its floor fails the build.
import { describe, expect, it } from "vitest";
import { cascade, el, selects, splitTop, type El } from "./sheet-cascade";
import { sheetText } from "./sheet-source";

type Rgba = [number, number, number, number];
const WIDTH = 1440;
/** WCAG 1.4.11: a mark that carries meaning, and its tile against the row. */
const NON_TEXT = 3;

const THEMES = [...new Set([...sheetText().matchAll(/:root\[data-theme="([\w-]+)"\]\s*\{/g)].map(m => m[1]))];
const LIGHT = new Set(["light", "white-contrast", "gruvbox-light"]);

const rootOf = (theme: string) =>
  el("html", [], { attrs: { "data-theme": theme, "data-color-scheme": LIGHT.has(theme) ? "light" : "dark" }, states: ["root"] });

/** A property as `chain`'s last element gets it. Custom properties inherit,
 *  so a name the element does not set is asked of its ancestors in turn. */
function prop(chain: El[], name: string): string | null {
  const inherits = name.startsWith("--");
  for (let i = chain.length; i > 0; i--) {
    const sub = chain.slice(0, i);
    const value = cascade(selector => selects(selector, sub), name, WIDTH);
    if (value != null || !inherits) return value;
  }
  return null;
}

/** `value` with every var() replaced by what `chain` gives it, or by its
 *  fallback when nothing does. */
function expand(value: string, chain: El[]): string {
  const at = value.indexOf("var(");
  if (at < 0) return value;
  let depth = 0, end = at + 3;
  for (; end < value.length; end++) {
    if (value[end] === "(") depth++;
    else if (value[end] === ")" && --depth === 0) break;
  }
  const [name, ...fallback] = splitTop(value.slice(at + 4, end));
  const found = prop(chain, name.trim()) ?? (fallback.length ? fallback.join(",") : null);
  if (found == null) throw new Error(`${name} is set nowhere on this element`);
  return expand(value.slice(0, at) + expand(found.trim(), chain) + value.slice(end + 1), chain);
}

function color(value: string, chain: El[]): Rgba {
  const v = expand(value, chain).trim();
  if (v === "transparent") return [0, 0, 0, 0];
  const hex = /^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1) as Rgba;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  const mix = /^color-mix\(in srgb,\s*(.+)\)$/.exec(v);
  if (mix) {
    const [first, second] = splitTop(mix[1]);
    const part = (s: string) => {
      const m = /^(.+?)\s+([\d.]+)%$/.exec(s.trim());
      return m ? { c: color(m[1], chain), w: Number(m[2]) / 100 } : { c: color(s, chain), w: null };
    };
    const a = part(first), b = part(second);
    const wa = a.w ?? (b.w == null ? 0.5 : 1 - b.w), wb = 1 - wa;
    const alpha = a.c[3] * wa + b.c[3] * wb;
    return [0, 1, 2].map(i => alpha ? (a.c[i] * a.c[3] * wa + b.c[i] * b.c[3] * wb) / alpha : 0).concat(alpha) as Rgba;
  }
  throw new Error(`Unsupported colour: ${v}`);
}

function over(ink: Rgba, bed: Rgba): Rgba {
  return [0, 1, 2].map(i => ink[i] * ink[3] + bed[i] * (1 - ink[3])).concat(1) as Rgba;
}
function luminance(c: Rgba): number {
  const linear = c.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}
function contrast(a: Rgba, b: Rgba): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

const SHAPES = ["bug", "story", "task", "subtask", "epic", "other"] as const;

describe("the issue type the panel draws itself", () => {
  it("reads every theme in the sheet", () => {
    expect(THEMES).toHaveLength(12);
  });

  for (const theme of THEMES) {
    for (const shape of SHAPES) {
      it(`${theme}: a ${shape}'s mark stands off its tile, and the tile off the row`, () => {
        const root = rootOf(theme);
        const glyph = [root, el("svg", ["jr-icon", "jr-type-glyph"], { attrs: { "data-shape": shape } })];
        const panel = color("var(--panel)", [root]);
        const tileChain = [...glyph, el("rect", ["jr-glyph-tile"])];
        const markClasses = shape === "task" ? ["jr-glyph-mark", "jr-glyph-stroke"] : ["jr-glyph-mark"];
        const markChain = [...glyph, el("path", markClasses)];
        const tile = over(color(prop(tileChain, "fill")!, tileChain), panel);
        const ink = prop(markChain, shape === "task" ? "stroke" : "fill")!;
        expect(ink, "the mark is drawn in a theme colour, never a fixed one").toMatch(/^var\(/);
        const mark = over(color(ink, markChain), tile);
        expect(contrast(mark, tile)).toBeGreaterThanOrEqual(NON_TEXT);
        expect(contrast(tile, panel)).toBeGreaterThanOrEqual(NON_TEXT);
      });
    }
  }
});
