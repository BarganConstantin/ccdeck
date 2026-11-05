// The rating question made room for the right rail with padding: 306px of it
// with one rail panel open and 606px with both, from a viewport media query
// that knew nothing of the detail panel or the accounts panel. Both rail
// panels are open by default, so selecting a session at 1024px left the row
// 40px for a question and eleven numbers: it stood 492px tall, one word to a
// line, and pushed the board down with it. With the accounts panel open too
// the padding was wider than the strip, the grid grew to fit it, the page
// scrolled sideways by 248px, and the machine panel sat over every number.
//
// The row now spans the window under the topbar, and everything docked starts
// under it: the left panel, the detail panel and the rail. It says how tall it
// is, so the rail — fixed, and so outside the grid — can be placed by it.
//
// The layout itself is measured in a browser (every panel combination at six
// widths); what a plain-node run can hold is the sheet's rules and the height
// the row hands the page.
import { afterEach, describe, expect, it, vi } from "vitest";

import { mount } from "./fake-react";
import { sheetText } from "./sheet-source";

vi.mock("react", async () => (await import("./fake-react")).react);

const { useStripHeight, createStripBinder } = await import("../use-strip-height");

interface Rule { selector: string; within: string[]; body: string }

/** Every style rule in the sheet: its selector, the at-rules around it, and
 *  its declarations. */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const stack: string[] = [];
  let buf = "";
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (ch === "{") { stack.push(buf.trim()); buf = ""; continue; }
    if (ch === "}") {
      const prelude = stack.pop() ?? "";
      if (!prelude.startsWith("@")) out.push({ selector: prelude, within: stack.filter(s => s.startsWith("@")), body: buf });
      buf = "";
      continue;
    }
    buf += ch;
  }
  return out;
}

const all = rules(sheetText());
const decl = (r: Rule, prop: string) => r.body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))?.[1].trim() ?? null;
/** The rules for the rating row and what is docked around it, outside any
 *  media query or inside the phone-width one. */
const top = (sel: RegExp) => all.filter(r => r.within.length === 0 && sel.test(r.selector));
const phone = (sel: RegExp) => all.filter(r => r.within.some(w => /max-width:\s*640px/.test(w)) && sel.test(r.selector));

describe("the rating question's row", () => {
  it("keeps no padding for the rail, at any width, so it can never be wider than the strip", () => {
    for (const r of all.filter(r => r.selector.includes("rating-banner"))) {
      expect(decl(r, "padding-right"), r.selector).toBeNull();
      expect(r.body, r.selector).not.toMatch(/\b(288|588)px/);
    }
  });

  // CHANGED ON PURPOSE (V4's Figma): every banner, not only the question, spans the window so its
  // dismiss sits at the right edge; the rule is the strip's (search-and-banners.css) and the left
  // panels' column rules are out-weighed by specificity rather than by source order.
  // CHANGED ON PURPOSE (V4's motion rules): every banner is drawn in one holder, the strip, whose
  // height eases in and out, so the rule that spans the window is the holder's.
  it("spans the window under the topbar, whichever left panel is open", () => {
    const own = top(/\.banner-strip/).find(r => r.selector.startsWith(".app.app.app") && decl(r, "grid-column") != null);
    expect(own && decl(own, "grid-column")).toBe("1 / -1");
    expect(own!.selector).toContain("> .banner-strip");
    const split = (list: string): string[] => {
      const out: string[] = [];
      let depth = 0, from = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i] === "(") depth++;
        else if (list[i] === ")") depth--;
        else if (list[i] === "," && depth === 0) { out.push(list.slice(from, i)); from = i + 1; }
      }
      return [...out, list.slice(from)];
    };
    const weight = (sel: string): number => {
      let n = 0;
      const rest = sel.replace(/:(is|not|has|where)\(((?:[^()]|\([^()]*\))*)\)/g, (_m, fn: string, args: string) => {
        if (fn !== "where") n += Math.max(...split(args).map(weight));
        return "";
      });
      return n + (rest.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
    };
    const others = all.filter(r => r !== own && /\.(ver|conn)-banner\b|\.banner-strip\b/.test(r.selector) && decl(r, "grid-column"));
    expect(others.length).toBeGreaterThan(0);
    for (const r of others) {
      for (const sel of split(r.selector)) expect(weight(sel.trim()), sel).toBeLessThan(weight(own!.selector));
    }
  });

  // CHANGED ON PURPOSE (V4's Figma): every banner with a mark pushes the docked panels down, so the rule is matched on `.banner-mark` as well as the question.
  it("starts the left panel and the detail panel under it", () => {
    const docked = top(/\.app:has\(\.banner-mark, \.rating-banner\)/).filter(r => decl(r, "grid-row") === "3 / -1");
    const covered = docked.map(r => r.selector).join(" ");
    // The left column is the grid item both left panels are drawn in since
    // 2026-10-08, so it is what starts a row lower (styles/left-column.css).
    for (const panel of [".left-column", ".detail"]) expect(covered).toContain(panel);
  });

  it("starts the rail under it, by the height it reports, and the rail gives that height back at its foot", () => {
    // Read against the rail's own rules rather than a number kept here: the
    // rail hangs 8px under the bar and ends 24px short of the window by the
    // bar's token (tokens.css), and under the question it is the same two
    // expressions with the row's height added and given back. Written as
    // literals they were the 52px bar's 60 and 76, and stayed so when the bar
    // became 44px (2026-10-08), so the rail stood 8px lower under the question
    // than it does without it.
    const rail = top(/\.app:has\(\.banner-mark, \.rating-banner\)/).filter(r => /\.usage-panel/.test(r.selector) && /\.sysdetail/.test(r.selector));
    expect(rail).toHaveLength(1);
    const own = (prop: string) => {
      const values = top(/^\.usage-panel$/).map(r => decl(r, prop)).filter(Boolean);
      expect(values, `.usage-panel's own ${prop}`).toHaveLength(1);
      return /^calc\((.*)\)$/.exec(values[0]!)![1];
    };
    expect(decl(rail[0], "top")).toBe(`calc(${own("top")} + var(--rating-h, 0px))`);
    expect(decl(rail[0], "max-height")).toBe(`calc(${own("max-height")} - var(--rating-h, 0px))`);
  });

  // CHANGED ON PURPOSE (V4's Figma): the phone corrections match every banner with a mark, not only the question, so an update or old-name banner stacks the rail the same way.
  it("on a phone, keeps the stacked rail stacked and starts the detail sheet under it too", () => {
    const at = (sel: RegExp, prop: string) => phone(sel).map(r => decl(r, prop)).filter(Boolean);
    expect(at(/\.app:has\(\.banner-mark, \.rating-banner\) \.detail\b/, "top")).toContain("calc(var(--topbar-h) + var(--rating-h, 0px))");
    // The machine panel holds the foot of a phone, so it is not moved down.
    expect(at(/\.app:has\(\.banner-mark, \.rating-banner\) \.sysdetail\b/, "top")).toContain("auto");
  });

  // CHANGED ON PURPOSE (V4's Figma): matched on every banner with a mark (see above).
  it("on a phone, keeps both rail panels' caps clear of the dock along the bottom", () => {
    // Under 641px the controls stand in a dock along the bottom
    // (edge-rails.css), and each rail panel's cap gives half the dock back so
    // the stacked pair keeps its 8px between them. The question's own caps
    // outrank those (`.app:has(.rating-banner) …` is the heavier selector), so
    // they have to carry the dock's half as well, or the pair overlaps by the
    // dock's height minus the gap while the question is up.
    const at = (sel: RegExp, prop: string) => phone(sel).map(r => decl(r, prop)).filter(Boolean);
    expect(at(/\.app:has\(\.banner-mark, \.rating-banner\) \.usage-panel\b/, "max-height"))
      .toContain("calc(50vh - 38px - var(--dock-h) / 2 - var(--rating-h, 0px))");
    expect(at(/\.app:has\(\.banner-mark, \.rating-banner\) \.sysdetail\b/, "max-height"))
      .toContain("calc(50vh - 38px - var(--dock-h) / 2)");
  });

  // CHANGED ON PURPOSE (V4's Figma): the question has no mark, so its two lines are "ask end" over
  // "next next"; the thanks keeps its mark, so it keeps a third column for it.
  it("on a phone, is two lines: the question and Not now, then the scale — and the thanks the same way", () => {
    const grids = phone(/\.rating-banner/).filter(r => decl(r, "display") === "grid");
    const area = (has: string) => grids.find(r => r.selector.includes(has));
    const ask = area(":has(> .rating-scale)");
    const thanks = area(":has(> .ver-act + .ver-close)");
    expect(ask).toBeDefined();
    expect(thanks).toBeDefined();
    const areas = (r: Rule) => decl(r, "grid-template-areas")!.replace(/\s+/g, " ");
    expect(areas(ask!)).toBe(`"ask end" "next next"`);
    expect(areas(thanks!)).toBe(`"mark ask end" ". next next"`);
  });
});

describe("the height it hands the page", () => {
  let observed: Array<() => void> = [];
  afterEach(() => { observed = []; vi.unstubAllGlobals(); });

  // CHANGED ON PURPOSE (V4's Figma): every banner reports its height, not only the question, so the
  // hook is the strip's (use-strip-height.ts, run by DeckBanner) and finds the row in the page.
  it("is written as --rating-h while a banner is up, follows it as it wraps, and is taken away with it", () => {
    let made = 0;
    vi.stubGlobal("ResizeObserver", class {
      constructor(private cb: () => void) { made++; }
      observe() { observed.push(this.cb); }
      disconnect() { observed = observed.filter(cb => cb !== this.cb); }
    });
    const style = new Map<string, string>();
    const sets: string[] = [];
    const removes: string[] = [];
    const page = { style: { setProperty: (k: string, v: string) => { sets.push(k); style.set(k, v); }, removeProperty: (k: string) => { removes.push(k); style.delete(k); } } };
    let height = 40.5;
    let asked = "";
    const row = { getBoundingClientRect: () => ({ height }), closest: (sel: string) => (sel === ".app" ? page : null) };
    vi.stubGlobal("document", { querySelector: (sel: string) => { asked = sel; return row; } });
    const view = mount(() => { useStripHeight(); return null; }, {});
    // CHANGED ON PURPOSE (V4's motion rules): the strip's holder is measured,
    // so the height handed on follows the banner while it eases in and out.
    expect(asked).toContain(".banner-strip");
    expect(asked).toContain(".ver-banner");
    expect(asked).toContain(".conn-banner > .banner-mark");
    expect(style.get("--rating-h")).toBe("41px");
    height = 72;
    for (const cb of observed) cb();
    expect(style.get("--rating-h")).toBe("72px");
    // A re-render with the same strip leaves the property and the observer alone.
    sets.length = 0; removes.length = 0; made = 0;
    view.rerender({});
    view.rerender({});
    expect(sets).toEqual([]);
    expect(removes).toEqual([]);
    expect(made).toBe(0);
    expect(observed).toHaveLength(1);
    view.unmount();
    expect(style.has("--rating-h")).toBe(false);
    expect(observed).toHaveLength(0);
  });
});

describe("the strip binder", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rebinds only when the strip is a different element, and lets go when none is left", () => {
    let made = 0, live = 0;
    vi.stubGlobal("ResizeObserver", class {
      constructor(_cb: () => void) { made++; live++; }
      observe() {}
      disconnect() { live--; }
    });
    const props: string[] = [];
    const page = { style: { setProperty: (k: string, v: string) => props.push(`set ${v}`), removeProperty: () => props.push("remove") } };
    const strip = (height: number) => ({ getBoundingClientRect: () => ({ height }), closest: () => page });
    const a = strip(32), b = strip(72);
    const binder = createStripBinder();
    binder.sync(a); binder.sync(a); binder.sync(a);
    expect(props).toEqual(["set 32px"]);
    expect(made).toBe(1);
    binder.sync(b);
    expect(props).toEqual(["set 32px", "remove", "set 72px"]);
    expect(made).toBe(2);
    expect(live).toBe(1);
    binder.sync(null);
    expect(props.at(-1)).toBe("remove");
    expect(live).toBe(0);
    binder.sync(null);
    expect(props.filter(p => p === "remove")).toHaveLength(2);
  });
});
