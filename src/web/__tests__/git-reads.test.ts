// The four reads the git view is drawn from — history, status, a file's diff,
// a commit — against real repositories, in the shapes that trip a parser: a
// file staged and then changed again, a rename, a binary, an untracked folder,
// a conflict, a merge, a root commit, a detached HEAD, a diff past the cap.
// And the property all four share: none of them writes to the repository.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { commitAll, emptyRepo, repoWith, sh, tempDir, watchNames, write } from "./git-fixture";

const HOME = tempDir("ccdeck-git-reads-home-");
const KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const;
const prev = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.XDG_CONFIG_HOME = join(HOME, ".config");

// @ts-expect-error — plain .mjs server module, no types
const reads = await import("../../server/git-reads.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { resolveRepo } = await import("../../server/git-repo.mjs");
const { readLog, readStatus, readFileDiff, readCommit, readCommitFileDiff, parseTrailers, countEntries, parseNumstat, graphOrder, hasCommitGraph, DIFF_CAP, LOG_LIMIT, UNTRACKED_COUNT_MAX_FILES } = reads;

const made: string[] = [HOME];
const track = (dir: string) => { made.push(dir); return dir; };
afterAll(() => {
  for (const k of KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  for (const dir of made) rmTempDir(dir);
});

const headOf = async (dir: string) => (await resolveRepo(dir)).head;
const entry = (entries: any[], path: string, area: string) => entries.find(e => e.path === path && e.area === area);

describe("readLog", () => {
  it("lists commits child-first with parents, author, date, subject and refs split by kind", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const first = sh(dir, ["rev-parse", "HEAD"]).trim();
    write(dir, { "a.txt": "two\n" });
    const second = commitAll(dir, "second", "2026-02-03T04:05:06Z");
    sh(dir, ["tag", "v1", first]);
    sh(dir, ["tag", "-a", "-m", "annotated", "v2", second]);
    sh(dir, ["update-ref", "refs/remotes/origin/main", first]);
    sh(dir, ["branch", "side", first]);
    // A stash is a ref, and not history anybody committed to.
    write(dir, { "a.txt": "stashed\n" });
    sh(dir, ["stash", "-q"]);

    const r = await readLog(dir, await headOf(dir));
    expect(r.ok).toBe(true);
    expect(r.commits.map((c: any) => c.sha)).toEqual([second, first]);
    expect(r.commits[0]).toMatchObject({
      parents: [first],
      author: { name: "Ada Lovelace", email: "ada@example.com" },
      subject: "second",
      refs: { local: ["main"], remote: [], tags: ["v2"], head: true },
    });
    expect(new Date(r.commits[0].date).toISOString()).toBe("2026-02-03T04:05:06.000Z");
    expect(r.commits[1]).toMatchObject({ parents: [], refs: { local: ["side"], remote: ["origin/main"], tags: ["v1"], head: false } });
  });

  it("keeps the co-author and session trailers, in either spelling, and nothing else", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    write(dir, { "a.txt": "two\n" });
    sh(dir, ["add", "-A"]);
    sh(dir, ["commit", "-q", "-m", "fix: a thing\n\nWhy it was broken.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nco-authored-by: Codex <codex@openai.com>\nClaude-Session: 1234-abcd\nSigned-off-by: Ada <ada@example.com>"]);
    const r = await readLog(dir, await headOf(dir));
    expect(r.commits[0].trailers).toEqual([
      { key: "Co-Authored-By", value: "Claude <noreply@anthropic.com>" },
      { key: "co-authored-by", value: "Codex <codex@openai.com>" },
      { key: "Claude-Session", value: "1234-abcd" },
    ]);
    // Only the last paragraph is a trailer block.
    expect(parseTrailers("Co-authored-by: not a trailer\n\nplain text")).toEqual([]);
    expect(parseTrailers("x\n\nCo-authored-by: Claude\n  continued")).toEqual([{ key: "Co-authored-by", value: "Claude continued" }]);
  });

  it("stops at the limit, and marks a detached HEAD on its commit", async () => {
    const dir = track(repoWith({ "a.txt": "0\n" }));
    let stream = "";
    for (let i = 1; i <= LOG_LIMIT + 20; i++) {
      stream += `commit refs/heads/main\ncommitter Ada <ada@example.com> ${1700000000 + i} +0000\ndata ${`c${i}`.length}\nc${i}\n`
        + (i === 1 ? "from refs/heads/main^0\n" : "") + `M 100644 inline a.txt\ndata ${`${i}\n`.length}\n${i}\n\n`;
    }
    sh(dir, ["fast-import", "--quiet"], stream);
    sh(dir, ["checkout", "-q", "-f", "--detach", "main~5"]);
    const head = await headOf(dir);
    const r = await readLog(dir, head);
    expect(r.commits).toHaveLength(LOG_LIMIT);
    expect(r.commits.filter((c: any) => c.refs.head).map((c: any) => c.sha)).toEqual([head.sha]);
  });

  /** Branches merged back, a branch left open, and dates that interleave the
   *  lines — what tells a topological order from a date order. */
  const branchy = () => {
    const dir = track(repoWith({ "a.txt": "0\n" }));
    const at = (h: number) => `2026-03-01T${String(h).padStart(2, "0")}:00:00Z`;
    let h = 1;
    const commit = (file: string, msg: string) => { write(dir, { [file]: `${msg}\n` }); return commitAll(dir, msg, at(h++)); };
    commit("a.txt", "main one");
    sh(dir, ["checkout", "-q", "-b", "side"]);
    commit("s.txt", "side one");
    sh(dir, ["checkout", "-q", "main"]);
    commit("a.txt", "main two");
    sh(dir, ["checkout", "-q", "side"]);
    commit("s.txt", "side two");
    sh(dir, ["checkout", "-q", "-b", "open", "main"]);
    commit("o.txt", "open one");
    sh(dir, ["checkout", "-q", "main"]);
    sh(dir, ["merge", "-q", "--no-ff", "-m", "merge side", "side"], undefined, at(h++));
    commit("a.txt", "main three");
    sh(dir, ["checkout", "-q", "open"]);
    commit("o.txt", "open two");
    sh(dir, ["checkout", "-q", "main"]);
    return dir;
  };
  const topoOrder = (dir: string) => sh(dir, ["-c", "core.commitGraph=false", "log", "--topo-order", "--format=%H", "--branches", "--remotes", "--tags", "HEAD", "--"]).trim().split("\n");

  it("reads a history git cannot sort in time the streaming way, sorted the way git sorts it", async () => {
    const dir = branchy();
    const head = await headOf(dir);
    // As --topo-order reads it, within its budget.
    expect((await readLog(dir, head)).commits.map((c: any) => c.sha)).toEqual(topoOrder(dir));
    // Over budget: the default order, put in the same graph order.
    const slow = await readLog(dir, head, { topoBudgetMs: 1 });
    expect(slow.ok).toBe(true);
    expect(slow.commits.map((c: any) => c.sha)).toEqual(topoOrder(dir));
    expect(slow.commits.find((c: any) => c.subject === "main three").refs).toMatchObject({ local: ["main"], head: true });
    // Remembered: the next read does not try --topo-order again. A window
    // shorter than the history shows which way it was read — the newest six
    // by date, against git's topological walk going down one line first.
    const subjects = async (dir: string, opts = {}) => (await readLog(dir, head, { limit: 6, ...opts })).commits.map((c: any) => c.subject);
    expect(await subjects(dir)).toEqual(["open two", "open one", "main three", "merge side", "side two", "main two"]);
    const fresh = branchy();
    const freshHead = await headOf(fresh);
    expect((await readLog(fresh, freshHead, { limit: 6 })).commits.map((c: any) => c.subject))
      .toEqual(["open two", "open one", "main three", "merge side", "side two", "side one"]);
  });

  it("puts a window in graph order: children first, one line followed to its end, parents outside ignored", () => {
    const c = (sha: string, ...parents: string[]) => ({ sha, parents });
    // Newest first, as git's default walk gives them: two tips, a merge whose
    // second parent's line is shown before its first parent's, and a parent
    // (z) outside the window.
    const walk = [c("m", "a", "s2"), c("t", "a"), c("s2", "s1"), c("a", "b"), c("s1", "b"), c("b", "z")];
    expect(graphOrder(walk).map((x: any) => x.sha)).toEqual(["m", "s2", "s1", "t", "a", "b"]);
    expect(graphOrder([])).toEqual([]);
  });

  it("knows a repository with a commit-graph from one without", async () => {
    const dir = branchy();
    const commonDir = join(dir, ".git");
    expect(await hasCommitGraph(commonDir)).toBe(false);
    expect(await hasCommitGraph(null)).toBe(false);
    sh(dir, ["commit-graph", "write", "--reachable"]);
    expect(await hasCommitGraph(commonDir)).toBe(true);
    expect((await readLog(dir, await headOf(dir), { commonDir, topoBudgetMs: 1 })).commits.map((c: any) => c.sha)).toEqual(topoOrder(dir));
  });

  it("answers an empty history for a repository with no commits", async () => {
    const dir = track(emptyRepo());
    expect(await readLog(dir, await headOf(dir))).toEqual({ ok: true, commits: [] });
  });
});

describe("readStatus", () => {
  it("keeps a file staged and then changed again as two entries", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    write(dir, { "a.txt": "two\n" });
    sh(dir, ["add", "a.txt"]);
    write(dir, { "a.txt": "three\n" });
    const r = await readStatus(dir);
    expect(r.entries.filter((e: any) => e.path === "a.txt")).toEqual([
      { path: "a.txt", area: "staged", change: "modified" },
      { path: "a.txt", area: "unstaged", change: "modified" },
    ]);
    expect(r.counts).toEqual({ staged: 1, unstaged: 1, untracked: 0, conflict: 0 });
  });

  it("reports renames with the path they came from, and every change type", async () => {
    const dir = track(repoWith({ "old.txt": "same\n", "gone.txt": "x\n", "keep.txt": "k\n" }));
    sh(dir, ["mv", "old.txt", "new name.txt"]);
    write(dir, { "added.txt": "a\n", "untracked.txt": "u\n", "folder/inner.txt": "i\n" });
    sh(dir, ["add", "added.txt"]);
    sh(dir, ["rm", "-q", "gone.txt"]);
    write(dir, { "keep.txt": "changed\n" });
    const r = await readStatus(dir);
    expect(entry(r.entries, "new name.txt", "staged")).toEqual({ path: "new name.txt", area: "staged", change: "renamed", from: "old.txt" });
    expect(entry(r.entries, "added.txt", "staged")).toMatchObject({ change: "added" });
    expect(entry(r.entries, "gone.txt", "staged")).toMatchObject({ change: "deleted" });
    expect(entry(r.entries, "keep.txt", "unstaged")).toMatchObject({ change: "modified" });
    expect(entry(r.entries, "untracked.txt", "untracked")).toMatchObject({ change: "untracked" });
    expect(entry(r.entries, "folder", "untracked")).toMatchObject({ directory: true });
  });

  it("reports a merge conflict as one conflict entry", async () => {
    const dir = track(repoWith({ "a.txt": "base\n" }));
    sh(dir, ["checkout", "-q", "-b", "other"]);
    write(dir, { "a.txt": "theirs\n" });
    commitAll(dir, "theirs");
    sh(dir, ["checkout", "-q", "main"]);
    write(dir, { "a.txt": "ours\n" });
    commitAll(dir, "ours");
    try { sh(dir, ["merge", "-q", "other"]); } catch { /* the conflict is the point */ }
    const r = await readStatus(dir);
    expect(r.entries.filter((e: any) => e.path === "a.txt")).toEqual([{ path: "a.txt", area: "conflict", change: "conflict" }]);
  });
});

describe("countEntries", () => {
  const counted = async (dir: string) => countEntries(dir, (await readStatus(dir)).entries);

  it("counts the staged and the unstaged half of one file apart, as their diffs show them", async () => {
    const dir = track(repoWith({ "a.txt": "one\ntwo\nthree\n" }));
    write(dir, { "a.txt": "one\n2\nthree\nfour\n" });
    sh(dir, ["add", "a.txt"]);
    write(dir, { "a.txt": "one\nthree\nfour\n" });
    const entries = await counted(dir);
    expect(entry(entries, "a.txt", "staged")).toEqual({ path: "a.txt", area: "staged", change: "modified", added: 2, removed: 1, binary: false });
    expect(entry(entries, "a.txt", "unstaged")).toEqual({ path: "a.txt", area: "unstaged", change: "modified", added: 0, removed: 1, binary: false });
    // The same numbers the diff route answers for each half.
    for (const area of ["staged", "unstaged"]) {
      const d = await readFileDiff(dir, entry(entries, "a.txt", area));
      expect({ added: d.added, removed: d.removed }, area).toEqual({ added: entry(entries, "a.txt", area).added, removed: entry(entries, "a.txt", area).removed });
    }
  });

  it("matches a staged rename by both its ends, edits included", async () => {
    const dir = track(repoWith({ "old name.txt": "same\nlines\nhere\nand\nmore\n", "other.txt": "x\n" }));
    sh(dir, ["mv", "old name.txt", "new name.txt"]);
    write(dir, { "new name.txt": "same\nlines\nhere\nand\nmore\nplus\n", "other.txt": "y\n" });
    sh(dir, ["add", "new name.txt"]);
    const entries = await counted(dir);
    expect(entry(entries, "new name.txt", "staged")).toEqual({ path: "new name.txt", area: "staged", change: "renamed", from: "old name.txt", added: 1, removed: 0, binary: false });
    expect(entry(entries, "other.txt", "unstaged")).toMatchObject({ added: 1, removed: 1, binary: false });
  });

  it("marks a binary file binary, tracked or not, and counts a deletion", async () => {
    const dir = track(repoWith({ "b.bin": Buffer.from([0, 1, 2, 3]), "gone.txt": "a\nb\n" }));
    write(dir, { "b.bin": Buffer.from([0, 9, 9, 9]), "new.bin": Buffer.from([7, 0, 7]) });
    sh(dir, ["rm", "-q", "--cached", "gone.txt"]);
    const entries = await counted(dir);
    expect(entry(entries, "b.bin", "unstaged")).toMatchObject({ added: 0, removed: 0, binary: true });
    expect(entry(entries, "new.bin", "untracked")).toMatchObject({ added: 0, removed: 0, binary: true });
    expect(entry(entries, "gone.txt", "staged")).toMatchObject({ change: "deleted", added: 0, removed: 2, binary: false });
  });

  it("counts an untracked text file by lines, a final line without a newline included, and CRLF as one line each", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    write(dir, { "n.txt": "x\ny", "crlf.txt": "one\r\ntwo\r\nthree\r\n", "empty.txt": "" });
    const entries = await counted(dir);
    expect(entry(entries, "n.txt", "untracked")).toMatchObject({ added: 2, removed: 0, binary: false });
    expect(entry(entries, "crlf.txt", "untracked")).toMatchObject({ added: 3, removed: 0, binary: false });
    expect(entry(entries, "empty.txt", "untracked")).toMatchObject({ added: 0, removed: 0, binary: false });
    // The diff the files pane opens says the same.
    expect((await readFileDiff(dir, entry(entries, "crlf.txt", "untracked"))).added).toBe(3);
  });

  it("counts a CRLF file's changed lines as git does, whatever core.autocrlf says", async () => {
    const dir = track(repoWith({ "w.txt": "a\r\nb\r\nc\r\n" }));
    sh(dir, ["config", "core.autocrlf", "true"]);
    write(dir, { "w.txt": "a\r\nB\r\nc\r\nd\r\n" });
    const entries = await counted(dir);
    expect(entry(entries, "w.txt", "unstaged")).toMatchObject({ added: 2, removed: 1, binary: false });
    expect(await readFileDiff(dir, entry(entries, "w.txt", "unstaged"))).toMatchObject({ added: 2, removed: 1 });
  });

  it("leaves the counts out for an untracked file past the diff cap, a folder, and a conflict", async () => {
    const dir = track(repoWith({ "a.txt": "base\n" }));
    sh(dir, ["checkout", "-q", "-b", "other"]);
    write(dir, { "a.txt": "theirs\n" });
    commitAll(dir, "theirs");
    sh(dir, ["checkout", "-q", "main"]);
    write(dir, { "a.txt": "ours\n" });
    commitAll(dir, "ours");
    try { sh(dir, ["merge", "-q", "other"]); } catch { /* the conflict is the point */ }
    const line = "y".repeat(99) + "\n";
    write(dir, { "huge.txt": line.repeat(Math.ceil((DIFF_CAP + 1) / line.length)), "folder/inner.txt": "i\n" });
    const entries = await counted(dir);
    for (const [path, area] of [["huge.txt", "untracked"], ["folder", "untracked"], ["a.txt", "conflict"]]) {
      const e = entry(entries, path, area);
      expect(e, path).toBeTruthy();
      expect("added" in e || "removed" in e || "binary" in e, path).toBe(false);
    }
  });

  it("reads no more than its budget of untracked files, and never changes the entries it was given", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const files: Record<string, string> = {};
    for (let i = 0; i < UNTRACKED_COUNT_MAX_FILES + 5; i++) files[`u${String(i).padStart(4, "0")}.txt`] = "x\n";
    write(dir, files);
    const status = await readStatus(dir);
    const before = JSON.stringify(status.entries);
    const entries = await countEntries(dir, status.entries);
    expect(entries.filter((e: any) => e.area === "untracked" && typeof e.added === "number")).toHaveLength(UNTRACKED_COUNT_MAX_FILES);
    expect(JSON.stringify(status.entries)).toBe(before);
  });

  it("parses numstat records, renames and binaries included", () => {
    expect(parseNumstat("3\t1\ta b.txt\0-\t-\timg.png\x001\t0\t\0old.txt\0new.txt\0")).toEqual([
      { path: "a b.txt", added: 3, removed: 1, binary: false },
      { path: "img.png", added: 0, removed: 0, binary: true },
      { path: "new.txt", from: "old.txt", added: 1, removed: 0, binary: false },
    ]);
    expect(parseNumstat("")).toEqual([]);
  });
});

describe("readFileDiff", () => {
  it("diffs the staged and the unstaged half of one file separately", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    write(dir, { "a.txt": "two\n" });
    sh(dir, ["add", "a.txt"]);
    write(dir, { "a.txt": "three\n" });
    const { entries } = await readStatus(dir);
    const staged = await readFileDiff(dir, entry(entries, "a.txt", "staged"));
    const unstaged = await readFileDiff(dir, entry(entries, "a.txt", "unstaged"));
    expect(staged).toMatchObject({ ok: true, binary: false, added: 1, removed: 1 });
    expect(staged.patch).toContain("-one\n+two\n");
    expect(unstaged.patch).toContain("-two\n+three\n");
  });

  it("shows a staged rename as a rename, not as an add and a delete", async () => {
    const dir = track(repoWith({ "old.txt": "same\nlines\nhere\n" }));
    sh(dir, ["mv", "old.txt", "new.txt"]);
    const { entries } = await readStatus(dir);
    const d = await readFileDiff(dir, entry(entries, "new.txt", "staged"));
    expect(d.patch).toContain("rename from old.txt\nrename to new.txt");
  });

  it("reports a binary change as binary, with no content", async () => {
    const dir = track(repoWith({ "b.bin": Buffer.from([0, 1, 2, 3]) }));
    write(dir, { "b.bin": Buffer.from([0, 9, 9, 9]), "new.bin": Buffer.from([0, 7]) });
    const { entries } = await readStatus(dir);
    expect(await readFileDiff(dir, entry(entries, "b.bin", "unstaged"))).toEqual({ ok: true, binary: true });
    expect(await readFileDiff(dir, entry(entries, "new.bin", "untracked"))).toMatchObject({ ok: true, binary: true, newSize: 2 });
  });

  it("shows an untracked text file as added, and says so when it has no final newline", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    write(dir, { "n.txt": "x\ny", "empty.txt": "" });
    const { entries } = await readStatus(dir);
    const d = await readFileDiff(dir, entry(entries, "n.txt", "untracked"));
    expect(d).toMatchObject({ ok: true, binary: false, added: 2, removed: 0 });
    expect(d.patch).toContain("--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n\\ No newline at end of file\n");
    expect(await readFileDiff(dir, entry(entries, "empty.txt", "untracked"))).toMatchObject({ ok: true, added: 0 });
  });

  it("shows a conflicted file against HEAD, its markers as added lines, whichever way it conflicts", async () => {
    const dir = track(repoWith({ "a.txt": "base\nshared\n", "gone.txt": "one\n" }));
    sh(dir, ["checkout", "-q", "-b", "other"]);
    write(dir, { "a.txt": "theirs\nshared\n", "both.txt": "theirs\n", "gone.txt": "one\ntheir edit\n" });
    commitAll(dir, "theirs");
    sh(dir, ["checkout", "-q", "main"]);
    write(dir, { "a.txt": "ours\nshared\n", "both.txt": "ours\n" });
    sh(dir, ["rm", "-q", "gone.txt"]);
    commitAll(dir, "ours");
    try { sh(dir, ["merge", "-q", "other"]); } catch { /* the conflict is the point */ }
    const { entries } = await readStatus(dir);
    const uu = await readFileDiff(dir, entry(entries, "a.txt", "conflict"));
    expect(uu.patch).not.toMatch(/^diff --cc|^@@@/m);
    expect(uu.patch).toMatch(/^@@ -1,2 \+1,6 @@/m);
    expect(uu.patch).toContain("+<<<<<<< HEAD\n ours\n+=======\n+theirs\n+>>>>>>> other\n");
    expect(uu).toMatchObject({ ok: true, binary: false, added: 4, removed: 0 });
    // Added on both sides: HEAD holds ours.
    const aa = await readFileDiff(dir, entry(entries, "both.txt", "conflict"));
    expect(aa.patch).toContain("@@ -1 +1,5 @@\n+<<<<<<< HEAD\n ours\n+=======\n+theirs\n+>>>>>>> other\n");
    // Deleted on this side, changed on the other: the folder holds theirs.
    const du = await readFileDiff(dir, entry(entries, "gone.txt", "conflict"));
    expect(du.patch).not.toContain("Unmerged path");
    expect(du.patch).toContain("+one\n+their edit\n");
  });

  it("counts a changed line that starts with -- or ++ as a changed line", async () => {
    const dir = track(repoWith({ "q.sql": "-- comment one\nSELECT 1;\n-- comment two\n", "f.md": "---\ntitle: x\n---\nbody\n" }));
    write(dir, { "q.sql": "SELECT 1;\n++i;\n", "f.md": "title: x\nbody\n" });
    const { entries } = await readStatus(dir);
    expect(await readFileDiff(dir, entry(entries, "q.sql", "unstaged"))).toMatchObject({ added: 1, removed: 2 });
    expect(await readFileDiff(dir, entry(entries, "f.md", "unstaged"))).toMatchObject({ added: 0, removed: 2 });
  });

  it("answers too large with the sizes instead of the content", async () => {
    const big = "x".repeat(80) + "\n";
    const dir = track(repoWith({ "big.txt": big.repeat(10) }));
    const content = big.repeat(Math.ceil((DIFF_CAP * 1.5) / big.length));
    write(dir, { "big.txt": content, "big-new.txt": content });
    const { entries } = await readStatus(dir);
    const d = await readFileDiff(dir, entry(entries, "big.txt", "unstaged"));
    expect(d).toEqual({ ok: true, tooLarge: true, limit: DIFF_CAP, oldSize: big.length * 10, newSize: content.length });
    expect(await readFileDiff(dir, entry(entries, "big-new.txt", "untracked"))).toMatchObject({ tooLarge: true, newSize: content.length });
  });
});

describe("readCommit", () => {
  it("lists a commit's files with change type and counts, renames and binaries included", async () => {
    const dir = track(repoWith({ "a.txt": "1\n2\n", "old.txt": "same\nsame\nsame\n", "gone.txt": "g\n", "b.bin": Buffer.from([0, 1]) }));
    sh(dir, ["mv", "old.txt", "new.txt"]);
    sh(dir, ["rm", "-q", "gone.txt"]);
    write(dir, { "a.txt": "1\n3\n4\n", "b.bin": Buffer.from([0, 2]), "added.txt": "x\n" });
    const sha = commitAll(dir, "many");
    const r = await readCommit(dir, sha.slice(0, 10));
    expect(r.ok).toBe(true);
    expect(r.commit).toMatchObject({ sha, subject: "many" });
    const by = (p: string) => r.files.find((f: any) => f.path === p);
    expect(by("a.txt")).toEqual({ path: "a.txt", change: "modified", binary: false, added: 2, removed: 1 });
    expect(by("new.txt")).toEqual({ path: "new.txt", from: "old.txt", change: "renamed", binary: false, added: 0, removed: 0 });
    expect(by("gone.txt")).toMatchObject({ change: "deleted", removed: 1 });
    expect(by("added.txt")).toMatchObject({ change: "added", added: 1 });
    expect(by("b.bin")).toMatchObject({ change: "modified", binary: true });

    const d = await readCommitFileDiff(dir, r.commit, by("a.txt"));
    expect(d.patch).toContain("-2\n+3\n+4\n");
    expect((await readCommitFileDiff(dir, r.commit, by("new.txt"))).patch).toContain("rename from old.txt");
  });

  it("shows a root commit as everything added, and a merge against its first parent", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const root = sh(dir, ["rev-parse", "HEAD"]).trim();
    const r0 = await readCommit(dir, root);
    expect(r0.files).toEqual([{ path: "a.txt", change: "added", binary: false, added: 1, removed: 0 }]);
    expect((await readCommitFileDiff(dir, r0.commit, r0.files[0])).patch).toContain("+one");

    sh(dir, ["checkout", "-q", "-b", "topic"]);
    write(dir, { "t.txt": "topic\n" });
    commitAll(dir, "topic");
    sh(dir, ["checkout", "-q", "main"]);
    write(dir, { "m.txt": "main\n" });
    commitAll(dir, "main side");
    sh(dir, ["merge", "-q", "--no-ff", "-m", "merge topic", "topic"]);
    const merge = await readCommit(dir, sh(dir, ["rev-parse", "HEAD"]).trim());
    expect(merge.commit.parents).toHaveLength(2);
    expect(merge.files.map((f: any) => f.path)).toEqual(["t.txt"]);
  });

  it("refuses anything that is not a commit id this repository has", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    for (const bad of ["HEAD", "--output=/tmp/x", "main", "deadbeef".repeat(5), "abc", "", "a b"]) {
      expect(await readCommit(dir, bad), bad).toEqual({ ok: false, reason: "unknown" });
    }
  });
});

describe("every read leaves the repository as it found it", () => {
  it("never writes .git/index or creates index.lock", async () => {
    const dir = track(repoWith({ "a.txt": "one\n", "b.txt": "two\n", "c.txt": "three\n" }));
    write(dir, { "a.txt": "staged\n" });
    sh(dir, ["add", "a.txt"]);
    write(dir, { "b.txt": "changed\n", "u.txt": "new\n" });
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "c.txt"), future, future);
    const index = join(dir, ".git", "index");
    const stamp = () => ({ mtime: statSync(index).mtimeMs, hash: createHash("sha256").update(readFileSync(index)).digest("hex") });
    const watcher = await watchNames(join(dir, ".git"));
    let seen: string[] | null = null;
    try {
      const before = stamp();
      const head = await headOf(dir);
      const log = await readLog(dir, head);
      const status = await readStatus(dir);
      for (const e of status.entries) expect((await readFileDiff(dir, e)).ok).toBe(true);
      expect((await countEntries(dir, status.entries)).filter((e: any) => typeof e.added === "number")).toHaveLength(status.entries.length);
      const c = await readCommit(dir, log.commits[0].sha);
      await readCommitFileDiff(dir, c.commit, c.files[0]);
      seen = await watcher.stop();
      expect(stamp()).toEqual(before);
      expect(existsSync(`${index}.lock`)).toBe(false);
      expect(seen.filter(n => n.includes("index.lock"))).toEqual([]);
    } finally {
      if (seen === null) await watcher.stop();
    }
  });
});
