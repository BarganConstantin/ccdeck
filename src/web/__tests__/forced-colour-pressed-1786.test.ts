// #1786. Under a Windows Contrast theme a pressed or chosen control looked
// exactly like its neighbours: the chosen range in Usage history and in the
// Projects report, the canvas's Pause while paused, the open tab in the Add
// account dialog, the chosen period in the usage panel and the selected row in
// the Sessions list. Each state was drawn as a fill, a text colour or a border
// colour, and a Contrast theme paints every fill Canvas and every text and
// border in one system colour. For Usage history the chip is the only place
// the chosen range is shown at all.
//
// #871's block already keeps a switch's state and a theme card's; it named
// none of these. Read from the sheet: each state has to leave that block in a
// channel the theme honours, a fill in the highlight or a heavier edge in it.
import { describe, expect, it } from "vitest";
import { defaultReadingSheetText as sheetText } from "./sheet-source";

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const OPEN = "@media (forced-colors: active) {";
const start = css.indexOf(OPEN);
const [block, end] = (() => {
  let depth = 0;
  for (let i = start + OPEN.length - 1; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return [css.slice(start + OPEN.length, i), i];
  }
  return ["", -1];
})();
const outside = css.slice(0, start) + css.slice(end + 1);

type Rule = { sels: string[]; body: string };
const parse = (s: string): Rule[] => [...s.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
  sels: m[1].split(",").map(x => x.trim().replace(/\s+/g, " ")).filter(Boolean),
  body: m[2],
}));
const forced = parse(block);
const forcedBody = (sel: string) => forced.filter(r => r.sels.includes(sel)).map(r => r.body).join("\n");
const decl = (body: string, prop: string) =>
  [...body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "g"))].pop()?.[1].trim();
/** Whether the rest of the sheet draws `sel` as a rule of its own. */
const drawn = (sel: string) => new RegExp(`(?:^|[},])\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[{,]`).test(outside);

const FILLED = [
  '.uh-range-btn[aria-pressed="true"]',
  '.react-flow__controls-button[aria-pressed="true"]',
  '.aa-tab.on',
];

describe("a pressed or chosen control under a Contrast theme (#1786)", () => {
  it("fills a pressed chip, a paused canvas and the open tab with the highlight", () => {
    for (const sel of FILLED) {
      expect(drawn(sel), `${sel} is the sheet's own state`).toBe(true);
      const body = forcedBody(sel);
      expect(decl(body, "forced-color-adjust"), sel).toBe("none");
      expect(decl(body, "background"), sel).toBe("Highlight");
      expect(decl(body, "color"), sel).toBe("HighlightText");
      // Opted out, its edge is no longer repainted for it: one it draws is in
      // the highlight too, not in the accent it rests in.
      expect(decl(body, "border-color"), sel).toBe("Highlight");
    }
  });

  it("keeps that fill under the pointer, where the control's own hover outranks the state", () => {
    for (const sel of FILLED) {
      const hover = `${sel}:hover`;
      if (!drawn(hover)) continue;
      const body = forcedBody(hover);
      expect(decl(body, "background"), hover).toBe("Highlight");
      expect(decl(body, "color"), hover).toBe("HighlightText");
    }
  });

  it("marks the usage panel's chosen period with the highlight under its word", () => {
    const mark = '.up-period .uh-range-btn[aria-pressed="true"]::after';
    expect(drawn(mark)).toBe(true);
    expect(decl(forcedBody(mark), "forced-color-adjust")).toBe("none");
    expect(decl(forcedBody(mark), "background")).toBe("Highlight");
    // The segment is the same chip, and it has no fill in any theme: the
    // pressed chip's highlight is taken back off it, word and hover included,
    // so the mark is the one thing that says which period is shown.
    for (const seg of ['.up-period .uh-range-btn[aria-pressed="true"]', '.up-period .uh-range-btn[aria-pressed="true"]:hover']) {
      expect(decl(forcedBody(seg), "forced-color-adjust"), seg).toBe("auto");
      expect(decl(forcedBody(seg), "background"), seg).toBe("transparent");
    }
  });

  it("gives the selected session a ring in the highlight, inside the row so the row keeps its size", () => {
    // V4's rail row has no border, and its selection is a fill the theme drops;
    // the ring is an outline drawn inside the row's box (negative offset), so
    // it grows nothing and moves no word. (It was a heavier border edge worked
    // out of the row's padding when the row had one.)
    const row = ".session-list .sl-row";
    const outsideRules = parse(outside);
    const outsideBody = (sel: string) => outsideRules.filter(r => r.sels.includes(sel)).map(r => r.body).join("\n");
    expect(decl(outsideBody(row), "border")).toBe("0");

    const body = forcedBody(`${row}.selected`);
    expect(decl(body, "outline")).toBe("2px solid Highlight");
    expect(decl(body, "outline-offset")).toBe("-2px");
  });
});
