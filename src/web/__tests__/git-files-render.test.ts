// The file list rendered: the counts an uncommitted row now carries, drawn as
// a commit's files draw theirs. Rendered server-side, where layout effects do
// not run, so the paths are uncut and nothing is measured.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GitFiles from "../components/GitFiles";
import type { GitEdit, StatusEntry } from "../git-files-model";

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
