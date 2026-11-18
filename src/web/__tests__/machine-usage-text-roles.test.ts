// "This machine" and "Usage" are read side by side, so the same kind of text
// is set the same way in both: a heading, a row's label and its figure, the
// sentence under a row, a row of small figures with their captions. Usage is
// the reference. Before this the machine panel had a heading at 400 among 600s,
// row labels a tier greyer than the ones above them, its load average as a
// 16px 600 headline Usage gives no figure, and a third weight on the process
// row; Usage's own By session rows that open the inspector reset their size to
// the body's 13/18.85. This suite holds each role of the machine panel to the
// Usage rule it matches, the line heights of both to the reader's text size,
// and every meter in both to one track.
import { describe, it, expect } from "vitest";
import { sheetParts, sheetText } from "./sheet-source";

interface Rule { media: string; selectors: string[]; decls: Record<string, string> }
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "");
function parse(text: string): Rule[] {
  const out: Rule[] = [];
  const block = (from: number): number => {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return i;
    }
    throw new Error("unbalanced braces");
  };
  const walk = (start: number, end: number, media: string) => {
    let i = start;
    while (i < end) {
      const open = text.indexOf("{", i);
      if (open < 0 || open >= end) return;
      const prelude = text.slice(i, open).trim().replace(/\s+/g, " ");
      const close = block(open);
      const inner = text.slice(open + 1, close);
      if (prelude.startsWith("@keyframes")) { /* not read here */ }
      else if (prelude.startsWith("@")) walk(open + 1, close, prelude.startsWith("@media") ? prelude.slice(6).trim() : media);
      else {
        const decls: Record<string, string> = {};
        for (const m of inner.matchAll(/([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) decls[m[1]] = m[2].replace(/\s+/g, " ");
        out.push({ media, selectors: prelude.split(/,(?![^()]*\))/).map(s => s.trim().replace(/\s+/g, " ")), decls });
      }
      i = close + 1;
    }
  };
  walk(0, text.length, "");
  return out;
}
const rules = parse(strip(sheetText()));
/** The last value the sheet gives `prop` on exactly this selector, outside any media query. */
function decl(selector: string, prop: string): string | undefined {
  let found: string | undefined;
  for (const r of rules) if (r.media === "" && r.selectors.includes(selector) && prop in r.decls) found = r.decls[prop];
  return found;
}
/** What a role is drawn at: its own rule, else the first ancestor in `from`
 *  that says it, else the default a span inherits (400 weight). */
function role(selectors: string[], prop: string): string | undefined {
  for (const s of selectors) { const v = decl(s, prop); if (v !== undefined) return v; }
  return prop === "font-weight" ? "400" : undefined;
}
const TYPE = ["font-size", "line-height", "font-weight", "color"] as const;
const look = (selectors: string[]) => Object.fromEntries(TYPE.map(p => [p, role(selectors, p)]));

describe("the machine panel sets each text role the way Usage does", () => {
  it("draws every section heading, CPU's included, as Usage's section title", () => {
    expect(look([".sd-h"])).toEqual(look([".up-section-title"]));
    // CPU's heading keeps its own height and nothing else of its own.
    expect(decl('.sd-reading[data-group="cores"] .sd-h', "font-weight")).toBeUndefined();
    expect(decl('.sd-reading[data-group="cores"] .sd-h', "color")).toBeUndefined();
    // The process row is named like the headings above it, at 600.
    expect(look([".sd-door-name"])).toEqual(look([".up-section-title"]));
  });

  it("gives both kinds of row the label Usage's rows have", () => {
    const usage = look([".qb-label", ".qb-meta"]);
    expect(look([".sd-row-label", ".sysdetail"])).toEqual(usage);
    expect(look([".sd-plain-label", ".sysdetail"])).toEqual(usage);
  });

  it("sets a row's figure as Usage's: mono, 12/16, 400, --text", () => {
    const usage = { ...look([".qb-pct"]), color: decl(".qb-pct[data-known]", "color") };
    for (const sel of [".sd-row-val", ".sd-plain-val", ".sd-h-val"]) {
      expect(decl(sel, "font-family"), sel).toBe(decl(".qb-pct", "font-family"));
      expect({ ...look([sel, ".sysdetail"]), "font-weight": role([sel], "font-weight") }, sel).toEqual(usage);
    }
  });

  it("sets the sentence under a row as Usage's: 12/16 --muted", () => {
    const usage = look([".qb-reset"]);
    expect(look([".sd-note"])).toEqual(usage);
    expect(look([".sd-plain-note", ".sysdetail"])).toEqual(usage);
  });

  it("sets the load average as Usage's tokens row: the figure, the caption and the gap", () => {
    expect(decl(".sd-fig-val", "font-family")).toBe(decl(".up-tok", "font-family"));
    expect(look([".sd-fig-val"])).toEqual(look([".up-tok"]));
    expect(look([".sd-fig-cap"])).toEqual(look([".up-k"]));
    const column = (gap: string) => gap.split(" ").at(-1);
    expect(column(decl(".sd-figs", "gap")!)).toBe(column(decl(".up-tokens-row", "gap")!));
  });

  it("keeps Usage's By session rows at the size the row sets, button or not", () => {
    // `font: inherit` on the button put the body's 13px back over the row's 12/16.
    expect(decl(".up-session-open", "font")).toBeUndefined();
    expect(decl(".up-session-open", "font-size")).toBeUndefined();
    expect(decl(".up-session-open", "line-height")).toBeUndefined();
    expect(decl(".up-session-row", "font-size")).toBe(decl(".up-table", "font-size"));
  });
});

describe("both panels grow their leading with the reader's text size", () => {
  // V4's type roles (tokens.css): a reader's increase is added to the size and
  // to the line height, so a larger text size keeps its leading.
  for (const part of ["styles/machine-panel.css", "styles/usage-panel.css"]) {
    it(`writes no fixed pixel line height in ${part}`, () => {
      const text = strip(sheetParts().find(([path]) => path === part)![1]);
      const fixed = [...text.matchAll(/line-height:\s*(\d+(?:\.\d+)?px)\s*;/g)].map(m => m[1]);
      expect(fixed).toEqual([]);
      expect(text).toMatch(/line-height: calc\(16px \+ var\(--ui-text-increase, 0px\)\)/);
    });
  }
});

describe("every meter in both panels draws on one track", () => {
  it("puts the per-core columns, the memory meters and the quota bars on --ctl-fill", () => {
    expect(decl(".sd-core", "background")).toBe("var(--ctl-fill)");
    expect(decl(".sd-track", "background")).toBe("var(--ctl-fill)");
    expect(decl(".qb-track", "background")).toBe("var(--ctl-fill)");
  });
});
