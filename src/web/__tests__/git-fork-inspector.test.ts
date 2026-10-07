// The Fork look's lower half rendered: the changed-file tree (every folder
// level a 22px row, folders before files, the filter and closed folders), the
// status squares and file kinds, the Changes tab and the Local Changes view
// around it — read-only, with no stage, unstage, discard or commit control
// anywhere — and the Commit tab: author and committer, refs, the whole SHA,
// parents as links, the message in monospace, the files. Rendered
// server-side, where layout effects do not run and nothing is measured.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import FkChanges, { TREE_SIZES_KEY, parseTreeSizes } from "../components/FkChanges";
import FkCommitTab, { FILES_MAX, refBadges } from "../components/FkCommitTab";
import FkCommitStrip, { avatarTone, initialsOf, longDate, stripDate } from "../components/FkCommitStrip";
import FkFileTree from "../components/FkFileTree";
import FkFileTypeLabel, { fileTypeOf } from "../components/FkFileTypeLabel";
import FkStatusBadge, { fkStatusKind } from "../components/FkStatusBadge";
import GitDiff from "../components/GitDiff";
import { fileOrder, foldersOf, treeRows, type FkTreeFile } from "../git-fork-tree";
import type { CommitDetail, CommitMessage, LogCommit, StatusEntry } from "../git-view-types";
import { sourceOf } from "./client-source";
import { sheetParts } from "./sheet-source";

/** One part of the sheet, by its path under src/web. */
const part = (path: string) => sheetParts().find(([p]) => p === path)![1];

// React 18 says on the server that layout effects do nothing there: true, and beside the point.
let quiet: ReturnType<typeof vi.spyOn>;
beforeAll(() => { quiet = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterAll(() => { quiet.mockRestore(); });

const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const file = (path: string, change = "modified", area = "commit", extra: Partial<FkTreeFile> = {}): FkTreeFile =>
  ({ key: `${area}:${path}`, path, area, change, ...extra });

const FILES = [
  file("src/auth/session.ts"),
  file("README.md", "added"),
  file("src/auth/jwt.ts", "renamed", "commit", { from: "src/auth/token.ts" }),
  file("src/Infrastructure/Context/Migrations/Snapshot.cs"),
  file("src/app.ts", "deleted"),
];

describe("the tree's rows", () => {
  it("draws every folder level, folders before files, each by name", () => {
    const rows = treeRows(FILES, new Set());
    expect(rows.map(r => `${"  ".repeat(r.depth)}${r.kind === "dir" ? `${r.name}/` : r.name}`)).toEqual([
      "src/",
      "  auth/",
      "    jwt.ts",
      "    session.ts",
      "  Infrastructure/",
      "    Context/",
      "      Migrations/",
      "        Snapshot.cs",
      "  app.ts",
      "README.md",
    ]);
    const src = rows[0];
    expect(src).toMatchObject({ key: "d:src", dir: "src", open: true, posinset: 1, setsize: 2 });
  });

  it("leaves a closed folder's rows out, and a filter opens every folder with a match", () => {
    const shut = treeRows(FILES, new Set(["src/auth", "src/Infrastructure"]));
    expect(shut.map(r => r.name)).toEqual(["src", "auth", "Infrastructure", "app.ts", "README.md"]);
    expect(shut.find(r => r.name === "auth")?.open).toBe(false);
    const found = treeRows(FILES, new Set(["src", "src/auth"]), "TOKEN");
    expect(found.map(r => r.name)).toEqual(["src", "auth", "jwt.ts"]);
    expect(treeRows(FILES, new Set(), "nothing-like-it")).toEqual([]);
  });

  it("steps through the files in the tree's order, folders open, and opens a file's folders to reveal it", () => {
    expect(fileOrder(FILES).map(f => f.path)).toEqual([
      "src/auth/jwt.ts", "src/auth/session.ts", "src/Infrastructure/Context/Migrations/Snapshot.cs", "src/app.ts", "README.md",
    ]);
    expect(foldersOf("src/Infrastructure/Context/x.cs")).toEqual(["src", "src/Infrastructure", "src/Infrastructure/Context"]);
    expect(foldersOf("README.md")).toEqual([]);
  });
});

describe("the tree rendered", () => {
  const render = (props: Partial<Parameters<typeof FkFileTree>[0]> = {}) => renderToStaticMarkup(createElement(FkFileTree, {
    files: FILES, selectedKey: "commit:src/auth/session.ts", onSelect: () => {}, onOpen: () => {}, label: "Files in abc1234", ...props,
  }));

  it("is a tree of 22px rows, each level 16px deeper, one tab stop on the selected file", () => {
    const html = render();
    expect(html).toContain('role="tree" aria-label="Files in abc1234"');
    const rows = [...html.matchAll(/<div role="treeitem"[^>]*>/g)].map(m => m[0]);
    expect(rows).toHaveLength(10);
    rows.forEach((r, i) => expect(r).toContain(`style="top:${i ? `${i * 22}px` : 0};height:22px;--depth:`));
    expect(html).toContain('style="height:220px"');
    expect(rows.filter(r => r.includes('tabindex="0"'))).toHaveLength(1);
    expect(rows.find(r => r.includes('tabindex="0"'))).toContain('data-key="commit:src/auth/session.ts"');
    expect(rows.find(r => r.includes('data-key="commit:src/auth/session.ts"'))).toContain('aria-selected="true"');
    expect(rows.find(r => r.includes('data-key="d:src"'))).toMatch(/aria-level="1"[\s\S]*aria-expanded="true"/);
    // The CSS behind it: 16px a level, the selection pill 10px in from both sides.
    expect(part("styles/git-inspector-fork.css")).toContain("padding: 0 4px 0 calc(var(--depth, 0) * 16px);");
  });

  it("gives a folder its folder icon and a file its status square and kind, its name never cut by the markup", () => {
    const html = render();
    const folder = /data-key="d:src\/auth"[\s\S]*?<\/div>/.exec(html)![0];
    expect(folder).toContain('class="fk-folder"');
    expect(folder).not.toContain("fk-st");
    const ts = /data-key="commit:src\/auth\/session\.ts"[\s\S]*?<\/div>/.exec(html)![0];
    expect(ts).toContain('<span class="fk-st" data-st="modified">');
    expect(ts).toContain('<span class="fk-ft" data-ft="ts" aria-hidden="true">TS</span>');
    expect(ts).toContain('<span class="fkt-name"><bdi>session.ts</bdi></span>');
    expect(ts).toContain('title="src/auth/session.ts"');
    expect(/data-key="commit:src\/auth\/jwt\.ts"[^>]*title="src\/auth\/jwt\.ts\nrenamed from src\/auth\/token\.ts"/.test(html)).toBe(true);
  });

  it("draws only the rows near the screen in a long list", () => {
    const many = Array.from({ length: 2000 }, (_, i) => file(`f/${String(i).padStart(4, "0")}.txt`));
    const html = render({ files: many, selectedKey: null });
    expect((html.match(/role="treeitem"/g) ?? []).length).toBeLessThanOrEqual(60);
    expect(html).toContain(`style="height:${2001 * 22}px"`);
  });

  it("says when there is nothing, and when the filter matches nothing", () => {
    expect(words(render({ files: [] }))).toBe("No changes");
    expect(words(render({ filter: "zzz" }))).toBe("No files match the filter");
  });
});

describe("status squares and file kinds", () => {
  it("draws each change as Fork does, its word for a screen reader", () => {
    const html = (c: string) => renderToStaticMarkup(createElement(FkStatusBadge, { change: c }));
    expect(html("modified")).toBe('<span class="fk-st" data-st="modified"><span class="fk-st-letter" aria-hidden="true">M</span><span class="vis-hidden">modified</span></span>');
    expect(html("typechange")).toContain(">T</span>");
    expect(html("added")).toMatch(/data-st="added"><svg class="fk-st-mark"[\s\S]*d="M4 \.8v6\.4M\.8 4h6\.4"/);
    expect(html("untracked")).toMatch(/data-st="untracked"><svg class="fk-st-mark"[\s\S]*vis-hidden">untracked</);
    expect(html("deleted")).toMatch(/data-st="deleted"><svg class="fk-st-mark"[\s\S]*d="M\.8 4h6\.4"/);
    expect(html("renamed")).toMatch(/data-st="renamed"><svg class="fk-st-mark"[\s\S]*d="M\.8 4h6\.2M4\.6 1\.6 7 4 4\.6 6\.4"/);
    expect(fkStatusKind("copied")).toBe("renamed");
    expect(html("conflict")).toMatch(/data-st="conflict"><svg class="fk-st-tri"[\s\S]*vis-hidden">conflict</);
  });

  it("labels a file's kind in letters, or draws the plain page", () => {
    expect(fileTypeOf("src/App.cs")).toEqual({ label: "C#", kind: "cs" });
    expect(fileTypeOf("a/b.TSX")).toEqual({ label: "TS", kind: "ts" });
    expect(fileTypeOf("styles/x.scss")).toEqual({ label: "CSS", kind: "css" });
    expect(fileTypeOf("Makefile")).toBeNull();
    expect(fileTypeOf(".gitignore")).toBeNull();
    expect(renderToStaticMarkup(createElement(FkFileTypeLabel, { path: "q.sql" }))).toContain('data-ft="sql" data-long="true"');
    expect(renderToStaticMarkup(createElement(FkFileTypeLabel, { path: "logo.png" }))).toContain('class="fk-ft is-page"');
  });

  it("keeps every colour in the sheet, none in the markup", () => {
    for (const f of ["FkStatusBadge.tsx", "FkFileTypeLabel.tsx", "FkFileTree.tsx", "FkChanges.tsx", "FkCommitTab.tsx", "FkCommitStrip.tsx", "FkPathBar.tsx"]) {
      expect(sourceOf(`components/${f}`), f).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });
});

// ── the Changes tab and Local Changes ─────────────────────────────────────

const STATUS: StatusEntry[] = [
  { path: "src/auth/session.ts", area: "staged", change: "modified" },
  { path: "src/auth/session.ts", area: "unstaged", change: "modified" },
  { path: "src/auth/password.ts", area: "staged", change: "added" },
  { path: "src/auth/oauth-callback.ts", area: "untracked", change: "untracked" },
  { path: "test/auth/session.test.ts", area: "untracked", change: "untracked" },
  { path: "src/legacy/basic-auth.ts", area: "unstaged", change: "deleted" },
  { path: "src/merge.ts", area: "conflict", change: "conflict" },
];
const EDITS = [
  { path: "src/auth/session.ts", agentId: null, label: "api-fix", at: 1 },
  { path: "src/auth/oauth-callback.ts", agentId: null, label: "api-fix", at: 2 },
  { path: "test/auth/session.test.ts", agentId: "a4f1", label: "test-writer", at: 3 },
];
const TEAM = { sessionId: "e3200d5a", agentIds: null };

const changes = (props: Partial<Parameters<typeof FkChanges>[0]> = {}) => renderToStaticMarkup(createElement(FkChanges, {
  mode: "local", entries: STATUS, edits: EDITS, focus: TEAM, selected: { path: "src/auth/session.ts", area: "unstaged" },
  onSelect: () => {}, onOpen: () => {}, collisions: [{ path: "src/auth/oauth-callback.ts", with: "web-bugfix" }],
  file: { path: "src/auth/session.ts", area: "unstaged" }, diff: null, loading: false, stale: false, onShowLatest: () => {},
  wrap: true, onToggleWrap: () => {}, name: "api-fix", ...props,
}));

describe("Local Changes", () => {
  it("lists Unstaged (untracked and conflicted included) and Staged, a file in both in both", () => {
    const html = changes();
    const unstaged = html.slice(html.indexOf(">Unstaged<"), html.indexOf(">Staged<"));
    const staged = html.slice(html.indexOf(">Staged<"));
    for (const p of ["unstaged:src/auth/session.ts", "untracked:src/auth/oauth-callback.ts", "untracked:test/auth/session.test.ts", "unstaged:src/legacy/basic-auth.ts", "conflict:src/merge.ts"]) {
      expect(unstaged, p).toContain(`data-key="${p}"`);
    }
    expect(staged).toContain('data-key="staged:src/auth/session.ts"');
    expect(staged).toContain('data-key="staged:src/auth/password.ts"');
    expect(staged).not.toContain("untracked:");
    expect(html).toContain('aria-label="Unstaged changes"');
    expect(html).toContain('aria-label="Staged changes"');
  });

  it("marks the agent's files with its swatch, a subagent's with ↳ name, and a sharp collision with its glyph", () => {
    const html = changes();
    const row = (key: string) => new RegExp(`data-key="${key.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"[\\s\\S]*?</div>`).exec(html)![0];
    expect(row("unstaged:src/auth/session.ts")).toContain('<i class="fkt-swatch" aria-hidden="true"></i>');
    expect(row("untracked:test/auth/session.test.ts")).toContain("↳ test-writer");
    expect(row("untracked:src/auth/oauth-callback.ts")).toContain('class="fkt-clash" role="img" aria-label="also edited by web-bugfix"');
    expect(row("unstaged:src/legacy/basic-auth.ts")).not.toContain("fkt-marks");
    // Every other file is quieter, so the agent's own stand out as they lead the deck's list.
    expect(html).toMatch(/data-key="unstaged:src\/legacy\/basic-auth\.ts" class="fkt-row is-quiet"/);
    expect(html).toMatch(/data-key="unstaged:src\/auth\/session\.ts" class="fkt-row is-sel"/);
    expect(changes({ edits: [] })).not.toContain("is-quiet");
    // The funnel narrows to those files; it is there only when there are some.
    expect(html).toContain('class="fkc-funnel" aria-pressed="false"');
    expect(changes({ edits: [] })).not.toContain("fkc-funnel");
  });

  it("renders no control that stages, unstages, discards, reverts or commits", () => {
    for (const html of [changes(), changes({ mode: "commit", entries: [], commit: null })]) {
      const buttons = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map(m => words(m[0]) + " " + (/aria-label="([^"]*)"/.exec(m[0])?.[1] ?? "") + " " + (/title="([^"]*)"/.exec(m[0])?.[1] ?? ""));
      for (const b of buttons) expect(b).not.toMatch(/\b(stage|unstage|discard|revert|reset|commit|stash|checkout|push|pull|fetch)\b/i);
      expect(words(html)).not.toMatch(/\b(Stage|Unstage|Discard|Commit \d+ Files?|Amend)\b/);
      expect(html).not.toMatch(/<(input|textarea)[^>]*(commit|subject|description)/i);
    }
  });

  it("puts the filter and the path bar on one 19px band, the diff in Fork's look", () => {
    const html = changes({ diff: { ok: true, binary: false, patch: "@@ -1,2 +1,2 @@\n a\n-b\n+c\n", added: 1, removed: 1 } as never });
    expect(html).toContain('<input type="search" class="fkc-filter-input" placeholder="Filter" aria-label="Filter the files"');
    expect(html).toContain('class="fkd-bar"');
    expect(html).not.toContain('class="gvd-head"');
    const css = part("styles/git-inspector-fork.css") + part("styles/git-diff-fork.css");
    expect(css).toMatch(/\.fkc-band \{[^}]*height: 19px;/);
    expect(css).toMatch(/\.fkd-bar \{[^}]*height: 19px;/);
  });
});

describe("the trees' sizes", () => {
  it("remembers each mode's tree width and the Unstaged share, each value checked on its own", () => {
    expect(TREE_SIZES_KEY).toBe("agent-dag.gitForkTrees");
    expect(parseTreeSizes(JSON.stringify({ commit: 240.4, local: 300, unstaged: 0.6 }))).toEqual({ commit: 240, local: 300, unstaged: 0.6 });
    expect(parseTreeSizes(JSON.stringify({ commit: -5, local: "x", unstaged: 2 }))).toEqual({ commit: undefined, local: undefined, unstaged: undefined });
    expect(parseTreeSizes("{broken")).toEqual({ commit: undefined, local: undefined, unstaged: undefined });
    expect(parseTreeSizes(null)).toEqual({ commit: undefined, local: undefined, unstaged: undefined });
  });
});

describe("the Changes tab", () => {
  const COMMIT = { sha: "65fecee0c1d2e3f405162738495a6b7c8d9e0f1a", author: { name: "Ada Lovelace", email: "ada@example.com" }, date: "2026-10-05T16:15:00Z", subject: "feat(auth): add login route" };
  it("leads with the commit's strip and lists its files as one tree", () => {
    const html = changes({ mode: "commit", entries: [{ path: "src/a.ts", change: "added", added: 3, removed: 0, binary: false }], commit: COMMIT, selected: null, file: null, edits: [] });
    expect(html).toContain('class="fkc-strip"');
    expect(html).toContain('<span class="fkm-ava" data-size="strip"');
    expect(html).toContain(">65fecee</button>");
    expect(html).toContain(">feat(auth): add login route</span>");
    expect(html).toContain('aria-label="Files in 65fecee"');
    expect(html).toContain('data-key="commit:src/a.ts"');
    expect(html).not.toContain(">Unstaged<");
    // Nothing selected: one quiet line where the diff goes.
    expect(html).toContain('<span class="fkd-empty-line">Select a file.</span>');
  });

  it("says the files are being read, or why they could not be", () => {
    expect(words(changes({ mode: "commit", entries: [], commit: COMMIT, reading: "loading" }))).toContain("Reading the commit's files…");
    const failed = changes({ mode: "commit", entries: [], commit: COMMIT, reading: { error: "timeout" }, onRetryFiles: () => {} });
    expect(words(failed)).toContain("Couldn't read this commit's files. git took too long to answer. Try again");
  });
});

describe("the Fork diff", () => {
  const diff = (patch: string, extra = {}) => renderToStaticMarkup(createElement(GitDiff, {
    file: { path: "src/a.ts", area: "commit" }, diff: { ok: true, binary: false, patch, added: 1, removed: 1 } as never,
    loading: false, stale: false, onShowLatest: () => {}, wrap: true, onToggleWrap: () => {}, collision: null, look: "fork", ...extra,
  }));

  it("draws the path bar with ▲ ▼, enabled only where there is a file to step to", () => {
    const html = diff("@@ -1 +1 @@\n-a\n+b\n", { onNextFile: () => {} });
    expect(html).toMatch(/<button type="button" class="fkd-step" disabled="" title="Previous file"/);
    expect(html).toMatch(/<button type="button" class="fkd-step" title="Next file" aria-label="Next file">/);
    expect(html).toContain('<span class="fkd-bar-dir">src/</span><span class="fkd-bar-base">a.ts</span>');
  });

  it("sizes the number gutter to the largest line number, and gives a new file one number column", () => {
    const wide = diff("@@ -998,3 +998,4 @@\n a\n-b\n+c\n+d\n e\n");
    expect(wide).toMatch(/class="gvd-diff" style="--fkd-digits:4"/);
    const created = diff("new file mode 100644\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n");
    expect(created).toContain('data-one="new"');
  });

  it("keeps the +/− glyph, the hunk header as a row, and the screen reader's words", () => {
    const html = diff("@@ -1,2 +1,2 @@ fn main\n a\n-b\n+c\n");
    expect(html).toContain('<span class="gvd-glyph" aria-hidden="true">+</span>');
    expect(html).toContain('<span class="gvd-glyph" aria-hidden="true">−</span>');
    expect(html).toContain('<span class="gvd-hunk-range">@@ -1,2 +1,2 @@</span>');
    expect(html).toContain('<span class="vis-hidden">added: </span>');
  });

  it("leaves the deck look's diff exactly as it was", () => {
    const deck = renderToStaticMarkup(createElement(GitDiff, {
      file: { path: "src/a.ts", area: "unstaged" }, diff: { ok: true, binary: false, patch: "@@ -1 +1 @@\n-a\n+b\n", added: 1, removed: 1 } as never,
      loading: false, stale: false, onShowLatest: () => {}, wrap: true, onToggleWrap: () => {}, collision: null,
    }));
    expect(deck).toContain('class="gvd-head"');
    expect(deck).not.toMatch(/fkd-|--fkd-digits|data-one/);
  });
});

// ── the Commit tab ─────────────────────────────────────────────────────────

const SHA = "2526e0dffc527d0ef6fe1e4708b60f099763533e";
const PARENT = "137940a1b2c3d4e5f60718293a4b5c6d7e8f9012";
const LOG: LogCommit = {
  sha: SHA, parents: [PARENT], author: { name: "Bargan Constantin", email: "cb@example.com" }, date: "2026-10-05T13:50:54Z",
  subject: "feat(ai): trip section screen counts as on the trip", trailers: [],
  refs: { local: ["feature/bargan/9277", "backup"], remote: ["origin/feature/bargan/9277", "origin/HEAD"], tags: ["v1.2.0"], head: true },
  agent: null,
};
const DETAIL: CommitDetail = {
  commit: {
    ...LOG, committer: { name: "Fiodor Songurov", email: "fs@example.com", date: "2026-10-06T04:00:01Z" },
    body: "On a trip's section screen the tools refused.\n\nAPI:\n- AssistantTripId falls back",
  } as LogCommit & CommitMessage,
  files: [
    { path: "src/Mcp/Tools/AssistantTripId.cs", change: "modified", added: 3, removed: 1, binary: false },
    { path: "docs/new.md", change: "added", added: 9, removed: 0, binary: false },
  ],
};
const tab = (props: Partial<Parameters<typeof FkCommitTab>[0]> = {}) => renderToStaticMarkup(createElement(FkCommitTab, {
  commit: LOG, detail: DETAIL, loading: false, onJump: () => {}, onOpenFile: () => {}, headBranch: "feature/bargan/9277", ...props,
}));

describe("the Commit tab", () => {
  it("shows the author and the committer, each with initials and the long date", () => {
    const html = tab();
    expect(words(html)).toMatch(/Author Bargan Constantin cb@example\.com .*Committer Fiodor Songurov fs@example\.com/);
    expect(html).toContain('<span class="fkm-ava" data-size="card" data-tone="');
    expect(html).toContain(`>BC</span>`);
    expect(html).toContain(`>FS</span>`);
    expect(html).toContain(longDate("2026-10-06T04:00:01Z"));
  });

  it("says the author and the committer once, when they are the same person at the same moment", () => {
    const same = { ...DETAIL, commit: { ...DETAIL.commit, committer: { name: LOG.author.name, email: LOG.author.email, date: "2026-10-05T16:50:54+03:00" } } as LogCommit & CommitMessage };
    const html = tab({ detail: same });
    expect(words(html)).toContain("Author and committer Bargan Constantin");
    expect((html.match(/class="fkm-id"/g) ?? []).length).toBe(1);
    expect((tab().match(/class="fkm-id"/g) ?? []).length).toBe(2);
  });

  it("lists the refs as badges, HEAD's branch first, a remote's HEAD left out", () => {
    expect(refBadges(LOG, "feature/bargan/9277")).toEqual([
      { kind: "head", name: "feature/bargan/9277" },
      { kind: "local", name: "backup" },
      { kind: "remote", name: "origin/feature/bargan/9277" },
      { kind: "tag", name: "v1.2.0" },
    ]);
    expect(refBadges({ refs: { local: [], remote: [], tags: [], head: true } }, null)).toEqual([{ kind: "detached", name: "HEAD" }]);
    // A real branch whose name ends in HEAD is no remote's HEAD.
    expect(refBadges({ refs: { local: [], remote: ["origin/fix/HEAD", "fork/HEAD"], tags: [], head: false } }, null)).toEqual([{ kind: "remote", name: "origin/fix/HEAD" }]);
    const html = tab();
    // The history's own badge, in its neutral colours.
    expect(html).toContain('<span class="fk-ref" data-kind="remote" data-tone="neutral" title="remote branch origin/feature/bargan/9277"><span class="fk-ref-cell"');
    expect(html).not.toContain("origin/HEAD");
  });

  it("gives the whole SHA with a copy button, and each parent as a link into the history", () => {
    const jumped: string[] = [];
    const html = tab({ onJump: s => jumped.push(s) });
    expect(html).toContain(`<span class="fkm-sha-text">${SHA}</span>`);
    expect(html).toContain('aria-label="Copy commit SHA 2526e0d"');
    expect(html).toContain('<button type="button" class="fkm-parent" title="Select 137940a in the history">137940a</button>');
    expect(words(html)).toContain("Parent 137940a");
  });

  it("sets the subject apart and the body in monospace, whole", () => {
    const html = tab();
    expect(html).toContain('<h3 class="fkm-subject">feat(ai): trip section screen counts as on the trip</h3>');
    expect(html).toContain("<pre class=\"fkm-body\">On a trip&#x27;s section screen the tools refused.\n\nAPI:\n- AssistantTripId falls back</pre>");
    expect(part("styles/git-inspector-fork.css")).toMatch(/\.fkm-body \{[^}]*font: 13px\/17px var\(--font-mono\);[^}]*white-space: pre-wrap;/);
    expect(words(tab({ detail: { ...DETAIL, commit: { ...DETAIL.commit, body: "x", clipped: true } as LogCommit & CommitMessage } }))).toContain("goes on past 64 KB");
  });

  it("lists the files in 20px rows, each opening in the Changes tab", () => {
    const html = tab();
    expect(html).toMatch(/<li class="fkm-file"><button type="button" class="fkm-file-btn" title="src\/Mcp\/Tools\/AssistantTripId\.cs\nOpen in the Changes tab"><span class="fk-st" data-st="modified">/);
    expect(html).toContain('<span class="fk-ft" data-ft="cs" aria-hidden="true">C#</span>');
    expect(part("styles/git-inspector-fork.css")).toMatch(/\.fkm-file-btn \{[^}]*height: 20px;/);
    const many: CommitDetail = { ...DETAIL, files: Array.from({ length: FILES_MAX + 5 }, (_, i) => ({ path: `f${i}`, change: "modified", added: 1, removed: 0, binary: false })) };
    expect(words(tab({ detail: many }))).toContain("And 5 more files: the Changes tab lists them all.");
  });

  it("waits for the commit's own read, and says when it failed", () => {
    expect(words(tab({ detail: null, loading: true }))).toBe("Reading the commit…");
    expect(words(tab({ detail: null, error: "timeout", onRetry: () => {} }))).toContain("Couldn't read this commit. git took too long to answer. Try again");
    expect(words(tab({ commit: null, detail: null }))).toBe("Select a commit to read it here.");
  });
});

describe("avatars and dates", () => {
  it("picks one of five tones by the lower-cased e-mail, and two initials", () => {
    expect(avatarTone("A", "Ada@Example.com")).toBe(avatarTone("Someone else", "ada@example.com"));
    expect(new Set(["a@x", "b@x", "c@x", "d@x", "e@x", "f@x", "g@x", "h@x"].map(e => avatarTone("", e))).size).toBeGreaterThan(1);
    for (const e of ["a@x", "zz@y", ""]) expect(avatarTone("n", e)).toBeGreaterThanOrEqual(0);
    expect(initialsOf("Bargan Constantin")).toBe("BC");
    expect(initialsOf("Tomás Ortega")).toBe("TO");
    expect(initialsOf("dependabot[bot]")).toBe("D");
    expect(initialsOf("")).toBe("?");
  });

  it("writes the strip's date and the Commit tab's long one in Fork's words", () => {
    expect(stripDate("2026-09-18T12:53:00Z", "en-GB")).toMatch(/^18 Sept? 2026 at \d\d:53$/);
    expect(longDate("2026-10-05T13:50:54Z", "en-GB")).toMatch(/^5 October 2026 at \d\d:50:54 /);
    expect(stripDate("not a date")).toBe("not a date");
  });

  it("puts the strip's SHA on a button that copies it", () => {
    const html = renderToStaticMarkup(createElement(FkCommitStrip, { commit: { sha: SHA, author: LOG.author, date: LOG.date, subject: LOG.subject } }));
    expect(html).toContain(`<button type="button" class="fkc-strip-sha" title="Copy ${SHA}" aria-label="Copy commit SHA 2526e0d">2526e0d</button>`);
  });
});
