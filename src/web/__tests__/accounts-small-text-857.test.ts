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
import { accountsSurface } from "./accounts-surface";
import { defaultReadingSheetText as sheetText } from "./sheet-source";

const css = sheetText()
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
    // CHANGED ON PURPOSE (V4's Figma): the row's name is the one name (`ap-alias`,
    // 13), the address it stands for having left the row for its title.
    for (const sel of [".ap-alias", ".ap-lane-label", ".ap-lane-pct"]) {
      expect(px(sel), sel).toBeGreaterThanOrEqual(11);
    }
  });

  it("keeps the reset line off the floor, at the key's own size", () => {
    // CHANGED ON PURPOSE (V4's motion-free text rule: nothing on screen under
    // 11px): the open bar's reset was 10 and is 11, the size of its key.
    expect(px(".ap-lane-reset")).toBe(11);
    expect(px(".ap-lane-label")).toBeGreaterThanOrEqual(px(".ap-lane-reset"));
  });

  it("sets every line under the name, and every control on those lines, at one size, 11px", () => {
    // CHANGED ON PURPOSE (V4's Figma): line 2 of the row (`ap-quota`) is the
    // kit's Small, 12 on a 16 line, so it leaves this list for its own test.
    const lines = [".ap-meta", ".ap-issue-line", ".ap-switch", ".ap-fix"];
    expect(lines.map(px), lines.join(" ")).toEqual(lines.map(() => 11));
    expect(px(".ap-quota")).toBe(12);
  });

  it("has no footnote under the roster any more — every row says when it was collected", () => {
    const panel = readFileSync(fileURLToPath(new URL("../components/AccountsPanel.tsx", import.meta.url)), "utf8");
    expect(accountsSurface()).not.toMatch(/className="ap-footnote"/);
    expect(accountsSurface()).not.toMatch(/These numbers only update while this accountsSurface() is open/);
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
