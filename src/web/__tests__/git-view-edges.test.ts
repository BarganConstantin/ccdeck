// The git view and the deck's edges: the stripes that hold the panel toggles
// on either side of the window, and the dock that holds them on a phone. The
// view stands between them and never over one, so every toggle stays in sight
// and in reach while it is open; a toggle whose panel the view stands over
// closes the view and shows that panel, and is not drawn open meanwhile.
import { describe, expect, it } from "vitest";
import { sourceOf } from "./client-source";
import { sheetParts } from "./sheet-source";

const own = sheetParts().find(([path]) => path === "styles/git-view.css")![1];
const view = sourceOf("components/GitView.tsx");
/** A rule of the view's own part of the sheet, outside any at-rule. */
const rule = (sel: string) => {
  const at = own.indexOf(`\n${sel} {`);
  expect(at, sel).toBeGreaterThan(-1);
  return own.slice(at, own.indexOf("}", at));
};

describe("where the view stands", () => {
  it("under the topbar, its right edge at the right stripe's inner edge", () => {
    const r = rule(".gv-wide");
    expect(r).toMatch(/top: var\(--gv-top, var\(--topbar-h\)\);/);
    expect(r).toMatch(/right: var\(--edge-w\);/);
    // The measured top is set only once there is a measure; the bar's height
    // stands in until then, never a number from an older bar.
    expect(view).toMatch(/\.\.\.\(box \? \{ "--gv-top": `\$\{box\.top\}px` \} : \{\}\),/);
  });

  it("as a full sheet, between the two stripes", () => {
    expect(rule(".gv-wide[data-sheet]")).toMatch(/left: var\(--edge-w\);\s*width: auto;\s*border-left: none;/);
  });

  it("on a phone, above the dock rather than under it", () => {
    expect(own).toMatch(/@media \(max-width: 640px\) \{[^}]*\}[^}]*\.gv-wide \{ bottom: calc\(var\(--dock-h\) \+ env\(safe-area-inset-bottom\)\); \}/);
  });

  it("takes its width, its cover and what it leaves in sight from the stripes, not the window's edge", () => {
    expect(view).toMatch(/const left = document\.querySelector\("\.edge-rail-left"\)\?\.getBoundingClientRect\(\);/);
    expect(view).toMatch(/const right = document\.querySelector\("\.edge-rail-right"\)\?\.getBoundingClientRect\(\);/);
    expect(view).toMatch(/end: right && right\.width > 0 \? right\.left : window\.innerWidth/);
    expect(view).toMatch(/const room = box \? end - box\.left : win;/);
    expect(view).toMatch(/const width = sheet \? end - \(box \? box\.start : 0\) : panelWidth\(/);
    expect(view).toMatch(/const cover = Math\.max\(0, width - \(box \? end - box\.right : detailShown \? 360 : 0\)\);/);
    expect(view).toMatch(/const cover = Math\.max\(0, w - \(chromeEdges\(\)\.end - rect\.right\)\);/);
    expect(view).not.toMatch(/window\.innerWidth - (w|rect)\b/);
  });
});
