// The git view's diff, held to what a page cannot be rendered to prove here:
// a line's meaning in its glyph and in words, wrap on by default and
// remembered, the pill in the header, lazy syntax colours, and a sheet that
// answers narrow panels, reduced motion and forced colours.
import { describe, expect, it } from "vitest";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";

const diff = sourceOf("components/GitDiff.tsx");
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

describe("the diff", () => {
  it("carries a line's meaning in its glyph and in words, never in its tint alone", () => {
    expect(diff).toMatch(/l\.kind === "add" \? "\+" : l\.kind === "del" \? "−" : ""/);
    expect(diff).toContain('<span className="vis-hidden">added: </span>');
    expect(diff).toContain('<span className="vis-hidden">removed: </span>');
  });

  it("wraps by default, remembers the choice and says it is pressed", () => {
    expect(diff).toMatch(/readStored\(WRAP_KEY\) !== "0"/);
    expect(diff).toMatch(/aria-pressed=\{wrap\}/);
    expect(css).toMatch(/\.gvd\[data-wrap="true"\] \.gvd-code \{ white-space: pre-wrap; overflow-wrap: anywhere; \}/);
  });

  it("keeps its gutters put and merges them into one under a 560px panel", () => {
    expect(css).toMatch(/\.gvd-ln, \.gvd-glyph \{ position: sticky;/);
    expect(css).toMatch(/@container gv \(max-width: 560px\) \{[\s\S]*?\.gvd-ln\.n1 \{ display: none; \}/);
    expect(css).toMatch(/\.gvd-line\[data-kind="del"\] \.gvd-ln\.n2::before \{ content: attr\(data-old\); \}/);
  });

  it("puts Show latest in the header, with its key, and announces it", () => {
    const head = diff.slice(diff.indexOf('<div className="gvd-head">'), diff.indexOf('{collision && ('));
    expect(head).toContain('className="gvd-pill" onClick={() => { holdFocus(); onShowLatest(); }}');
    expect(head).toContain("Show latest <kbd>n</kbd>");
    expect(head).toMatch(/aria-live="polite"/);
  });

  it("states the header's type size and gap, and the sheet agrees", () => {
    expect(diff).toContain("export const HEAD_PATH_PX = 12;");
    expect(diff).toContain("export const HEAD_GAP = 8;");
    expect(/\.gvd-path \{[^}]*font: 12px\/1\.4 var\(--font-mono\);/.test(css)).toBe(true);
    expect(/\.gvd-title \{[^}]*gap: 8px;/.test(css)).toBe(true);
    expect(diff).not.toMatch(/getComputedStyle/);
  });

  it("is a focusable region the view can hand the keyboard to", () => {
    expect(diff).toMatch(/className="gvd-scroll" tabIndex=\{0\} role="region" aria-label=\{`Diff of \$\{file\.path\}`\}/);
    expect(diff).toContain("focus: () => scrollRef.current?.focus()");
  });

  it("colours lazily, through the worker client, and is plain text until then", () => {
    expect(diff).toContain("highlightDocs(lang, docs)");
    expect(diff).not.toMatch(/from "shiki/);
  });

  it("answers reduced motion for the pill and glows new lines with colour alone", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.gvd-pill \{ animation: gvd-fade-in/);
    const glow = /@keyframes gvd-glow \{([\s\S]*?)\n\}/.exec(css)![1];
    expect(glow).not.toMatch(/transform|translate|top|left/);
  });

  it("keeps the changed words visible under forced colours", () => {
    expect(css).toMatch(/@media \(forced-colors: active\) \{[\s\S]*?\.gvd-word \{ forced-color-adjust: none; background: Mark; color: MarkText; \}/);
  });
});

describe("the diff's sources", () => {
  it("name no colour: every tone is the sheet's", () => {
    expect(diff).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe("copying from the diff", () => {
  it("copies the code alone: what a line says to a screen reader cannot be selected", () => {
    expect(css).toMatch(/\.gvd-code \.vis-hidden, \.gvd-noeol, \.gvd-cr \{ -webkit-user-select: none; user-select: none; \}/);
    // The words are still there for a screen reader.
    expect(diff).toContain('<span className="vis-hidden">added: </span>');
    expect(diff).toContain('<span className="vis-hidden"> no newline at end of file</span>');
    // An empty line is an empty line on the clipboard, not a space.
    expect(diff).toMatch(/if \(!text\) return <br \/>;/);
  });
});

describe("the header and the rows that stay put", () => {
  it("cuts the path only by measuring: it never shrinks, and the rename chip gives way", () => {
    expect(/\.gvd-path \{[^}]*flex: none;/.test(css)).toBe(true);
    const from = /\.gvd-from \{([^}]*)\}/.exec(css)![1];
    expect(from).toMatch(/flex: 0 1 auto;/);
    expect(from).toMatch(/max-width: 40%;/);
    expect(from).toMatch(/text-overflow: ellipsis;/);
  });

  it("keeps a hunk's range and the load-more row in view when unwrapped code scrolls sideways", () => {
    expect(css).toMatch(/\.gvd-hunk-range \{ position: sticky; left: 106px;/);
    expect(css).toMatch(/\.gvd-hunk-range \{ grid-column: 3; left: 56px; \}/);
    const more = /\.gvd-more \{([^}]*)\}/.exec(css)![1];
    expect(more).toMatch(/position: sticky;\s*left: 0;/);
    expect(css).toMatch(/\.gvd-table \{ width: max-content; min-width: 100%; \}/);
    expect(diff).toContain('<div className="gvd-table">');
  });
});
