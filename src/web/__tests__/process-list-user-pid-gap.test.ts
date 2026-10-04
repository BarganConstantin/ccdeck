// Busiest processes printed the user and the pid as one word.
//
// The user column is a name, read left; the pid beside it is a number, read
// right. The table gives every cell `padding: 2px 0`, and the name column takes
// whatever width is left, so the other columns come down to their content —
// and a Linux pid has seven digits as often as not (pid_max is 4194304). The
// pid then filled its cell to the left edge, against the end of the user name:
// `constantin1365092`, on most rows. The two boundaries where a number meets a
// name were given a fixed gap (18px); this one, where a name meets a number,
// had none.
//
// Column geometry is layout, which this suite has no engine for, so the rule
// is read from the sheet: the gap is on the user cell and its heading, and it
// outranks the table's own padding rather than losing to it.
import { describe, expect, it } from "vitest";

import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

/** A selector list's selectors — split at its commas, not at the ones inside
 *  an `:is()`. */
const selectors = (list: string) => list.split(/,(?![^(]*\))/).map(x => x.trim());

/** The value the last rule naming exactly `selector` gives `prop`. */
function decl(selector: string, prop: string): string | null {
  let out: string | null = null;
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!selectors(m[1]).includes(selector)) continue;
    const d = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(m[2]);
    if (d) out = d[1].trim();
  }
  return out;
}
const px = (v: string | null) => (v == null ? 0 : Number(/^([\d.]+)px/.exec(v)?.[1] ?? 0));

describe("the process table's user and pid columns", () => {
  it("are fifth and sixth, the order the gap below is written for", () => {
    const heads = [...sourceOf("components/ProcessListModal.tsx").matchAll(/(?:<SortHead\s+col="(\w+)"|className="(pl-pid-h)")/g)]
      .map(m => m[1] ?? "pid");
    expect(heads.slice(4, 6)).toEqual(["user", "pid"]);
  });

  it("keep a gap between a user name and a seven-digit pid", () => {
    // On the cells and on their headings, so the labels do not meet either.
    expect(px(decl(".pl-body .pl-table td:nth-child(5)", "padding-right"))).toBeGreaterThanOrEqual(12);
    expect(px(decl(".pl-body .pl-table th:nth-child(5)", "padding-right"))).toBeGreaterThanOrEqual(12);
  });

  it("keep it over the table's own padding, by specificity", () => {
    // `:is(.sysdetail, .pl-body) .sd-procs td { padding: 2px 0 }` is (0,2,1)
    // and zeroes every cell's sides; the gap's (0,3,1) has to be the one that
    // applies, without an !important of its own.
    expect(decl(":is(.sysdetail, .pl-body) .sd-procs td", "padding")).toBe("2px 0");
    expect(decl(".pl-body .pl-table td:nth-child(5)", "padding-right")).toMatch(/^\d+px$/);
  });
});
