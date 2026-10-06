// The diff pane rendered: what it says for the answers a file's diff can be.
// Rendered server-side, where effects do not run, so nothing is measured,
// coloured or windowed: the first frame, as a page draws it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GitDiff, { BLOCK_LINES, blocksOf, lineKeys, type GitDiffProps } from "../components/GitDiff";
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
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

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
    expect((html.match(/class="gvd-line"[^>]*data-kind="add"/g) ?? []).length).toBe(4);
    expect(words(html)).toContain("added: <<<<<<< HEAD");
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

describe("what the diff windows and how it keeps the keyboard", () => {
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

  it("moves the keyboard to the diff before a control it was on goes away", () => {
    expect(src).toContain('onClick={() => { holdFocus(); setExpanded(true); }}>Show diff</button>');
    expect(src).toContain("onClick={() => { holdFocus(); setSteps(() => Infinity); }}>Load all</button>");
    expect(src).toContain("onClick={() => { if (next >= b.total) holdFocus(); setSteps(s => s + 1); }}");
    expect(src).toMatch(/const holdFocus = useCallback\(\(\) => \{[\s\S]*?s\.focus\(\{ preventScroll: true \}\)/);
  });
});

describe("the reader's place when the latest version comes", () => {
  const v1 = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -40,4 +40,5 @@ fn\n x\n-y\n+Y\n+Y2\n z\n w\n";
  // The first hunk is gone (the file was put back there) and the second has
  // one more line; the second is still the same block, its lines the same.
  const v2 = "@@ -40,4 +40,6 @@ fn\n x\n-y\n+Y\n+Y2\n+Y3\n z\n w\n";

  it("keys each hunk's blocks by where the hunk starts in the old file, not by its place in the list", () => {
    const a = blocksOf(parsePatch(v1).hunks), b = blocksOf(parsePatch(v2).hunks);
    expect(a.map(k => k.key)).toEqual(["o1.0", "o40.0"]);
    expect(b.map(k => k.key)).toEqual(["o40.0"]);
  });

  it("keys a line by its old number, or by the old line an added one follows", () => {
    const h1 = parsePatch(v1).hunks[1], h2 = parsePatch(v2).hunks[0];
    expect(lineKeys(h1.lines, h1.oldStart)).toEqual(["o40", "o41", "a41.0", "a41.1", "o42", "o43"]);
    // The same lines keep their keys, whatever their new numbers became.
    expect(lineKeys(h2.lines, h2.oldStart)).toEqual(["o40", "o41", "a41.0", "a41.1", "a41.2", "o42", "o43"]);
    // A hunk that only adds, at the top of a file, still has keys of its own.
    const add = parsePatch("@@ -0,0 +1,2 @@\n+p\n+q\n").hunks[0];
    expect(lineKeys(add.lines, add.oldStart)).toEqual(["a-1.0", "a-1.1"]);
  });

  it("names a line the same in both versions when its hunk starts elsewhere", () => {
    // Two changes close enough to share a hunk; the top one is put back, so
    // the hunk now starts lower in the old file. The lines under the reader
    // are the same lines, and the place they were read at must still find them.
    const both = "@@ -4,9 +4,9 @@\n d\n e\n f\n-g\n+G\n h\n i\n-j\n+J\n k\n l\n";
    const one = "@@ -7,7 +7,7 @@\n g\n h\n i\n-j\n+J\n k\n l\n";
    const keyOf = (patch: string, code: string) => {
      const html = render({ diff: { ok: true, binary: false, patch, added: 1, removed: 1 } });
      const line = [...html.matchAll(/<div class="gvd-line" data-k="([^"]+)"[\s\S]*?<\/div>/g)].find(m => words(m[0]).endsWith(code));
      return line?.[1];
    };
    expect(keyOf(both, "k")).toBeDefined();
    expect(keyOf(both, "k")).toBe(keyOf(one, "k"));
    expect(keyOf(both, "added: J")).toBe(keyOf(one, "added: J"));
  });

  it("looks again for that line once the blocks near it are drawn, when a long diff's block was drawn anew", () => {
    const src = sourceOf("components/GitDiff.tsx");
    expect(src).toMatch(/function keepPlace\(s: HTMLElement \| null, at: \{ k: string; off: number \} \| null\): boolean \{/);
    expect(src).toMatch(/if \(!keepPlace\(scrollRef\.current, at\) && at && windowed\) \{/);
    // For a moment, and never against a reader who has moved the scroller since.
    expect(src).toMatch(/if \(!s \|\| s\.scrollTop !== st \|\| performance\.now\(\) > until \|\| keepPlace\(s, at\)\) return;/);
  });

  it("notes the reader's line again once the blocks at the top of the view are drawn, after one jump of the scroller", () => {
    // A jump (a scrollbar drag, End) lands on blocks not drawn yet: the scroll
    // event is noted before they are, and nothing else scrolls. Each block
    // drawn by the window notes the place again, so `n` finds the line.
    const src = sourceOf("components/GitDiff.tsx");
    expect(src).toMatch(/<DiffBlock key=\{k\.key\} block=\{k\} rows=\{rows!\} watch=\{watch\} heights=\{heights\.current\} onDrawn=\{notePlace\} \/>/);
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{ if \(watch && near\) onDrawn\(\); \}, \[watch, near, onDrawn\]\);/);
  });

  it("puts the line the reader was on back where it was on screen", () => {
    const src = sourceOf("components/GitDiff.tsx");
    expect(src).toMatch(/if \(prev\.key === fileKey && prev\.parsed && parsed && prev\.parsed !== parsed\) holdPlace\(\);/);
    expect(src).toContain("onScroll={notePlace}");
    expect(src).toMatch(/<div key=\{keys\[li\]\} className="gvd-line" data-k=/);
  });
});

describe("a read that failed, or a change git no longer lists", () => {
  it("says the diff could not be read, why, and offers it again", () => {
    const html = render({ error: "timeout", onRetry: () => {} });
    expect(words(html)).toContain("Couldn't read this diff. git took too long to answer. Try again");
    expect(html).not.toContain("Nothing to show yet.");
    expect(words(render({ error: "the deck did not answer", onRetry: () => {} }))).toContain("The deck did not answer. Try again");
    // A failed read the route answered with 200 says the same.
    expect(words(render({ diff: { ok: false, reason: "timeout" }, onRetry: () => {} }))).toContain("Couldn't read this diff. git took too long to answer. Try again");
  });

  it("offers no Try again where reading again cannot help: a partial clone's missing content, a filter it will not run", () => {
    for (const html of [render({ error: "not-downloaded", onRetry: () => {} }), render({ diff: { ok: false, reason: "not-downloaded" }, onRetry: () => {} })]) {
      expect(words(html)).toContain("Not downloaded in this partial clone. The deck never fetches");
      expect(html).not.toContain("Try again");
    }
    const unsafe = render({ error: "unsafe", onRetry: () => {} });
    expect(words(unsafe)).toContain("Couldn't read this diff. git would run a filter program");
    expect(unsafe).not.toContain("Try again");
  });

  it("says a change git no longer lists is no longer there, rather than an error", () => {
    for (const error of ["unlisted", "no such change in this repository"]) {
      const html = render({ error });
      expect(words(html)).toContain("No longer unstaged. git no longer lists this change here: it was committed, staged, or put back as it was.");
      expect(html).not.toContain("Try again");
    }
  });

  it("keeps the diff on screen and says in the header that git no longer lists it", () => {
    const html = render({ diff: { ok: true, binary: false, patch: "@@ -1 +1 @@\n-a\n+b\n", added: 1, removed: 1 }, stale: true, gone: true });
    expect(words(html)).toContain("No longer unstaged · Show latest n");
    expect((html.match(/class="gvd-line"/g) ?? []).length).toBe(2);
  });

  it("is read again from the view: the pill, n and Try again all read the latest, or read once more", () => {
    const hook = sourceOf("use-git-view.ts");
    expect(hook).toMatch(/if \(data\.entries && !data\.entries\.some\(e => e\.path === file\.path && e\.area === file\.area\)\) \{ unlisted\(\); return; \}/);
    expect(hook).toMatch(/if \(next === GONE\) \{ setDiff\(d => \(\{ \.\.\.d, diff: null, stale: false, gone: false, error: "unlisted" \}\)\); return; \}/);
    expect(hook).toMatch(/setAgain\(n => n \+ 1\);\n  \}, \[\]\);/);
    expect(hook).toMatch(/\}, \[active, fileKey, again\]\);/);
    const view = sourceOf("components/GitView.tsx");
    expect(view).toContain("error={view.diff.error} gone={view.diff.gone} onRetry={view.showLatest}");
  });
});

describe("a commit's files that are still being read, or could not be", () => {
  const hook = sourceOf("use-git-view.ts");

  it("never keeps a failed read as the commit's files: choosing it again, Try again or the folder moving reads again", () => {
    expect(hook).not.toMatch(/"error"\)\);/);
    expect(hook).toMatch(/a\.ok && a\.files \? a\.files : \{ error: failureOf\(a, status\) \}/);
    expect(hook).toMatch(/const setSel = useCallback\(\(id: string\) => \{\n    dropFailures\(id\);/);
    expect(hook).toMatch(/useEffect\(\(\) => \{ dropFailures\(\); \}, \[data\.treeSeq\]\);/);
    expect(sourceOf("components/GitView.tsx")).toMatch(/reading=\{sel === UNCOMMITTED \? null : view\.commitFiles == null \? "loading" : Array\.isArray\(view\.commitFiles\) \? null : view\.commitFiles\}/);
  });
});

describe("a rename, and a change of line endings, as the header and lines say them", () => {
  it("names a renamed file's old path as the list has it, not as git quoted it in the patch", () => {
    const patch = 'diff --git "a/edge/we\\"q.txt" "b/edge/moved.txt"\nsimilarity index 66%\nrename from "edge/we\\"q.txt"\nrename to "edge/moved.txt"\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n';
    const html = render({ file: { path: "edge/moved.txt", area: "staged", from: "edge/we\"q.txt" }, diff: { ok: true, binary: false, patch, added: 1, removed: 1 } });
    expect(words(html)).toContain('← we"q.txt · 66%');
    expect(html).not.toContain("we\\&quot;q.txt&quot;");
  });

  it("marks the carriage return a line lost, and says only the endings changed", () => {
    const html = render({ file: { path: "edge/eol.txt", area: "unstaged" }, diff: { ok: true, binary: false, patch: "@@ -1,2 +1,2 @@\n-one\r\n-two\r\n+one\n+two\n", added: 2, removed: 2 } });
    expect((html.match(/class="gvd-cr"/g) ?? []).length).toBe(2);
    expect(words(html)).toContain("Only the line endings changed (CRLF → LF).");
    // A CRLF file with an ordinary edit marks nothing and says nothing.
    const edit = render({ diff: { ok: true, binary: false, patch: "@@ -1 +1 @@\n-a\r\n+b\r\n", added: 1, removed: 1 } });
    expect(edit).not.toContain("gvd-cr");
    expect(edit).not.toContain("line endings");
  });
});

describe("one path in two commits", () => {
  it("is two diffs: each opens on its own first budget and collapsed, never on the other's", () => {
    const diff = sourceOf("components/GitDiff.tsx");
    expect(diff).toContain('const fileKey = props.diffKey ?? (file ? `${file.area}\\0${file.path}` : "");');
    const view = sourceOf("components/GitView.tsx");
    expect(view).toContain("diffKey={view.diff.file && view.diff.sel ? `${view.diff.sel}:${view.diff.file.area}:${view.diff.file.path}` : undefined}");
    expect(sourceOf("use-git-view.ts")).toContain("setDiff({ file, sel, diff: null, loading: true, stale: false, error: null });");
  });
});

describe("the keys inside an unwrapped diff", () => {
  it("scroll the code sideways both ways, and step back to the files only from the left edge", () => {
    const diff = sourceOf("components/GitDiff.tsx");
    expect(diff).toContain("onScroll={notePlace} onKeyDown={scrollSideways}>");
    expect(diff).toMatch(/const room = e\.key === "ArrowLeft" \? s\.scrollLeft : s\.scrollWidth - s\.clientWidth - s\.scrollLeft;\n    if \(room <= 0\) return;\n    e\.preventDefault\(\);/);
    // The view swallows a key the pane already answered, and moves to the
    // files on an ← nobody answered.
    expect(sourceOf("git-view-keys.ts")).toMatch(/if \(where\.typing \|\| where\.handled\) return \{ kind: "swallow" \};/);
  });
});

describe("the header's Open in editor and Reload", () => {
  const text = { ok: true, binary: false, patch: "@@ -1 +1 @@\n-a\n+b\n", added: 1, removed: 1 };

  it("reloads the working tree's diff, the way n does, and has nothing to reload in a commit", () => {
    const html = render({ diff: text, onReload: () => {} });
    expect(html).toMatch(/<button type="button" class="glyph-btn gvd-icon" title="Reload the diff \(n\)" aria-label="Reload the diff">/);
    expect(render({ file: { path: "src/a.ts", area: "commit" }, diff: text, onReload: () => {} })).not.toContain("Reload the diff");
    expect(sourceOf("components/GitView.tsx")).toContain("onReload={view.showLatest}");
  });

  it("opens the file in the editor the deck found, only on the deck's own machine", () => {
    // Until the deck says it found an editor and the page is on its machine, no button.
    expect(render({ diff: text, editorFor: { sessionId: "s", agentId: null } })).not.toContain("Open src/a.ts in");
    const diff = sourceOf("components/GitDiff.tsx");
    expect(diff).toMatch(/if \(handoffs\.state !== "ready" \|\| !handoffs\.local \|\| !app\) return null;/);
    expect(diff).toContain('openHandoff({ sessionId: to.sessionId, agentId: to.agentId, slot: "editor", file: path })');
    expect(diff).toContain("<b>Couldn't open it in {openFailed.app}.</b>");
  });
});
