// The git view's file list, held to what a page cannot be rendered to prove
// here: the listbox and its one tab stop, the words a screen reader hears for
// every mark, paths cut by measuring, and a sheet that answers narrow panels.
import { describe, expect, it } from "vitest";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";

const files = sourceOf("components/GitFiles.tsx");
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

describe("the file list", () => {
  it("is a listbox of options with one tab stop, the selected row", () => {
    expect(files).toMatch(/role="listbox"/);
    expect(files).toMatch(/role="option"/);
    expect(files).toMatch(/aria-selected=\{sel\}/);
    expect(files).toMatch(/tabIndex=\{row\.key === tabKey \? 0 : -1\}/);
    // Groups are labelled the APG way: a group named by its presentational header.
    expect(files).toMatch(/role="group" aria-labelledby=/);
    expect(files).toMatch(/role="presentation"/);
  });

  it("walks with the arrows, Home and End, and opens the diff on Enter or →", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) expect(files).toContain(`case "${key}"`);
    expect(files).toMatch(/case "Enter":\s*case "ArrowRight": activate\(walk\[i\]\); break;/);
    // On a file row that is the diff; the line naming a subagent elsewhere narrows instead.
    expect(files).toMatch(/onOpen\(refOf\(item\.row\)\);/);
    // A handled key goes no further: the deck's shortcuts never see it.
    expect(files).toMatch(/if \(handled\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); \}/);
  });

  it("says every mark in words: the change, the stage, the clash, the subagent", () => {
    expect(files).toMatch(/<span aria-hidden="true">\{row\.letter\}<\/span>\s*<span className="vis-hidden">\{row\.word\} <\/span>/);
    expect(files).toMatch(/role="img" aria-label=\{`also edited by \$\{row\.clash\}`\}/);
    expect(files).toMatch(/className="vis-hidden">, \{row\.stage\}/);
    expect(files).toMatch(/className="vis-hidden">, edited by \{row\.sub\}/);
    // The path a reader hears is whole, whatever the row had room to draw.
    expect(files).toMatch(/<span className="vis-hidden">\{row\.path\}<\/span>/);
  });

  it("cuts paths by measuring, one cut per file, and folds a subagent's name first", () => {
    expect(files).toContain("fitShared(rooms, measure)");
    expect(files).toContain("monoMeasure(PATH_PX)");
    expect(files).toMatch(/nameFits\(shownPath\(row\.path\), withName, measure\)/);
    expect(css).toMatch(/\.gvf-row\.is-folded \.gvf-who-name \{ display: none; \}/);
    // No ellipsis on the path: it would take the file name off the end.
    const path = /\.gvf-path \{([^}]*)\}/.exec(css)![1];
    expect(path).not.toMatch(/text-overflow/);
    expect(path).toMatch(/overflow: hidden/);
  });

  it("states the type sizes it measures in, and the sheet agrees", () => {
    // Read off the sheet here rather than off the computed style on a render.
    expect(files).toContain("export const PATH_PX = 11;");
    expect(files).toContain("export const WHO_PX = 10;");
    expect(/\.gvf-path \{[^}]*font: 11px\/1\.4 var\(--font-mono\);/.test(css)).toBe(true);
    expect(/\.gvf-who \{[^}]*font: 10px\/1 var\(--font-mono\);/.test(css)).toBe(true);
    expect(files).not.toMatch(/getComputedStyle/);
  });

  it("draws the line naming a subagent elsewhere as a dashed row, ringed when focused", () => {
    const line = /\.gvf-elsewhere \{([^}]*)\}/.exec(css)![1];
    expect(line).toMatch(/border: 1px dashed var\(--line\)/);
    expect(line).toMatch(/height: 24px/);
    expect(line).toMatch(/font: 11px\/22px var\(--font-mono\)/);
    expect(css).toMatch(/\.gvf-elsewhere:focus-visible \{[^}]*outline-offset: -2px/);
    // Its words never spill: the lead gives way with an ellipsis, the full sentence is the title.
    expect(css).toMatch(/\.gvf-elsewhere-lead \{[^}]*text-overflow: ellipsis/);
    expect(files).toMatch(/title=\{away\.title\}/);
    // In a narrow pane the verb folds before the folder's name is cut.
    expect(css).toMatch(/@container gvf \(max-width: 300px\) \{\s*\.gvf-elsewhere \{ padding-left: 10px; \}\s*\.gvf-elsewhere-verb \{ display: none; \}/);
  });

  it("keeps the counts in a 64px right-aligned column, thousands grouped", () => {
    const counts = /\.gvf-counts \{([^}]*)\}/.exec(css)![1];
    expect(counts).toMatch(/min-width: 64px/);
    expect(counts).toMatch(/justify-content: flex-end/);
    expect(counts).toMatch(/tabular-nums/);
    expect(files).toContain("groupDigits(added)");
  });

  it("turns stage words into S/U badges under a 760px panel", () => {
    expect(css).toMatch(/@container gv \(max-width: 760px\) \{[^}]*\.gvf-stage-long[^}]*display: none;/);
    expect(css).toMatch(/\.gvf-stage-short \{ display: none; \}/);
  });

  it("moves a selection from the keyboard without animating it", () => {
    const row = /\.gvf-row \{([^}]*)\}/.exec(css)![1];
    expect(row).not.toMatch(/transition/);
    expect(css).toMatch(/\.gvf-row:hover \{[^}]*transition: background-color 120ms ease;/);
  });

  it("names the commit and copies its SHA in commit mode", () => {
    expect(files).toMatch(/aria-label=\{`Copy commit SHA \$\{short\}`\}/);
    expect(files).toContain("copyText(sha)");
  });
});

describe("the file list's sources", () => {
  it("name no colour: every tone is the sheet's", () => {
    for (const src of [files, sourceOf("components/GitDiffIcons.tsx")]) expect(src).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
