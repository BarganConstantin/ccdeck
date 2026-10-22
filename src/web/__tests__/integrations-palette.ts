// Colour arithmetic for the integrations' contrast tests, read from the
// stylesheet itself: every shipped theme's palette as the generated sheet
// declares it, the host's own properties from integrations.css (theme-scoped
// overrides included), var() and color-mix(in srgb, …) resolved the way CSS
// Color 5 mixes, and WCAG contrast and OKLab distance on the result.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";

export type Rgba = [number, number, number, number];

export const web = fileURLToPath(new URL("../", import.meta.url));
export const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
export const host = readFileSync(`${web}styles/integrations.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every theme the deck ships, by the JSON catalog's file names. */
export const THEMES = readdirSync(`${web}themes`).filter(f => f.endsWith(".json") && f !== "schema.json").map(f => f.replace(/\.json$/, ""));

/** The custom properties of the first top-level rule one of whose selectors is exactly `selector`. */
export function declarations(src: string, selector: string): Record<string, string> {
  const want = selector.replace(/\s+/g, " ");
  let depth = 0, start = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "{") {
      const head = src.slice(start, i).trim();
      const close = src.indexOf("}", i);
      const inner = src.slice(i + 1, close);
      if (depth === 0 && !head.startsWith("@") && !inner.includes("{")
        && head.split(",").some(sel => sel.trim().replace(/\s+/g, " ") === want)) {
        return Object.fromEntries([...inner.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
      }
      depth++;
      start = i + 1;
    } else if (src[i] === "}") {
      depth--;
      start = i + 1;
    } else if (src[i] === ";" && depth === 0) {
      start = i + 1;
    }
  }
  return {};
}

/** A theme's palette as the generated sheet declares it. Dark is also :root's. */
export function palette(theme: string): Record<string, string> {
  const own = declarations(css, `:root[data-theme="${theme}"]`);
  return Object.keys(own).length ? own : declarations(css, `:root,\n:root[data-theme="${theme}"]`);
}

export function hex(value: string): Rgba {
  const h = value.slice(1);
  const full = h.length <= 4 ? h.replace(/./g, c => c + c) : h;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
}

/** Resolves var() against the theme's palette (and the host's own properties),
 *  then reads hex, rgb()/rgba(), `transparent` and `color-mix(in srgb, …)`,
 *  mixing premultiplied the way CSS Color 5 does. */
export function color(value: string, scope: Record<string, string>): Rgba {
  const v = value.trim();
  const ref = /^var\(--([\w-]+)\)$/.exec(v);
  if (ref) {
    if (!(ref[1] in scope)) throw new Error(`--${ref[1]} is not declared`);
    return color(scope[ref[1]], scope);
  }
  if (v === "transparent") return [0, 0, 0, 0];
  if (/^#[\da-f]{3,8}$/i.test(v)) return hex(v);
  const rgb = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgb) {
    const p = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  const mix = /^color-mix\(in srgb,\s*(.+?)(?:\s+([\d.]+)%)?,\s*(.+?)(?:\s+([\d.]+)%)?\)$/.exec(v);
  if (mix) {
    const a = color(mix[1], scope), b = color(mix[3], scope);
    const wa = mix[2] != null ? +mix[2] / 100 : mix[4] != null ? 1 - +mix[4] / 100 : 0.5;
    const alpha = a[3] * wa + b[3] * (1 - wa);
    return [0, 1, 2].map(i => (alpha ? (a[i] * a[3] * wa + b[i] * b[3] * (1 - wa)) / alpha : 0)).concat(alpha) as Rgba;
  }
  throw new Error(`unreadable colour: ${value}`);
}

export const over = (top: Rgba, under: Rgba): Rgba =>
  [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as Rgba;

export function linear(v: number) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
export function luminance(c: Rgba): number {
  const [r, g, b] = c.slice(0, 3).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const contrast = (a: Rgba, b: Rgba) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** OKLab, where a distance of about 0.02 is the least two flat fills can differ and be seen to. */
export function oklab(c: Rgba): [number, number, number] {
  const [r, g, b] = c.slice(0, 3).map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
export const apart = (a: Rgba, b: Rgba) => {
  const x = oklab(a), y = oklab(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

/** The host's properties as a theme sees them: the shared rule, then any
 *  theme-scoped override in integrations.css. */
export function hostProps(theme: string): Record<string, string> {
  return { ...declarations(host, ".ig-modal"), ...declarations(host, `:root[data-theme="${theme}"] .ig-modal`) };
}

/** A theme's palette with the host's properties over it: the scope a value is resolved in. */
export function scopeOf(theme: string): Record<string, string> {
  return { ...palette(theme), ...hostProps(theme) };
}

/** The panel as it is painted: --panel over --bg. */
export function panelOf(scope: Record<string, string>): Rgba {
  return over(color("var(--panel)", scope), color("var(--bg)", scope));
}
