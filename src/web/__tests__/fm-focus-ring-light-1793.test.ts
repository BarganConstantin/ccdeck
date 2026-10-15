// #1793: in the light theme the Claude FM character's focus ring was its body.
//
// The character's body is painted in --accent, and the light theme wants a
// sky blue for that large filled silhouette rather than its link blue — so the
// sheet set `--accent: var(--pixel-character-body)` on `.fm-sprite`. That rule
// is on the button itself, and the global ring is `outline: 2px solid
// var(--accent)` resolved on that same element, so the ring came out #38bdf8:
// 1.89:1 against the light canvas and 2.04:1 against the minimap, the same
// colour as the body right beside it. Every other control in the light theme
// gets the theme's own accent.
//
// So this resolves what the cascade paints — the ring on the focused button,
// the body inside it — with custom properties inheriting down the chain the
// way they do in a browser, and measures the ring against both surfaces the
// character stands on.
import { describe, it, expect } from "vitest";
import { cascade, el, selects, splitTop, type El } from "./sheet-cascade";

/** WCAG 1.4.11: a focus indicator is a non-text boundary. */
const NON_TEXT = 3;
const WIDTH = 1280;

const html = (theme: "light" | "dark") => el("html", [], { states: ["root"], attrs: { "data-theme": theme, "data-color-scheme": theme } });

/** The character's button and its ancestors, standing on the ledge or the floor. */
function sprite(theme: "light" | "dark", place: "ledge" | "floor"): El[] {
  return [
    html(theme), el("body"), el("div", ["app"]), el("main", ["canvas-wrap"]), el("div", ["react-flow"]),
    el("div", ["fm"], { attrs: { "data-place": place } }),
    el("div", ["fm-walker"], { attrs: { "data-place": place } }),
    el("button", ["fm-sprite"], { states: ["focus-visible"] }),
  ];
}
/** Inside the button: FmSprite's svg and the body group. */
const body = (chain: El[]) => [...chain, el("svg"), el("g", ["fm-body"])];

/** A declared value on `chain`'s last element, or null. */
const own = (chain: El[], prop: string) => cascade(s => selects(s, chain), prop, WIDTH);

/** A custom property as the last element of `chain` sees it: its own, or the
 *  nearest ancestor's — they inherit — with its var()s resolved where it was
 *  declared, as a browser computes them. */
function custom(chain: El[], name: string): string | null {
  for (let j = chain.length; j > 0; j--) {
    const v = own(chain.slice(0, j), name);
    if (v != null) return vars(v, chain.slice(0, j));
  }
  return null;
}

/** `value` with every `var(--x, fallback)` in it substituted on `chain`. */
function vars(value: string, chain: El[]): string {
  const at = value.indexOf("var(");
  if (at < 0) return value;
  let depth = 0, end = at + 3;
  for (; end < value.length; end++) {
    if (value[end] === "(") depth++;
    else if (value[end] === ")" && --depth === 0) break;
  }
  const [name, ...fallback] = splitTop(value.slice(at + 4, end));
  const got = custom(chain, name) ?? (fallback.length ? vars(fallback.join(","), chain) : null);
  if (got == null) throw new Error(`${name} is not defined on ${chain.at(-1)!.classes.join(".")}`);
  return vars(value.slice(0, at) + got + value.slice(end + 1), chain);
}

type Rgb = [number, number, number];

/** #rgb / #rrggbb and `color-mix(in srgb, …)`: what these tokens are written in. */
function colour(v: string): Rgb {
  const s = v.trim();
  const mix = /^color-mix\(in srgb,\s*(.*)\)$/.exec(s);
  if (mix) {
    const [a, b] = splitTop(mix[1]).map(part => {
      const m = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(part)!;
      return { c: colour(m[1]), p: m[2] == null ? null : +m[2] / 100 };
    });
    const pa = a.p ?? (b.p == null ? 0.5 : 1 - b.p);
    return a.c.map((x, i) => x * pa + b.c[i] * (1 - pa)) as Rgb;
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!hex) throw new Error(`unread colour: ${v}`);
  const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

function contrast(a: Rgb, b: Rgb): number {
  const lum = (c: Rgb) => {
    const [r, g, bl] = c.map(x => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The ring's colour on the focused button: the longhand, else the shorthand's. */
function ringColour(chain: El[]): Rgb {
  const longhand = own(chain, "outline-color");
  const shorthand = own(chain, "outline");
  const c = longhand ?? splitTop(shorthand ?? "", " ").filter(t => !/^(-?[\d.]+px|solid|dashed|dotted|double|auto)$/.test(t)).join(" ");
  return colour(vars(c, chain));
}

describe("the Claude FM character's focus ring in the light theme (#1793)", () => {
  const root = [html("light")];
  const surfaces: Record<string, Rgb> = {
    "the canvas": colour(custom(root, "--bg")!),
    "the minimap": colour(custom(root, "--chrome-bg")!),
  };

  for (const place of ["ledge", "floor"] as const) {
    for (const [name, surface] of Object.entries(surfaces)) {
      it(`clears ${NON_TEXT}:1 against ${name}, standing on the ${place}`, () => {
        const r = contrast(ringColour(sprite("light", place)), surface);
        expect(r, `${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(NON_TEXT);
      });
    }
  }

  it("is the theme's own accent, the ring every other light control draws", () => {
    expect(ringColour(sprite("light", "floor"))).toEqual(colour(custom(root, "--accent")!));
  });

  it("leaves the body its sky blue", () => {
    // The override was there for the silhouette, and the silhouette keeps it.
    const fill = vars(own(body(sprite("light", "floor")), "fill")!, body(sprite("light", "floor")));
    expect(colour(fill)).toEqual(colour(custom(root, "--pixel-character-body")!));
  });

  it("changes nothing in the dark theme, where ring and body are both the accent", () => {
    const dark = sprite("dark", "floor");
    expect(ringColour(dark)).toEqual(colour(custom([html("dark")], "--accent")!));
    expect(colour(vars(own(body(dark), "fill")!, body(dark)))).toEqual(colour(custom([html("dark")], "--accent")!));
  });
});
