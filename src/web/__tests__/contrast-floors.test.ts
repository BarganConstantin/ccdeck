// Three colour tokens were doing jobs they were never bright (or dark) enough
// for, and nothing in the suite noticed because there is no DOM here to sample.
//   #262 --muted-dim is a decorative tint — 2.35:1 on --panel dark, 3.32-3.76:1
//        light — and seventeen rules were setting it as `color:` on 8-13px
//        annotation text: axis dates, the plan badge, quota reset times, the
//        add-account placeholder. Under 4.5:1 in both themes, under 3:1 in dark.
//   #268 the light-theme node rings reused the dark rules' alphas over a white
//        node and composited to 2.26:1 (done) and 3.12:1 (err) against the node
//        interior, below the 3:1 that a non-text boundary needs; and the light
//        done pill's own text sat at 4.39:1, just under AA.
//   #272 .ver-banner painted a 13% --warn wash and then wrote on it in --warn:
//        3.74:1 light over the tinted end. Its .done twin did the same with --ok.
//   #619 the stacked cost bar's four segments, and the four legend swatches that
//        key them, were fixed-lightness hsl() literals with no light override:
//        2.74, 2.86, 1.82 and 1.86 against white, and 1.02:1 from each other at
//        the cache end, so the tail of the bar composited into one flat area.
//        The 1px gap between them showed --line, 1.14:1 from what it separated.
//   #622 .cat-filter-bar.occluded put `opacity: 0.2` on the whole bar, which
//        makes a stacking context and takes the chips' 11px labels with the
//        fill: 1.55:1 light and 1.67:1 dark on, 1.37:1 and 1.29:1 off.
// So the ratios are computed here from the stylesheet's own token values, and a
// palette edit that walks any of them back under its floor fails the build.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gradientStops as readStops } from "./gradient-stops";
import { sheetText } from "./sheet-source";

const css = sheetText();
const agentNode = readFileSync(fileURLToPath(new URL("../components/AgentNode.tsx", import.meta.url)), "utf8");
/** The card's words, stateLabel among them, lifted out of AgentNode.tsx. */
const agentCopy = readFileSync(fileURLToPath(new URL("../agent-copy.ts", import.meta.url)), "utf8");

/** WCAG 1.4.3 for body text, 1.4.11 for large text and non-text boundaries. */
const BODY = 4.5;
const NON_TEXT = 3;

type Rgba = [number, number, number, number];

/** CSS Color 4's hsl-to-rgb, which is the sRGB one every browser ships. */
function fromHsl(hue: number, sat: number, light: number, alpha: number): Rgba {
  const h = (((hue % 360) + 360) % 360) / 30;
  const s = sat / 100;
  const l = light / 100;
  const c = s * Math.min(l, 1 - l);
  const k = (n: number) => (n + h) % 12;
  const f = (n: number) => l - c * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255), alpha];
}

/** #rgb, #rrggbb, rgb()/rgba() and hsl()/hsla() — every colour form this
 *  stylesheet writes.
 *
 *  hsl() was outside this grammar until #619 and the omission was not academic.
 *  Four cost-bar segments and the four legend swatches that key them were the
 *  only fixed-lightness hsl() in the sheet, and this function THREW on every one
 *  of them — so each contrast sweep in the repo that reached those declarations
 *  either crashed or, in the sweeps that read a hand-named list of rules, never
 *  reached them at all. A notation the parser cannot read is a notation the
 *  floors do not apply to, and the eight worst readings on the light canvas were
 *  written in it. Both syntaxes are accepted, comma and space, with the alpha in
 *  either notation, because a rule is free to use whichever and a sweep that
 *  reads one and throws on the other is the same blind spot one comma over. */
export function parseColor(input: string): Rgba {
  const s = input.trim();
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) return [+fn[1], +fn[2], +fn[3], fn[4] === undefined ? 1 : +fn[4]];
  const hsl = /^hsla?\(\s*(-?[\d.]+)(?:deg)?\s*(?:,\s*|\s+)([\d.]+)%\s*(?:,\s*|\s+)([\d.]+)%\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(s);
  if (hsl) {
    const a = hsl[4] === undefined ? 1 : hsl[4].endsWith("%") ? parseFloat(hsl[4]) / 100 : +hsl[4];
    return fromHsl(+hsl[1], +hsl[2], +hsl[3], a);
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!hex) throw new Error(`unparseable colour: ${input}`);
  const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}

/** Source-over compositing, non-premultiplied, onto an already-opaque backdrop. */
export function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)).concat(1) as Rgba;
}

export function relativeLuminance(c: Rgba): number {
  const [r, g, b] = [c[0], c[1], c[2]].map(v => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x relative-luminance ratio. Both arguments must already be opaque. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The declarations of the first rule whose selector starts a line verbatim —
 *  enough to keep `.agent-node.state-done` and its `:root[data-theme="light"]`
 *  override apart without modelling cascade order. */
function rule(selector: string): string | null {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  const m = re.exec(css);
  return m ? m[1] : null;
}

function decl(body: string | null, prop: string): string | null {
  if (body === null) return null;
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "m").exec(body);
  return m ? m[1].trim() : null;
}

const themes = ["dark", "light"] as const;
type Theme = (typeof themes)[number];

function tokens(theme: Theme): Record<string, string> {
  const head = theme === "dark" ? ":root,\\s*\\n:root\\[data-theme=\"dark\"\\]" : ":root\\[data-theme=\"light\"\\]";
  const block = new RegExp(`${head}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
  if (!block) throw new Error(`no ${theme} token block`);
  const out: Record<string, string> = {};
  for (const [, name, value] of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

const TOK: Record<Theme, Record<string, string>> = { dark: tokens("dark"), light: tokens("light") };

/** var() all the way down, plus the `color-mix(in srgb, var(--x) N%, transparent)`
 *  form the banners use — which is just var(--x) at N% alpha.
 *
 *  All the way down since #1290: --ctl-edge is itself that color-mix(), so a
 *  rule reading `var(--ctl-edge)` is two steps from a colour, and a resolver
 *  that took one step handed parseColor() the color-mix() text and threw. */
function resolve(value: string, theme: Theme): Rgba {
  const mix = /color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%,\s*transparent\)/.exec(value);
  if (mix) {
    const base = resolve(TOK[theme][mix[1]], theme);
    return [base[0], base[1], base[2], +mix[2] / 100];
  }
  const v = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return v ? resolve(TOK[theme][v[1]], theme) : parseColor(value);
}

/** The colour stops of a gradient token, in order — and a failure naming the
 *  token when its value says nothing this reader can see.
 *
 *  This ended in `?? []` until #649, which is the hsl() blind spot above wearing
 *  its other costume. There, a notation the grammar could not read THREW, and
 *  the damage was the sweeps that never reached the declaration. Here the miss
 *  is quieter and therefore worse: the regex simply matches nothing, `?? []`
 *  turns that into an empty collection, and a sweep quantified over an empty
 *  collection is a passing sweep. Neither `var()` nor `#rrggbb` occurs inside an
 *  `oklch()`, so respelling --node-grad in the notation a designer reaches for
 *  next emptied this in both themes and left the two node sweeps below asserting
 *  over nothing — no crash, no error, green, and nothing else in this file to
 *  tell anybody. A sweep that cannot read the value it was pointed at has to
 *  fail, and it has to say WHICH value, or the failure is a puzzle rather than
 *  a report.
 *
 *  #662 wrote that reader here; #664 and #665 moved it to `./gradient-stops`,
 *  because the same `?? []` was still in three other files reading the same two
 *  tokens — one of them silently, two of them as a bare TypeError. It also grew
 *  a grammar rather than a regex on the way, which is what refuses a
 *  `color-mix()` stop instead of scraping the two tokens INSIDE it as though
 *  they were two stops of their own.
 *
 *  Two is the floor rather than one because a single colour is not a gradient
 *  and every caller here reads a top and a bottom; more than two is a sheet's
 *  business, not this reader's. */
const gradientStops = (token: string, theme: Theme) => readStops(token, theme, TOK[theme]);

/** The label every node bed carries, and the prefix the two sweeps below filter
 *  the three fixed surfaces back out with. One constant, so the naming and the
 *  filtering cannot drift apart into an empty answer. */
const NODE_BED = "--node-grad stop";

/** Every opaque surface small text lands on: the three panel tiers plus both
 *  stops of the node gradient, since a node's top and bottom differ. */
function surfaces(theme: Theme): Array<[string, Rgba]> {
  const named: Array<[string, Rgba]> = (["--panel", "--bg-soft", "--bg"] as const)
    .map(t => [t, parseColor(TOK[theme][t])]);
  const stops = gradientStops("--node-grad", theme);
  return named.concat(stops.map((s, i) => [`${NODE_BED} ${i}`, resolve(s, theme)]));
}

/** Just the node beds: the sweeps that measure a ring or a pill against the node
 *  filter the three fixed surfaces back out, which makes this the one collection
 *  in the file a respelled gradient can empty completely. */
const nodeBeds = (theme: Theme) => surfaces(theme).filter(([n]) => n.startsWith(NODE_BED));

describe("contrast maths", () => {
  it("puts white on black at the 21:1 ceiling and a colour on itself at 1:1", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#0b0c10"), parseColor("#0b0c10"))).toBeCloseTo(1, 5);
  });

  it("agrees with the known AA boundary grey — #767676 on white is 4.54:1", () => {
    expect(contrastRatio(parseColor("#767676"), parseColor("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  it("does not care which colour is passed first", () => {
    const a = parseColor("#7e828c");
    const b = parseColor("#14161b");
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });

  it("composites a half-alpha white to the midpoint of white and black", () => {
    const half = over([255, 255, 255, 0.5], parseColor("#000000"));
    expect(half.slice(0, 3)).toEqual([127.5, 127.5, 127.5]);
    expect(over([255, 255, 255, 1], parseColor("#000000"))).toEqual([255, 255, 255, 1]);
    expect(over([255, 255, 255, 0], parseColor("#0b0c10"))).toEqual([11, 12, 16, 1]);
  });

  it("reproduces the ratios the three audits reported, from the shipped values", () => {
    // The defects, restated as arithmetic so the fixes below have a baseline.
    expect(contrastRatio(parseColor("#50535b"), parseColor("#14161b"))).toBeCloseTo(2.35, 2);
    expect(contrastRatio(parseColor("#7c8493"), parseColor("#eef1f6"))).toBeCloseTo(3.32, 2);
    expect(contrastRatio(over([21, 128, 61, 0.55], parseColor("#ffffff")), parseColor("#ffffff"))).toBeCloseTo(2.26, 2);
    expect(contrastRatio(over([185, 28, 28, 0.6], parseColor("#ffffff")), parseColor("#ffffff"))).toBeCloseTo(3.12, 2);
    expect(contrastRatio(parseColor("#b45309"), over([180, 83, 9, 0.13], parseColor("#eef1f6")))).toBeCloseTo(3.74, 2);
  });
});

describe("--text-dim, the token the annotation rules now read from (#262)", () => {
  it("is defined in both themes, because half a token is a light-theme bug", () => {
    for (const theme of themes) expect(TOK[theme]["--text-dim"], theme).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("clears 4.5:1 on every surface it can land on, in both themes", () => {
    for (const theme of themes) {
      const fg = parseColor(TOK[theme]["--text-dim"]);
      for (const [name, bg] of surfaces(theme)) {
        expect(contrastRatio(fg, bg), `${theme} --text-dim on ${name}`).toBeGreaterThanOrEqual(BODY);
      }
    }
  });

  it("still reads as dim — never louder than --muted, the tier above it", () => {
    for (const theme of themes) {
      const panel = parseColor(TOK[theme]["--panel"]);
      const dim = contrastRatio(parseColor(TOK[theme]["--text-dim"]), panel);
      const muted = contrastRatio(parseColor(TOK[theme]["--muted"]), panel);
      expect(dim, `${theme} --text-dim vs --muted`).toBeLessThanOrEqual(muted + 1e-9);
    }
  });

  it("leaves --muted-dim alone for the decoration it was always sized for", () => {
    // A hover hairline, the auto-restart dot, the idle sparkline bar, the
    // session dot. None of them is text. (The scrollbar thumb's hover was one
    // too, until #1290 needed it louder than the thumb a keyboard reveals.)
    expect(css).toMatch(/background: var\(--muted-dim\)/);
    expect(css).toMatch(/fill: var\(--muted-dim\)/);
    for (const theme of themes) {
      expect(contrastRatio(parseColor(TOK[theme]["--muted-dim"]), parseColor(TOK[theme]["--panel"])))
        .toBeLessThan(BODY);
    }
  });

  it("is the only dim tier that text is allowed to use — no rule sets --muted-dim as a colour", () => {
    // `border-color:` keeps it; a bare `color:` is the regression.
    const offenders = [...css.matchAll(/(^|[^-\w])color:\s*var\(--muted-dim\)/g)];
    expect(offenders.map(m => m[0].trim())).toEqual([]);
    // Fifteen, down from the seventeen #262 converted: .chips-empty went with
    // #243 as unreachable, and .ap-manage-label went when the manage block's
    // labels came off the screen — the fields keep hidden <label>s, which carry
    // no colour at all. The floor tracks deletions; a rule switching BACK to
    // --muted-dim is what the assertion above catches.
    expect([...css.matchAll(/color:\s*var\(--text-dim\)/g)].length).toBeGreaterThanOrEqual(15);
  });
});

describe("agent-node state rings (#268)", () => {
  const ringOf = (state: string, theme: Theme) => {
    const base = decl(rule(`.agent-node.state-${state}`), "border-color")!;
    const light = decl(rule(`:root[data-theme="light"] .agent-node.state-${state}`), "border-color");
    return resolve(theme === "light" && light ? light : base, theme);
  };

  it("draws every state's ring at 3:1 or better against the node it outlines", () => {
    for (const theme of themes) {
      const node = nodeBeds(theme);
      // The floor, and it sits OUTSIDE the quantification it is the floor for
      // (#627's lesson, applied here by #649). gradientStops already refuses an
      // unreadable --node-grad, so this is the second line rather than the
      // first: it is what still fails if that reader is ever softened back to a
      // `?? []`, or if the label these beds are filtered by is renamed on one
      // side only. Both ends of the gradient, because a node's top and bottom
      // differ and a ring is drawn across the whole of it.
      expect(node.map(([n]) => n), `${theme}: no node beds — every ring below would be measured against nothing`)
        .toEqual([`${NODE_BED} 0`, `${NODE_BED} 1`]);
      for (const state of ["active", "done", "err"]) {
        const ring = ringOf(state, theme);
        for (const [name, bg] of node) {
          expect(contrastRatio(over(ring, bg), bg), `${theme} ${state} ring on ${name}`)
            .toBeGreaterThanOrEqual(NON_TEXT);
        }
      }
    }
  });

  it("holds that 3:1 against the canvas too, since the ring is the node's edge", () => {
    for (const theme of themes) {
      const canvas = parseColor(TOK[theme]["--bg"]);
      for (const state of ["active", "done", "err"]) {
        expect(contrastRatio(over(ringOf(state, theme), canvas), canvas), `${theme} ${state} ring on --bg`)
          .toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
  });

  it("keeps the light rings opaque — an alpha tuned for #14161b vanishes on white", () => {
    for (const state of ["done", "err"]) {
      const light = decl(rule(`:root[data-theme="light"] .agent-node.state-${state}`), "border-color");
      expect(light, state).not.toMatch(/rgba\(/);
    }
  });

  it("reads every state pill's own label at 4.5:1 over its own wash", () => {
    for (const theme of themes) {
      const node = nodeBeds(theme);
      // The same floor, for the same reason, on the file's other node sweep.
      expect(node.map(([n]) => n), `${theme}: no node beds — every pill label below would be measured against nothing`)
        .toEqual([`${NODE_BED} 0`, `${NODE_BED} 1`]);
      for (const state of ["active", "done", "err"]) {
        const base = rule(`.state-pill.state-${state}`);
        const light = rule(`:root[data-theme="light"] .state-pill.state-${state}`);
        const pick = (p: string) => (theme === "light" ? decl(light, p) ?? decl(base, p) : decl(base, p))!;
        const fg = resolve(pick("color"), theme);
        const wash = resolve(pick("background"), theme);
        for (const [name, bg] of node) {
          expect(contrastRatio(fg, over(wash, bg)), `${theme} ${state} pill text on ${name}`)
            .toBeGreaterThanOrEqual(BODY);
        }
      }
    }
  });

  it("never leans on the ring alone — every node spells its state out in words", () => {
    // 1.4.1: running / done / failed are near-isoluminant under red-green CVD
    // (deuteranope ΔE 4.5 light, 4.5 dark between done and err), so the ring is
    // a reinforcement. The words are the channel that actually carries it.
    expect(agentCopy).toMatch(/state === "active" \? "live" : state === "done" \? "done" : "err"/);
    expect(agentNode).toMatch(/<StatePill state=\{data\.state\} \/>/);
  });

  it("keeps the three state hues from collapsing into each other", () => {
    for (const theme of themes) {
      const hues = ["--inflight", "--ok", "--err"].map(t => TOK[theme][t]);
      expect(new Set(hues).size, theme).toBe(3);
    }
  });
});

describe("version-drift banner (#272)", () => {
  const banner = rule(".ver-banner")!;

  it("writes its running text in --text, not in the accent it paints behind it", () => {
    expect(decl(banner, "color")).toBe("var(--text)");
    // .done inherits: --ok on a 13% --ok wash is the same trap, 3.75:1 light.
    expect(decl(rule(".ver-banner.done"), "color")).toBeNull();
  });

  it("clears 4.5:1 at both ends of the wash, in both themes and both states", () => {
    const wash = /(color-mix\(in srgb,\s*var\(--[\w-]+\)\s*[\d.]+%,\s*transparent\))/;
    const gradients = [
      decl(banner, "background")!,
      decl(rule(".ver-banner.done"), "background")!,
    ];
    for (const theme of themes) {
      const fg = resolve(decl(banner, "color")!, theme);
      const canvas = parseColor(TOK[theme]["--bg"]);
      for (const g of gradients) {
        const tint = resolve(wash.exec(g)![1], theme);
        expect(contrastRatio(fg, over(tint, canvas)), `${theme} tinted end of ${g.slice(0, 40)}`)
          .toBeGreaterThanOrEqual(BODY);
      }
      expect(contrastRatio(fg, canvas), `${theme} transparent end`).toBeGreaterThanOrEqual(BODY);
    }
  });

  it("leaves the accent where it is decoration — the dot still pulses in --warn", () => {
    expect(decl(rule(".ver-banner .ver-dot"), "background")).toBe("var(--warn)");
    expect(decl(rule(".ver-banner.done .ver-dot"), "background")).toBe("var(--ok)");
  });
});

describe("the update dialog's failure line (#1187)", () => {
  it("writes --warn on the modal's own --panel, not on a wash of itself", () => {
    // The trap #272 fell into was --warn text on a 13% --warn wash, 3.74:1 in
    // light. This line has no wash: it sits on the dialog's panel, where the
    // same --warn is 5.43:1 light and 12.55:1 dark (measured in Chromium too).
    expect(decl(rule(".modal"), "background")).toBe("var(--panel)");
    const said = rule(".release-notes .rn-update-said");
    expect(decl(said, "color")).toBe("var(--warn)");
    expect(decl(said, "background")).toBeNull();
    for (const theme of themes) {
      const ratio = contrastRatio(resolve("var(--warn)", theme), parseColor(TOK[theme]["--panel"]));
      expect(ratio, theme).toBeGreaterThanOrEqual(BODY);
    }
  });
});

// ── #619 / #622 ─────────────────────────────────────────────────────────────

/** Comments in this sheet quote the very declarations these blocks assert are
 *  gone, so every scan of the raw text below reads a stripped copy. rule() and
 *  decl() keep reading `css` — they anchor on a selector at the start of a
 *  line, which no comment here writes. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** CSS `filter: brightness(n)`, which multiplies each sRGB channel. */
function brightness(c: Rgba, factor: number): Rgba {
  return [0, 1, 2].map(i => Math.min(255, c[i] * factor)).concat(c[3]) as Rgba;
}

describe("hsl(), the notation no contrast sweep in this repo could read (#619)", () => {
  it("parses both syntaxes, with the alpha written either way", () => {
    expect(parseColor("hsl(0 0% 100%)")).toEqual([255, 255, 255, 1]);
    expect(parseColor("hsl(0, 0%, 0%)")).toEqual([0, 0, 0, 1]);
    expect(parseColor("hsl(0 100% 50%)")).toEqual([255, 0, 0, 1]);
    expect(parseColor("hsl(120deg 100% 50%)")).toEqual([0, 255, 0, 1]);
    expect(parseColor("hsl(240 100% 50%)")).toEqual([0, 0, 255, 1]);
    // Hue is a circle, and a sheet is allowed to say so.
    expect(parseColor("hsl(480 100% 50%)")).toEqual(parseColor("hsl(120 100% 50%)"));
    expect(parseColor("hsl(-120 100% 50%)")).toEqual(parseColor("hsl(240 100% 50%)"));
    expect(parseColor("hsl(213 80% 65% / 40%)")[3]).toBeCloseTo(0.4, 6);
    expect(parseColor("hsla(213, 80%, 65%, 0.4)")[3]).toBeCloseTo(0.4, 6);
    expect(parseColor("hsl(213 80% 65% / 40%)").slice(0, 3))
      .toEqual(parseColor("hsl(213 80% 65%)").slice(0, 3));
  });

  it("agrees with the browser on the four literals the cost bar used to declare", () => {
    // #5e9fed, #c679ec, #5cd699, #f2b25a — the resolved values #619 tabulated.
    expect(parseColor("hsl(213 80% 65%)")).toEqual(parseColor("#5e9fed"));
    expect(parseColor("hsl(280 75% 70%)")).toEqual(parseColor("#c679ec"));
    expect(parseColor("hsl(150 60% 60%)")).toEqual(parseColor("#5cd699"));
    expect(parseColor("hsl(35 85% 65%)")).toEqual(parseColor("#f2b25a"));
  });

  it("reproduces every ratio #619 reported, now that the grammar reaches them", () => {
    const white = parseColor("#ffffff");
    const lightLine = parseColor("#c8cdd6");
    expect(contrastRatio(parseColor("hsl(213 80% 65%)"), white)).toBeCloseTo(2.74, 2);
    expect(contrastRatio(parseColor("hsl(280 75% 70%)"), white)).toBeCloseTo(2.86, 2);
    expect(contrastRatio(parseColor("hsl(150 60% 60%)"), white)).toBeCloseTo(1.82, 2);
    expect(contrastRatio(parseColor("hsl(35 85% 65%)"), white)).toBeCloseTo(1.86, 2);
    // The two cache bands against each other, and against the gap that was
    // supposed to separate them.
    expect(contrastRatio(parseColor("hsl(150 60% 60%)"), parseColor("hsl(35 85% 65%)")))
      .toBeCloseTo(1.02, 2);
    expect(contrastRatio(lightLine, parseColor("hsl(150 60% 60%)"))).toBeCloseTo(1.14, 2);
    expect(contrastRatio(lightLine, parseColor("hsl(35 85% 65%)"))).toBeCloseTo(1.17, 2);
    // And why it read perfectly on the canvas it was designed for.
    expect(contrastRatio(parseColor("hsl(150 60% 60%)"), parseColor("#14161b"))).toBeCloseTo(9.94, 2);
  });

  it("leaves no fixed-lightness hsl() in the sheet — every one reads a theme token", () => {
    // The assertion that would have caught #619 at the commit that wrote it,
    // and the one that catches the next colour in this notation. A literal
    // lightness is one decision made for two canvases; every other hsl() here
    // spends --session-*-l or --mcp-dot-l, which is the boundary #330 drew and
    // #583 drew again one class of colour further on.
    const blind = [...bare.matchAll(/hsl\(([^)]*)\)/g)]
      .map(m => m[0])
      .filter(expr => !expr.includes("var(--"));
    expect(blind, `theme-blind hsl() literals: ${blind.join(", ")}`).toEqual([]);
  });
});

describe("the stacked cost bar and the key that reads it (#619)", () => {
  const BANDS = {
    input: ".cost-bar .cb-input",
    output: ".cost-bar .cb-output",
    "cache-read": ".cost-bar .cb-cache-r",
    "cache-write": ".cost-bar .cb-cache-w",
  } as const;
  const SWATCHES = {
    input: ".session-summary .ssl-in::before",
    output: ".session-summary .ssl-out::before",
    "cache-read": ".session-summary .ssl-cr::before",
    "cache-write": ".session-summary .ssl-cw::before",
  } as const;
  type Band = keyof typeof BANDS;
  const names = Object.keys(BANDS) as Band[];
  const bandValue = (b: Band) => decl(rule(BANDS[b]), "background")!;
  const band = (b: Band, theme: Theme) => resolve(bandValue(b), theme);

  /** Every opaque bed a segment or a swatch lands on, named out of the sheet:
   *  the three panels that draw the bar all paint --panel, `.cost-bar` declares
   *  its own track, and the session summary lays a 5% green wash under its
   *  legend. */
  function beds(theme: Theme): Array<[string, Rgba]> {
    const panel = parseColor(TOK[theme]["--panel"]);
    const heroWash = /rgba\([^)]*\)/.exec(decl(rule(".session-summary .ss-hero"), "background")!)![0];
    return [
      ["--panel", panel],
      ["--bg-soft", parseColor(TOK[theme]["--bg-soft"])],
      ["the bar's own track", resolve(decl(rule(".cost-bar"), "background")!, theme)],
      ["the summary hero's wash", over(parseColor(heroWash), panel)],
    ];
  }

  it("reads all four bands out of tokens that both themes declare", () => {
    for (const b of names) {
      expect(bandValue(b), b).toMatch(/^var\(--[\w-]+\)$/);
      const token = /^var\((--[\w-]+)\)$/.exec(bandValue(b))![1];
      for (const theme of themes) {
        expect(TOK[theme][token], `${theme} ${token}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("clears 3:1 on every bed it is drawn on, in both themes", () => {
    for (const theme of themes) {
      for (const b of names) {
        for (const [where, bg] of beds(theme)) {
          const ratio = contrastRatio(band(b, theme), bg);
          expect(ratio, `${theme} ${b} on ${where} — ${ratio.toFixed(2)}:1, 1.4.11 asks ${NON_TEXT}`)
            .toBeGreaterThanOrEqual(NON_TEXT);
        }
      }
    }
  });

  it("inverts polarity between the themes, which is what a literal could not do", () => {
    for (const b of names) {
      expect(relativeLuminance(band(b, "dark")), `${b} should be lighter than the dark panel`)
        .toBeGreaterThan(relativeLuminance(parseColor(TOK.dark["--panel"])));
      expect(relativeLuminance(band(b, "light")), `${b} should be darker than the light panel`)
        .toBeLessThan(relativeLuminance(parseColor(TOK.light["--panel"])));
    }
  });

  it("keeps the legend keying the bar — a swatch that drifts keys nothing", () => {
    for (const b of names) {
      expect(decl(rule(SWATCHES[b]), "background"), `${b} swatch`).toBe(bandValue(b));
    }
  });

  it("cuts the bands with a hairline, because no palette can separate four of them", () => {
    // 1.4.1, not 1.4.11: a chain of n colours each 3:1 from the next needs
    // (L + 0.05) to span 3^(n-1), and 3^3 = 27 already exceeds the 21 sRGB
    // allows. Four mutually distinguishable luminances do not exist at any
    // tuning, so the pairwise floor is bought with geometry — which is only
    // honest if the arithmetic is measured rather than asserted about.
    for (const theme of themes) {
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          expect(contrastRatio(band(names[i], theme), band(names[j], theme)),
            `${theme} ${names[i]} vs ${names[j]} — if this ever clears 3:1 the cut is decoration`)
            .toBeLessThan(NON_TEXT);
        }
      }
    }
    expect(decl(rule(".cost-bar .cb-seg"), "box-shadow"),
      "the bands have nothing between them, and the pairs above show colour cannot do it")
      .toBe("-1px 0 0 var(--panel)");
    // A shadow and not a border: a segment's width is its share of the spend.
    expect(decl(rule(".cost-bar .cb-seg"), "border"),
      "a border comes out of the band's width — on a one-cent band it IS the band")
      .toBeNull();
    // And not a gap either: that separator is the bar's own --line track, which
    // #619 measured at 1.14:1 from cache-read and 1.17:1 from cache-write.
    expect(decl(rule(".cost-bar"), "gap"),
      "a gap separates the bands with --line, 1.14:1 from what it separates on white")
      .toBeNull();
    expect(decl(rule(".cost-bar"), "overflow"),
      "without this the first band's hairline becomes the bar's own left edge")
      .toBe("hidden");
  });

  it("makes that cut visible against whichever two bands it lands between", () => {
    const shadow = decl(rule(".cost-bar .cb-seg"), "box-shadow");
    expect(shadow, "no hairline to measure — the bands are separated by colour alone").not.toBeNull();
    const hairline = /var\(--[\w-]+\)/.exec(shadow!)![0];
    for (const theme of themes) {
      const line = resolve(hairline, theme);
      for (const b of names) {
        const ratio = contrastRatio(line, band(b, theme));
        expect(ratio, `${theme} hairline against ${b} — ${ratio.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
  });

  it("keeps the hover brighten from taking a band under the floor it holds at rest", () => {
    // The same defect as the colours, in a filter: one factor for two canvases.
    // brightness(1.3) on white takes a hovered band to between 2.16:1 and
    // 3.00:1 against the track, so pointing at a segment hid it.
    const factor = (theme: Theme) => {
      const base = decl(rule(".cost-bar .cb-seg:hover"), "filter")!;
      const light = decl(rule(':root[data-theme="light"] .cost-bar .cb-seg:hover'), "filter");
      return +/brightness\(([\d.]+)\)/.exec(theme === "light" && light ? light : base)![1];
    };
    expect(factor("dark"), "dark should brighten").toBeGreaterThan(1);
    expect(factor("light"), "light should darken — on white a band reads by being darker")
      .toBeLessThan(1);
    for (const theme of themes) {
      for (const b of names) {
        const hovered = brightness(band(b, theme), factor(theme));
        for (const [where, bg] of beds(theme)) {
          const ratio = contrastRatio(hovered, bg);
          expect(ratio, `${theme} hovered ${b} on ${where} — ${ratio.toFixed(2)}:1`)
            .toBeGreaterThanOrEqual(NON_TEXT);
        }
      }
    }
  });
});

describe("the category filter bar when a card drifts under it (#622)", () => {
  const FADED = ".cat-filter-bar.occluded:not(:hover):not(:focus-within)";
  const fillOf = (selector: string, theme: Theme) => {
    const light = decl(rule(`:root[data-theme="light"] ${selector}`), "background");
    const base = decl(rule(selector), "background");
    const value = theme === "light" && light ? light : base;
    // A missing fill here does not mean "no fill", it means the yielding is
    // being done by something other than the fill — which is the whole defect.
    if (value === null) {
      throw new Error(`${theme}: no background on ${selector} — the bar is yielding by some channel other than its own fill, and #622 is about what that costs the labels`);
    }
    return resolve(value, theme);
  };
  /** The bar goes occluded only because something is under it, so a node card is
   *  the backdrop that matters; the empty canvas is given too. */
  const backdrops = (theme: Theme): Array<[string, Rgba]> =>
    [["a card", parseColor(TOK[theme]["--panel"])], ["the canvas", parseColor(TOK[theme]["--bg"])]];
  const labels = { on: ".cat-filter", off: ".cat-filter.off" } as const;

  it("reproduces what `opacity: 0.2` on the group was worth, in both themes", () => {
    // Group opacity composites the label AND the fill it sits on, which is why
    // the numbers land so far under: both ends of the ratio collapse together.
    const was = (theme: Theme, fg: string, backdrop: Rgba) => {
      const fill = fillOf(".cat-filter-bar", theme);
      const bed = over([fill[0], fill[1], fill[2], fill[3] * 0.2], backdrop);
      const text = resolve(fg, theme);
      return contrastRatio(over([text[0], text[1], text[2], 0.2], backdrop), bed);
    };
    const card = (t: Theme) => parseColor(TOK[t]["--panel"]);
    expect(was("light", "var(--text)", card("light"))).toBeCloseTo(1.55, 2);
    expect(was("dark", "var(--text)", card("dark"))).toBeCloseTo(1.67, 2);
    expect(was("light", "var(--muted)", card("light"))).toBeCloseTo(1.37, 2);
    expect(was("dark", "var(--muted)", card("dark"))).toBeCloseTo(1.29, 2);
  });

  it("shows no fade of the group would have worked — 0.9 is still under AA in dark", () => {
    // The argument the `.cat-filter.off` comment already made about this exact
    // element, restated for the bar that contains it: --muted clears AA on this
    // fill by 0.20 at full strength, so there is no alpha left to spend. A lower
    // floor was never an available fix, which is why the fill fades and not the
    // group.
    const fill = fillOf(".cat-filter-bar", "dark");
    const card = parseColor(TOK.dark["--panel"]);
    const muted = resolve("var(--muted)", "dark");
    const at = (o: number) => contrastRatio(
      over([muted[0], muted[1], muted[2], o], card),
      over([fill[0], fill[1], fill[2], fill[3] * o], card));
    expect(at(0.8)).toBeLessThan(BODY);
    expect(at(0.9)).toBeLessThan(BODY);
    expect(at(1)).toBeGreaterThanOrEqual(BODY);
  });

  it("spends no opacity anywhere on the bar or its occluded state", () => {
    // The bar is written as two rules six thousand lines apart — the slab up
    // with the chips, the yielding down with the canvas motion — so this reads
    // every body either of them or their occluded states declare, not the first
    // one a selector match happens to land on.
    const bodies = [...bare.matchAll(/^[^\n{}]*\.cat-filter-bar[^\n{}]*\{([^}]*)\}/gm)].map(m => m[1]);
    expect(bodies.length, "no .cat-filter-bar rules found — the scan is reading nothing")
      .toBeGreaterThanOrEqual(4);
    for (const body of bodies) {
      expect(body.replace(/\s+/g, " ").trim(),
        "a bar rule declares opacity — it makes a stacking context and takes every chip label down with the fill, 1.55:1 light and 1.29:1 dark at 0.2")
        .not.toMatch(/(?:^|[;{\s])opacity\s*:/);
    }
    for (const body of bodies) {
      // And the now-dead property is gone from the transition list, the same
      // thing quiet-signals holds the chip itself to.
      expect(body.replace(/\s+/g, " ").trim(), "a bar rule still transitions opacity")
        .not.toMatch(/transition:[^;]*opacity/);
    }
  });

  it("fades the slab instead — a thinner fill, no blur, no border, no shadow", () => {
    for (const theme of themes) {
      const rest = fillOf(".cat-filter-bar", theme);
      const faded = fillOf(FADED, theme);
      expect(faded[3], `${theme} occluded fill`).toBeLessThan(rest[3]);
      // Some fill is left on purpose: it beds the labels rather than floating
      // them over whatever drifted under, which is what keeps the floor below a
      // floor and not a coincidence of what happened to be there.
      expect(faded[3], `${theme} occluded fill`).toBeGreaterThan(0);
    }
    expect(decl(rule(FADED), "box-shadow")).toBe("none");
    expect(decl(rule(FADED), "border-color")).toBe("transparent");
    expect(decl(rule(FADED), "backdrop-filter")).toBe("none");
    expect(decl(rule(FADED), "-webkit-backdrop-filter")).toBe("none");
  });

  it("reads every chip label at 4.5:1 while the bar is yielding, in both themes", () => {
    for (const theme of themes) {
      const fill = fillOf(FADED, theme);
      for (const [state, selector] of Object.entries(labels)) {
        const fg = resolve(decl(rule(selector), "color")!, theme);
        for (const [where, backdrop] of backdrops(theme)) {
          const ratio = contrastRatio(fg, over(fill, backdrop));
          expect(ratio, `${theme} ${state} chip over ${where} while occluded — ${ratio.toFixed(2)}:1, 1.4.3 asks ${BODY} of 11px text`)
            .toBeGreaterThanOrEqual(BODY);
        }
      }
    }
  });

  it("costs the bar nothing at rest — the faded state is the only thing that changed", () => {
    for (const theme of themes) {
      const fill = fillOf(".cat-filter-bar", theme);
      for (const [state, selector] of Object.entries(labels)) {
        const fg = resolve(decl(rule(selector), "color")!, theme);
        for (const [where, backdrop] of backdrops(theme)) {
          expect(contrastRatio(fg, over(fill, backdrop)), `${theme} ${state} chip over ${where} at rest`)
            .toBeGreaterThanOrEqual(BODY);
        }
      }
    }
  });

  it("gives a coarse pointer the same way back as a fine one", () => {
    // Both restore paths are the :not() on the faded rule itself, so neither can
    // be lost to a media query the way the old :hover restore was — it sat
    // inside `(hover: hover) and (pointer: fine)`, which a touch pointer never
    // matches, leaving one way to read the bar: tap a chip, and change what it
    // says. :focus-within was no better, since putting focus in there by touch
    // IS that tap.
    for (const m of bare.matchAll(/@media \(hover: hover\)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g)) {
      expect(m[0].replace(/\s+/g, " ").trim(),
        "a .cat-filter-bar rule is behind a fine-pointer guard, which a touch pointer never matches — the only way back is then to tap a chip, and a tap toggles the category the reader was trying to read")
        .not.toContain(".cat-filter-bar");
    }
    const rules = [...bare.matchAll(/^([^\n{}]*\.cat-filter-bar\.occluded[^\n{}]*?)\s*\{/gm)]
      .map(m => m[1].trim());
    expect(rules,
      "the occluded state should be one rule per theme carrying both restore paths in its own selector")
      .toEqual([FADED, `:root[data-theme="light"] ${FADED}`]);
    for (const selector of rules) {
      expect(selector, "restores on a pointer of any kind").toContain(":not(:hover)");
      expect(selector, "restores once focus is inside").toContain(":not(:focus-within)");
    }
  });

  it("keeps the strike, which is the channel that never depended on any of this", () => {
    expect(decl(rule(".cat-filter.off .cat-name"), "text-decoration")).toBe("line-through");
  });
});

// ── #872 ────────────────────────────────────────────────────────────────────

describe("the × that clears an account failure (#872)", () => {
  // The only way to dismiss the note, drawn in the note's own red and dimmed by
  // `opacity` — which no token sweep sees, because the token itself is fine.
  // At 0.6 it composited to 2.81:1 in light over the note's 12% wash.
  const note = rule(".ap-failure")!;
  const dismiss = rule(".ap-failure-x")!;

  it("inherits the note's colour, so the note's red is the ink being measured", () => {
    expect(decl(dismiss, "color")).toBe("inherit");
    expect(decl(note, "color")).toBe("var(--err)");
  });

  it("reproduces the 2.81:1 the audit measured at the old 0.6", () => {
    const panel = parseColor(TOK.light["--panel"]);
    const bed = over(resolve(decl(note, "background")!, "light"), panel);
    const ink = resolve("var(--err)", "light");
    expect(contrastRatio(over([ink[0], ink[1], ink[2], 0.6], bed), bed)).toBeCloseTo(2.81, 2);
  });

  it("rests at 3:1 or better on the note, on every surface the note sits on, in both themes", () => {
    const opacity = Number(decl(dismiss, "opacity") ?? "1");
    for (const theme of themes) {
      const ink = resolve(decl(note, "color")!, theme);
      // The accounts panel and the LAN dialogs both paint --panel; the other
      // two tiers are here so a move to either is measured, not assumed.
      for (const surface of ["--panel", "--bg-soft", "--bg"] as const) {
        const bed = over(resolve(decl(note, "background")!, theme), parseColor(TOK[theme][surface]));
        const ratio = contrastRatio(over([ink[0], ink[1], ink[2], opacity], bed), bed);
        expect(ratio, `${theme} × on the note over ${surface} — ${ratio.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
  });

  it("still has somewhere to lift to under the pointer", () => {
    expect(Number(decl(dismiss, "opacity"))).toBeLessThan(1);
    expect(decl(rule(".ap-failure-x:hover"), "opacity")).toBe("1");
  });
});

// ── #859 ────────────────────────────────────────────────────────────────────

describe("the machine panel's process door, on the bed it is actually drawn on (#859)", () => {
  // A composite bed: the door's plate is a 4% (8% on hover) share of --text over
  // the panel. Every token pair in this file passes; the pair a reader sees is
  // the ink over THAT, and --muted there was 4.34:1 in dark.
  const sub = rule(".sd-door-sub")!;
  // The plate is gone: the door is a row of the panel now, not a card inside
  // it. At rest its bed is the panel itself, and on hover it is the full-bleed
  // fill every section takes. The 4% plate stays here as a literal, as the
  // record of what the audit measured on it.
  const OLD_PLATE = "color-mix(in srgb, var(--text) 4%, transparent)";
  const beds: Array<[string, string | null]> = [
    ["at rest", null],
    ["on hover", decl(rule(".sysdetail .sd-open:hover"), "background")!],
  ];
  const bedOf = (fill: string | null, theme: Theme) => {
    expect(decl(rule(".sysdetail"), "background")).toBe("var(--panel)");
    const panel = parseColor(TOK[theme]["--panel"]);
    return fill ? over(resolve(fill, theme), panel) : panel;
  };

  it("reproduces the 4.34:1 the audit measured for --muted on the old resting plate", () => {
    expect(contrastRatio(resolve("var(--muted)", "dark"), bedOf(OLD_PLATE, "dark"))).toBeCloseTo(4.34, 2);
  });

  it("reads the door's one line of description at 4.5:1, rest and hover, both themes", () => {
    for (const theme of themes) {
      const ink = resolve(decl(sub, "color")!, theme);
      for (const [state, fill] of beds) {
        const ratio = contrastRatio(ink, bedOf(fill, theme));
        expect(ratio, `${theme} door subtitle ${state} — ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(BODY);
      }
    }
  });

  it("sets the panel's sentences at 11px, not 10", () => {
    expect(decl(sub, "font-size")).toBe("11px");
    expect(decl(rule(".sd-note"), "font-size")).toBe("11px");
  });
});

// ── #878 ────────────────────────────────────────────────────────────────────

describe("the ? on a card whose start was synthesised (#878)", () => {
  const card = rule(".agent-node.synthetic")!;
  const tag = rule(".agent-node .synth-tag")!;
  /** Opacity on the card composites the ink AND the ground under it onto the
   *  canvas, which is why a token pair never saw it. */
  const ratioAt = (opacity: number, theme: Theme, bed: Rgba) => {
    const canvas = parseColor(TOK[theme]["--bg"]);
    const ink = resolve(decl(tag, "color")!, theme);
    return contrastRatio(
      over([ink[0], ink[1], ink[2], opacity], canvas),
      over([bed[0], bed[1], bed[2], opacity], canvas));
  };

  it("reproduces the defect: at the old 0.92 the dark ? fell under 4.5:1", () => {
    const worst = Math.min(...nodeBeds("dark").map(([, bed]) => ratioAt(0.92, "dark", bed)));
    expect(worst).toBeLessThan(BODY);
  });

  it("marks the card with its dashed edge, not with a fade of the whole card", () => {
    expect(decl(card, "border-style")).toBe("dashed");
    expect(decl(card, "opacity"), "a fade takes the ? with it").toBeNull();
  });

  it("reads the ? at 4.5:1 on every node bed, in both themes", () => {
    const opacity = Number(decl(card, "opacity") ?? "1");
    for (const theme of themes) {
      const beds = nodeBeds(theme);
      expect(beds.length, `${theme}: no node beds to measure against`).toBe(2);
      for (const [name, bed] of beds) {
        const ratio = ratioAt(opacity, theme, bed);
        expect(ratio, `${theme} ? on ${name} — ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(BODY);
      }
    }
  });
});

// ── and one reader, so the blind spot has one place to be ───────────────────
//
// #662 fixed the reader in this file and in toggle-state.test.ts. #664 and #665
// found the same `?? []` still in three more files reading the same two gradient
// tokens — which is what a correction leaves behind when it corrects a copy: the
// copies that were not in the issue. So the grammar moved to `./gradient-stops`,
// and this is the guard that keeps it there. Two halves, the
// duplicated-helpers.test.ts method, because a sweep for a shape nobody can
// write any more would pass just as happily over a suite with no files in it.

describe("one reader for every gradient this suite measures against (#664, #665)", () => {
  const testDir = fileURLToPath(new URL(".", import.meta.url));

  /** Comment-stripped, because the paragraphs in these files quote the very
   *  shape the sweeps below assert is gone. */
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /** A file scraping a gradient's stops with a regex of its own — the shape that
   *  ends in `?? []` and answers nothing rather than failing. */
  const PRIVATE_SCRAPE = /\.match\(\s*\/[^\n]*var\\\(--/;

  const GRADIENT_TOKEN = /--(?:node|topbar)-grad/;

  const FILES: Array<[string, string]> = readdirSync(testDir)
    .filter((name: string) => name.endsWith(".test.ts"))
    .map((name: string): [string, string] => [name, strip(readFileSync(join(testDir, name), "utf8"))]);

  /** The files that measure something against a gradient. Harvested rather than
   *  listed — a hand-kept list of five is the list the sixth file is not on,
   *  which is exactly how #664 and #665 outlived #662. */
  const READERS = FILES.filter(([, text]) => GRADIENT_TOKEN.test(text));

  it("reads every gradient token through ./gradient-stops, in every file that names one", () => {
    const offenders = READERS
      .filter(([, text]) => !/from "\.\/gradient-stops"/.test(text))
      .map(([name]) => name);
    expect(offenders,
      "a file measuring against --node-grad or --topbar-grad without the shared reader is a file with its own grammar, and so with its own blind spot")
      .toEqual([]);
  });

  it("leaves no file with a private scrape of one", () => {
    // Scoped to the files that name a gradient, deliberately. The same shape
    // appears in usage-series-contrast.test.ts over a `box-shadow`, which is one
    // layer rather than a list of stops, is asserted with a `!` so a miss throws
    // rather than answering `[]`, and is nothing to do with either token here.
    // Widening this to every `.match()` in the suite would be a guard about a
    // regex; it is meant to be a guard about a gradient.
    const offenders = READERS.filter(([, text]) => PRIVATE_SCRAPE.test(text)).map(([name]) => name);
    expect(offenders,
      "a `.match(/…var\\(--…/)` over a gradient value is the shape that ends in `?? []` — five files had it, and respelling either gradient made two of them go vacuous, two throw an unattributed TypeError, and one answer Infinity")
      .toEqual([]);
  });

  it("is not a vacuous sweep — both detectors still find what they look for", () => {
    // The half that cannot be faked: each pattern is matched against a string it
    // MUST hit and one it must not, so a typo in a regex cannot quietly retire a
    // guard. Built by concatenation, so this file's own text does not trip the
    // sweep two cases up.
    expect(FILES.length, "there are test files to sweep at all").toBeGreaterThan(200);
    expect(READERS.map(([name]) => name).sort(),
      "the five files that read a gradient token, which both sweeps above are quantified over")
      .toEqual([
        "contrast-floors.test.ts", "control-edges.test.ts", "quiet-signals.test.ts",
        "session-hue.test.ts", "toggle-state.test.ts",
      ]);
    expect(PRIVATE_SCRAPE.test("const stops = value" + ".match(/var" + "\\(--[\\w-]+\\)|#[0-9a-f]{3,6}/gi) ?? [];")).toBe(true);
    expect(PRIVATE_SCRAPE.test("const stops = gradientStops(token, theme, TOK[theme]);")).toBe(false);
    expect(GRADIENT_TOKEN.test('TOK[theme]["--node' + '-grad"]')).toBe(true);
    expect(GRADIENT_TOKEN.test('TOK[theme]["--panel"]')).toBe(false);
  });
});

// ── #1290: the scrollbar thumb, the one colour here no sweep read ──────────
//
// Every sweep above measures a token against the surface a rule paints it on,
// and the thumb was never one of those rules: `::-webkit-scrollbar-thumb` is a
// pseudo-element under two pseudo-classes, `scrollbar-color` is a property no
// sweep names, and the two states shared one selector list that rule() — which
// anchors on a selector ending in `{` — cannot read the first member of. So the
// colour a keyboard user got for the bar they scroll by was 1.14:1 in dark and
// nothing noticed. These read the four states out of the sheet the way the
// browser picks between them, and measure each on every surface a scroller has.

/** Every style rule in the stripped sheet, at any depth, with its selector list
 *  split and each member whitespace-collapsed. rule() finds a selector only
 *  where it opens a line and closes with the brace; this finds it as any member
 *  of a list, which is where both halves of the scrollbar used to live. */
type SheetRule = { selectors: string[]; body: string; at: string };
function sheetRules(src: string, at = ""): SheetRule[] {
  const out: SheetRule[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const prelude = src.slice(i, open).replace(/\s+/g, " ").trim();
    let depth = 0, end = open;
    for (; end < src.length; end++) {
      if (src[end] === "{") depth++;
      else if (src[end] === "}" && --depth === 0) break;
    }
    const inner = src.slice(open + 1, end);
    if (prelude.startsWith("@")) out.push(...sheetRules(inner, prelude));
    else out.push({ selectors: prelude.split(",").map(s => s.trim()).filter(Boolean), body: inner, at });
    i = end + 1;
  }
  return out;
}
const SHEET = sheetRules(bare);

/** The last value `prop` is given by a top-level rule listing `selector`, which
 *  is the one the cascade keeps at equal specificity. */
function declFor(selector: string, prop: string): string | null {
  let found: string | null = null;
  for (const r of SHEET) {
    if (r.at || !r.selectors.includes(selector)) continue;
    const v = decl(r.body, prop);
    if (v !== null) found = v;
  }
  return found;
}

/** The colour before the first top-level space: the thumb half of a
 *  `scrollbar-color: <thumb> <track>` pair, parentheses respected. */
function firstColour(value: string): string {
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === " " && depth === 0) return value.slice(0, i);
  }
  return value;
}

describe("the scrollbar thumb, in every state it has (#1290)", () => {
  const THUMB = {
    rest: declFor("*::-webkit-scrollbar-thumb", "background-color"),
    pointer: declFor(":hover::-webkit-scrollbar-thumb", "background-color"),
    keyboard: declFor(":focus-within::-webkit-scrollbar-thumb", "background-color"),
    grabbed: declFor("*::-webkit-scrollbar-thumb:hover", "background-color"),
  };
  const ratio = (value: string, bed: Rgba, theme: Theme) => contrastRatio(over(resolve(value, theme), bed), bed);

  it("reads all four states out of the sheet, so the sweeps below measure something", () => {
    expect(THUMB.rest).toBe("transparent");
    for (const [state, value] of Object.entries(THUMB)) expect(value, state).not.toBeNull();
  });

  it("reproduces what the keyboard was shown — --line, at the ratios #1290 measured", () => {
    const line = (theme: Theme) => contrastRatio(parseColor(TOK[theme]["--line"]), parseColor(TOK[theme]["--panel"]));
    expect(line("dark")).toBeCloseTo(1.14, 2);
    expect(line("light")).toBeCloseTo(1.60, 2);
  });

  it("reveals a thumb a keyboard can find: 3:1 on every surface a scroller has, in both themes", () => {
    for (const theme of themes) {
      for (const [name, bed] of surfaces(theme)) {
        const r = ratio(THUMB.keyboard!, bed, theme);
        expect(r, `${theme} keyboard thumb ${THUMB.keyboard} on ${name} — ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
  });

  it("keeps the grabbed thumb the loudest of the three, so hovering a focused bar never dims it", () => {
    for (const theme of themes) {
      for (const [name, bed] of surfaces(theme)) {
        const grabbed = ratio(THUMB.grabbed!, bed, theme);
        expect(grabbed, `${theme} grabbed vs keyboard on ${name}`).toBeGreaterThan(ratio(THUMB.keyboard!, bed, theme));
        expect(grabbed, `${theme} grabbed vs pointer on ${name}`).toBeGreaterThan(ratio(THUMB.pointer!, bed, theme));
      }
    }
    // Equal specificity, so source order is what makes it win: it has to come
    // after both reveals.
    const at = (sel: string) => SHEET.findIndex(r => !r.at && r.selectors.includes(sel));
    expect(at("*::-webkit-scrollbar-thumb:hover")).toBeGreaterThan(at(":focus-within::-webkit-scrollbar-thumb"));
    expect(at(":focus-within::-webkit-scrollbar-thumb")).toBeGreaterThan(at(":hover::-webkit-scrollbar-thumb"));
  });

  it("hands Chromium and Firefox the same two reveals through scrollbar-color", () => {
    // Not a courtesy copy. Chromium ignores every ::-webkit-scrollbar rule once
    // scrollbar-color is set, so for the browser and the desktop shell this
    // property IS the thumb, and the webkit rules above are Safari's.
    expect(firstColour(declFor("*", "scrollbar-color")!)).toBe("transparent");
    expect(firstColour(declFor(":hover", "scrollbar-color")!)).toBe(THUMB.pointer);
    expect(firstColour(declFor(":focus-within", "scrollbar-color")!)).toBe(THUMB.keyboard);
  });
});

// ── #1289: an opacity is a colour too ──────────────────────────────────────
//
// Every sweep in this file measures a token against a surface, and an opacity
// is neither: it multiplies whatever colour lands under it, so a rule can take
// a tier this file has just proved at 4.5:1 and composite it to 3.55:1 without
// naming a single colour. --dim-stale did exactly that to four blocks of words —
// the usage panel's figures, the history modal's whole answer, an expired
// share's text twice — and the build passed, because nothing here composited
// an opacity over anything. The sheet had learned this once already, at
// `.ap-account.disabled`, and the lesson lived in a comment.
//
// So the maths goes first: no readable tier survives --dim-stale on any surface
// in either theme, which makes "never on text" arithmetic rather than taste.
// Then the sweep that follows from it: every rule reading the token must dim an
// element that CANNOT hold a word — one the markup only ever writes as a
// self-closing tag. That is a structural question the stylesheet cannot answer
// alone, so it reads the components, the way usage-series-contrast.test.ts does.

/** Every .tsx in the bundle, tests excluded. */
const WEB = fileURLToPath(new URL("..", import.meta.url));
function tsxUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : tsxUnder(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}
const MARKUP = tsxUnder(WEB).map(path => ({
  file: path.slice(WEB.length).replace(/\\/g, "/"),
  src: readFileSync(path, "utf8"),
}));

/** The index just past a string literal opened at `i`, `${…}` in a template
 *  counted out so a nested brace or quote cannot end it early. */
function pastString(src: string, i: number): number {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (q === "`" && src[j] === "$" && src[j + 1] === "{") {
      let depth = 1;
      for (j += 2; j < src.length && depth > 0; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
      }
      j--;
      continue;
    }
    if (src[j] === q) return j + 1;
  }
  return src.length;
}

/** Where the opening tag that starts at `start` closes: the first `>` outside
 *  every brace and string, so an arrow function in an attribute is not it. */
function tagEnd(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { i = pastString(src, i) - 1; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return i;
  }
  return -1;
}

/** The class names an attribute value can spell literally, interpolations
 *  dropped — `ap-share-blob${dead ? " sa-dead" : ""}` spells both. */
function classTokens(value: string): string[] {
  const literals = [...value.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)]
    .map(m => (m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, " "));
  return literals.flatMap(l => l.split(/\s+/)).filter(Boolean);
}

/** Every JSX element whose className names `cls`, and whether it closes itself.
 *  A self-closing element has no children, so nothing it paints can be a word. */
function elementsWithClass(cls: string): Array<{ file: string; selfClosing: boolean }> {
  const out: Array<{ file: string; selfClosing: boolean }> = [];
  for (const { file, src } of MARKUP) {
    for (const m of src.matchAll(/<([A-Za-z][\w.]*)(?=[\s>])/g)) {
      const end = tagEnd(src, m.index!);
      if (end < 0) continue;
      const tag = src.slice(m.index!, end + 1);
      const at = tag.indexOf("className=");
      if (at < 0) continue;
      const rest = tag.slice(at + "className=".length);
      const value = rest[0] === "{" ? rest.slice(0, tagEnd(rest, 0) + 1) : rest.slice(0, rest.indexOf('"', 1) + 1);
      if (classTokens(value).includes(cls)) out.push({ file, selfClosing: tag.endsWith("/>") });
    }
  }
  return out;
}

/** The class a selector finally styles: the last class of its last compound. */
const subjectClass = (selector: string) => [...selector.trim().split(/[\s>+~]+/).pop()!.matchAll(/\.([\w-]+)/g)].pop()?.[1] ?? null;

/** Whether the markup proves `selector` lands only on childless elements. */
function dimsOnlyMarks(selector: string): boolean {
  const cls = subjectClass(selector);
  if (!cls) return false;
  const found = elementsWithClass(cls);
  return found.length > 0 && found.every(e => e.selfClosing);
}

describe("an opacity over text is a contrast ratio too (#1289)", () => {
  const STALE = parseFloat(declFor(":root", "--dim-stale")!);
  /** The tiers this file holds to 4.5:1 — the four a reader is meant to read. */
  const READABLE = ["--text", "--text-secondary", "--muted", "--text-dim"];
  const through = (fg: Rgba, alpha: number, bed: Rgba) => over([fg[0], fg[1], fg[2], fg[3] * alpha], bed);
  const dimmed = (tier: string, theme: Theme, bed: Rgba) => contrastRatio(through(parseColor(TOK[theme][tier]), STALE, bed), bed);

  it("reproduces the table #1289 measured, from the token as it ships", () => {
    expect(STALE).toBe(0.45);
    const panel = (theme: Theme) => parseColor(TOK[theme]["--panel"]);
    expect(dimmed("--text", "dark", panel("dark"))).toBeCloseTo(3.55, 1);
    expect(dimmed("--muted", "dark", panel("dark"))).toBeCloseTo(1.95, 1);
    expect(dimmed("--text", "light", panel("light"))).toBeCloseTo(3.04, 1);
    expect(dimmed("--muted", "light", panel("light"))).toBeCloseTo(2.15, 1);
  });

  it("leaves no readable tier at 4.5:1 on any surface in either theme, so it can never dim a word", () => {
    for (const theme of themes) {
      for (const [name, bed] of surfaces(theme)) {
        for (const tier of READABLE) {
          const r = dimmed(tier, theme, bed);
          expect(r, `${theme} ${tier} through --dim-stale on ${name} — ${r.toFixed(2)}:1`).toBeLessThan(BODY);
        }
      }
    }
  });

  it("tells a mark from a box that can hold a word, so the sweep below means something", () => {
    // Childless: the day bar's segments, the legend swatch, the meter fill.
    for (const mark of [".uh-bar-seg", ".uh-legend-dot", ".uh-model-bar-fill", ".uh-agent-seg"]) {
      expect(dimsOnlyMarks(mark), mark).toBe(true);
    }
    // Word-bearing: the status line, a share's text, the modal's own wrapper.
    for (const box of [".uh-status", ".ap-share-blob", ".uh-stale", ".up-section"]) {
      expect(dimsOnlyMarks(box), box).toBe(false);
    }
    // And a class nothing in the markup writes proves nothing, so it fails too.
    expect(dimsOnlyMarks(".no-such-class-anywhere")).toBe(false);
  });

  it("would have failed every one of the four rules #1289 found", () => {
    for (const was of [".up-stale", ".uh-stale", ".sa-dead", ".ap-share.expired .ap-share-blob"]) {
      expect(dimsOnlyMarks(was), was).toBe(false);
    }
  });

  it("puts --dim-stale on marks and fills only — elements with no children to hold a word", () => {
    const readers = SHEET.filter(r => decl(r.body, "opacity") === "var(--dim-stale)").flatMap(r => r.selectors);
    expect(readers.length, "nothing reads --dim-stale, so the sweep is over nothing").toBeGreaterThan(0);
    for (const sel of readers) expect(dimsOnlyMarks(sel), `${sel} dims something that can hold a word`).toBe(true);
    // Nor through a literal. The same number written out is held to the same
    // rule — it composites exactly as far — which today is one SVG ring.
    const literal = SHEET.filter(r => decl(r.body, "opacity") === String(STALE)).flatMap(r => r.selectors);
    expect(literal).toEqual([".aa-mark-ring"]);
    for (const sel of literal) expect(dimsOnlyMarks(sel), `${sel} dims something that can hold a word at ${STALE}`).toBe(true);
  });

  it("says stale in words where the dim came off, and those words are at full contrast", () => {
    const src = (file: string) => MARKUP.find(m => m.file === file)!.src;
    // The history modal: the subtitle says what is running while a re-run is out.
    expect(src("components/UsageHistoryModal.tsx"))
      .toContain('<div className="uh-sub">{view.stale ? "running ccusage…" : usageSubtitle(');
    expect(declFor(".uh-sub", "color")).toBe("var(--text-dim)");
    // The usage panel: the headline names the period its figures are from.
    expect(src("components/UsagePanel.tsx"))
      .toContain('<span className="up-total-label">{fromRange ? periodNoun : BOARD_SPEND_LABEL}</span>');
    // The share dialog's heading, and the popover's countdown.
    expect(src("components/ShareAccountsDialog.tsx")).toContain('"This share has expired"');
    expect(src("components/AccountMenuPopover.tsx")).toContain("<span className={`ap-share-expiry ${exp.tone}`}>{exp.text}</span>");
    // And none of those words sits inside anything that still dims.
    for (const box of [".uh-sub", ".up-total", ".ap-share-blob", ".ap-share-expiry"]) {
      expect(SHEET.filter(r => r.selectors.includes(box)).map(r => decl(r.body, "opacity")).filter(Boolean), box).toEqual([]);
    }
  });
});

// ── #1283: one hue for "right now" ─────────────────────────────────────────
//
// --inflight is meant to be the one colour that says a thing is happening at
// this moment, and a claim like that is only as good as its exclusivity. It
// was not exclusive: the dark value was also --cat-agent's and the dark Opus
// chip's, byte for byte, so with nothing running every agent-category stripe
// and every Opus chip wore "running". On white the Opus band was it byte for
// byte and the plan category sat 7.4 ΔE away. Nothing measured the distance
// between the in-flight hue and anything else in the palette, because every
// sweep here measures a colour against the paper it lands on.

/** CIE76 ΔE — the question a contrast ratio cannot answer: whether two colours
 *  of different luminance are still the same hue to somebody glancing. */
function deltaE(a: Rgba, b: Rgba): number {
  const lab = (c: Rgba) => {
    const lin = (v: number) => { const n = v / 255; return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); };
    const [r, g, bl] = [c[0], c[1], c[2]].map(lin);
    const f = (v: number) => (v > 216 / 24389 ? Math.cbrt(v) : (841 / 108) * v + 4 / 29);
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047);
    const y = f(0.2126 * r + 0.7152 * g + 0.0722 * bl);
    const z = f((0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

describe("--inflight is the only colour wearing the in-flight hue (#1283)", () => {
  /** The floor usage-series-contrast.test.ts keeps between a band and a state
   *  colour: twice the 8 ΔE at which two bands stop reading as two. */
  const APART = 16;
  const inflight = (theme: Theme) => parseColor(TOK[theme]["--inflight"]);
  /** Every opaque colour a theme block declares, the in-flight token aside. */
  const colours = (theme: Theme) => Object.entries(TOK[theme])
    .filter(([name, value]) => name !== "--inflight" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value));

  it("reproduces the collisions, from the values that shipped", () => {
    // --cat-agent and the dark Opus chip were written #f0abfc; the light Opus
    // band was #7e22ce; the light plan category #6d28d9.
    expect(deltaE(parseColor("#f0abfc"), inflight("dark"))).toBe(0);
    expect(deltaE(parseColor("#7e22ce"), inflight("light"))).toBe(0);
    expect(deltaE(parseColor("#6d28d9"), inflight("light"))).toBeCloseTo(7.4, 1);
  });

  it("keeps every other colour in both palettes 16 ΔE from it", () => {
    for (const theme of themes) {
      for (const [name, value] of colours(theme)) {
        const d = deltaE(parseColor(value), inflight(theme));
        expect(d, `${theme} ${name} ${value} — ΔE ${d.toFixed(1)} from --inflight`).toBeGreaterThanOrEqual(APART);
      }
    }
  });

  it("keeps every model chip off it too, through the family token the chip reads", () => {
    // The chip's hue is two steps from a colour: --model-* in a bare :root,
    // naming a --usage-* member each theme declares.
    for (const family of ["opus", "sonnet", "haiku", "fable", "mythos"]) {
      const token = declFor(`.model-chip[data-family="${family}"]`, "--chip-hue")!;
      const member = declFor(":root", /^var\((--[\w-]+)\)$/.exec(token)![1])!;
      for (const theme of themes) {
        const d = deltaE(resolve(member, theme), inflight(theme));
        expect(d, `${theme} ${family} chip — ΔE ${d.toFixed(1)} from --inflight`).toBeGreaterThanOrEqual(APART);
      }
    }
  });

  it("sweeps both palettes whole, so a pass is not a sweep over nothing", () => {
    for (const theme of themes) {
      const names = colours(theme).map(([name]) => name);
      expect(names.length, theme).toBeGreaterThan(30);
      for (const t of ["--cat-agent", "--cat-plan", "--usage-purple", "--accent", "--err"]) expect(names, `${theme} ${t}`).toContain(t);
    }
  });
});

// ── #1649: four surfaces that wore it with nothing running ─────────────────
//
// #1283 cleared the palette: no other token comes within 16 ΔE of --inflight.
// That sweep reads the theme blocks, so it could not see a rule that paints
// --inflight ITSELF somewhere nothing is running. Four did. The context window
// meter and the session summary's tool bars drew their fill from --accent to
// --inflight, so a finished session's bars ended in "running"; the context
// donut turned --inflight between 70% and 90% full, using the running hue as
// its "getting full" warning; and the empty canvas, which shows only when
// nothing is running at all, orbited an --inflight dot around a core lit in
// the dark --inflight's literal #f0abfc and rgba(240,171,252,…) — and in the
// light theme's, rgba(126,34,206,…).

/** Every colour a declaration can paint, with its var() references followed
 *  to the end in `theme` — the theme blocks first, then the bare :root. It is a
 *  scrape of every colour atom, ingredients of a mix included, which is the
 *  strict direction for a sweep that asks what may NOT appear: a stop mixed
 *  from --inflight wears it even if the mix is something else. */
function paintedColours(value: string, theme: Theme, depth = 0): string[] {
  if (depth > 8) throw new Error(`var() cycle in ${value}`);
  const expanded = value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    const v = TOK[theme][name] ?? declFor(":root", name);
    if (v == null) throw new Error(`${theme}: ${name} is declared nowhere`);
    return paintedColours(v, theme, depth + 1).join(" ");
  });
  return expanded.match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b|rgba?\([^)]*\)/gi) ?? [];
}

/** The colour-carrying properties a rule can paint with. */
const PAINTS = ["color", "background", "background-color", "box-shadow", "border", "border-color"];

/** What `selector` paints in `theme`: each property's winning value, where a
 *  light-theme rule for the same selector outranks the base one. */
function paintsOf(selector: string, theme: Theme): string[] {
  return PAINTS.flatMap(prop => {
    const light = theme === "light" ? declFor(`:root[data-theme="light"] ${selector}`, prop) : null;
    const value = light ?? declFor(selector, prop);
    return value == null ? [] : paintedColours(value, theme);
  });
}

describe("nothing at rest paints --inflight itself (#1649)", () => {
  const APART = 16;
  const inflight = (theme: Theme) => parseColor(TOK[theme]["--inflight"]);
  const far = (label: string, colours: string[], theme: Theme) => {
    expect(colours.length, `${theme} ${label} paints nothing this sweep can read`).toBeGreaterThan(0);
    for (const c of colours) {
      const d = deltaE(parseColor(c), inflight(theme));
      expect(d, `${theme} ${label} ${c} — ΔE ${d.toFixed(1)} from --inflight`).toBeGreaterThanOrEqual(APART);
    }
  };

  it("fills the context meter and the summary's tool bars off it", () => {
    // A fill level is a quantity, and it is the same quantity whether or not
    // the session is still running.
    for (const theme of themes) {
      for (const sel of [".ctx-window-fill", ".session-summary .ss-tt-bar-fill"]) far(sel, paintsOf(sel, theme), theme);
    }
  });

  it("warns that the context is filling up in a colour that means attention, not running", () => {
    const donut = readFileSync(fileURLToPath(new URL("../components/ContextModal.tsx", import.meta.url)), "utf8");
    const at = donut.indexOf("export function ContextDonut");
    expect(at).toBeGreaterThan(0);
    const body = donut.slice(at);
    const stroke = /const stroke = ([^;]+);/.exec(body);
    expect(stroke, "the donut's stroke ternary").not.toBeNull();
    const steps = [...stroke![1].matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1]);
    // Three steps up the ramp: --accent while there is room, --err at the
    // ceiling, and between them the one this issue is about.
    expect(steps).toHaveLength(3);
    for (const t of ["--accent", "--err"]) expect(steps).toContain(t);
    for (const theme of themes) {
      far("donut stroke", steps.flatMap(s => paintedColours(`var(${s})`, theme)), theme);
      // And the rest of the ring — its track and its number.
      for (const [, name] of body.matchAll(/var\((--[\w-]+)\)/g)) {
        const colours = paintedColours(`var(${name})`, theme);
        if (colours.length) far(`donut ${name}`, colours, theme);
      }
    }
  });

  it("draws the empty canvas, which only shows when nothing runs, in neither theme's --inflight", () => {
    const hero = SHEET.filter(r => !r.at).flatMap(r => r.selectors).filter(s => s.startsWith(".empty-hero"));
    // The orbits, their dots and the core must all be in the sweep.
    for (const s of [".empty-hero .orbit.r2", ".empty-hero .orbit.r2 .dot", ".empty-hero .core"]) expect(hero, s).toContain(s);
    for (const theme of themes) {
      for (const sel of new Set(hero)) {
        const colours = paintsOf(sel, theme);
        if (colours.length) far(sel, colours, theme);
      }
    }
  });
});
