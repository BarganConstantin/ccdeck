// #583: the usage-history modal was the one surface the deck's contrast work
// never reached, and the reason is the same for both halves of it.
//
// The chart's eight model colours were literal hexes returned from a function
// in UsageHistoryModal.tsx and written straight into `style={{ background }}`.
// They were chosen against the dark canvas — four of them are byte-identical to
// the dark theme's --accent, --ok, --warn and --err — and on white they measured
// 1.40:1 (haiku), 1.44:1 (gpt-5), 1.67:1 (sonnet), 1.69:1 (codex), 1.85:1
// (opus), 1.90:1 (gpt), 1.99:1 (gemini) and 2.56:1 (the fallback) against the
// modal's own --panel. Every one of them under the 3:1 that SC 1.4.11 asks of a
// graphical object you have to see to understand the content, which a bar in a
// bar chart is by definition. `agentColor` in usage-agents.ts was the same
// palette by five cases, on the by-CLI split bar and its key.
//
// Worse, and theme-independently, the palette does not separate its own members:
// sonnet against codex is 1.011:1, haiku against gpt-5 1.027:1, opus against gpt
// 1.028:1, gemini against gpt 1.050:1. Those pairs stack inside one day's bar
// with nothing between them, so a machine running both CLIs drew a day whose
// Sonnet band and Codex band met at a boundary carrying one percent of a
// contrast step — one band, in greyscale, on a projector, or to a reader with
// achromatopsia, and the split the chart exists to show simply absent. That is
// SC 1.4.1 rather than 1.4.11: the defect is that colour was the only channel.
//
// And the range strip: `.uh-range-btn.on` added exactly two declarations to the
// rest state, an --accent-dim wash and a lift from --muted to --text. The wash
// is 1.392:1 over the track in light and 1.895:1 in dark; the word's step is
// 2.403:1 and 2.752:1. No border, no weight, no geometry — no third channel at
// all — so a reader who pressed 90d and looked away could not afterwards tell
// which of the four ranges the chart was showing.
//
// Why nothing caught any of it, which is the half of this fix worth more than
// the palette. Every contrast sweep in this repo reads styles.css and resolves
// var(--…) out of the two :root blocks: contrast-floors, control-edges,
// quiet-signals, session-hue. A bare hex returned from a .tsx and handed to an
// inline style is not in that grammar and enters none of them, and no rule
// added to the sheet could have reached it either — an inline style outranks
// every selector (#357). control-edges' exhaustiveness check, the guard meant to
// make a control impossible to miss, classifies only rules that paint an edge,
// and `.uh-range-btn` declares `border: none` while its on-state declared only
// a background and a colour; a state expressed purely as a fill fell out of that
// check without landing in `unclassified`.
//
// So this file closes the grammar. It reads the colour expressions out of the
// components rather than restating them, resolves each one in both themes the
// way a browser would, and measures it against the beds the stylesheet itself
// names for the elements it is painted on — the same treatment a CSS-declared
// colour already gets. Then it sweeps every inline style in src/web and fails
// if a colour literal reaches one anywhere, directly or through a helper, so the
// next colour composed in JS cannot arrive unmeasured the way these eight did.
//
// Plain node, no DOM — React cannot be rendered in this suite — exactly as
// contrast-floors, session-hue, toggle-state and state-channels do it. The
// helpers are re-declared here rather than imported from a sibling test, since
// importing one registers its suites into this file as well.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));

/** Comments quote the very declarations this file asserts are gone, so every
 *  read of the sheet goes through a stripped copy. */
const css = readFileSync(join(web, "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every module under src/web, tests excluded — the same walk session-hue and
 *  control-edges do, for the same reason: a hand-kept list of four files is a
 *  list the fifth file is not on. */
function modulesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : modulesUnder(path);
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}
const MODULES = modulesUnder(web).map(path => ({
  path: path.slice(web.length),
  // Prose about a colour is not a colour. Both comment forms go before any of
  // the scanning below, so the argument written above `modelColor` — which
  // quotes the hexes it replaced — cannot be mistaken for the code.
  src: readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n"),
}));
const sourceOf = (name: string) => MODULES.find(m => m.path.endsWith(name))!.src;
const historySrc = sourceOf("UsageHistoryModal.tsx");
const agentsSrc = sourceOf("usage-agents.ts");

/** WCAG 1.4.3 for a word, 1.4.11 for a graphic that carries meaning. */
const BODY = 4.5;
const NON_TEXT = 3;
/** CIE76 ΔE below which two bands stop being two hues. The shipped dark set's
 *  closest pair — purple against indigo — sits at 9.6, so this is a floor with
 *  the palette above it rather than a number chosen to fit. */
const HUE_APART = 8;

// ── colour maths ────────────────────────────────────────────────────────────

type Rgba = [number, number, number, number];

/** #rgb, #rrggbb, #rrggbbaa and rgba()/rgb() — every colour form the sheet and
 *  the components between them write. */
function parseColor(input: string): Rgba {
  const s = input.trim();
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) return [+fn[1], +fn[2], +fn[3], fn[4] === undefined ? 1 : +fn[4]];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (!hex) throw new Error(`unparseable colour: ${input}`);
  let h = hex[1];
  if (h.length === 3 || h.length === 4) h = h.replace(/./g, c => c + c);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
}

/** Source-over compositing, non-premultiplied, onto an already-opaque backdrop. */
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

/** WCAG 2.x relative-luminance ratio. Both arguments must already be opaque. */
function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** CIE76 ΔE, for the one question a contrast ratio cannot answer: whether two
 *  bands of near-identical luminance are still two colours. */
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

const RULES = topLevel(css);
const selectors = (list: string) => list.split(",").map(s => s.replace(/\s+/g, " ").trim());

function bodyOf(selector: string): string {
  const hit = RULES.filter(r => selectors(r.selector).includes(selector));
  if (!hit.length) throw new Error(`no rule for ${selector}`);
  return hit.map(r => r.body).join(";");
}

function declIn(body: string, prop: string): string | null {
  const all = [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`, "g"))];
  return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
}
const decl = (selector: string, prop: string) => declIn(bodyOf(selector), prop);

const themes = ["dark", "light"] as const;
type Theme = (typeof themes)[number];

function rootTokens(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of bodyOf(selector).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}
/** Light inherits every token the dark block declares and overrides the ones it
 *  redeclares, which is what the cascade does — the geometry block writes to a
 *  bare :root and belongs to both themes. */
const DARK_TOK = rootTokens(":root");
const TOK: Record<Theme, Record<string, string>> = {
  dark: DARK_TOK,
  light: { ...DARK_TOK, ...rootTokens(':root[data-theme="light"]') },
};

/** var() one level deep, which is every form these sites write. */
function resolve(value: string, theme: Theme): Rgba {
  const v = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
  if (!v) return parseColor(value);
  const raw = TOK[theme][v[1]];
  if (raw === undefined) throw new Error(`${theme} declares no ${v[1]}`);
  return resolve(raw, theme);
}
const tokenNameOf = (value: string) => /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim())?.[1] ?? null;

// ── what the components hand to an inline style ─────────────────────────────

/** The balanced body of `function NAME(…) {…}` in a module. */
function functionBody(src: string, name: string): string {
  const head = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!head) throw new Error(`no function ${name}`);
  const open = src.indexOf("{", src.indexOf(")", head.index));
  return block(src, open)[0];
}

/** Every string a mapping function can hand back, in source order. */
const returnsOf = (src: string, name: string) =>
  [...functionBody(src, name).matchAll(/return\s+"([^"]*)"/g)].map(m => m[1]);

/** The eight, as UsageHistoryModal writes them — read out of the source rather
 *  than restated here, so a ninth model family lands in every sweep below on
 *  the day it is added rather than on the day somebody remembers this file. */
const MODEL_COLOURS = returnsOf(historySrc, "modelColor");
const AGENT_COLOURS = returnsOf(agentsSrc, "agentColor");
const SERIES = [...new Set([...MODEL_COLOURS, ...AGENT_COLOURS])];

/** The literal hexes as they shipped, so the numbers this file opens with have
 *  a baseline that is not this file's own opinion. */
const WAS: Record<string, string> = {
  opus: "#c4b5fd", sonnet: "#7dd3fc", haiku: "#86efac", "gpt-5": "#fcd34d",
  gpt: "#fca5a5", gemini: "#a5b4fc", codex: "#fdba74", fallback: "#94a3b8",
};

/** The beds these colours land on, by the name the sheet gives each surface —
 *  read from the rules that paint them, not restated, for the same reason.
 *    --panel     the modal itself, under every day bar and the top legend
 *    --bg-soft   the day-detail panel, under its legend dots and model meters
 *    --line      the track both meters draw their fills over, which is the bed
 *                that matters most: a partial fill's boundary against its track
 *                is how the length of a meter is read at all. */
const BEDS = {
  panel: tokenNameOf(decl(".uh-modal", "background")!)!,
  detail: tokenNameOf(decl(".uh-detail", "background")!)!,
  track: tokenNameOf(decl(".uh-model-bar", "background")!)!,
};

// ── the maths, against ends everybody already knows ─────────────────────────

describe("the contrast and colour maths", () => {
  it("puts white on black at the 21:1 ceiling and a colour on itself at 1:1", () => {
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#000"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#0b0c10"), parseColor("#0b0c10"))).toBeCloseTo(1, 5);
  });

  it("agrees with the known AA boundary grey — #767676 on white is 4.54:1", () => {
    expect(contrastRatio(parseColor("#767676"), parseColor("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  it("does not care which colour is passed first", () => {
    const a = parseColor("#7dd3fc"), b = parseColor("#14161b");
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });

  it("composites a half-alpha wash to the midpoint of it and its backdrop", () => {
    expect(over([255, 255, 255, 0.5], parseColor("#000000")).slice(0, 3)).toEqual([127.5, 127.5, 127.5]);
    expect(over([255, 255, 255, 0], parseColor("#0f1116"))).toEqual([15, 17, 22, 1]);
  });

  it("scores ΔE at zero for a colour against itself and above it for a hue step", () => {
    expect(deltaE(parseColor("#7dd3fc"), parseColor("#7dd3fc"))).toBeCloseTo(0, 9);
    expect(deltaE(parseColor("#7dd3fc"), parseColor("#fdba74"))).toBeGreaterThan(HUE_APART);
  });
});

// ── the defect, restated as arithmetic ──────────────────────────────────────

describe("what the eight series colours were worth (#583)", () => {
  it("reproduces the table the report tabulated, from the hexes it named", () => {
    const white = parseColor("#ffffff");
    expect(contrastRatio(parseColor(WAS.haiku), white)).toBeCloseTo(1.40, 2);
    expect(contrastRatio(parseColor(WAS["gpt-5"]), white)).toBeCloseTo(1.44, 2);
    expect(contrastRatio(parseColor(WAS.sonnet), white)).toBeCloseTo(1.67, 2);
    expect(contrastRatio(parseColor(WAS.codex), white)).toBeCloseTo(1.69, 2);
    expect(contrastRatio(parseColor(WAS.opus), white)).toBeCloseTo(1.85, 2);
    expect(contrastRatio(parseColor(WAS.gpt), white)).toBeCloseTo(1.90, 2);
    expect(contrastRatio(parseColor(WAS.gemini), white)).toBeCloseTo(1.99, 2);
    expect(contrastRatio(parseColor(WAS.fallback), white)).toBeCloseTo(2.56, 2);
  });

  it("agrees each one was perfectly visible in dark — the palette was not wrong, it was one-sided", () => {
    // Every one of them clears 7:1 on the dark panel. That is the whole shape
    // of the bug: a colour composed for one canvas, in the one place the
    // cascade could not answer for the other.
    for (const [name, hex] of Object.entries(WAS)) {
      expect(contrastRatio(parseColor(hex), parseColor("#14161b")), `dark ${name}`).toBeGreaterThan(7);
    }
  });

  it("reproduces the four pairs the report called out, which no theme can fix", () => {
    expect(contrastRatio(parseColor(WAS.sonnet), parseColor(WAS.codex))).toBeCloseTo(1.01, 2);
    expect(contrastRatio(parseColor(WAS.haiku), parseColor(WAS["gpt-5"]))).toBeCloseTo(1.03, 2);
    expect(contrastRatio(parseColor(WAS.opus), parseColor(WAS.gpt))).toBeCloseTo(1.03, 2);
    expect(contrastRatio(parseColor(WAS.gemini), parseColor(WAS.gpt))).toBeCloseTo(1.05, 2);
  });

  it("shows no re-tune could have bought the pairwise half — the arithmetic forbids it", () => {
    // A chain of n colours each 3:1 from the next needs (L + 0.05) to span
    // 3^(n-1), and sRGB offers 21. So three mutually-3:1 colours exist, four do
    // not, and eight is not close. This is why the fix below is geometry: no
    // palette, in any theme, can separate eight stacked bands by luminance.
    expect(Math.pow(NON_TEXT, 2)).toBeLessThan(21);
    expect(Math.pow(NON_TEXT, 3)).toBeGreaterThan(21);
  });
});

// ── the palette, as the two functions write it now ──────────────────────────

describe("the eight colours answer the theme now, and still say which model they are", () => {
  it("hands the inline style a var() and never a literal, in both functions", () => {
    expect(MODEL_COLOURS.length).toBe(8);
    expect(AGENT_COLOURS.length).toBe(5);
    for (const value of SERIES) {
      expect(tokenNameOf(value), `modelColor/agentColor returned ${value}`).toMatch(/^--usage-/);
    }
  });

  it("keeps the mapping in TypeScript, which is the half JS is the only one that knows", () => {
    // The family test is the thing the cascade cannot do — there is no selector
    // for "the model name contains sonnet". What moved is the value, not the
    // decision, which is exactly the boundary #330 drew for the session hues.
    expect(historySrc).toMatch(/s\.includes\("sonnet"\)\) return "var\(--usage-blue\)"/);
    expect(agentsSrc).toMatch(/case "codex": return "var\(--usage-orange\)"/);
  });

  it("declares every one of them in both themes, since half a token is a light-theme bug", () => {
    for (const value of SERIES) {
      const token = tokenNameOf(value)!;
      for (const theme of themes) {
        expect(TOK[theme][token], `${theme} ${token}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("pins the dark canvas — every dark value is the hex that shipped", () => {
    // #330's rule, and the same reason: this issue is about the light theme,
    // and quietly re-tuning dark on the way past would be a separate call.
    expect(TOK.dark["--usage-purple"]).toBe(WAS.opus);
    expect(TOK.dark["--usage-blue"]).toBe(WAS.sonnet);
    expect(TOK.dark["--usage-green"]).toBe(WAS.haiku);
    expect(TOK.dark["--usage-amber"]).toBe(WAS["gpt-5"]);
    expect(TOK.dark["--usage-red"]).toBe(WAS.gpt);
    expect(TOK.dark["--usage-indigo"]).toBe(WAS.gemini);
    expect(TOK.dark["--usage-orange"]).toBe(WAS.codex);
    expect(TOK.dark["--usage-zinc"]).toBe(WAS.fallback);
  });

  it("keeps the by-CLI strip reading as a summary of the chart above it", () => {
    // Claude's models are the purple band of every daily bar, so Claude's CLI
    // is the purple band of the split; Codex's are the orange ones. The strip
    // is a second key otherwise.
    expect(returnsOf(agentsSrc, "agentColor")[0]).toBe(MODEL_COLOURS[0]);
    expect(returnsOf(agentsSrc, "agentColor")[1]).toBe(MODEL_COLOURS[6]);
    expect(AGENT_COLOURS[4]).toBe(MODEL_COLOURS[7]);
  });
});

describe("every band is visible on the bed the sheet draws it on", () => {
  it("names the three beds out of the stylesheet rather than assuming them", () => {
    expect(BEDS).toEqual({ panel: "--panel", detail: "--bg-soft", track: "--line" });
    // The by-CLI bar's track is the same token, so the two meters share a floor.
    expect(decl(".uh-agent-bar", "background")).toBe("var(--line)");
  });

  it("clears 3:1 against --panel, --bg-soft and --line, in both themes", () => {
    for (const theme of themes) {
      for (const value of SERIES) {
        const band = resolve(value, theme);
        for (const bed of Object.values(BEDS)) {
          const ratio = contrastRatio(band, parseColor(TOK[theme][bed]));
          expect(ratio, `${theme} ${value} on ${bed} — ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(NON_TEXT);
        }
      }
    }
  });

  it("keeps every band opaque, since an alpha tuned for one canvas vanishes on the other", () => {
    for (const theme of themes) for (const value of SERIES) expect(resolve(value, theme)[3]).toBe(1);
  });

  it("inverts polarity between the themes, the way every generated colour here does", () => {
    // On the dark panel a band reads by being brighter than the paper; on white
    // it reads by being darker. If a value ever stopped answering the theme,
    // this is the assertion that says so in one line.
    for (const value of SERIES) {
      expect(relativeLuminance(resolve(value, "dark")),
        `${value} should be lighter than the dark panel`)
        .toBeGreaterThan(relativeLuminance(parseColor(TOK.dark["--panel"])));
      expect(relativeLuminance(resolve(value, "light")),
        `${value} should be darker than the light panel`)
        .toBeLessThan(relativeLuminance(parseColor(TOK.light["--panel"])));
    }
  });
});

describe("no two bands are told apart by luminance, which is why there is a hairline", () => {
  const pairs = SERIES.flatMap((a, i) => SERIES.slice(i + 1).map(b => [a, b] as const));

  it("has 28 pairs to measure, so the sweep is not one colour looking at itself", () => {
    expect(SERIES.length).toBe(8);
    expect(pairs.length).toBe(28);
  });

  it("finds every pair under 3:1 in both themes — the measurement that makes the cut load-bearing", () => {
    // The same shape toggle-state.test.ts uses for the category chips' strike:
    // the geometric channel is justified by proving the colour one cannot carry
    // it. Not a floor to raise — see the 3^(n-1) ceiling above.
    for (const theme of themes) {
      for (const [a, b] of pairs) {
        expect(contrastRatio(resolve(a, theme), resolve(b, theme)), `${theme} ${a} vs ${b}`)
          .toBeLessThan(NON_TEXT);
      }
    }
  });

  it("keeps them apart as hues even so, in both themes", () => {
    for (const theme of themes) {
      for (const [a, b] of pairs) {
        const d = deltaE(resolve(a, theme), resolve(b, theme));
        expect(d, `${theme} ${a} vs ${b} — ΔE ${d.toFixed(1)}`).toBeGreaterThanOrEqual(HUE_APART);
      }
    }
  });

  it("cuts both stacked bars with a hairline, and cuts them in the modal's own paper", () => {
    // The day bar stacks upward and the by-CLI bar sideways, so the offsets
    // differ and the colour does not.
    expect(declIn(bodyOf(".uh-bar-seg"), "box-shadow")).toBe("0 -1px 0 var(--panel)");
    expect(declIn(bodyOf(".uh-agent-seg"), "box-shadow")).toBe("-1px 0 0 var(--panel)");
  });

  it("draws it as a shadow and not a border, so a one-cent band is still its own colour", () => {
    // `*` is border-box and a segment's height is a percentage of the day's
    // cost: a border would come out of that height, and on a $0.01 band inside
    // a $600 day the border would BE the band. A shadow costs the segment
    // nothing — the neighbour above gives up the pixel.
    for (const seg of [".uh-bar-seg", ".uh-agent-seg"]) {
      expect(declIn(bodyOf(seg), "border")).toBeNull();
      expect(declIn(bodyOf(seg), "border-top")).toBeNull();
      expect(declIn(bodyOf(seg), "border-left")).toBeNull();
    }
    // And the overflow that swallows the first segment's copy, so no bar grows
    // a lid and no rounded end grows a notch.
    expect(declIn(bodyOf(".uh-bar"), "overflow")).toBe("hidden");
    expect(declIn(bodyOf(".uh-agent-bar"), "overflow")).toBe("hidden");
  });

  it("makes the cut visible against whichever two bands it lands between", () => {
    // One measurement doing two jobs: the hairline is --panel, and every band
    // already clears 3:1 against --panel, so the floor above IS this floor.
    const hairline = declIn(bodyOf(".uh-bar-seg"), "box-shadow")!.match(/var\(--[\w-]+\)/)![0];
    for (const theme of themes) {
      const line = resolve(hairline, theme);
      for (const value of SERIES) {
        expect(contrastRatio(line, resolve(value, theme)), `${theme} hairline against ${value}`)
          .toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
  });

  it("leaves the legend alone, because a swatch there is never the only channel", () => {
    // Every dot is followed by the model's own name and its cost, and a day's
    // breakdown panel prints the same list in words. The bar is the one place
    // colour stood alone, and the cut is where the fix belongs.
    expect(historySrc).toMatch(/<span className="uh-legend-dot"[^>]*\/>\s*\n\s*\{shortModel\(m\)\}/);
    expect(historySrc).toMatch(/<span className="uh-model-label">\{shortModel\(mb\.modelName\)\}<\/span>/);
  });
});

// ── the range strip ─────────────────────────────────────────────────────────

describe("the selected range is a state you can see (#583)", () => {
  const track = (theme: Theme) => resolve(decl(".uh-range", "background")!, theme);
  const pressed = ".uh-range-btn[aria-pressed=\"true\"]";

  it("reproduces what the on-state used to be worth, in both themes", () => {
    for (const theme of themes) {
      const wash = over(parseColor(TOK[theme]["--accent-dim"]), track(theme));
      const rest = parseColor(TOK[theme]["--muted"]);
      const on = parseColor(TOK[theme]["--text"]);
      expect(contrastRatio(wash, track(theme))).toBeCloseTo(theme === "light" ? 1.392 : 1.895, 3);
      expect(contrastRatio(rest, on)).toBeCloseTo(theme === "light" ? 2.403 : 2.752, 3);
    }
  });

  it("stopped painting itself in --accent-dim, which is a wash and not a state", () => {
    expect(decl(pressed, "background")).toBe("var(--accent)");
    expect(bodyOf(pressed)).not.toMatch(/--accent-dim/);
  });

  it("is keyed on the attribute, so no chip can look selected while announcing nothing", () => {
    // The icon buttons' idiom, from #370. The `on` class went with it — the
    // pixels and the accessibility tree are one fact now.
    expect(css).not.toMatch(/\.uh-range-btn\.on\b/);
    expect(historySrc).toMatch(/aria-pressed=\{rangeDays === p\}/);
    expect(historySrc).toMatch(/className="uh-range-btn"/);
    expect(historySrc).not.toMatch(/uh-range-btn\$\{/);
  });

  /** Composited over the track, always — the defect this replaces was an alpha,
   *  and a wash measured without its backdrop measures as the colour it is not. */
  const fillOn = (theme: Theme) => over(resolve(decl(pressed, "background")!, theme), track(theme));

  it("stands 3:1 or better off the bare track, in both themes", () => {
    for (const theme of themes) {
      const ratio = contrastRatio(fillOn(theme), track(theme));
      expect(ratio, `${theme} pressed fill on the track — ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });

  it("reads its own label at 4.5:1 on that fill — the state is visible AND the word legible", () => {
    for (const theme of themes) {
      const label = resolve(decl(pressed, "color")!, theme);
      const ratio = contrastRatio(label, fillOn(theme));
      expect(ratio, `${theme} pressed label — ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(BODY);
    }
  });

  it("inverts polarity rather than shifting hue — the channel greyscale cannot flatten", () => {
    // The unpressed chip writes a darker word on a lighter track in light and a
    // lighter word on a darker track in dark; the pressed one does the opposite
    // in each. That reversal is what survives every colour vision deficiency and
    // a later re-tune of whichever hue --accent happens to be.
    for (const theme of themes) {
      const restStep = relativeLuminance(resolve(decl(".uh-range-btn", "color")!, theme))
        - relativeLuminance(track(theme));
      const onStep = relativeLuminance(resolve(decl(pressed, "color")!, theme))
        - relativeLuminance(fillOn(theme));
      expect(Math.sign(restStep), theme).toBe(-Math.sign(onStep));
    }
  });

  it("out-specifies the hover it has to survive", () => {
    // `.uh-range-btn:hover` repaints the label in --text, which on the accent
    // fill is 1.72:1 in dark. Class plus attribute ties with class plus
    // pseudo-class, so the pressed chip says it again with the pseudo-class on.
    expect(decl(`${pressed}:hover`, "color")).toBe("var(--bg)");
    expect(decl(".uh-range-btn:hover", "color")).toBe("var(--text)");
  });

  it("did not spend the rest state's contrast to get there", () => {
    expect(decl(".uh-range-btn", "color")).toBe("var(--muted)");
    for (const theme of themes) {
      expect(contrastRatio(resolve("var(--muted)", theme), track(theme)), `${theme} rest label`)
        .toBeGreaterThanOrEqual(BODY);
    }
  });

  it("keeps the press feedback the strip already had", () => {
    expect(decl(".uh-range-btn:active", "transform")).toBe("scale(0.97)");
  });
});

// ── the blind spot, closed ──────────────────────────────────────────────────

/** Top-level parts of `s`, split on `sep`, ignoring separators nested inside
 *  brackets, braces, parens or any string. */
function topLevelParts(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = "", buf = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      buf += c;
      if (c === "\\") { buf += s[++i] ?? ""; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; buf += c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (c === sep && depth === 0) { out.push(buf); buf = ""; continue; }
    buf += c;
  }
  out.push(buf);
  return out.filter(p => p.trim() !== "");
}

/** Every `style={{ … }}` and `style: { … }` object literal in a module. */
function inlineStyleObjects(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bstyle\s*(?:=\{\{|:\s*\{)/g)) {
    const open = m.index + m[0].lastIndexOf("{");
    out.push(block(src, open)[0]);
  }
  return out;
}

/** The CSS properties whose value is, or can contain, a colour. A property not
 *  on this list cannot carry one, so a width or a transform never lands here. */
const COLOUR_PROPS = new Set([
  "background", "backgroundColor", "backgroundImage", "color", "border",
  "borderColor", "borderTop", "borderRight", "borderBottom", "borderLeft",
  "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
  "outline", "outlineColor", "boxShadow", "textShadow", "fill", "stroke",
  "caretColor", "textDecorationColor", "columnRuleColor", "accentColor",
]);

/** A colour written out rather than named: a hex, an rgb()/hsl() with numbers
 *  in it, or one of the CSS colour keywords somebody might plausibly type. The
 *  keyword list is not all 148 of them — it is the ones a developer reaches for
 *  — because the defect this guards against is a hex, and the keywords are the
 *  cheap extra mile. `transparent` and `currentColor` are not colours in this
 *  sense: neither one can be wrong in a theme.
 *
 *  A var() reference is deleted before the test rather than exempted after it,
 *  because half these token names ARE colour words: `var(--usage-purple)` has
 *  to read as a reference and not as the word purple. What the property hands
 *  over once the references are gone is what this file is asking about. */
const NAMED = "black|white|red|green|blue|yellow|orange|purple|violet|indigo|pink|"
  + "brown|grey|gray|cyan|magenta|teal|navy|olive|maroon|silver|gold|lime|aqua|"
  + "salmon|coral|crimson|khaki|lavender|plum|orchid|turquoise|tomato|tan|beige|"
  + "azure|ivory|wheat|slateblue|skyblue|steelblue|seagreen|firebrick|chocolate";
const COLOUR_RE = new RegExp(`#[0-9a-fA-F]{3,8}\\b|\\brgba?\\s*\\(|\\bhsla?\\s*\\(|\\b(?:${NAMED})\\b`);
const isColourLiteral = (s: string) => COLOUR_RE.test(s.replace(/var\(\s*--[\w-]+\s*\)/g, ""));

/** Every string literal inside the declaration of `name`, wherever in src/web
 *  it lives — one level of indirection, which is all these sites use: a
 *  `modelColor(m)` call, a `const color = … ? … : …`, a `{ color }` shorthand.
 *  Strings that are not colours (a model family to match on, a class name) fall
 *  out at the COLOUR_LITERAL test rather than here. */
function literalsBehind(name: string, corpus: string[]): string[] {
  const out: string[] = [];
  for (const src of corpus) {
    const fn = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
    if (fn) out.push(block(src, src.indexOf("{", src.indexOf(")", fn.index)))[0]);
    for (const m of src.matchAll(new RegExp(`(?:const|let|var)\\s+${name}\\b[^=\\n]*=([^;\\n]*(?:\\n\\s{4,}[^;\\n]*)*)`, "g"))) {
      out.push(m[1]);
    }
  }
  return out.flatMap(body => [...body.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)].map(m => m[1] ?? m[2]));
}
const CORPUS = MODULES.map(m => m.src);

/** One colour a component hands to an inline style, and everywhere its value
 *  could have come from. */
interface InlineColour { file: string; prop: string; expression: string; sources: string[] }

function inlineColours(file: string, src: string, corpus = CORPUS): InlineColour[] {
  const out: InlineColour[] = [];
  for (const obj of inlineStyleObjects(src)) {
    for (const part of topLevelParts(obj, ",")) {
      const colon = topLevelParts(part, ":");
      // `{ color }` is a shorthand: the key is the key and the value too.
      const prop = colon[0].trim().replace(/^\[|\]$|["']/g, "");
      const expression = (colon.length > 1 ? part.slice(part.indexOf(":") + 1) : part).trim();
      if (!COLOUR_PROPS.has(prop)) continue;
      const strings = [...expression.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)].map(m => m[1] ?? m[2] ?? m[3]);
      const names = [...expression.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map(m => m[1]);
      out.push({
        file, prop, expression,
        sources: [...strings, ...names.flatMap(n => literalsBehind(n, corpus))],
      });
    }
  }
  return out;
}

const INLINE = MODULES.flatMap(m => inlineColours(m.path, m.src));

describe("the sweep that could not see a .tsx literal, which is why none of this was caught", () => {
  it("finds the colours the components set inline at all", () => {
    // Six of them are this modal's — the day bars' segments, both legend dots,
    // the per-CLI share bar and the per-model bar fill — and the rest are the
    // deck's. If this number collapses, the scanner broke and every assertion
    // below went vacuous with it.
    expect(INLINE.length).toBeGreaterThanOrEqual(10);
    const modal = INLINE.filter(c => c.file.endsWith("UsageHistoryModal.tsx"));
    expect(modal.length).toBe(6);
    expect(new Set(modal.map(c => c.prop))).toEqual(new Set(["background"]));
  });

  it("resolves a mapping function's returns rather than stopping at the call", () => {
    // The indirection is the whole reason the existing sweeps missed this:
    // `background: modelColor(mb.modelName)` mentions no colour at all.
    const seg = INLINE.find(c => c.expression === "modelColor(mb.modelName)")!;
    expect(seg.sources).toEqual(expect.arrayContaining(["var(--usage-purple)", "var(--usage-zinc)"]));
    const share = INLINE.find(c => c.expression === "agentColor(a.id)")!;
    expect(share.sources).toEqual(expect.arrayContaining(["var(--usage-orange)"]));
  });

  it("would fail on a hard-coded hex in an inline style, which is the shape that shipped", () => {
    // The detector, run against the code as it was. Vacuous otherwise: a sweep
    // that cannot fail is a sweep that says nothing about the code that passes.
    const before = 'const x = <div style={{ background: modelColorWas(m) }} />;'
      + '\nfunction modelColorWas(m: string): string { return "#c4b5fd"; }';
    const found = inlineColours("fixture.tsx", before, [before]);
    expect(found).toHaveLength(1);
    expect(found[0].sources.some(isColourLiteral), "a hex behind a call has to be found")
      .toBe(true);
    // A hex written straight into the object is the same finding.
    const direct = 'const x = <div style={{ background: "#c4b5fd" }} />;';
    expect(inlineColours("f.tsx", direct, [direct])[0].sources.some(isColourLiteral)).toBe(true);
    // …and the same shape passes once the value is a token, colour-word name
    // and all, which is what says the var() stripping is doing its job.
    const after = 'const x = <div style={{ background: "var(--usage-purple)" }} />;';
    expect(inlineColours("f.tsx", after, [after])[0].sources.some(isColourLiteral)).toBe(false);
  });

  it("lets no colour literal reach an inline style anywhere in src/web", () => {
    const offenders = INLINE.flatMap(c =>
      c.sources.filter(isColourLiteral).map(s => `${c.file} ${c.prop}: ${c.expression} → ${s}`));
    expect(offenders).toEqual([]);
  });

  it("holds every token that reaches one to being declared in both themes", () => {
    // The other half of the same rule. A value the cascade owns is only worth
    // owning if both cascades declare it; a token that exists in dark alone is
    // the same defect wearing a var().
    const missing: string[] = [];
    for (const c of INLINE) {
      for (const s of [...c.sources, c.expression]) {
        for (const [, token] of s.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
          for (const theme of themes) {
            if (TOK[theme][token] === undefined) missing.push(`${theme} ${token} (${c.file})`);
          }
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
