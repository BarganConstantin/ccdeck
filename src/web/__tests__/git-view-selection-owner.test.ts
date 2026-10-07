// What the open git view has selected belongs to one agent and one worktree.
//
// The view follows the deck's selection to another agent, and an agent moves
// to another worktree (a `cd`, a `git -C`). Either way the row, the file, the
// commit files read for it and the diff are the agent's and the worktree's
// before. They were carried over: a request's row and file opened the next
// agent on a commit of another repository, and the commit tab kept the old
// repository's commit after a move. A commit read that failed and was then
// dropped by a status answer was never asked for again, and the view read
// "Reading the commit's files…" for good. And the Fork look's opening, landing
// with a slow history, moved a selection the reader had already made.
//
// Run, not read: the hook runs in React itself, under a root with nothing to
// draw (as feedback-image-refusal-repeat.test.ts does), with fetch answered here.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EMPTY_GIT_DATA, startPick, useGitData, useGitSelection, type GitData } from "../use-git-view";
import { UNCOMMITTED, type GitFileRef, type GraphFocus, type LogCommit, type StatusEntry } from "../git-view-types";

type Selection = ReturnType<typeof useGitSelection>;
type Props = Parameters<typeof useGitSelection>[0];

interface Call { url: URL; answer: (status: number, body: unknown) => void }
const calls: Call[] = [];
/** Answers given at once, by route and sha; anything else waits in `calls`. */
let auto: (url: URL) => { status: number; body: unknown } | null = () => null;

const container = {
  nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
  ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {},
};

beforeAll(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { HTMLIFrameElement: class {} });
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("fetch", (input: string) => new Promise(resolve => {
    const url = new URL(input, "http://deck");
    const reply = (status: number, body: unknown) => resolve({ status, json: async () => body });
    const now = auto(url);
    if (now) reply(now.status, now.body);
    else calls.push({ url, answer: reply });
  }));
});
afterAll(() => vi.unstubAllGlobals());
afterEach(() => { calls.length = 0; auto = () => null; });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 5)); });

function mount(first: Props) {
  const renders: Selection[] = [];
  function Probe(props: Props) {
    renders.push(useGitSelection(props));
    return null;
  }
  let root: Root;
  return {
    renders,
    now: () => renders[renders.length - 1],
    async start() { root = createRoot(container as unknown as Element); await act(async () => root.render(createElement(Probe, first))); await flush(); },
    async update(props: Props) { await act(async () => root.render(createElement(Probe, props))); await flush(); },
    async run(fn: (s: Selection) => void) { await act(async () => fn(renders[renders.length - 1])); await flush(); },
    async stop() { await act(async () => root.unmount()); },
  };
}

const focus: GraphFocus = { sessionId: "s1", agentIds: null };
const entry = (path: string): StatusEntry => ({ path, area: "unstaged", change: "modified" } as StatusEntry);
const commit = (sha: string, date: string, mine = false): LogCommit =>
  ({ sha, date, subject: sha, parents: [], ...(mine ? { agent: { sessionId: "s1", agentId: null } } : {}) } as unknown as LogCommit);
const repoData = (over: Partial<GitData> = {}): GitData => ({
  ...EMPTY_GIT_DATA, state: "repo", entries: [entry("a.ts")], edits: [], commits: [commit("c1", "2026-10-05T10:00:00Z")], treeSeq: 1, at: 1, ...over,
});
const fileRef = (path: string): GitFileRef => ({ path, area: "commit" });
const commitReads = (session?: string) => calls.filter(c => c.url.pathname === "/api/git/commit" && !c.url.searchParams.get("path") && (!session || c.url.searchParams.get("session") === session));
const okFiles = (paths: string[]) => ({ ok: true, files: paths.map(path => ({ path, change: "modified" })), commit: commit("c1", "2026-10-05T10:00:00Z") });

describe("a request's row and file", () => {
  it("are taken by the agent they were named for, and never by the next agent the view follows", async () => {
    const v = mount({ data: repoData(), sessionId: "s1", agent: null, top: "/r/shop-api", focus, initial: { sel: "c1", file: fileRef("CHANGELOG.md") }, seq: 1, active: true });
    await v.start();
    expect([v.now().sel, v.now().file?.path]).toEqual(["c1", "CHANGELOG.md"]);
    commitReads("s1")[0].answer(200, okFiles(["money.test.ts", "CHANGELOG.md"]));
    await flush();
    expect(Array.isArray(v.now().commitFiles)).toBe(true);

    // The view follows another session (GitView hands it no hints: they were s1's).
    const from = v.renders.length;
    await v.update({ data: repoData({ commits: [], entries: [entry("README")] }), sessionId: "s2", agent: null, top: "/r/empty-repo", focus: { sessionId: "s2", agentIds: null }, initial: {}, seq: 1, active: true });
    // Not one render of the new agent draws the old one's commit, its files or its file.
    for (const r of v.renders.slice(from)) {
      expect(r.sel).toBe(UNCOMMITTED);
      expect(r.commitFiles).toBeNull();
      expect(r.file?.path ?? null).not.toBe("CHANGELOG.md");
    }
    expect(commitReads("s2")).toEqual([]);
    expect(v.now().file?.path).toBe("README");
    await v.stop();
  });

  it("are taken once per request: the agent moving to another worktree opens it fresh", () => {
    const first = startPick("1|s1||/a", 1, { sel: "c1" }, null);
    expect(first).toMatchObject({ sel: "c1", settled: true, hinted: 1 });
    expect(startPick("1|s1||/b", 1, { sel: "c1" }, first.hinted)).toMatchObject({ sel: UNCOMMITTED, file: null, settled: false });
    // A new request names them again.
    expect(startPick("2|s1||/b", 2, { sel: "c1" }, first.hinted)).toMatchObject({ sel: "c1", hinted: 2 });
  });
});

describe("a move to another worktree", () => {
  it("starts the selection over: the old repository's commit is neither shown nor served from what was read", async () => {
    auto = url => (url.searchParams.get("sha") === "a240d6f" && !url.searchParams.get("path") ? { status: 200, body: okFiles(["src/styles.css"]) } : null);
    const props: Props = { data: repoData({ commits: [commit("a240d6f", "2026-10-05T10:00:00Z")] }), sessionId: "s1", agent: null, top: "/r/web-app", focus, initial: {}, seq: 3, active: true };
    const v = mount(props);
    await v.start();
    await v.run(s => s.setSel("a240d6f"));
    expect(v.now().commitDetail?.files.map(f => f.path)).toEqual(["src/styles.css"]);

    const from = v.renders.length;
    await v.update({ ...props, data: EMPTY_GIT_DATA, top: "/r/infra" });
    for (const r of v.renders.slice(from)) {
      expect(r.sel).toBe(UNCOMMITTED);
      expect(r.commitDetail).toBeNull();
      expect(r.diff.file).toBeNull();
    }
    await v.stop();
  });
});

describe("a commit read that failed", () => {
  it("is asked for again when a status answer drops it, never left reading", async () => {
    const props: Props = { data: repoData(), sessionId: "s1", agent: null, top: "/r/shop-api", focus, initial: { sel: "c1" }, seq: 1, active: true };
    const v = mount(props);
    await v.start();
    commitReads()[0].answer(404, { error: "no such commit" });
    await flush();
    expect(v.now().commitFiles).toEqual({ error: "no such commit" });

    // The status answer that follows drops the failure: the commit is read again.
    await v.update({ ...props, data: repoData({ treeSeq: 2 }) });
    expect(commitReads()).toHaveLength(2);
    commitReads()[1].answer(200, okFiles(["CHANGELOG.md"]));
    await flush();
    expect(Array.isArray(v.now().commitFiles)).toBe(true);
    await v.stop();
  });

  it("is read again on Try again", async () => {
    auto = () => ({ status: 504, body: { error: "timeout" } });
    const v = mount({ data: repoData(), sessionId: "s1", agent: null, top: null, focus, initial: { sel: "c1" }, seq: 1, active: true });
    await v.start();
    expect(v.now().commitFiles).toEqual({ error: "timeout" });
    auto = () => ({ status: 200, body: okFiles(["x.ts"]) });
    await v.run(s => s.retryCommit());
    expect(Array.isArray(v.now().commitFiles)).toBe(true);
    await v.stop();
  });
});

describe("the Fork look's opening", () => {
  const slow = { data: repoData({ commits: null, edits: [] }), sessionId: "s1", agent: null, top: "/r/a", focus, initial: {}, seq: 5, active: true, forkOpen: true } satisfies Props;
  const landed = repoData({ commits: [commit("bb50a24", "2026-10-05T10:00:00Z", true)], edits: [] });

  it("moves an opening nobody touched to the focus's latest commit once the history lands", async () => {
    const v = mount(slow);
    await v.start();
    expect(v.now().view).toBe("local");
    await v.update({ ...slow, data: landed });
    expect(v.now().sel).toBe("bb50a24");
    await v.stop();
  });

  it("keeps the file the reader chose while the history was on its way", async () => {
    const v = mount(slow);
    await v.start();
    await v.run(s => s.pickFile({ path: "src/auth/session.ts", area: "unstaged" }));
    await v.update({ ...slow, data: landed });
    expect([v.now().view, v.now().file?.path]).toEqual(["local", "src/auth/session.ts"]);
    await v.stop();
  });
});

describe("the shared read", () => {
  it("never hands one worktree's answer to a reader asking for another", async () => {
    auto = url => ({ status: 200, body: { ok: true, state: "repo", repo: null, entries: [entry(url.pathname.endsWith("status") ? "web.ts" : "x")], commits: [], edits: [] } });
    const seen: Array<{ top: string | null; entries: string[] | null }> = [];
    function Reader({ top }: { top: string | null }) {
      const d = useGitData({ sessionId: "s9", agent: null, stale: 0, top, enabled: true });
      seen.push({ top, entries: d.entries?.map(e => e.path) ?? null });
      return null;
    }
    const root = createRoot(container as unknown as Element);
    await act(async () => root.render(createElement(Reader, { top: "/r/web-app" })));
    await flush();
    expect(seen[seen.length - 1].entries).toEqual(["web.ts"]);
    const from = seen.length;
    auto = () => null;
    await act(async () => root.render(createElement(Reader, { top: "/r/infra" })));
    expect(seen.slice(from).every(s => s.entries === null)).toBe(true);
    await act(async () => root.unmount());
  });
});
