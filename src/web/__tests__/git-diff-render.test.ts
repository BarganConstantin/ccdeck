// The diff pane rendered: what it says for the answers a file's diff can be.
// Rendered server-side, where effects do not run, so nothing is measured,
// coloured or windowed: the first frame, as a page draws it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GitDiff, { type GitDiffProps } from "../components/GitDiff";
import { parsePatch } from "../git-diff-parse";

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
