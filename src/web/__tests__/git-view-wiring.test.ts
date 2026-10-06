// The git view's wiring for the counts the server now sends on the working
// tree's changes: the glance's file rows end with them.
import { describe, expect, it } from "vitest";
import { sourceOf } from "./client-source";
import { sheetParts } from "./sheet-source";

const glance = sourceOf("components/GitGlance.tsx");
const viewCss = sheetParts().find(([path]) => path === "styles/git-view.css")![1];

describe("counts in the glance", () => {
  it("ends a file row with its counts, the file's sides added together", () => {
    expect(glance).toMatch(/const n = pathCounts\(data\.entries \?\? \[\], f\.path\);/);
    expect(glance).toMatch(/<span className="gv-g-counts"><span className="gv-g-bin" title="binary file">bin<\/span><\/span>/);
    expect(glance).toContain("groupDigits(n.added)");
  });

  it("keeps the counts on the file row's right, never pushing the path out", () => {
    const at = viewCss.indexOf(".gv-g-counts {");
    expect(at).toBeGreaterThan(-1);
    const rule = viewCss.slice(at, viewCss.indexOf("}", at));
    expect(rule).toMatch(/flex: none/);
    expect(rule).toMatch(/tabular-nums/);
    expect(viewCss).toMatch(/\.gv-g-add \{ color: var\(--gv-add-ink\); \}/);
    expect(viewCss).toMatch(/\.gv-g-del \{ color: var\(--gv-del-ink\); \}/);
  });
});
