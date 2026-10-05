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
const { readLog, readStatus, readFileDiff, readCommit, readCommitFileDiff, parseTrailers, DIFF_CAP, LOG_LIMIT } = reads;

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
