// #857: the accounts panel set the numbers people read to choose an account —
// lane labels, percentages, reset times, emails — at 9-10px, its row footer at
// 9px, and its "more" link was a padding-free 29x13 target.
//
// Content takes the panel's 11px floor. The reset line keeps one ladder step
// under its key, because in dark the two tiers are one colour and the step is
// all that separates them there. The footer's two text-weight controls keep
// their look and get a 24px target drawn around the word.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** Bodies of every rule whose selector list names exactly this selector. */
function bodies(selector: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(",").map(s => s.trim()).includes(selector))
    .map(m => m[2]);
}

/** The first value this selector is given for `prop`. */
function decl(selector: string, prop: string): string | null {
  for (const body of bodies(selector)) {
    const m = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(body);
    if (m) return m[1].trim();
  }
  return null;
}

const px = (selector: string) => {
  const v = decl(selector, "font-size");
  if (v === null) throw new Error(`${selector} declares no font-size`);
  return parseFloat(v);
};

describe("the accounts panel's reading sizes (#857)", () => {
  it("sets what an account is chosen by at the panel's 11px floor", () => {
    for (const sel of [".ap-email", ".ap-lane-label", ".ap-lane-pct"]) {
      expect(px(sel), sel).toBeGreaterThanOrEqual(11);
    }
  });

  it("keeps the reset line one ladder step under its key, and off the 9px floor", () => {
    expect(px(".ap-lane-reset")).toBe(10);
    expect(px(".ap-lane-label")).toBeGreaterThan(px(".ap-lane-reset"));
  });

  it("sets every line under the name, and every control on those lines, at one size, 11px", () => {
    const lines = [".ap-meta", ".ap-quota", ".ap-issue-line", ".ap-switch", ".ap-fix"];
    expect(lines.map(px), lines.join(" ")).toEqual(lines.map(() => 11));
  });

  it("has no footnote under the roster any more — every row says when it was collected", () => {
    const panel = readFileSync(fileURLToPath(new URL("../components/AccountsPanel.tsx", import.meta.url)), "utf8");
    expect(panel).not.toMatch(/className="ap-footnote"/);
    expect(panel).not.toMatch(/These numbers only update while this panel is open/);
    expect(css).not.toMatch(/\.ap-footnote\s*\{/);
  });
});

// The footer's two text-weight controls went — the lanes open from the whole
// row now, and holding an account out is in its ⋯ — and the warning's words are
// the text-weight control left on a row, drawn the same way.
describe("a row's text-weight control has a 24px target (#857)", () => {
  for (const sel of [".ap-issue"]) {
    it(`${sel} draws the target around the word without growing the word`, () => {
      expect(decl(sel, "position")).toBe("relative");
      expect(decl(sel, "padding"), "padding would widen a flex item in a wrapping footer").toBe("0");
      const after = `${sel}::after`;
      expect(decl(after, "content")).toBe('""');
      expect(decl(after, "position")).toBe("absolute");
      expect(decl(after, "height")).toBe("24px");
      expect(decl(after, "width")).toBe("max(100%, 24px)");
      expect(decl(after, "transform")).toBe("translate(-50%, -50%)");
    });

    it(`${sel}::after paints nothing — it exists only to be hit`, () => {
      for (const painted of ["background", "border", "box-shadow", "outline", "color"]) {
        expect(decl(`${sel}::after`, painted), `${painted} on ${sel}::after`).toBeNull();
      }
    });
  }
});
