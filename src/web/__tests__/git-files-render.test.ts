// The file list rendered: the counts an uncommitted row now carries, drawn as
// a commit's files draw theirs, and the line naming a subagent that works in
// another folder — where it sits, what it says, and that it is reached and
// activated like a row. Rendered server-side, where layout effects do not run,
// so the paths are uncut and nothing is measured.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GitFiles from "../components/GitFiles";
import type { ElsewhereRow, GitEdit, StatusEntry } from "../git-files-model";
import { elsewhereRows } from "../git-files-model";
import { sourceOf } from "./client-source";

// React 18 says on the server that layout effects do nothing there: true, and beside the point.
let quiet: ReturnType<typeof vi.spyOn>;
beforeAll(() => { quiet = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterAll(() => { quiet.mockRestore(); });

const TEAM = { sessionId: "e3200d5a", agentIds: null };
const EDITS: GitEdit[] = [{ path: "src/auth/session.ts", agentId: null, label: "api-fix", at: 1 }];
const ENTRIES: StatusEntry[] = [
  { path: "src/auth/session.ts", area: "staged", change: "modified", added: 12, removed: 3, binary: false },
  { path: "src/auth/session.ts", area: "unstaged", change: "modified", added: 1204, removed: 0, binary: false },
  { path: "public/logo.png", area: "unstaged", change: "modified", added: 0, removed: 0, binary: true },
  { path: "src/merge.ts", area: "conflict", change: "conflict" },
];
const AWAY: ElsewhereRow[] = elsewhereRows([
  { agentId: "b7", label: "docs-sync", folder: "/code/shop-api-docs", folderName: "shop-api-docs", state: "repo", topLevel: "/code/shop-api-docs", sameRepo: true, changed: 1 },
  { agentId: "c9", label: "notes-bot", folder: "/code/notes", folderName: "notes", state: "not-a-repo", topLevel: null, sameRepo: false, changed: null },
], () => null);

const render = (props: Partial<Parameters<typeof GitFiles>[0]> = {}) => renderToStaticMarkup(createElement(GitFiles, {
  entries: ENTRIES, mode: "uncommitted", edits: EDITS, focus: TEAM, selected: null,
  onSelect: () => {}, onOpen: () => {}, collisions: [], name: "api-fix", ...props,
}));

describe("counts on the working tree's rows", () => {
  it("shows +N −N in the counts column, thousands grouped, bin for a binary file", () => {
    const html = render();
    expect(html).toContain('<span class="gvf-add">+12<span class="vis-hidden"> added</span></span><span class="gvf-del">−3<span class="vis-hidden"> removed</span></span>');
    expect(html).toContain('<span class="gvf-add">+1,204<span class="vis-hidden"> added</span></span>');
    expect(html).toContain('<span class="gvf-bin" title="binary file">bin</span>');
  });

  it("says nothing for a change with no counts, and keeps its column so the tags line up", () => {
    const conflict = /data-file="conflict:src\/merge\.ts"[\s\S]*?(?=data-file=|$)/.exec(render())![0];
    expect(conflict).toContain('<span class="gvf-counts"></span>');
    expect(conflict).not.toMatch(/gvf-add|gvf-del|gvf-bin/);
  });

  it("draws no column at all when the status sent no counts", () => {
    const html = render({ entries: ENTRIES.map(({ added, removed, binary, ...e }) => e) });
    expect(html).not.toContain("gvf-counts");
  });
});

describe("a subagent that works in another folder", () => {
  it("is named right under the agent's own files, before the folder's other changes", () => {
    const html = render({ elsewhere: AWAY });
    const mine = html.indexOf(">Edited by api-fix<");
    const lastMine = html.indexOf('data-file="unstaged:src/auth/session.ts"');
    const away = html.indexOf('data-file="elsewhere:b7"');
    const other = html.indexOf(">Other changes in this folder<");
    expect(mine).toBeGreaterThan(-1);
    expect(away).toBeGreaterThan(lastMine);
    expect(other).toBeGreaterThan(away);
  });

  it("says who, where and how many files, with a way in", () => {
    const html = render({ elsewhere: AWAY });
    const line = /<div[^>]*data-file="elsewhere:b7"[^>]*>[\s\S]*?<\/div>/.exec(html)![0];
    expect(line).toMatch(/role="option"/);
    expect(line).toMatch(/class="gvf-elsewhere"/);
    expect(line.replace(/<!-- -->/g, "")).toContain('<span class="gvf-elsewhere-arrow" aria-hidden="true">↳</span><span class="gvf-elsewhere-lead">docs-sync<span class="gvf-elsewhere-verb"> works</span> in shop-api-docs</span>');
    expect(line).toMatch(/>1 file<\/span><span class="gvf-elsewhere-go" aria-hidden="true">›<\/span>/);
    expect(line).toMatch(/aria-label="docs-sync works in shop-api-docs, 1 file\. Enter shows its changes\."/);
    expect(line).not.toMatch(/aria-disabled/);
  });

  it("says why a folder with no repository has nothing to show, and does not open", () => {
    const line = /<div[^>]*data-file="elsewhere:c9"[^>]*>[\s\S]*?<\/div>/.exec(render({ elsewhere: AWAY }))![0];
    expect(line).toMatch(/aria-disabled="true"/);
    expect(line).toContain(">not a repo<");
    expect(line).toMatch(/aria-label="notes-bot works in notes, which is not a git repository\."/);
    expect(line).not.toContain("›");
  });

  it("is still named when the session's own folder is clean", () => {
    const html = render({ entries: [], elsewhere: AWAY });
    expect(html).toContain("Working tree clean.");
    expect(html).toMatch(/role="listbox"[^>]*>[\s\S]*data-file="elsewhere:b7"/);
  });

  it("is not drawn for a commit's files", () => {
    const html = render({ mode: "commit", entries: [{ path: "a.ts", change: "modified", added: 1, removed: 0, binary: false }], elsewhere: AWAY, sha: "65fecee" });
    expect(html).not.toContain("gvf-elsewhere");
  });
});

describe("reaching and activating the line", () => {
  const files = sourceOf("components/GitFiles.tsx");

  it("is walked with the arrows like a row, without changing which file is selected", () => {
    expect(files).toMatch(/if \(to\.away\) \{ rowEls\.current\.get\(to\.key\)\?\.focus\(\); return; \}/);
  });

  it("narrows the view on Enter, → or a click, and only when there is a repository to show", () => {
    expect(files).toMatch(/if \(item\.away\) \{ if \(item\.away\.opens\) onElsewhere\?\.\(item\.away\.agentId\); return; \}/);
    expect(files).toMatch(/onClick=\{\(\) => activate\(item\)\}/);
  });
});
