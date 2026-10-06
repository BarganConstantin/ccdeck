// The diff pane rendered: what it says for the answers a file's diff can be.
// Rendered server-side, where effects do not run, so nothing is measured,
// coloured or windowed: the first frame, as a page draws it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GitDiff, { BLOCK_LINES, blocksOf, type GitDiffProps } from "../components/GitDiff";
import { parsePatch } from "../git-diff-parse";
import { sourceOf } from "./client-source";

// React 18 says on the server that layout effects do nothing there: true, and beside the point.
let quiet: ReturnType<typeof vi.spyOn>;
beforeAll(() => { quiet = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterAll(() => { quiet.mockRestore(); });

const render = (props: Partial<GitDiffProps>) => renderToStaticMarkup(createElement(GitDiff, {
  file: { path: "src/a.ts", area: "unstaged" }, diff: null, loading: false, stale: false, onShowLatest: () => {},
  wrap: true, onToggleWrap: () => {}, collision: null, ...props,
}));

/** The visible words of some markup, tags dropped. */
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const CONFLICT = [
  "diff --git a/CHANGELOG.md b/CHANGELOG.md",
  "index 94ec7c6..59b3f5a 100644",
  "--- a/CHANGELOG.md",
  "+++ b/CHANGELOG.md",
  "@@ -35,4 +35,8 @@",
  " ## 1.4.0",
  "+<<<<<<< HEAD",
  " # CHANGELOG from ours",
  "+=======",
  "+# CHANGELOG from other",
  "+>>>>>>> conflict-src",
  "",
].join("\n");

describe("a file in conflict", () => {
  it("shows its markers as added lines, under a note that says it is in conflict", () => {
    const html = render({ file: { path: "CHANGELOG.md", area: "conflict" }, diff: { ok: true, binary: false, patch: CONFLICT, added: 4, removed: 0 } });
    expect(html).toContain("Unresolved merge conflict.");
    expect(html).not.toContain("No changes in the text.");
    expect((html.match(/class="gvd-line" data-kind="add"/g) ?? []).length).toBe(4);
    expect(words(html)).toContain("added: &lt;&lt;&lt;&lt;&lt;&lt;&lt; HEAD");
  });

  it("never claims nothing changed when git answers with a combined diff or an unmerged path", () => {
    const cc = "diff --cc CHANGELOG.md\nindex 94ec7c6,59b3f5a..0000000\n--- a/CHANGELOG.md\n+++ b/CHANGELOG.md\n@@@ -35,4 -35,4 +35,8 @@@\n  ## 1.4.0\n++<<<<<<< HEAD\n";
    expect(parsePatch(cc)).toMatchObject({ unmerged: true, hunks: [] });
    expect(parsePatch("* Unmerged path both.txt\n").unmerged).toBe(true);
    for (const patch of [cc, "* Unmerged path both.txt\n", ""]) {
      const html = render({ file: { path: "both.txt", area: "conflict" }, diff: { ok: true, binary: false, patch, added: 0, removed: 0 } });
      expect(html).not.toContain("No changes in the text.");
      expect(html).toContain("In conflict");
    }
  });
});

describe("a long diff", () => {
  const long = (n: number) => `@@ -1,${n} +1,${n} @@\n${Array.from({ length: n }, (_, i) => `-row ${i}\n+row ${i}!`).join("\n")}\n`;

  it("is drawn in blocks of lines, each hunk's header with its first block", () => {
    const p = parsePatch(`${long(130)}@@ -400 +400 @@ fn\n-a\n+b\n`);
    const blocks = blocksOf(p.hunks);
    expect(blocks.map(b => [b.hi, b.from, b.to, b.head])).toEqual([
      [0, 0, BLOCK_LINES, true], [0, BLOCK_LINES, 200, false], [0, 200, 260, false], [1, 0, 2, true],
    ]);
    // Each starts where the one before it ends, by its estimate.
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].top).toBe(blocks[i - 1].top + blocks[i - 1].est);
  });

  it("draws its first budget in full on the first frame, with Load more and Load all", () => {
    const html = render({ diff: { ok: true, binary: false, patch: long(5000), added: 5000, removed: 5000 } });
    expect((html.match(/class="gvd-line"/g) ?? []).length).toBe(400);
    expect((html.match(/class="gvd-block"/g) ?? []).length).toBe(4);
    expect(words(html)).toContain("Showing 400 of 10,000 lines Load 400 more Load all");
  });

  it("keeps the last body as it was, in the same wrapper, while the next file's diff is read", () => {
    const html = render({ diff: null, loading: true });
    expect(html).toContain('class="gvd-loading"');
    expect(html).toContain('<div class="gvd-body">');
  });
});

describe("what the diff windows", () => {
  const src = sourceOf("components/GitDiff.tsx");

  it("renders only the blocks near the view once a diff is long, each skipped block holding its height", () => {
    expect(src).toMatch(/const windowed = !!budgeted && budgeted\.shown >= WINDOW_FROM/);
    expect(src).toMatch(/new IntersectionObserver\([\s\S]*?\{ root: scrollRef\.current, rootMargin: WINDOW_MARGIN \}/);
    expect(src).toMatch(/if \(watch && !near\) return <div ref=\{ref\} className="gvd-block" style=\{\{ height: heights\.get\(block\.key\) \?\? block\.est \}\} \/>/);
    expect(src).toContain("export const WINDOW_FROM = 1200;");
  });

  it("keeps the body it last drew as the same element while the next one loads, so nothing is drawn twice", () => {
    expect(src).toMatch(/content = pending \? lastBody\.current/);
    expect(src).toMatch(/<div className="gvd-body" data-pending=\{pending \|\| undefined\}/);
    expect(src).not.toContain("gvd-pending");
  });

});
