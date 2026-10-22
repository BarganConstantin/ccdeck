// A selected row in an integration panel's list (#2178, #2179) is one rule for
// Jira and the forges, declared by the host in integrations.css: a quiet
// accent fill (--ig-sel-fill), distinct from the neutral fill a hover lifts a
// row with, and every word on it in --text.
//
// Two panels used to disagree: Jira filled a selected row with --accent-dim
// and left its keys, estimates and versions in --muted on it, 3.76:1 in Rider
// Black; the forges filled it with --ctl-fill, the hover's own fill, so a
// selected row and the row under the pointer looked the same. A wash over a
// panel lowers the contrast of everything on it, and how much depends on the
// theme, so this measures every palette the deck ships: the fill composited
// over --panel, the words on it at 4.5:1, a status mark at 3:1, and the fill
// far enough from the hover's, in OKLab, to be told apart. The values are read
// from the stylesheet itself, theme overrides included, so a palette edit or a
// change to the rule that walks a theme under the floor fails here.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetText } from "./sheet-source";

type Rgba = [number, number, number, number];

const web = fileURLToPath(new URL("../", import.meta.url));
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const host = readFileSync(`${web}styles/integrations.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every theme the deck ships, by the JSON catalog's file names. */
const THEMES = readdirSync(`${web}themes`).filter(f => f.endsWith(".json") && f !== "schema.json").map(f => f.replace(/\.json$/, ""));

/** The custom properties of the first top-level rule one of whose selectors is exactly `selector`. */
function declarations(src: string, selector: string): Record<string, string> {
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
function palette(theme: string): Record<string, string> {
  const own = declarations(css, `:root[data-theme="${theme}"]`);
  return Object.keys(own).length ? own : declarations(css, `:root,\n:root[data-theme="${theme}"]`);
}

function hex(value: string): Rgba {
  const h = value.slice(1);
  const full = h.length <= 4 ? h.replace(/./g, c => c + c) : h;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
}

/** Resolves var() against the theme's palette (and the host's own properties),
 *  then reads hex, rgb()/rgba(), `transparent` and `color-mix(in srgb, …)`,
 *  mixing premultiplied the way CSS Color 5 does. */
function color(value: string, scope: Record<string, string>): Rgba {
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

const over = (top: Rgba, under: Rgba): Rgba =>
  [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as Rgba;

function linear(v: number) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(c: Rgba): number {
  const [r, g, b] = c.slice(0, 3).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: Rgba, b: Rgba) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** OKLab, where a distance of about 0.02 is the least two flat fills can differ and be seen to. */
function oklab(c: Rgba): [number, number, number] {
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
const apart = (a: Rgba, b: Rgba) => {
  const x = oklab(a), y = oklab(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

/** The host's properties as a theme sees them: the shared rule, then any
 *  theme-scoped override in integrations.css. */
function hostProps(theme: string): Record<string, string> {
  return { ...declarations(host, ".ig-modal"), ...declarations(host, `:root[data-theme="${theme}"] .ig-modal`) };
}

function measure(theme: string) {
  const scope = { ...palette(theme), ...hostProps(theme) };
  const panel = over(color("var(--panel)", scope), color("var(--bg)", scope));
  const fill = over(color("var(--ig-sel-fill)", scope), panel);
  const hover = over(color("var(--ig-hover-fill)", scope), panel);
  const on = (ink: string, ground: Rgba) => Math.round(contrast(over(color(`var(--${ink})`, scope), ground), ground) * 100) / 100;
  return { fill, hover, panel, on };
}

const r2 = (n: number) => Math.round(n * 1000) / 1000;

describe("the selected row in an integration panel", () => {
  it("reads every shipped theme, so a pass covers all of them", () => {
    expect(THEMES.length).toBe(12);
    for (const theme of THEMES) expect(palette(theme).panel, theme).toBeTruthy();
  });

  it("declares one fill, one hover fill and one ink for every word, on the host's modal", () => {
    const props = declarations(host, ".ig-modal");
    expect(props["ig-sel-fill"]).toBe("var(--accent-dim)");
    expect(props["ig-hover-fill"]).toBe("var(--ctl-fill)");
    expect(props["ig-sel-ink"]).toBe("var(--text)");
    expect(props["ig-sel-muted"]).toBe("var(--text)");
  });

  it("leaves the app-wide --accent-dim alone and overrides only the palettes it fails in", () => {
    const overridden = THEMES.filter(t => "ig-sel-fill" in declarations(host, `:root[data-theme="${t}"] .ig-modal`));
    expect(overridden.sort()).toEqual(["gruvbox-dark", "gruvbox-material"]);
    expect(host).not.toMatch(/--accent-dim\s*:/);
  });

  for (const theme of THEMES) {
    it(`keeps every word at 4.5:1 and every status mark at 3:1 on the fill in ${theme}`, () => {
      const m = measure(theme);
      expect(m.on("ig-sel-ink", m.fill), `${theme} --ig-sel-ink`).toBeGreaterThanOrEqual(4.5);
      expect(m.on("ig-sel-muted", m.fill), `${theme} --ig-sel-muted`).toBeGreaterThanOrEqual(4.5);
      for (const mark of ["ok", "warn", "err", "accent"]) {
        expect(m.on(mark, m.fill), `${theme} --${mark} mark`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`is a fill of its own in ${theme}, not the hover's and not the panel's`, () => {
      const m = measure(theme);
      expect(r2(apart(m.fill, m.hover)), `${theme}: selected vs hovered`).toBeGreaterThanOrEqual(0.03);
      expect(apart(m.fill, m.panel), `${theme}: selected vs resting`).toBeGreaterThan(apart(m.hover, m.panel));
    });

    it(`keeps a hovered row's quiet words at 4.5:1 in ${theme}`, () => {
      const m = measure(theme);
      // The hover re-points --muted and --text-dim at --text-secondary.
      expect(m.on("text-secondary", m.hover), `${theme} --text-secondary on hover`).toBeGreaterThanOrEqual(4.5);
      expect(m.on("text", m.hover), `${theme} --text on hover`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("re-points the quiet tiers inside a selected row, so no rule has to name its own", () => {
    const rule = /\.ig-row\[data-selected\]\s*\{([^}]*)\}/.exec(host)?.[1] ?? "";
    for (const tier of ["--text-secondary", "--muted", "--text-dim"]) {
      expect(rule, tier).toMatch(new RegExp(`${tier}\\s*:\\s*var\\(--ig-sel-muted\\)`));
    }
    expect(rule).toMatch(/background\s*:\s*var\(--ig-sel-fill\)/);
    expect(rule).toMatch(/(^|[;\s])color\s*:\s*var\(--ig-sel-ink\)/);
    // No coloured edge on a selected row (owner, 2026-10-13).
    expect(rule).not.toMatch(/border-(left|inline-start)|box-shadow\s*:\s*inset\s+\d/);
    const hover = /\.ig-row:hover\s*\{([^}]*)\}/.exec(host)?.[1] ?? "";
    expect(hover).toMatch(/--muted\s*:\s*var\(--text-secondary\)/);
  });

  it("drops a pill's fill inside a selected row, so its word sits on the selection", () => {
    expect(host).toMatch(/\.ig-row\[data-selected\] \.ig-chip\s*\{[^}]*background:\s*transparent[^}]*color:\s*var\(--ig-sel-ink\)/);
  });

  it("lets the hover lift only rows that are not chosen, and keeps the choice visible in forced colours", () => {
    const hoverAt = host.indexOf(".ig-row:hover {");
    const selectedAt = host.indexOf(".ig-row[data-selected] {");
    expect(hoverAt).toBeGreaterThan(-1);
    // Equal specificity: the selection is written later, so a hovered selected row keeps its fill.
    expect(selectedAt).toBeGreaterThan(hoverAt);
    // The deck answers forced colours in one block (forced-colors-871.test.ts).
    const forced = css.slice(css.indexOf("@media (forced-colors: active) {"));
    expect(forced).toMatch(/\n\s*\.ig-row\[data-selected\]\s*\{\s*outline:\s*2px solid Highlight/);
    expect(host).toMatch(/@media \(hover: none\)\s*\{[^}]*\.ig-row:hover:not\(\[data-selected\]\)/);
  });
});
