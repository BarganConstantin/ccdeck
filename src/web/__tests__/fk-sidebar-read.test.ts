// When the Fork-look sidebar reads its refs again: run, not read. The hook
// runs in React itself, under a root with nothing to draw (as in
// feedback-image-refusal-repeat.test.ts), with fetch answering as the route
// does. The history re-reads when the view follows the session to another
// worktree and when a view just opened would show an old read; the sidebar
// must do the same, or it lists another worktree's branches, or misses a ref
// made in a terminal that the history already draws.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import FkSidebar from "../components/FkSidebar";
import { REFS_FRESH_MS, useGitRefs } from "../use-git-refs";
import { sourceOf } from "./client-source";

type Props = Parameters<typeof useGitRefs>[0];
type Seen = ReturnType<typeof useGitRefs>;

let root: Root | null = null;
const renders: Seen[] = [];
const now = () => renders[renders.length - 1];
const asked: string[] = [];
let answer: (url: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
/** Held answers wait for this before they land; null answers at once. */
let hold: Promise<void> | null = null;
let clock = 1_000_000;

const container = () => ({
  nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
  ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {},
});

function Probe(props: Props) {
  renders.push(useGitRefs(props));
  return null;
}

async function show(props: Props) {
  if (!root) root = createRoot(container() as unknown as Element);
  await act(async () => { root!.render(createElement(Probe, props)); });
  await settle();
}

/** The answer's promise chain, then React's update. */
async function settle() {
  await act(async () => { await new Promise(r => setTimeout(r, 5)); });
}

async function hide() {
  if (!root) return;
  await act(async () => root!.unmount());
  root = null;
}

const branchesIn = (top: string, names: string[]) => ({
  status: 200,
  body: {
    ok: true, state: "repo", repo: { topLevel: top },
    branches: names.map(name => ({ name, sha: "a".repeat(40), current: false, upstream: null, ahead: 0, behind: 0, gone: false, worktree: null })),
    remotes: [], tags: [], stashes: [], worktrees: [], submodules: [], clipped: [], unread: [],
  },
});

beforeAll(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { HTMLIFrameElement: class {} });
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    const { status, body } = answer(url);
    if (hold) await hold;
    return { status, json: async () => body };
  });
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});

afterEach(async () => {
  hold = null;
  await hide();
  renders.length = 0;
  asked.length = 0;
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the sidebar follows the view to another worktree", () => {
  it("reads again when the view reads another worktree, with the stale counter unchanged", async () => {
    let top = "/code/web-app";
    answer = () => branchesIn(top, top.endsWith("locked") ? ["edge/locked-wt"] : ["main"]);
    await show({ sessionId: "S-move", agent: null, stale: 0, top });
    expect(asked).toHaveLength(1);
    expect(now().refs?.branches.map(b => b.name)).toEqual(["main"]);

    top = "/code/web-app-locked";
    await show({ sessionId: "S-move", agent: null, stale: 0, top });
    expect(asked).toHaveLength(2);
    expect(now().refs?.branches.map(b => b.name)).toEqual(["edge/locked-wt"]);
  });

  it("never draws the last worktree's refs for the new one while it reads", async () => {
    let top = "/code/infra";
    answer = () => branchesIn(top, top === "/code/infra" ? ["main"] : ["develop"]);
    await show({ sessionId: "S-wait", agent: null, stale: 0, top });
    expect(now().refs?.branches.map(b => b.name)).toEqual(["main"]);
    let release: () => void = () => {};
    hold = new Promise<void>(r => { release = r; });
    top = "/code/shop-api";
    await show({ sessionId: "S-wait", agent: null, stale: 0, top });
    expect(now().refs).toBeNull();
    release();
    await settle();
    expect(now().refs?.branches.map(b => b.name)).toEqual(["develop"]);
  });

  it("keeps its answer while the view's worktree is not known yet", async () => {
    answer = () => branchesIn("/code/notes-app", ["main"]);
    await show({ sessionId: "S-unknown", agent: null, stale: 0, top: "/code/notes-app" });
    await show({ sessionId: "S-unknown", agent: null, stale: 0, top: null });
    expect(asked).toHaveLength(1);
    expect(now().refs?.branches.map(b => b.name)).toEqual(["main"]);
  });
});

describe("the panel while the view follows the session to another worktree", () => {
  // The history's answer is empty while the new worktree's reads are on their
  // way, so the repository it names goes from the old worktree to nothing to
  // the new one. The panel keeps to the worktree the view reads, which is
  // known from the start of the move.
  const panel = (top: string | null) => renderToStaticMarkup(createElement(FkSidebar, {
    sessionId: "S-follow", agent: null, repo: null, top, stale: 0, view: "all", onView: () => {},
    localCount: 0, selectedSha: null, onJump: () => {}, focused: false,
  }));

  it("never lists the worktree before's branches while the history of the new one is read", async () => {
    let quiet: ReturnType<typeof vi.spyOn> | null = null;
    try {
      answer = () => branchesIn("/code/web-app", ["main", "web-only"]);
      await show({ sessionId: "S-follow", agent: null, stale: 0, top: "/code/web-app" });
      expect(now().refs?.branches.map(b => b.name)).toEqual(["main", "web-only"]);
      // React says on the server that layout effects do nothing there.
      quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(panel("/code/web-app")).toContain('data-key="branches:web-only"');
      expect(panel("/code/infra")).not.toContain("web-only");
    } finally {
      quiet?.mockRestore();
    }
  });

  it("is given the worktree the view reads, not the one its history last answered for", () => {
    const view = sourceOf("components/GitView.tsx");
    const tag = /<FkSidebar\b[\s\S]*?\/>/.exec(view)?.[0] ?? "";
    expect(tag).toMatch(/\btop=\{top\}/);
    expect(view).toContain("const top = facts?.topLevel ?? null;");
    const sidebar = sourceOf("components/FkSidebar.tsx");
    expect(sidebar).toMatch(/useGitRefs\(\{[^}]*\btop, fresh: true \}\)/);
    expect(sidebar).not.toMatch(/useGitRefs\(\{[^}]*repo\?\.topLevel/);
  });
});

describe("a sidebar shown again", () => {
  it("reads again over an answer older than the history's ten seconds, and not over a newer one", async () => {
    answer = () => branchesIn("/code/infra", asked.length > 1 ? ["main", "made-in-a-terminal"] : ["main"]);
    const props = { sessionId: "S-reopen", agent: null, stale: 3, top: "/code/infra", fresh: true };
    await show(props);
    await hide();
    clock += REFS_FRESH_MS - 1000;
    await show(props);
    expect(asked).toHaveLength(1);
    await hide();
    clock += 2000;
    await show(props);
    expect(asked).toHaveLength(2);
    expect(now().refs?.branches.map(b => b.name)).toEqual(["main", "made-in-a-terminal"]);
  });
});

describe("a first read that fails", () => {
  it("keeps why, and Try again reads again", async () => {
    answer = () => ({ status: 200, body: { ok: false, state: "repo", reason: "timeout" } });
    await show({ sessionId: "S-fail", agent: null, stale: 0, top: "/code/infra" });
    expect(now()).toMatchObject({ state: "repo", refs: null, reason: "timeout" });
    answer = () => branchesIn("/code/infra", ["main"]);
    await act(async () => { now().retry(); });
    await settle();
    expect(asked).toHaveLength(2);
    expect(now()).toMatchObject({ state: "repo", reason: null });
  });

  it("asks again when git timed out on the folder itself, rather than keeping that as an answer", async () => {
    answer = () => ({ status: 200, body: { ok: false, state: "timeout" } });
    await show({ sessionId: "S-slow", agent: null, stale: 1 });
    expect(now().state).toBe("timeout");
    await hide();
    await show({ sessionId: "S-slow", agent: null, stale: 1 });
    expect(asked).toHaveLength(2);
  });
});
