// #330: eight colours in this app were built in JS at a lightness hard-coded
// for the dark canvas, and they were the only ones that could not answer to
// data-theme. The hue is a hash of a session id or an MCP server name, so JS
// has to supply it; the lightness is a property of the surface underneath,
// which only the cascade knows. One number decided both, and on white the
// result was the worst reading in the app — `.cluster-label` at 1.21:1 swept
// across all 360 hues, against a 4.5:1 floor.
//
// The fix moves the composition across that boundary: JS emits --session-hue /
// --mcp-hue and styles.css builds the colour from a per-job lightness tier.
// Which means the whole thing is now arithmetic over token values, and this
// file is where it is checked — every hue 0..359, every tier, both themes, no
// DOM, exactly like contrast-floors.test.ts and manage-block.test.ts before it.
//
// CHANGED ON PURPOSE (V4 top-10 #1): six of the seven sites this file swept
// were a SESSION's hue — the cluster label and its rim, the box's rim and its
// 4% wash, the card's accent, and the live and settled edges — and all of them
// are gone. A hash of an id is not a meaning, and on the board colour means
// state only: the label is --muted text, the box a 3% wash of --text with no
// rim, the card reads the deck's --accent, and an edge is --inflight while the
// session works and --muted once it has settled. Their five lightness tiers
// left the theme catalog with them. What is left of #330 is the MCP server's
// hue (the burst stripe and the category chip), still composed from a
// per-theme tier and still swept here exactly as before; the session half now
// asserts the opposite of what it did — nothing composes a session's hue.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gradientStops } from "./gradient-stops";
import { mouseFlat, sheetText } from "./sheet-source";

const web = fileURLToPath(new URL("..", import.meta.url));
const css = sheetText();
const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const COMPONENTS: Record<string, string> = {
  "App.tsx": src("../App.tsx"),
  // The detail panel, out of App.tsx — its MCP category chip hands a hue across.
  "Detail.tsx": src("../components/Detail.tsx"),
  // The canvas's nodes and edges, out of App.tsx since #1175 — the two sites
  // that used to hand a session's hue across the boundary moved with them.
  "canvas-flow.ts": src("../canvas-flow.ts"),
  "SessionClusters.tsx": src("../components/SessionClusters.tsx"),
  // The cluster box's and label's inline styles, out of SessionClusters.tsx's
  // render — where the hue used to cross the boundary for them.
  "cluster-bounds.ts": src("../cluster-bounds.ts"),
  "AgentNode.tsx": src("../components/AgentNode.tsx"),
  "ToolBursts.tsx": src("../components/ToolBursts.tsx"),
};

/** Every module under src/web, tests excluded — the same walk
 *  control-edges.test.ts does, for the same reason: a hand-kept list of four
 *  files is a list the fifth file is not on. */
function modulesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : modulesUnder(path);
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}

/** A path from the walk, relative to src/web and with forward slashes. join()
 *  spells `components/Detail.tsx` with a backslash on Windows, so every name
 *  this file compares a path against goes through here first. */
const rel = (path: string) => path.slice(web.length).replace(/\\/g, "/");

/** Whether the walk reached the module `name` — by its name or by its path
 *  under src/web, matched on whole path segments the way landmark-outline.test.ts
 *  matches them (#1556), so `Detail.tsx` is not also `ToolDetail.tsx`. */
const walked = (files: string[], name: string) =>
  files.some(p => rel(p) === name || rel(p).endsWith(`/${name}`));

/** WCAG 1.4.3 for the words, 1.4.11 for a graphic that carries meaning. */
const BODY = 4.5;
const NON_TEXT = 3;

type Rgba = [number, number, number, number];

function parseColor(input: string): Rgba {
  const s = input.trim();
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) return [+fn[1], +fn[2], +fn[3], fn[4] === undefined ? 1 : +fn[4]];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!hex) throw new Error(`unparseable colour: ${input}`);
  const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}

/** CSS Color 4's hsl-to-rgb, which is what the browser runs on these values. */
function hsl(h: number, s: number, l: number, a = 1): Rgba {
  const sat = s / 100, lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const c = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - c * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [255 * f(0), 255 * f(8), 255 * f(4), a];
}

/** Source-over compositing onto an already-opaque backdrop. */
function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)).concat(1) as Rgba;
}

function relativeLuminance(c: Rgba): number {
  const [r, g, b] = [c[0], c[1], c[2]].map(v => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** CIE76 ΔE, for the one question contrast cannot answer: whether two MCP
 *  servers whose hues landed near each other are still telling themselves
 *  apart. */
function lab(c: Rgba): [number, number, number] {
  const lin = (v: number) => { const n = v / 255; return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); };
  const [r, g, b] = [c[0], c[1], c[2]].map(lin);
  const f = (v: number) => (v > 216 / 24389 ? Math.cbrt(v) : (841 / 108) * v + 4 / 29);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a: Rgba, b: Rgba) => {
  const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

// ── the stylesheet, as rules and tokens ─────────────────────────────────────

const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The `{…}` opened at `open`, and the index of its closing brace. */
function block(s: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return [s.slice(open + 1, i), i];
  }
  throw new Error("unbalanced braces in styles.css");
}

/** Top-level rules only — a @media body is a different cascade. */
function topLevel(s: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("{", i);
    if (open < 0) break;
    const prelude = s.slice(i, open).replace(/\s+/g, " ").trim();
    const [inner, end] = block(s, open);
    if (!prelude.startsWith("@")) out.push({ selector: prelude, body: inner });
    i = end + 1;
  }
  return out;
}

// The mouse query's rules are read where they stand: a desktop pointer meets them at the top level.
const RULES = topLevel(mouseFlat(bare));
const selectors = (list: string) => list.split(",").map(s => s.replace(/\s+/g, " ").trim());

/** The balanced contents of every `hsl(…)` in `body`. Parens are counted rather
 *  than matched with `[^)]*`, which stops inside the nested `var(--x, 200)`
 *  every one of these calls opens with. */
function hslCalls(body: string): string[] {
  const out: string[] = [];
  for (const head of [...body.matchAll(/hsl\(/g)]) {
    const open = head.index + head[0].length - 1;
    let depth = 0;
    for (let i = open; i < body.length; i++) {
      if (body[i] === "(") depth++;
      else if (body[i] === ")" && --depth === 0) { out.push(body.slice(open + 1, i)); break; }
    }
  }
  return out;
}

/** One `hsl(var(--*-hue …) S% L …)` the sheet writes, split into the parts
 *  #330 cares about: which rule it is in, and what it put in the LIGHTNESS
 *  slot. That slot is the whole issue — a literal there is a colour composed
 *  for one canvas, which is the defect, and a `var(--*-l)` is a colour the
 *  cascade can answer for. */
interface HueSite {
  selector: string;
  call: string;
  lightness: string;
}

const HUE_SITES: HueSite[] = RULES.flatMap(rule =>
  hslCalls(rule.body)
    .filter(call => /^\s*var\(\s*--(?:session|mcp)-hue\b/.test(call))
    .map(call => {
      // Drop the leading balanced var(--*-hue, …), then the alpha after `/`,
      // and what is left is `S% L` — two components, lightness last.
      const after = call.slice(call.indexOf(")") + 1).split("/")[0];
      const parts = after.trim().split(/\s+/);
      return { selector: rule.selector, call, lightness: parts[parts.length - 1] };
    }));

function bodyOf(selector: string): string {
  const hit = RULES.filter(r => selectors(r.selector).includes(selector));
  if (!hit.length) throw new Error(`no rule for ${selector}`);
  return hit.map(r => r.body).join(";");
}

/** The last declaration of `prop` in that rule, which is the one that wins. */
function decl(selector: string, prop: string): string | null {
  const all = [...bodyOf(selector).matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`, "g"))];
  return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
}

const themes = ["dark", "light"] as const;
type Theme = (typeof themes)[number];

function rootTokens(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  const head = theme === "dark" ? ":root" : ':root[data-theme="light"]';
  for (const [, name, value] of bodyOf(head).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}
const TOK: Record<Theme, Record<string, string>> = { dark: rootTokens("dark"), light: rootTokens("light") };

function lightnessOf(theme: Theme, token: string): number {
  const raw = TOK[theme][token];
  if (raw === undefined) throw new Error(`${theme} declares no ${token} — #330's tiers are how these colours reach the theme`);
  const pct = /^([\d.]+)%$/.exec(raw);
  if (!pct) throw new Error(`${token} is "${raw}", which is not a lightness`);
  return +pct[1];
}

/** Every opaque surface in a theme, by the name the sheet gives it. The node
 *  gradient's two stops are separate beds: a node's top and bottom differ.
 *
 *  The stops come from `./gradient-stops` since #665. They used to come from a
 *  private regex ending in `?? []`, and this file is where that ending did its
 *  particular damage: the beds are looked up BY NAME below, so an empty read did
 *  not shorten a list, it left `beds["--node-grad stop 0"]` undefined — and four
 *  cases died inside `over()` with `Cannot read properties of undefined`, a
 *  crash that names neither the token that could not be read nor the notation
 *  that defeated the reader. Not vacuous, but no more use to whoever has to
 *  debug it. The reader now fails first, quoting the value. */
function surfaces(theme: Theme): Record<string, Rgba> {
  const out: Record<string, Rgba> = {};
  for (const t of ["--panel", "--bg-soft", "--bg"]) out[t] = parseColor(TOK[theme][t]);
  gradientStops("--node-grad", theme, TOK[theme]).forEach((s, i) => {
    const ref = /^var\((--[\w-]+)\)$/.exec(s);
    out[`--node-grad stop ${i}`] = parseColor(ref ? TOK[theme][ref[1]] : s);
  });
  return out;
}

/** The names `surfaces` answers to. Stated once so a sweep can floor itself
 *  against the whole set rather than counting a Record it looks up by name. */
const BEDS = ["--panel", "--bg-soft", "--bg", "--node-grad stop 0", "--node-grad stop 1"];

// ── the colours a hue still composes, as the sheet writes them ──────────────

/** One generated colour: the constant half (saturation, alpha) that says what
 *  the thing IS, and the token that says how bright it has to be to survive
 *  the canvas it lands on. `beds` is every opaque surface it can be read
 *  against. */
interface Site {
  name: string;
  where: string;
  s: number;
  token: string;
  alpha: number;
  role: "text" | "graphic" | "decoration";
  beds: string[];
  /** How JS used to write it, for the before/after in the report. */
  was: number;
}

// CHANGED ON PURPOSE (V4 top-10 #1): this list held the six session sites as
// well — cluster label, node accent, live edge, settled edge, label rim and
// card rim. They left the sheet with the session hue; the MCP stripe is the
// one #330 site that still composes a hue.
const SITES: Site[] = [
  // #330's eighth site was the topbar's MCP legend dot, on --panel / --bg-soft /
  // --bg. The legend has been removed from the strip, and with it the only place
  // an --mcp-dot-l hue was ever painted outside the detail panel — so the tier
  // keeps its reader (this stripe, and the MCP category chip that composes the
  // same expression at 0.40) and loses two beds it no longer lands on. Its dark
  // ratio was --panel's, which is the bed the stripe already names, so the
  // number below did not move when the site did.
  { name: "mcp burst stripe", where: ".tool-burst.cat-mcp.mcp-hue", s: 65, token: "--mcp-dot-l", alpha: 1,
    role: "graphic", beds: ["--panel"], was: 65 },
];

/** The session's five lightness tiers, which went with the colours they lit. */
const SESSION_TIERS = ["--session-label-l", "--session-accent-l", "--session-rim-l", "--session-edge-l", "--session-edge-idle-l"];

const FLOOR = { text: BODY, graphic: NON_TEXT, decoration: 0 } as const;

/** The worst of all 360 hues on one bed. Every one of these colours is a hash
 *  away from any hue, so the sweep is the only honest measurement. */
function worstHue(s: number, l: number, alpha: number, bed: Rgba): { ratio: number; hue: number } {
  let ratio = Infinity, hue = -1;
  for (let h = 0; h < 360; h++) {
    const r = contrastRatio(over(hsl(h, s, l, alpha), bed), bed);
    if (r < ratio) { ratio = r; hue = h; }
  }
  return { ratio, hue };
}

/** …across every bed the thing can land on.
 *
 *  The lookup is guarded rather than trusted, which is the floor for every sweep
 *  in this file (#665). `gradientStops` already refuses a --node-grad it cannot
 *  read, so this is the second line: it is what still fails, by name, if that
 *  reader is ever softened back to a `?? []`, or if a site names a bed the sheet
 *  stopped painting. An unguarded `beds[name]` is how a missing bed used to
 *  reach `over()` as `undefined`. */
function worst(site: Site, l: number, theme: Theme): { ratio: number; hue: number; bed: string } {
  const beds = surfaces(theme);
  let out = { ratio: Infinity, hue: -1, bed: "" };
  for (const name of site.beds) {
    const bed = beds[name];
    expect(bed, `${theme} has no surface called ${name}, so ${site.name} would be measured against nothing`)
      .toBeDefined();
    const w = worstHue(site.s, l, site.alpha, bed);
    if (w.ratio < out.ratio) out = { ...w, bed: name };
  }
  return out;
}

// ── the maths, against ends everybody already knows ─────────────────────────

describe("the contrast and colour maths", () => {
  it("puts white on black at 21:1 and a colour on itself at 1:1", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#0b0c10"), parseColor("#0b0c10"))).toBeCloseTo(1, 5);
  });

  it("agrees with the known AA boundary grey — #767676 on white is 4.54:1", () => {
    expect(contrastRatio(parseColor("#767676"), parseColor("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  it("converts hsl the way the spec does, at the corners and at a mid hue", () => {
    expect(hsl(0, 0, 100).slice(0, 3)).toEqual([255, 255, 255]);
    expect(hsl(0, 0, 0).slice(0, 3)).toEqual([0, 0, 0]);
    expect(hsl(0, 100, 50).slice(0, 3)).toEqual([255, 0, 0]);
    expect(hsl(120, 100, 50).slice(0, 3)).toEqual([0, 255, 0]);
    expect(hsl(240, 100, 50).slice(0, 3)).toEqual([0, 0, 255]);
    // 50% grey has no hue to lose, so every hue lands on the same bytes.
    for (const h of [0, 97, 359]) expect(hsl(h, 0, 50)[0]).toBeCloseTo(127.5, 6);
  });

  it("scores ΔE at zero for a colour against itself and above it for a hue step", () => {
    expect(deltaE(hsl(200, 70, 50), hsl(200, 70, 50))).toBeCloseTo(0, 9);
    expect(deltaE(hsl(200, 70, 50), hsl(230, 70, 50))).toBeGreaterThan(5);
  });

  it("reproduces the readings #330 reported, so the tiers below have a baseline", () => {
    // The audit measured in Chrome on a live deck. These are the same numbers
    // from the same values, which is what makes the sweep trustworthy.
    const white = parseColor("#ffffff");
    const darkPanel = parseColor("#14161b");
    expect(worstHue(70, 78, 1, white).ratio).toBeCloseTo(1.21, 2);   // cluster label
    expect(worstHue(70, 78, 1, darkPanel).ratio).toBeCloseTo(7.52, 2);
    expect(worstHue(70, 60, 1, white).ratio).toBeCloseTo(1.40, 2);   // node accent
    expect(worstHue(70, 60, 1, darkPanel).ratio).toBeCloseTo(3.13, 2);
    expect(worstHue(65, 65, 1, white).ratio).toBeCloseTo(1.40, 2);   // dot / --cat-accent
    expect(worstHue(65, 65, 1, darkPanel).ratio).toBeCloseTo(4.17, 2);
    // And the three rendered samples the report tabulated, exactly.
    expect(contrastRatio(parseColor("#a0d9ee"), white)).toBeCloseTo(1.54, 2);
    expect(contrastRatio(parseColor("#eec6a0"), white)).toBeCloseTo(1.59, 2);
    expect(contrastRatio(parseColor("#52bae0"), parseColor("#eef1f6"))).toBeCloseTo(1.96, 2);
  });
});

// ── the tiers themselves ────────────────────────────────────────────────────

describe("every generated colour clears its floor in light, for every hue", () => {
  it("reads the words at 4.5:1 and draws the graphics at 3:1, worst hue, worst bed", () => {
    // The floor, outside the quantification it is the floor for: the beds these
    // sites are measured against, by name, in both themes. Two of the five come
    // out of --node-grad, and a respelling of it used to take both away.
    for (const theme of themes) {
      expect(Object.keys(surfaces(theme)), `${theme}: the beds every site is measured against`).toEqual(BEDS);
    }
    for (const site of SITES) {
      if (site.role === "decoration") continue;
      const l = lightnessOf("light", site.token);
      const w = worst(site, l, "light");
      expect(w.ratio, `${site.name} @${l}% worst on ${w.bed} at h=${w.hue}`)
        .toBeGreaterThanOrEqual(FLOOR[site.role]);
    }
  });

  it("holds against --panel and --bg specifically, which is where the audit looked", () => {
    const beds = surfaces("light");
    for (const site of SITES) {
      if (site.role === "decoration") continue;
      const l = lightnessOf("light", site.token);
      for (const bed of ["--panel", "--bg"]) {
        expect(worstHue(site.s, l, site.alpha, beds[bed]).ratio, `${site.name} on light ${bed}`)
          .toBeGreaterThanOrEqual(FLOOR[site.role]);
      }
    }
  });

  it("is the fix and not a rounding — every one of them failed before", () => {
    // The same sweep against the lightness JS used to hard-code. Six of the
    // eight #330 measured sat between 1.05:1 and 1.82:1 on this canvas; none
    // reached its floor. The MCP stripe is the one of them still painted.
    for (const site of SITES) {
      const w = worst(site, site.was, "light");
      expect(w.ratio, `${site.name} at the old ${site.was}%`).toBeLessThan(NON_TEXT);
    }
  });
});

describe("the dark theme did not move", () => {
  it("keeps the exact lightness every one of these had before #330", () => {
    // The issue fixes light and pins dark. A tier that drifts here redraws the
    // canvas the app is used on, which is a regression however good the number.
    for (const site of SITES) {
      expect(lightnessOf("dark", site.token), `dark ${site.token}`).toBe(site.was);
    }
  });

  it("keeps the ratios that came with them, to the second decimal", () => {
    // CHANGED ON PURPOSE (V4 top-10 #1): the six session pins (label 7.52,
    // accent 3.13, live edge 5.74, settled edge 3.18, rims 1.51 and 1.25) went
    // with the tiers they measured. 4.17 is the reading the retired legend dot
    // carried too — its worst bed was --panel, which is this stripe's only one —
    // so removing that site left the tier's pinned dark number where it was.
    const l = (t: string) => lightnessOf("dark", t);
    expect(worst(SITES[0], l("--mcp-dot-l"), "dark").ratio).toBeCloseTo(4.17, 2);
  });

  it("closes the one dark shortfall #330 named, because the card has no hue of its own", () => {
    // CHANGED ON PURPOSE (V4 top-10 #1): this pinned the node accent,
    // hsl(h 70% 60%), at 3.13:1 on dark --panel — thin for the TEXT it painted
    // (.tokens-meta, .spawn-badge) and left standing because #330 forbade
    // editing dark. The card no longer composes an accent at all: it reads the
    // deck's --accent, a fixed colour that clears 4.5:1 on --panel in both
    // themes, so the shortfall is gone rather than pinned.
    expect(decl(".agent-node", "--accent"), ".agent-node composes no accent of its own").toBeNull();
    for (const theme of themes) {
      expect(TOK[theme]["--session-accent-l"], `${theme} still declares the card's tier`).toBeUndefined();
      const r = contrastRatio(parseColor(TOK[theme]["--accent"]), surfaces(theme)["--panel"]);
      expect(r, `${theme} --accent on --panel`).toBeGreaterThanOrEqual(BODY);
    }
  });
});

// CHANGED ON PURPOSE (V4 top-10 #1): this block proved the two cluster rims
// (the label's at 50%, the box's at 32%) could only ever be decoration, and that
// the box's 4% hue wash was 1.01:1 on either canvas. The rims are gone and the
// wash is the reading ink's, so what it checks now is that the session's box
// and label are quiet and neutral, and that the label still reads.
describe("a session's box and label carry no hue", () => {
  /** The box's wash over the canvas: the bed the label is read on. */
  const washed = (theme: Theme) => over([...parseColor(TOK[theme]["--text"]).slice(0, 3), 0.03] as Rgba, surfaces(theme)["--bg"]);

  it("draws the box as a 3% wash of the reading ink with no rim, barely off the canvas", () => {
    expect(decl(".cluster-card", "background")).toBe("color-mix(in srgb, var(--text) 3%, transparent)");
    expect(decl(".cluster-card", "border"), "the box draws no frame").toBeNull();
    expect(decl(".cluster-card", "border-color"), "the box draws no frame").toBeNull();
    // Measured: 1.05:1 in dark and 1.06:1 in light — a group, not an edge.
    for (const theme of themes) {
      expect(contrastRatio(washed(theme), surfaces(theme)["--bg"]), `${theme} wash`).toBeLessThan(1.1);
    }
  });

  it("writes the label in --muted, --text under the pointer and --warn while it waits, each at 4.5:1 on that wash", () => {
    expect(decl(".cluster-label", "color")).toBe("var(--muted)");
    expect(decl(".cluster-label", "border")).toBe("0");
    expect(decl(".cluster-label", "background")).toBe("transparent");
    expect(decl(".cluster-label:hover", "color")).toBe("var(--text)");
    expect(decl(".cluster-label[data-alarm]", "color")).toBe("var(--warn)");
    // Measured on the wash: --muted 4.86 dark / 6.55 light, --text 13.37 /
    // 15.73, --warn 12.96 / 4.66.
    for (const theme of themes) {
      for (const ink of ["--muted", "--text", "--warn"]) {
        const r = contrastRatio(parseColor(TOK[theme][ink]), washed(theme));
        expect(r, `${theme} ${ink} on the box's wash — ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(BODY);
      }
    }
  });

  it("leaves none of the session's tiers in either theme", () => {
    for (const theme of themes) {
      for (const tier of SESSION_TIERS) expect(TOK[theme][tier], `${theme} ${tier}`).toBeUndefined();
    }
    expect(bare, "the sheet still reads a session's hue").not.toMatch(/--session-hue/);
  });
});

// CHANGED ON PURPOSE (V4 top-10 #1): this asked the same of the session label,
// node accent and both edges; the MCP stripe is the one hue left to separate.
describe("the hue still tells two MCP servers apart, which is what it is for", () => {
  it("keeps a full step of colour between hues 30° apart, in both themes", () => {
    // Contrast is against the paper; this is against each other. A tier dark
    // enough to read can still be dark enough to collapse, and that would
    // trade one defect for another.
    for (const site of SITES.filter(s => s.role !== "decoration")) {
      for (const theme of themes) {
        const l = lightnessOf(theme, site.token);
        let min = Infinity;
        for (let h = 0; h < 360; h++) min = Math.min(min, deltaE(hsl(h, site.s, l), hsl((h + 30) % 360, site.s, l)));
        expect(min, `${theme} ${site.name} ΔE at 30°`).toBeGreaterThan(6);
      }
    }
  });

  it("keeps more than half of what dark separates, having paid for the contrast", () => {
    // Some is spent and that is honest: a mid-dark tier has less room to swing
    // than a pale one. Measured ΔE at 30°, dark → light: dot 14.49 → 10.68. The
    // floor is what stops a future tier from buying its ratio by walking every
    // hue toward the same near-black.
    for (const site of SITES.filter(s => s.role !== "decoration")) {
      const sep = (theme: Theme) => {
        const l = lightnessOf(theme, site.token);
        let min = Infinity;
        for (let h = 0; h < 360; h++) min = Math.min(min, deltaE(hsl(h, site.s, l), hsl((h + 30) % 360, site.s, l)));
        return min;
      };
      expect(sep("light") / sep("dark"), `${site.name}`).toBeGreaterThan(0.5);
    }
  });
});

// ── the boundary itself ─────────────────────────────────────────────────────

describe("the colour is composed on the CSS side of the theme boundary", () => {
  it("leaves no module under src/web building a colour at all", () => {
    // The defect was never a wrong number, it was a number in the wrong file.
    // Nothing under src/web composes hsl() any more; the components emit a hue
    // and the sheet does the rest, which is the only reason data-theme reaches
    // any of these at all.
    //
    // #378: this ran over the four files in COMPONENTS, which is the four that
    // had the defect — the other twelve .tsx and every .ts beside them could
    // compose colours freely. Measured: a template literal building
    // `hsl(200 70% 62%)` inside SessionList.tsx passed every test in the repo.
    // The tree is walked now, the way control-edges.test.ts walks it, so a file
    // that does not exist yet is covered by the same line.
    const files = modulesUnder(web);
    expect(files.length, "the walk found nothing — src/web moved").toBeGreaterThan(12);
    for (const path of files) {
      expect(readFileSync(path, "utf8"), `${rel(path)} composes a colour`)
        .not.toMatch(/hsl\(/);
    }
    // The four the audit named are still among them, so the walk cannot quietly
    // stop reaching the files this rule was written about.
    for (const name of Object.keys(COMPONENTS)) {
      expect(walked(files, name), `${name} is no longer in the walk`).toBe(true);
    }
  });

  it("hands the MCP sites their hue as a custom property, and the board none", () => {
    // CHANGED ON PURPOSE (V4 top-10 #1): cluster-bounds.ts, AgentNode.tsx and
    // canvas-flow.ts each wrote `"--session-hue": hue` here. The board draws no
    // session colour now, so no module under src/web writes one at all.
    for (const name of ["cluster-bounds.ts", "AgentNode.tsx", "canvas-flow.ts", "SessionClusters.tsx"]) {
      expect(COMPONENTS[name], `${name} hands a session hue across`).not.toMatch(/--session-hue/);
    }
    const files = modulesUnder(web);
    const writers = files.filter(p => /--session-hue/.test(readFileSync(p, "utf8"))).map(rel);
    expect(writers, "modules that still write a session's hue").toEqual([]);
    // App's --mcp-hue was the topbar legend's dot until that row was removed;
    // the MCP category chip hands its hue across the same boundary the same
    // way, so the rule this line states is unchanged and still has a subject.
    expect(COMPONENTS["Detail.tsx"]).toMatch(/"--mcp-hue": hue/);
    expect(COMPONENTS["ToolBursts.tsx"]).toMatch(/"--mcp-hue": b\.mcpHue/);
  });

  it("builds every one of them from a tier the sheet declares for both themes", () => {
    // The declaration has to name a var() for the lightness: an hsl() with a
    // literal there is the original bug wearing a stylesheet.
    const spec = (value: string) =>
      /hsl\(\s*var\(\s*--(?:session|mcp)-hue[^)]*\)\s+(\d+)%\s+var\(\s*(--[\w-]+)\s*\)\s*(?:\/\s*([\d.]+)\s*)?\)/.exec(value);
    const found = new Map<string, ReturnType<typeof spec>>();
    // CHANGED ON PURPOSE (V4 top-10 #1): the pairing list named the six session
    // sites too (color, --accent, two strokes, two borders); one site is left.
    for (const [prop, site] of [
      ["--cat-accent", SITES[0]],
    ] as Array<[string, Site]>) {
      const value = decl(site.where, prop);
      expect(value, `${site.where} { ${prop} }`).toBeTruthy();
      const m = spec(value!);
      expect(m, `${site.name}: ${value}`).toBeTruthy();
      expect(+m![1], `${site.name} saturation`).toBe(site.s);
      expect(m![2], `${site.name} tier`).toBe(site.token);
      expect(m![3] === undefined ? 1 : +m![3], `${site.name} alpha`).toBe(site.alpha);
      found.set(site.name, m);
    }
    // Not "seven were checked" — the loop above ran once per pair by
    // construction, so this only ever said that no two SITES share a name. It
    // does catch a SITES that has grown or shrunk without the pairing list
    // following it, which is how the retired legend dot was kept honest.
    // What proves the sheet holds no second hue is the sweep in the next case.
    expect(found.size, "two SITES share a name, so one of them was never checked").toBe(SITES.length);
    for (const theme of themes) {
      for (const site of SITES) expect(() => lightnessOf(theme, site.token), `${theme} ${site.token}`).not.toThrow();
    }
  });

  it("puts a tier in the lightness slot of every hue the SHEET composes, not just the ones named here", () => {
    // #378. `SITES` is hand-written and the check above walks it, so the sheet
    // was only ever asked about colours somebody had already remembered to
    // list. Measured: adding `.sl-waiting-count { border-color: hsl(var(
    // --session-hue, 200) 70% 62%); }` — a hard-coded lightness, which is the
    // literal defect #330 exists to remove — left all 1849 tests green.
    //
    // So the enumeration runs the other way now: every hue-composed colour in
    // the stylesheet has to put a `var(--…-l)` in its lightness slot, and a new
    // one arrives already covered rather than arriving unnoticed.
    //
    // CHANGED ON PURPOSE (V4 top-10 #1): `.cluster-card`'s 4% hue wash was the
    // one exemption, a literal lightness at 1.01:1. The box washes with --text
    // now, so no rule is allowed a literal — and none composes a session hue.
    const TIER = /^var\(\s*--[\w-]+-l\s*\)$/;
    expect(HUE_SITES.length, "the sweep found no hue-composed colours at all — the walk is broken")
      .toBeGreaterThanOrEqual(SITES.length);

    const literals = HUE_SITES.filter(site => !TIER.test(site.lightness));
    expect(literals.map(s => s.selector), "rules that write a literal lightness").toEqual([]);
    expect(HUE_SITES.filter(site => /--session-hue/.test(site.call)).map(s => s.selector),
      "rules that still compose a session's hue").toEqual([]);

    // …and every tier it names is declared in both themes, which is what makes
    // the cascade able to answer at all.
    for (const site of HUE_SITES) {
      const token = /^var\(\s*(--[\w-]+)\s*\)$/.exec(site.lightness)?.[1];
      if (!token) continue;
      for (const theme of themes) {
        expect(() => lightnessOf(theme, token), `${theme} declares no ${token}`).not.toThrow();
      }
    }
  });

  it("gives every hsl() in the sheet a fallback hue, so a missing one is not a dropped rule", () => {
    // A var() with no value makes the whole declaration invalid at computed-
    // value time and the property silently falls back to inherit/initial — a
    // chip with no border rather than a visible mistake.
    const composed = [...bare.matchAll(/hsl\(\s*var\(\s*(--(?:session|mcp)-hue[^)]*)\)/g)];
    // The floor, outside the sweep, the way every other enumeration in this file
    // already has one (#652) — `files.length` above, `found.size`, and
    // `HUE_SITES.length` in the case before this. This was the sweep that was
    // not given one, and a regex that matches nothing runs its body zero times
    // and reports green. Measured: spelling the custom property `--sessionHue`
    // took the match count from nine to two without this case noticing, and
    // renaming the mcp half as well would have taken it to zero. HUE_SITES is
    // the same population read through the rule parser rather than through a
    // regex on the raw sheet. The floor counts against SITES, which is written
    // out longhand in this file — HUE_SITES would be the closer population but
    // it is found by the same property name this sweep is, so the two empty
    // together and a floor drawn from it would agree that zero is enough.
    expect(composed.length, "no hsl(var(--mcp-hue …)) left in the sheet for this case to check — the hue custom properties were renamed out from under it")
      .toBeGreaterThanOrEqual(SITES.length);
    for (const [, value] of composed) {
      expect(value, `hsl(var(${value}))`).toMatch(/,\s*\d+\s*$/);
    }
  });

  it("outranks the two rules an inline stroke used to shadow", () => {
    // .react-flow__edge.animated and the light-theme .react-flow__edge-path
    // both set stroke at 0-3-0. The inline style App used to write beat them
    // by being inline; the replacement has to beat them on specificity, which
    // is why both edge classes are in the selector.
    //
    // CHANGED ON PURPOSE (V4 top-10 #1): the two selectors stroked the session's
    // hue; they stroke its state now — --inflight while it works, --muted once
    // it has settled — and still need the specificity to win.
    const LIVE = ".react-flow__edge.sess-edge.sess-live .react-flow__edge-path";
    const IDLE = ".react-flow__edge.sess-edge.sess-idle .react-flow__edge-path";
    for (const where of [LIVE, IDLE]) {
      expect(where.split(".").length - 1, where).toBeGreaterThanOrEqual(4);
    }
    expect(decl(LIVE, "stroke")).toBe("var(--inflight)");
    expect(decl(IDLE, "stroke")).toBe("var(--muted)");
    expect(COMPONENTS["canvas-flow.ts"]).toMatch(/a\.state === "active" \? "sess-live" : "sess-idle"/);
    expect(decl(".react-flow__edge.animated .react-flow__edge-path", "stroke")).toBe("var(--inflight)");
  });
});

// CHANGED ON PURPOSE (V4 top-10 #1): this block checked that the hovered
// pill's brightness() filter brightened in dark and deepened in light, so a
// hued label never fell under 4.5:1. The label is plain text now and its hover
// is a step to --text with an underline, the same in both themes; the 4.5:1 of
// that ink is measured in "a session's box and label carry no hue" above.
describe("hover is a colour step, not a filter", () => {
  it("puts no filter on the hovered label, and no light-theme twin beside it", () => {
    expect(decl(".cluster-label:hover", "filter")).toBeNull();
    expect(decl(".cluster-label:hover", "text-decoration")).toBe("underline");
    const twin = ':root[data-color-scheme="light"] .cluster-label:hover';
    expect(RULES.some(r => selectors(r.selector).includes(twin)), twin).toBe(false);
  });
});
