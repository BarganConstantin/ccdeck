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

const { default: RatingBanner } = await import("../components/RatingBanner");

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

  it("spans the window under the topbar, whichever left panel is open", () => {
    const own = top(/\.ver-banner\.rating-banner\b/).find(r => decl(r, "grid-column") != null);
    expect(own && decl(own, "grid-column")).toBe("1 / -1");
    // The rules that put a banner in the canvas's column come earlier in the
    // sheet with no more classes, so this one wins.
    const dots = (s: string) => (s.match(/\./g) ?? []).length;
    const sheet = sheetText();
    for (const r of all.filter(r => /\.ver-banner\b/.test(r.selector) && !r.selector.includes("rating") && decl(r, "grid-column"))) {
      expect(sheet.indexOf(r.selector + " {") < sheet.indexOf(own!.selector + " {") || r.selector.includes(","), r.selector).toBe(true);
      for (const s of r.selector.split(",")) expect(dots(s), s).toBeLessThanOrEqual(dots(own!.selector));
    }
  });

  it("starts the left panel and the detail panel under it", () => {
    const docked = top(/\.app:has\(\.rating-banner\)/).filter(r => decl(r, "grid-row") === "3 / -1");
    const covered = docked.map(r => r.selector).join(" ");
    for (const panel of [".session-list", ".accounts-panel", ".detail"]) expect(covered).toContain(panel);
  });

  it("starts the rail under it, by the height it reports, and the rail gives that height back at its foot", () => {
    const rail = top(/\.app:has\(\.rating-banner\)/).filter(r => /\.usage-panel/.test(r.selector) && /\.sysdetail/.test(r.selector));
    expect(rail).toHaveLength(1);
    expect(decl(rail[0], "top")).toMatch(/^calc\(60px \+ var\(--rating-h, 0px\)\)$/);
    expect(decl(rail[0], "max-height")).toMatch(/^calc\(100vh - 76px - var\(--rating-h, 0px\)\)$/);
  });

  it("on a phone, keeps the stacked rail stacked and starts the detail sheet under it too", () => {
    const at = (sel: RegExp, prop: string) => phone(sel).map(r => decl(r, prop)).filter(Boolean);
    expect(at(/\.app:has\(\.rating-banner\) \.detail\b/, "top")).toContain("calc(52px + var(--rating-h, 0px))");
    expect(at(/\.app:has\(\.rating-banner\) \.usage-panel\b/, "max-height")).toContain("calc(50vh - 38px - var(--rating-h, 0px))");
    // The machine panel holds the foot of a phone, so it is not moved down.
    expect(at(/\.app:has\(\.rating-banner\) \.sysdetail\b/, "top")).toContain("auto");
  });

  it("on a phone, is two lines: the question and Not now, then the scale — and the thanks the same way", () => {
    const grid = phone(/\.rating-banner/).find(r => decl(r, "display") === "grid");
    expect(grid).toBeDefined();
    // The question's row, and the low score's thanks, which has an offer.
    expect(grid!.selector).toContain(":has(> .rating-scale)");
    expect(grid!.selector).toContain(":has(> .ver-act + .ver-close)");
    const areas = decl(grid!, "grid-template-areas")!.replace(/\s+/g, " ");
    expect(areas).toBe(`"dot ask end" ". next next"`);
  });
});

describe("the height it hands the page", () => {
  let observed: Array<() => void> = [];
  afterEach(() => { observed = []; vi.unstubAllGlobals(); });

  it("is written as --rating-h while the row is up, follows it as it wraps, and is taken away with it", () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private cb: () => void) {}
      observe() { observed.push(this.cb); }
      disconnect() { observed = observed.filter(cb => cb !== this.cb); }
    });
    const style = new Map<string, string>();
    const page = { style: { setProperty: (k: string, v: string) => style.set(k, v), removeProperty: (k: string) => style.delete(k) } };
    let height = 40.5;
    const row = { getBoundingClientRect: () => ({ height }), closest: (sel: string) => (sel === ".app" ? page : null) };
    const props = { phase: "asking" as const, score: null, onAnswer: () => {}, onLater: () => {}, onClose: () => {}, onFeedback: () => {} };
    const view = mount(RatingBanner, props, {
      commit: tree => {
        const ref = (tree as { ref?: { current: unknown } } | null)?.ref;
        if (ref && typeof ref === "object") ref.current = row;
      },
    });
    expect(style.get("--rating-h")).toBe("41px");
    height = 70;
    for (const cb of observed) cb();
    expect(style.get("--rating-h")).toBe("70px");
    view.unmount();
    expect(style.has("--rating-h")).toBe(false);
    expect(observed).toHaveLength(0);
  });
});
