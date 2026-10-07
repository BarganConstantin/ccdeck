// A selected commit's own read, as the Fork look's Commit and Changes tabs get
// it: run, not read. The hook runs in React itself under a root with nothing
// to draw (as in feedback-image-refusal-repeat.test.ts), with fetch answering
// as GET /api/git/commit does.
//
// A commit whose file list passes the deck's cap still has a message, an
// author and a SHA: the Commit tab shows them and says the files are too many,
// and the Changes tab says why it lists none. A read that failed is asked
// again when the working tree moves, never left reading forever.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EMPTY_GIT_DATA, useGitSelection, type GitData } from "../use-git-view";
import type { LogCommit } from "../git-view-types";

type Seen = ReturnType<typeof useGitSelection>;

const SHA = "47abb5fb651f105f4e91cf6438f3b4a17fc839e3";
const COMMIT = {
  sha: SHA, parents: ["a240d6ff78f45a05f130668fe733314b3131c0e9"], author: { name: "Edge Tester", email: "edge@example.com" },
  date: "2026-10-06T12:00:00Z", subject: "chore(vendor): import sixty thousand files", trailers: [],
  refs: { local: [], remote: [], tags: [], head: false }, agent: null,
  committer: { name: "Edge Tester", email: "edge@example.com", date: "2026-10-06T12:00:00Z" }, body: "",
} as LogCommit;

let root: Root | null = null;
const renders: Seen[] = [];
const now = () => renders[renders.length - 1];
const asked: string[] = [];
/** The commit's own reads, not a file's diff within it. */
const commitReads = () => asked.filter(u => u.startsWith("/api/git/commit?") && !u.includes("path="));
let answer: (url: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

const DATA: GitData = { ...EMPTY_GIT_DATA, state: "repo", entries: [], edits: [], commits: [COMMIT], at: 1, treeSeq: 1 };

function Probe({ data }: { data: GitData }) {
  renders.push(useGitSelection({
    data, sessionId: "S-commit", agent: null, focus: { sessionId: "S-commit", agentIds: null },
    initial: { sel: SHA }, seq: 1, active: true,
  }));
  return null;
}

async function show(data: GitData) {
  if (!root) {
    root = createRoot({
      nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {},
    } as unknown as Element);
  }
  await act(async () => { root!.render(createElement(Probe, { data })); });
  await act(async () => { await new Promise(r => setTimeout(r, 5)); });
}

beforeAll(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { HTMLIFrameElement: class {} });
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => setTimeout(f, 0));
  vi.stubGlobal("cancelAnimationFrame", (t: ReturnType<typeof setTimeout>) => clearTimeout(t));
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    const { status, body } = answer(url);
    return { status, json: async () => body };
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  renders.length = 0;
  asked.length = 0;
});

afterAll(() => vi.unstubAllGlobals());

describe("a commit whose file list passes the cap", () => {
  it("is shown whole, saying its files are too many, and the Changes tab says why it lists none", async () => {
    answer = () => ({ status: 200, body: { ok: true, state: "repo", commit: COMMIT, files: [], filesTooLarge: true } });
    await show(DATA);
    expect(now().commitDetail).toMatchObject({ commit: { sha: SHA, subject: COMMIT.subject }, files: [], filesTooLarge: true });
    expect(now().commitFiles).toEqual({ error: "too-large" });
  });

  it("is not read again each time the working tree moves", async () => {
    answer = () => ({ status: 200, body: { ok: true, state: "repo", commit: COMMIT, files: [], filesTooLarge: true } });
    await show(DATA);
    await show({ ...DATA, treeSeq: 2 });
    await show({ ...DATA, treeSeq: 3 });
    expect(commitReads()).toHaveLength(1);
  });
});

describe("a commit read that failed", () => {
  it("is asked again when the working tree moves, rather than reading forever", async () => {
    answer = () => ({ status: 200, body: { ok: false, state: "repo", reason: "timeout" } });
    await show(DATA);
    expect(now().commitFiles).toEqual({ error: "timeout" });
    answer = () => ({ status: 200, body: { ok: true, state: "repo", commit: COMMIT, files: [{ path: "a.txt", change: "added", added: 1, removed: 0, binary: false }] } });
    await show({ ...DATA, treeSeq: 2 });
    expect(commitReads()).toHaveLength(2);
    expect(now().commitDetail?.files.map(f => f.path)).toEqual(["a.txt"]);
  });
});
