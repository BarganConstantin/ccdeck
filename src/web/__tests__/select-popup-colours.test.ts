// On Windows and Linux, a select's option list was white with light text in
// the dark theme.
//
// Everywhere but macOS, Chromium (and so the desktop app) draws the list a
// <select> opens as a small page of its own; on macOS the platform's menu draws
// it, which is why the defect never showed there. That page's body is white,
// always: its own stylesheet says `background-color: white` and nothing about a
// theme. Over it goes the select's computed background-color and colour, and
// over those each optgroup's and option's own, but only where one is set, is
// not transparent and is not the colour already beneath it.
//
// Every select in the deck fills itself with a wash mixed toward transparent:
// --sm-fill is 5% of --text, --ctl-fill 7%, the order picker's `none` nothing at
// all. On the panel that is a surface a hair above it; on that white page it is
// white. The words were the select's own colour, which in the dark theme is a
// light grey, so the Sounds menu's Tone list read "Two notes", "Ascent", "Bell"
// and the Custom group's label at 1.38:1, and only the highlighted row could be
// read. The order picker had met this already and painted its own options;
// the other six had not, so that rule is every select's now.
//
// So this paints each row the way that page does (white, then the select, then
// the optgroup, then the option) for every select the deck renders, at rest and
// in the states it is opened from, in both themes, and holds the words to 4.5:1
// on what is under them. It also holds the other half: the popup takes its
// color-scheme from the select, so the select has to carry the deck's own
// theme and not leave the choice to the OS.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import { cascade, el, mediaApplies, selects, sheetRules, splitTop, type El } from "./sheet-cascade";
import { openTags } from "./tsx-scan";

/** WCAG 1.4.3: an option's label is body text. */
const BODY = 4.5;
const WIDTH = 1280;
const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

type Rgba = [number, number, number, number];

/** The popup page's own body, in Chromium's picker stylesheet. */
const POPUP_PAGE: Rgba = [255, 255, 255, 1];

const WEB = fileURLToPath(new URL("..", import.meta.url));

const html = (theme: Theme) => el("html", [], { states: ["root"], attrs: { "data-theme": theme } });

/** Every select the deck renders, by the file that renders it, as the sheet
 *  sees it: its ancestors' classes, then its own. */
const SELECTS: Record<string, Array<{ name: string; chain: El[] }>> = {
  "components/TelemetryCapture.tsx": [{ name: "telemetry signal", chain: [el("body"), el("div", ["modal", "tr-modal"]), el("div", ["tr-body"]), el("div", ["tr-telemetry"]), el("div", ["tr-workspace"]), el("section", ["tr-feed"]), el("div", ["tr-filter"]), el("label"), el("select", ["tr-select"])] }],
  "components/ToneSection.tsx": [{
    name: "a tone's figure",
    chain: [el("body"), el("div", ["modal", "settings-modal"]), el("div", ["settings-body"]), el("div", ["settings-pane"]), el("div", ["sm-sounds"]), el("div", ["sm-tones"]), el("section", ["sm-tone"]), el("div", ["sm-row"]), el("select", ["sm-select"])],
  }],
  "components/SpokenVoiceForm.tsx": [{
    name: "a spoken voice",
    chain: [el("body"), el("div", ["modal", "settings-modal"]), el("div", ["settings-body"]), el("div", ["settings-pane"]), el("div", ["sm-sounds"]), el("section", ["sm-custom"]), el("details", ["sm-voice"]), el("div", ["sm-voice-fields"]), el("label"), el("select", ["sm-select"])],
  }],
  "components/BrowserWatchSettings.tsx": [
    { name: "Browser Watch's quiet time", chain: [el("body"), el("div", ["bw-settings"]), el("label"), el("select")] },
    { name: "Browser Watch's reaction", chain: [el("body"), el("div", ["bw-settings"]), el("label"), el("select")] },
  ],
  "components/OtherAccounts.tsx": [{
    name: "the other accounts' order",
    chain: [el("body"), el("aside", ["accounts-panel"]), el("div", ["ap-rest-tools"]), el("span", ["ap-rest-sort"]), el("select")],
  }],
  "components/AutoSwitchPolicy.tsx": [{
    name: "the auto-switch threshold",
    chain: [el("body"), el("aside", ["accounts-panel"]), el("div", ["ap-policy-block"]), el("div", ["ap-policy"]), el("span", ["ap-field"]), el("select")],
  }],
  "components/AccountMenuPopover.tsx": [{
    name: "an account's slot",
    chain: [el("body"), el("aside", ["accounts-panel"]), el("div", ["ap-pop"]), el("div", ["ap-pop-form"]), el("span", ["ap-field"]), el("select")],
  }],
};

/** The states a list is opened from: a click, which hovers, and a key, which
 *  focuses. */
const OPENED_FROM: Record<string, string[]> = {
  "at rest": [],
  "hovered": ["hover"],
  "focused from the keyboard": ["focus", "focus-visible"],
  "hovered and focused": ["hover", "focus", "focus-visible"],
};

/** The rows of an open list: an option, a group's label, an option in a group. */
const ROWS: Record<string, El[]> = {
  "an option": [el("option")],
  "a group's label": [el("optgroup")],
  "an option in a group": [el("optgroup"), el("option")],
};

function inTheme(chain: El[], theme: Theme, states: string[] = []): El[] {
  const select = chain.at(-1)!;
  return [html(theme), ...chain.slice(0, -1), { ...select, states: [...select.states, ...states] }];
}

/** `selects`, less one thing it hands back to its caller: a subject it cannot
 *  read (`:nth-child`, a sibling inside `:is()`) under an ancestor that carries
 *  a class nothing in this chain has. That rule cannot reach a select or its
 *  rows, so it is not read; anything else unreadable, a sibling combinator
 *  outside a pseudo-class among it, still throws. */
function matching(chain: El[]): (selector: string) => number | null {
  const classes = new Set(chain.flatMap(e => e.classes));
  return selector => {
    try {
      return selects(selector, chain);
    } catch (err) {
      const steps = splitTop(selector.replace(/\s*([>+~])\s*/g, " $1 "), " ").filter(Boolean);
      if (steps.includes("+") || steps.includes("~")) throw err;
      const ancestors = steps.slice(0, -1).filter(step => step !== ">")
        .map(step => step.replace(/:[\w-]+\((?:[^()]|\([^()]*\))*\)/g, "").replace(/\[[^\]]*\]/g, ""));
      const unreachable = ancestors.some(a => [...a.matchAll(/\.([\w-]+)/g)].some(m => !classes.has(m[1])));
      if (unreachable) return null;
      throw err;
    }
  };
}

/** One chain as a key: every row asks the same ancestors the same questions. */
const keyOf = (chain: El[]) => chain.map(e => `${e.tag}.${e.classes.join(".")}${JSON.stringify(e.attrs)}:${e.states.join(":")}`).join(" > ");

const declaredOn = new Map<string, string | null>();

/** A declared value on `chain`'s last element, or null. */
function own(chain: El[], prop: string): string | null {
  const key = `${keyOf(chain)} | ${prop}`;
  if (!declaredOn.has(key)) declaredOn.set(key, cascade(matching(chain), prop, WIDTH));
  return declaredOn.get(key)!;
}

/** A custom property as the last element of `chain` sees it, resolved where it
 *  was declared, as a browser computes it. */
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
  if (got == null) throw new Error(`${name} is not defined on ${chain.at(-1)!.tag}`);
  return vars(value.slice(0, at) + got + value.slice(end + 1), chain);
}

/** An inherited property on `chain`'s last element: its own, or the nearest
 *  ancestor's. */
function inherited(chain: El[], prop: string): string | null {
  for (let j = chain.length; j > 0; j--) {
    const v = own(chain.slice(0, j), prop);
    if (v != null && v !== "inherit") return vars(v, chain.slice(0, j));
  }
  return null;
}

/** The background colour the cascade gives `chain`'s last element, from the
 *  longhand or the shorthand, whichever wins. Not inherited. */
const paintedOn = new Map<string, Rgba>();

function background(chain: El[]): Rgba {
  const key = keyOf(chain);
  if (!paintedOn.has(key)) paintedOn.set(key, backgroundUncached(chain));
  return paintedOn.get(key)!;
}

function backgroundUncached(chain: El[]): Rgba {
  let best: { spec: number; order: number; value: string } | null = null;
  for (const r of sheetRules()) {
    if (!mediaApplies(r.media, WIDTH)) continue;
    const decl = [...r.body.matchAll(/(?:^|[;\s])background(?:-color)?\s*:\s*([^;]+)/g)].at(-1);
    if (!decl) continue;
    const select = matching(chain);
    for (const s of r.selectors) {
      const spec = select(s);
      if (spec == null) continue;
      if (!best || spec > best.spec || (spec === best.spec && r.order > best.order)) best = { spec, order: r.order, value: decl[1].trim() };
    }
  }
  return colour(vars(best?.value ?? "transparent", chain));
}

/** #rgb / #rrggbb, `transparent` / `none`, and CSS Color 5's
 *  `color-mix(in srgb, …)`, alpha kept: what these rules are written in. */
function colour(v: string): Rgba {
  const s = v.trim();
  if (s === "transparent" || s === "none") return [0, 0, 0, 0];
  const mix = /^color-mix\(in srgb,\s*(.*)\)$/.exec(s);
  if (mix) {
    const [a, b] = splitTop(mix[1]).map(part => {
      const m = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(part.trim())!;
      return { c: colour(m[1]), p: m[2] == null ? null : +m[2] / 100 };
    });
    const pa = a.p ?? (b.p == null ? 0.5 : 1 - b.p);
    const pb = b.p ?? 1 - pa;
    const wa = (pa / (pa + pb)) * a.c[3];
    const wb = (pb / (pa + pb)) * b.c[3];
    const alpha = wa + wb;
    const rgb = [0, 1, 2].map(i => (alpha === 0 ? 0 : (a.c[i] * wa + b.c[i] * wb) / alpha));
    return [rgb[0], rgb[1], rgb[2], alpha * Math.min(1, pa + pb)];
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!hex) throw new Error(`unread colour: ${v}`);
  const h = hex[1].length === 3 ? hex[1].replace(/./g, c => c + c) : hex[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}

const over = (fg: Rgba, bg: Rgba): Rgba => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as Rgba;
const same = (a: Rgba, b: Rgba) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);

function contrast(a: Rgba, b: Rgba): number {
  const lum = (c: Rgba) => {
    const [r, g, bl] = c.slice(0, 3).map(x => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** One row of the open list as Chromium paints it: the page, the select over
 *  it, then each element down to the row whose background is set, not
 *  transparent and not its parent's; and the row's own colour on top. */
function paintedRow(select: El[], row: El[]): { ink: Rgba; bed: Rgba } {
  let parent = background(select);
  let bed = over(parent, POPUP_PAGE);
  let chain = select;
  for (const e of row) {
    chain = [...chain, e];
    const fill = background(chain);
    if (fill[3] > 0 && !same(fill, parent)) bed = over(fill, bed);
    parent = fill;
  }
  const ink = colour(inherited(chain, "color") ?? "transparent");
  return { ink: over(ink, bed), bed };
}

/** Every .tsx under src/web, tests aside, relative to it and written with
 *  forward slashes on every platform, as SELECTS names them. */
function sources(dir = WEB): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === "__tests__" || name === "node_modules") return [];
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".tsx") ? [relative(WEB, path).split(sep).join("/")] : [];
  });
}

describe("draws a select's option list in the deck's own theme, not the OS's", () => {
  it("knows every select the deck renders", () => {
    const counts = Object.fromEntries(sources()
      .map(file => [file, openTags(readFileSync(join(WEB, file), "utf8"), ["select"]).length] as const)
      .filter(([, n]) => n > 0));
    const known = Object.fromEntries(Object.entries(SELECTS).map(([file, list]) => [file, list.length]));
    expect(counts).toEqual(known);
  });

  for (const theme of THEMES) {
    for (const [file, list] of Object.entries(SELECTS)) {
      for (const { name, chain } of list) {
        it(`reads ${name}'s list at ${BODY}:1 in the ${theme} theme (${file})`, () => {
          const misses: string[] = [];
          for (const [opened, states] of Object.entries(OPENED_FROM)) {
            const select = inTheme(chain, theme, states);
            for (const [rowName, row] of Object.entries(ROWS)) {
              const { ink, bed } = paintedRow(select, row);
              const ratio = contrast(ink, bed);
              if (ratio < BODY) misses.push(`${rowName}, ${opened}: ${ratio.toFixed(2)}:1`);
            }
          }
          expect(misses).toEqual([]);
        });

        it(`opens ${name}'s list in the deck's ${theme} color-scheme (${file})`, () => {
          expect(inherited(inTheme(chain, theme), "color-scheme")).toBe(theme);
        });
      }
    }
  }
});
