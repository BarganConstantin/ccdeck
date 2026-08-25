// #539: the usage-history chart drew one <button> per day and then made most of
// those buttons too small to press.
//
// Every column in that chart is a real control — `onClick`, `aria-pressed`, its
// own tab stop, an `aria-label` reading the date and the money — and clicking
// one is the only way to open the per-day breakdown panel underneath it. So
// every column owes SC 2.5.8 a 24px short side. The width it actually got is
// arithmetic off two declarations: `.uh-modal` is `min(760px, 100%)` with 18px
// of padding a side, which under the sheet's global `box-sizing: border-box` is
// a 724px content box, and each column's `flexBasis` is `100 / days.length %`
// of that with `min-width: 0` letting flex shrink it the rest of the way. The
// four presets are 7, 14, 30 and 90 days, and what came out was
//
//     7d    (724 - 6)  / 7  = 102.57px
//     14d   (724 - 13) / 14 =  50.79px
//     30d   (724 - 29) / 30 =  23.17px
//     90d   (724 - 89) / 90 =   7.06px
//
// — the bottom two under the floor, and one of them the preset the modal opens
// on. The spacing exception that excuses an undersized target could not cover
// either, because the next day's button started 1px away. At 90d that is ninety
// 7px buttons in a row: a pointer aimed at a day lands on its neighbour and the
// panel below answers for a date nobody picked, which looks exactly like an
// answer rather than like a miss.
//
// The fix is two declarations and it is deliberately arithmetic rather than a
// number somebody typed: a 24px `min-width` floor on the column, and the
// removal of the chart's `gap: 1px`, which is precisely what would have pushed
// the DEFAULT preset over — 30 × 24 is 720 and fits inside 724, 720 plus 29px
// of gap is 749 and does not. What is left over at 90d is a chart wider than
// its box, and `overflow-x: auto` on the chart is what keeps that overflow off
// the dialog, which declares `overflow: auto` and would otherwise have become
// the sideways scroller itself.
//
// This suite runs in plain node — no DOM, no layout engine — the way
// panel-overflow.test.ts and panel-rhythm.test.ts do, so none of the widths
// above can be measured here. What it does instead is re-derive them from the
// stylesheet on every run: the modal's cap, its padding, the chart's gap and
// the column's floor are all read out of styles.css and the presets out of the
// component, so the day somebody narrows the modal or adds a 180d preset this
// file recomputes rather than going stale against a number it had memorised.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
const css = read("../styles.css");
const historySrc = read("../components/UsageHistoryModal.tsx");

/** The rule comments quote the declarations they retired — `gap: 1px` and
 *  `min-width: 0` are both written out a few lines above the rule that replaced
 *  them — so every read below is of the stripped text. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");

const bare = strip(css);
const history = strip(historySrc);

// ── the stylesheet, as rules ────────────────────────────────────────────────

/** The `{…}` opened at `open`, and the index of its closing brace. */
function block(src: string, open: number): [string, number] {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [src.slice(open + 1, i), i];
  }
  throw new Error("unbalanced braces in styles.css");
}

/** Top-level rules only, in source order. Nothing in this chart's geometry is
 *  declared inside a @media block, and a @media body is a different cascade. */
function topLevel(src: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const prelude = src.slice(i, open).replace(/\s+/g, " ").trim();
    const [inner, end] = block(src, open);
    if (!prelude.startsWith("@")) out.push({ selector: prelude, body: inner });
    i = end + 1;
  }
  return out;
}

const RULES = topLevel(bare);
const selectors = (list: string) => list.split(",").map(s => s.replace(/\s+/g, " ").trim());

/** Every top-level rule naming this exact selector, concatenated in source
 *  order — one element's cascade, however many rules the sheet spends on it. */
function bodyOf(selector: string): string {
  const hit = RULES.filter(r => selectors(r.selector).includes(selector));
  if (!hit.length) throw new Error(`no rule for ${selector}`);
  return hit.map(r => r.body).join(";");
}

/** The last declaration of `prop` in a body, which is the one that wins. */
function declIn(body: string, prop: string): string | null {
  const all = [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`, "g"))];
  return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
}

const decl = (selector: string, prop: string) => declIn(bodyOf(selector), prop);

/** A CSS length in px, or NaN for anything else. A bare `0` is a length too,
 *  and a chart with no gap is allowed to say so by saying nothing. */
const px = (value: string | null) => {
  const m = /^(-?[\d.]+)(px)?$/.exec((value ?? "").trim());
  return m && (m[2] || +m[1] === 0) ? +m[1] : NaN;
};

/** The px term inside a `min()` — the cap, which is the width this modal has on
 *  any window wide enough to give it one. `min(760px, 100%)` is 760. */
const capPx = (value: string | null) => {
  const m = /min\(\s*(-?[\d.]+)px\s*,/.exec(value ?? "");
  return m ? +m[1] : px(value);
};

// ── the geometry, derived rather than remembered ────────────────────────────

/** The 24px short side SC 2.5.8 asks of a pointer target. The one number in
 *  this file that is not read out of the source, because it is not this app's
 *  number to choose — the sheet argues for it in prose at `.ver-close`,
 *  `.ap-more` and `.detail-reopen`, and panel-rhythm.test.ts pins four other
 *  controls to it. */
const FLOOR = 24;

/** The modal's content box, derived the way the browser derives it. */
const modalWidth = capPx(decl(".uh-modal", "width"));
const modalPadding = decl(".uh-modal", "padding")!.split(/\s+/);
/** `16px 18px 20px` — three values, so left and right are both the second. */
const padSide = px(modalPadding[modalPadding.length === 1 ? 0 : 1]);
const contentWidth = modalWidth - 2 * padSide;

/** Absent means none. `gap` is the declaration #539 removed, and its removal is
 *  half of why the default preset still fits, so it is read rather than
 *  assumed. */
const chartGap = px(declIn(bodyOf(".uh-chart"), "gap") ?? "0");
const columnFloor = px(declIn(bodyOf(".uh-bar-col"), "min-width") ?? "0");

/** The presets, out of the component. Four today; the loops below do not care
 *  how many there are or what they are. */
const PRESETS = JSON.parse(
  /const PRESETS = (\[[^\]]*\])/.exec(history)![1],
) as number[];

/** What flex would give a column with nothing stopping it: an equal share of
 *  what is left after the gaps. This is the number the defect was. */
const share = (n: number) => (contentWidth - chartGap * (n - 1)) / n;

/** What a column actually measures: the share, or the floor if the share is
 *  under it. `min-width` is a hard stop in flex layout — the shrink algorithm
 *  clamps to it and the container overflows instead. */
const columnWidth = (n: number) => Math.max(columnFloor, share(n));

/** The whole row of columns plus the gaps between them, against the box that
 *  has to hold it. Positive means the chart overflows and has to scroll. */
const rowOverflow = (n: number) => columnWidth(n) * n + chartGap * (n - 1) - contentWidth;

const round = (v: number) => Math.round(v * 100) / 100;

// ── 1. the premise ──────────────────────────────────────────────────────────

describe("the box the chart has to fit its days into", () => {
  it("is a border box, which is what makes a 760px modal a 724px chart", () => {
    // Every number in this file assumes the declared width IS the border box.
    // The sheet says so once, globally, and the arithmetic is wrong without it.
    expect(bodyOf("*")).toMatch(/box-sizing\s*:\s*border-box/);
    expect(Number.isNaN(modalWidth)).toBe(false);
    expect(Number.isNaN(padSide)).toBe(false);
    expect(contentWidth).toBe(724);
  });

  it("holds four presets, and the widest of them is the one that cannot fit", () => {
    // Read from the component so the sweep below is over what the modal really
    // offers. 90 days at the floor is 2160px, which no modal this app could
    // sensibly draw is going to contain — which is the whole reason the answer
    // here is a scroll and not a smaller bar.
    expect(PRESETS.length).toBeGreaterThanOrEqual(2);
    expect(PRESETS).toContain(30);
    expect(Math.max(...PRESETS) * FLOOR).toBeGreaterThan(contentWidth);
  });

  it("puts a real control in every one of those columns", () => {
    // If the column ever stopped being a button, the floor below would be a
    // rule about a decoration and this file would be pinning nothing. It is a
    // button, it toggles the breakdown panel, and it takes its width from an
    // equal share of the chart.
    expect(history).toMatch(/className=\{`uh-bar-col\$\{isSel \? " sel" : ""\}`\}/);
    expect(history).toMatch(/onClick=\{\(\) => setSelected\(isSel \? null : d\.period\)\}/);
    expect(history).toMatch(/aria-pressed=\{isSel\}/);
    expect(history).toMatch(/flexBasis: `\$\{100 \/ days\.length\}%`/);
  });
});

// ── 2. the floor ────────────────────────────────────────────────────────────

describe("every day in the chart is a target somebody can hit", () => {
  it("clears the 24px floor at every preset the modal offers", () => {
    // The assertion this file exists for. Recomputed from the sheet on every
    // run, so narrowing the modal or adding a preset fails here rather than
    // shipping another 7px button.
    for (const n of PRESETS) {
      expect(round(columnWidth(n)), `${n}d: ${round(columnWidth(n))}px per column`)
        .toBeGreaterThanOrEqual(FLOOR);
    }
  });

  it("gets there from a floor in the sheet, not from a chart that happens to be wide", () => {
    // Naming the mechanism, because the presets that need it are the presets a
    // future change is most likely to disturb. Without the floor the share is
    // what it always was — 23.17px and 7.06px — and both are failures.
    expect(columnFloor).toBeGreaterThanOrEqual(FLOOR);
    const needFloor = PRESETS.filter(n => share(n) < FLOOR);
    expect(needFloor, "no preset is short, so the floor is not doing anything")
      .not.toEqual([]);
    for (const n of needFloor) expect(columnWidth(n)).toBe(columnFloor);
  });

  it("cannot be capped back under it by anything else the sheet says", () => {
    // A `width` or a `max-width` on the same element would beat the floor
    // outright, and a second `min-width` further down the sheet would replace
    // it. Swept over every rule whose subject is the column rather than over
    // the one rule this file knows about.
    const escapes: string[] = [];
    for (const rule of RULES) {
      for (const sel of selectors(rule.selector)) {
        const subject = sel.split(/[\s>+~]+/).filter(Boolean).pop() ?? "";
        if (!/^\.uh-bar-col\b/.test(subject)) continue;
        for (const prop of ["width", "max-width"]) {
          const value = declIn(rule.body, prop);
          if (value !== null) escapes.push(`${sel} { ${prop}: ${value} }`);
        }
        const floor = declIn(rule.body, "min-width");
        if (floor !== null && px(floor) < FLOOR) escapes.push(`${sel} { min-width: ${floor} }`);
      }
    }
    expect(escapes).toEqual([]);
  });
});

// ── 3. what the floor costs, and where the cost is paid ─────────────────────

describe("the chart is the box that scrolls, and only when it has to", () => {
  it("leaves the preset the modal opens on exactly where it was", () => {
    // 30 columns of 24.13px in 724px, edge to edge, no scrollbar. This is the
    // half of the fix that is easy to lose: reinstate the chart's gap and the
    // default view gains a horizontal scrollbar for the sake of 25px.
    const defaultPreset = 30;
    expect(PRESETS).toContain(defaultPreset);
    expect(history).toMatch(/useState\(30\)/);
    expect(rowOverflow(defaultPreset)).toBeLessThanOrEqual(0);
    // And says why: with a 1px gap between the columns it would not.
    const withGap = FLOOR * defaultPreset + 1 * (defaultPreset - 1);
    expect(withGap).toBeGreaterThan(contentWidth);
    expect(chartGap).toBe(0);
  });

  it("declares the scroll on the chart, so the dialog is not the thing that slides", () => {
    // `.uh-modal` already scrolls, so an overflow left unclaimed in here would
    // have been the dialog's: header, totals strip and legend sliding out from
    // under the pointer on the way to the far end of a chart. Same lesson as
    // #369, one modal over.
    expect(decl(".uh-modal", "overflow")).toBe("auto");
    expect(declIn(bodyOf(".uh-chart"), "overflow-x")).toBe("auto");
    // Only the presets that cannot fit actually draw a scrollbar; `auto` is
    // what makes that true, and the arithmetic says which ones they are.
    expect(PRESETS.some(n => rowOverflow(n) > 0), "nothing overflows, so nothing scrolls").toBe(true);
    expect(PRESETS.some(n => rowOverflow(n) <= 0), "every preset scrolls, which is not the fix").toBe(true);
  });

  it("keeps the keyboard's ring inside the scroll container that would clip it", () => {
    // `overflow-x: auto` computes `overflow-y` to `auto` as well and both clip
    // at the padding box, so the shared `button:focus-visible` ring — 2px at
    // `outline-offset: 1px` — would lose its top on every column and its outer
    // edge on the first and the last. `.canvas-wrap:focus-visible` inset its
    // ring for the same reason.
    const offset = px(decl(".uh-bar-col:focus-visible", "outline-offset"));
    expect(offset).toBeLessThan(0);
    // The ring is the deck's one ring; only where it sits changes.
    expect(declIn(bodyOf(".uh-bar-col:focus-visible"), "outline")).toBeNull();
    expect(decl(":focus-visible", "outline")).toBe("2px solid var(--accent)");
    // And the whole band still fits inside the narrowest column there can be.
    const ring = px(/(-?[\d.]+)px/.exec(decl(":focus-visible", "outline")!)![0]);
    expect(-offset + ring).toBeLessThan(columnFloor / 2);
  });

  it("opens the scroller on today rather than three months ago", () => {
    // A scroller left where the browser puts it starts at scrollLeft 0, which
    // at 90d is the oldest thirty days of the range — the wrong end of a panel
    // read for what was spent recently. Parked before paint, so there is no
    // frame of the far past to see, and keyed on the days themselves so a new
    // range lands already scrolled.
    expect(history).toMatch(/const chartRef = useRef<HTMLDivElement>\(null\)/);
    expect(history).toMatch(/<div ref=\{chartRef\} className="uh-chart"/);
    expect(history).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]*?el\.scrollLeft = el\.scrollWidth;[\s\S]*?\}, \[days\]\)/);
  });
});
