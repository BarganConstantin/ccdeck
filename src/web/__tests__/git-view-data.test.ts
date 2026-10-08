// The git view's data: what a read's answer does to what the page holds, whose
// work a commit or a file is, which file the view opens on, and the rules the
// hook keeps — never poll, read again only when the repository moved, and
// never change the diff under the reader.
import { describe, expect, it } from "vitest";
import {
  EMPTY_GIT_DATA, changedFiles, editByFocus, firstFile, focusCounts, foldAnswer, gitQuery, madeByFocus, newInHistory,
} from "../use-git-view";
import type { Edit, LogCommit, StatusEntry } from "../git-view-types";
import { sourceOf } from "./client-source";

const commit = (sha: string, agent: LogCommit["agent"] = null, extra: Partial<LogCommit> = {}): LogCommit => ({
  sha, parents: [], author: { name: "a", email: "a@x" }, date: "2026-10-05T16:15:00Z", subject: sha, trailers: [],
  refs: { local: [], remote: [], tags: [], head: false }, agent, ...extra,
});
const seen = (sessionId: string, agentId: string | null = null): LogCommit["agent"] =>
  ({ sessionId, agentId, label: null, confidence: "seen" });
const entry = (path: string, area: StatusEntry["area"] = "unstaged", extra: Partial<StatusEntry> = {}): StatusEntry =>
  ({ path, area, change: "M", ...extra });
const edit = (path: string, agentId: string | null = null): Edit => ({ path, agentId, label: null, at: 1 });

describe("a read names its session, never a folder", () => {
  it("asks by session, and by subagent only when narrowed", () => {
    expect(gitQuery("s1", null)).toBe("session=s1");
    expect(gitQuery("s1", "a4f1", { path: "src/a b.ts", area: "staged" })).toBe("session=s1&agent=a4f1&path=src%2Fa+b.ts&area=staged");
  });
});

describe("an answer folded into what the page holds", () => {
  it("takes the working tree, and counts that the tree moved", () => {
    const d = foldAnswer(EMPTY_GIT_DATA, "status", { ok: true, state: "repo", repo: null, entries: [entry("a.ts")], counts: { staged: 0, unstaged: 1, untracked: 0, conflict: 0 } }, 200);
    expect(d.state).toBe("repo");
    expect(d.entries).toHaveLength(1);
    expect(d.treeSeq).toBe(1);
  });

  it("says why there is no repository in one word, for the whole read", () => {
    for (const state of ["not-a-repo", "gone", "no-git", "bare", "unsafe", "timeout", "error"] as const) {
      expect(foldAnswer(EMPTY_GIT_DATA, "log", { ok: true, state, repo: null }, 200).state, state).toBe(state);
    }
  });

  it("knows the switch is off, and keeps a failed read's reason", () => {
    expect(foldAnswer(EMPTY_GIT_DATA, "status", { error: "git is switched off in Settings" }, 409).state).toBe("off");
    const failed = foldAnswer(EMPTY_GIT_DATA, "status", { ok: false, state: "repo", repo: null, reason: "timeout" }, 200);
    expect(failed).toMatchObject({ state: "repo", reason: "timeout" });
    expect(foldAnswer(EMPTY_GIT_DATA, "edits", { error: "unknown session" }, 404)).toMatchObject({ state: "error", reason: "unknown session" });
  });

  it("keeps why the history could not be read, whatever the other answers say, until a history read lands", () => {
    const failed = foldAnswer(EMPTY_GIT_DATA, "log", { ok: false, state: "repo", repo: null, reason: "error" }, 200);
    expect(failed).toMatchObject({ state: "repo", commits: null, logReason: "error" });
    // The working tree answering after it does not take that back.
    const tree = foldAnswer(failed, "status", { ok: true, state: "repo", repo: null, entries: [entry("d.txt")] }, 200);
    expect(tree).toMatchObject({ commits: null, logReason: "error", reason: null });
    expect(foldAnswer(EMPTY_GIT_DATA, "log", { error: "the deck did not answer" }, 0).logReason).toBe("the deck did not answer");
    // A history that reads clears it.
    expect(foldAnswer(tree, "log", { ok: true, state: "repo", commits: [commit("a")] }, 200).logReason).toBeNull();
    expect(EMPTY_GIT_DATA.logReason).toBeNull();
  });

  it("takes the session's subagents that work in another folder from the repository's answer", () => {
    const away = { agentId: "b7", label: "docs-sync", folder: "/c/docs", folderName: "docs", state: "repo" as const, topLevel: "/c/docs", sameRepo: true, changed: 1 };
    const d = foldAnswer(EMPTY_GIT_DATA, "repo", { ok: true, state: "repo", repo: null, subagents: [away] }, 200);
    expect(d.subagents).toEqual([away]);
    expect(EMPTY_GIT_DATA.subagents).toBeNull();
    // An answer without the list (an older deck) says there are none.
    expect(foldAnswer(EMPTY_GIT_DATA, "repo", { ok: true, state: "repo", repo: null }, 200).subagents).toEqual([]);
  });

  it("names the commits that arrived at the top since the last read", () => {
    const first = foldAnswer(EMPTY_GIT_DATA, "log", { ok: true, state: "repo", commits: [commit("b"), commit("a")] }, 200);
    expect(first.newShas).toEqual([]);
    const next = foldAnswer(first, "log", { ok: true, state: "repo", commits: [commit("d"), commit("c"), commit("b"), commit("a")] }, 200);
    expect(next.newShas).toEqual(["d", "c"]);
    expect(newInHistory([commit("a")], [commit("x", null, { outsideWindow: true }), commit("a")])).toEqual([]);
  });

  it("names a commit that landed under the top rows too, and not what fills the window's foot", () => {
    // A fetch brought commits dated before the branches at the top: they land
    // in the middle, under rows the reader already had.
    const before = [commit("t2"), commit("t1"), commit("m"), commit("b"), commit("a")];
    expect(newInHistory(before, [commit("t2"), commit("t1"), commit("f1"), commit("f2"), commit("m"), commit("b")])).toEqual(["f1", "f2"]);
    // A branch deleted: older commits move up into the window's foot.
    expect(newInHistory(before, [commit("t2"), commit("m"), commit("b"), commit("a"), commit("z")])).toEqual([]);
    // Nothing in common (another repository): nothing is new.
    expect(newInHistory(before, [commit("q"), commit("r")])).toEqual([]);
  });
});

describe("whose work it is", () => {
  const team = { sessionId: "s1", agentIds: null };
  const sub = { sessionId: "s1", agentIds: ["a4f1"] };

  it("counts a commit the session's team made, or only the subagent's when narrowed", () => {
    expect(madeByFocus(commit("x", seen("s1")), team)).toBe(true);
    expect(madeByFocus(commit("x", seen("s1", "a4f1")), team)).toBe(true);
    expect(madeByFocus(commit("x", seen("s1")), sub)).toBe(false);
    expect(madeByFocus(commit("x", seen("s1", "a4f1")), sub)).toBe(true);
    expect(madeByFocus(commit("x", seen("s2")), team)).toBe(false);
    // A trailer names no session: never the focus's own.
    expect(madeByFocus(commit("x", { agent: "claude", confidence: "trailer" }), team)).toBe(false);
  });

  it("marks an edit the focus made", () => {
    expect(editByFocus(edit("a.ts"), team)).toBe(true);
    expect(editByFocus(edit("a.ts"), sub)).toBe(false);
    expect(editByFocus(edit("a.ts", "a4f1"), sub)).toBe(true);
  });

  it("lists each changed path once, the focus's first, a rename counted by its old name", () => {
    const entries = [entry("README.md"), entry("src/s.ts", "staged"), entry("src/s.ts"), entry("src/jwt.ts", "staged", { from: "src/token.ts" })];
    const files = changedFiles(entries, [edit("src/s.ts"), edit("src/token.ts")], team);
    expect(files.map(f => [f.path, f.mine])).toEqual([["src/s.ts", true], ["src/jwt.ts", true], ["README.md", false]]);
  });

  it("opens on the first file the focus edited, else the first change", () => {
    const entries = [entry("README.md"), entry("src/s.ts", "staged")];
    expect(firstFile(entries, [edit("src/s.ts")], team)).toEqual({ path: "src/s.ts", area: "staged" });
    expect(firstFile(entries, [], team)).toEqual({ path: "README.md", area: "unstaged" });
    expect(firstFile([], [], team)).toBeNull();
  });

  it("counts the scope chip's commits and files", () => {
    const data = { ...EMPTY_GIT_DATA, entries: [entry("a.ts"), entry("b.ts")], edits: [edit("a.ts")], commits: [commit("x", seen("s1")), commit("y")] };
    expect(focusCounts(data, team)).toEqual({ commits: 1, files: 1, changed: 2 });
  });
});

describe("the reads' rhythm", () => {
  it("reads the whole team's edits, so the files can name another agent's", () => {
    expect(sourceOf("use-git-view.ts")).toMatch(/gitQuery\(sessionId, kind === "edits" \? editsAgent : agent\)/);
  });

  it("asks where the subagents work only for a whole session: a narrowed read lists none", () => {
    expect(sourceOf("use-git-view.ts")).toMatch(/const kinds = agent \? READS : \[\.\.\.READS, "repo"\] as const;/);
  });

  const src = sourceOf("use-git-view.ts");

  it("never polls: no timer drives a read", () => {
    expect(src).not.toMatch(/setInterval|setTimeout/);
  });

  it("reads again when the repository's stale counter moves past what was read", () => {
    expect(src).toMatch(/if \(e\.seen < stale \|\| e\.data\.at === 0 \|\| \(fresh && old\) \|\| \(e\.top !== undefined && e\.top !== top\)\) read\(key, sessionId, agent, stale, ownFolder \? agent : null, top\);/);
  });

  it("reads again, from nothing, when the agent has moved to another worktree", () => {
    // The server follows an agent into the worktree it works in, and that
    // worktree's stale counter is its own: the counter alone would not say so.
    expect(src).toMatch(/\}, \[key, stale, top, fresh\]\);/);
    expect(src).toMatch(/const moved = e\.top !== undefined && e\.top !== top;/);
    expect(src).toMatch(/e\.data = moved \? \{ \.\.\.EMPTY_GIT_DATA, at: Date\.now\(\) \} : \{ \.\.\.e\.data, at: Date\.now\(\) \};/);
  });

  it("never reads the old folder's file in the new one when the view narrows or widens", () => {
    expect(src).toMatch(/const sameRead = of === was\.of;/);
    expect(src).toMatch(/if \(!sameRead \|\| !active \|\| !file \|\| sel !== UNCOMMITTED \|\| diff\.loading\) return;/);
  });

  it("reads the diff a frame after it is asked for, and keeps a newer one aside", () => {
    expect(src).toMatch(/const raf = requestAnimationFrame\(\(\) => \{\s*fetch\(urlFor\(file\)\)/);
    expect(src).toMatch(/latest\.current = a\.diff;\s*setDiff\(d => \(d\.file === file \? \{ \.\.\.d, stale: true, gone: false \} : d\)\);/);
  });
});
