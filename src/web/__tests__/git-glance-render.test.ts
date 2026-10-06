// The Git section of the detail panel, rendered: the letter and word each
// changed file carries (the files pane's own), the "Ended" note only for work
// that really ended, its name for a screen reader, the room it holds while
// its read arrives, and the read it shares with the view. Rendered on the
// server with the shared read stood in for, so nothing is fetched or measured.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitData } from "../use-git-view";
import type { AgentNodeData } from "../types";
import { sourceOf } from "./client-source";

const read = vi.hoisted(() => ({ data: null as GitData | null, calls: [] as unknown[] }));
vi.mock("../use-git-view", async () => {
  const actual = await vi.importActual<typeof import("../use-git-view")>("../use-git-view");
  return { ...actual, useGitData: (opts: unknown) => { read.calls.push(opts); return read.data ?? actual.EMPTY_GIT_DATA; } };
});
vi.mock("../git-pref", async () => ({ ...(await vi.importActual<object>("../git-pref")), useGitOn: () => true }));

import GitGlance from "../components/GitGlance";
import { EMPTY_GIT_DATA } from "../use-git-view";

let quiet: ReturnType<typeof vi.spyOn>;
beforeAll(() => { quiet = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterAll(() => { quiet.mockRestore(); });
beforeEach(() => { read.data = null; read.calls = []; });

const NOW = Date.parse("2026-10-06T12:00:00Z");
const root = (over: Partial<AgentNodeData> = {}): AgentNodeData => ({
  id: "s1", sessionId: "s1", label: "app", kind: "root", state: "done", startedAt: NOW - 3_600_000, tools: [],
  cwd: "/code/app", git: { state: "repo", stale: 1, branch: "main" },
  ...over,
} as AgentNodeData);
const REPO: GitData = {
  ...EMPTY_GIT_DATA, state: "repo", at: NOW,
  repo: { head: { branch: "main", detached: false, sha: "abc1234", short: "abc1234", unborn: false }, upstream: null, name: "app" } as GitData["repo"],
  commits: [],
  entries: [
    { path: "README.md", area: "untracked", change: "untracked", added: 3, removed: 0, binary: false },
    { path: "src/merge.ts", area: "conflict", change: "conflict" },
    { path: "logo.png", area: "unstaged", change: "modified", added: 0, removed: 0, binary: true },
  ],
  edits: [
    { path: "README.md", agentId: null, label: "app", at: NOW },
    { path: "src/merge.ts", agentId: null, label: "app", at: NOW },
  ],
};
const stateRef = { current: { agents: new Map() } } as never;
const render = (agent: AgentNodeData) => renderToStaticMarkup(createElement(GitGlance, { agent, root: agent.kind === "root" ? agent : null, now: NOW, stateRef }));

describe("a changed file's letter and word", () => {
  it("are the files pane's: untracked is U and untracked, a conflict is ! and conflict", () => {
    read.data = REPO;
    const html = render(root());
    expect(html).toContain('<span class="gv-st" title="untracked"><span aria-hidden="true">U</span><span class="vis-hidden">untracked</span></span>');
    expect(html).toContain('<span class="gv-st" title="conflict"><span aria-hidden="true">!</span><span class="vis-hidden">conflict</span></span>');
    expect(html).not.toContain('title="copied"');
  });
});

describe("the Ended note", () => {
  it("is not said of a session that only finished a turn", () => {
    read.data = REPO;
    expect(render(root({ endedAt: NOW - 600_000 }))).not.toContain("Ended");
  });

  it("is said of a session that really ended, from when it ended", () => {
    read.data = REPO;
    expect(render(root({ endedAt: NOW - 600_000, closedAt: NOW - 120_000 }))).toContain("Ended 2m ago.");
  });

  it("is said of a subagent that stopped", () => {
    read.data = REPO;
    const sub = root({ id: "s1::ab12", kind: "subagent", parentId: "s1", endedAt: NOW - 300_000, git: undefined });
    expect(render(sub)).toContain("Ended 5m ago.");
  });
});

describe("what a screen reader hears", () => {
  it("names the section and its heading Git, not after the Open button inside it", () => {
    read.data = REPO;
    const html = render(root());
    expect(html).toContain('aria-labelledby="gv-glance-s1"><h3 aria-labelledby="gv-glance-s1"><span id="gv-glance-s1">Git</span>');
  });

  it("reads a binary file's mark as binary file", () => {
    read.data = { ...REPO, edits: [{ path: "logo.png", agentId: null, label: "app", at: NOW }] };
    expect(render(root())).toContain('<span class="gv-g-bin" title="binary file"><span aria-hidden="true">bin</span><span class="vis-hidden">binary file</span></span>');
    expect(sourceOf("components/GitFiles.tsx")).toContain('<span className="gvf-bin" title="binary file"><span aria-hidden="true">bin</span><span className="vis-hidden">binary file</span></span>');
  });
});
