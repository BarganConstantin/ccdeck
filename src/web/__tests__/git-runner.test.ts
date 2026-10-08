// The deck reads repositories it does not own, often while an agent is writing
// in them. Every case here is a way an ordinary git read could write to the
// repository or start a program the repository's configuration names, and each
// is shown happening with plain git first, so the case cannot pass merely
// because the trap was never armed.
import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { rmTempDir } from "./rm-temp-dir";
import { commitAll, markerProgram, repoWith, sh, tempDir, watchNames, write } from "./git-fixture";

// The deck's reads see the user's global git configuration; these must not.
const HOME = tempDir("ccdeck-git-runner-home-");
const KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "PATH"] as const;
const prev = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.XDG_CONFIG_HOME = join(HOME, ".config");

// @ts-expect-error — plain .mjs server module, no types
const { git, gitArgv, gitEnv, classifyFailure, filterConfigEnv, filtersCanBeEmptied, parseGitVersion } = await import("../../server/git-run.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { filterNames } = await import("../../server/git-repo.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { readCommit, readCommitFileDiff, readLastCommitTime } = await import("../../server/git-reads.mjs");

const made: string[] = [HOME];
const track = (dir: string) => { made.push(dir); return dir; };
afterAll(() => {
  for (const k of KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  for (const dir of made) rmTempDir(dir);
});

/** A folder outside the repository for the trap programs and their markers. */
const traps = () => track(tempDir("ccdeck-git-traps-"));

describe("the argument vector", () => {
  it("never takes an optional lock and never asks an fsmonitor, on every subcommand", () => {
    for (const sub of ["rev-parse", "symbolic-ref", "for-each-ref", "config", "status", "diff", "diff-tree", "log", "show", "cat-file", "rev-list"]) {
      const argv: string[] = gitArgv(sub, []);
      expect(argv.indexOf("--no-optional-locks"), sub).toBeGreaterThanOrEqual(0);
      expect(argv.indexOf("--no-optional-locks"), sub).toBeLessThan(argv.indexOf(sub));
      expect(argv.join(" "), sub).toContain("-c core.fsmonitor=false");
    }
  });

  it("turns off external diff drivers and text conversion on everything that can print a diff", () => {
    for (const sub of ["diff", "diff-tree", "log", "show"]) {
      const after = gitArgv(sub, []).slice(gitArgv(sub, []).indexOf(sub) + 1);
      expect(after, sub).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv"]));
    }
    expect(gitArgv("log", [])).toContain("--no-show-signature");
  });

  it("empties every filter driver it is told about", () => {
    const argv = gitArgv("status", [], { filters: ["lfs", "a.b", "a=b"] }).join(" ");
    for (const d of ["lfs", "a.b"]) {
      expect(argv).toContain(`-c filter.${d}.clean= `);
      expect(argv).toContain(`-c filter.${d}.process= `);
      expect(argv).toContain(`-c filter.${d}.required=false`);
    }
    // `-c` splits at the first "=", so that name goes through the environment.
    expect(argv).not.toContain("filter.a=b");
    const env = filterConfigEnv(["lfs", "a=b"]);
    expect(env.GIT_CONFIG_COUNT).toBe("8");
    const pairs = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
    expect(pairs).toEqual({
      "filter.lfs.clean": "", "filter.lfs.smudge": "", "filter.lfs.process": "", "filter.lfs.required": "false",
      "filter.a=b.clean": "", "filter.a=b.smudge": "", "filter.a=b.process": "", "filter.a=b.required": "false",
    });
    expect(filterConfigEnv([])).toEqual({});
  });

  it("refuses a read whose filter driver this git could not empty", () => {
    expect(parseGitVersion("git version 2.53.0\n")).toEqual([2, 53]);
    expect(parseGitVersion("git version 2.30.2.windows.1")).toEqual([2, 30]);
    expect(parseGitVersion("nonsense")).toBeNull();
    expect(filtersCanBeEmptied(["lfs", "x y"], null)).toBe(true);
    expect(filtersCanBeEmptied(["a=b"], [2, 31])).toBe(true);
    expect(filtersCanBeEmptied(["a=b"], [3, 0])).toBe(true);
    expect(filtersCanBeEmptied(["a=b"], [2, 30])).toBe(false);
    expect(filtersCanBeEmptied(["a=b"], null)).toBe(false);
    expect(classifyFailure({ refused: true, stderr: "" })).toBe("unsafe");
  });

  it("never fetches, and never connects anywhere", () => {
    for (const sub of ["status", "diff", "diff-tree", "log", "cat-file", "rev-list"]) {
      expect(gitArgv(sub, []).join(" "), sub).toContain("-c protocol.allow=never");
    }
    expect(gitEnv({}, "linux").GIT_NO_LAZY_FETCH).toBe("1");
    expect(classifyFailure({ stderr: "warning: lazy fetching disabled; some objects may not be available\nfatal: could not fetch 6b7a from promisor remote" })).toBe("not-downloaded");
    expect(classifyFailure({ stderr: "fatal: transport 'file' not allowed\nfatal: could not fetch 6b7a from promisor remote" })).toBe("not-downloaded");
  });

  it("refuses to start anything that writes", () => {
    for (const sub of ["commit", "checkout", "switch", "restore", "add", "rm", "mv", "reset", "stash", "fetch", "pull", "push",
      "merge", "rebase", "cherry-pick", "branch", "tag", "worktree", "gc", "update-index", "clean", "notes", "am", "apply"]) {
      expect(() => gitArgv(sub, []), sub).toThrow(/not a read/);
    }
  });

  it("hands the child none of the deck's GIT_* variables, and pins locks off", () => {
    const env = gitEnv({ PATH: "/bin", GIT_DIR: "/elsewhere", GIT_EXTERNAL_DIFF: "x", GIT_CONFIG_COUNT: "1", HOME: "/h" }, "linux");
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" });
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
    // One variable on Windows, whatever its case.
    expect(gitEnv({ Git_Dir: "/elsewhere" }, "win32").Git_Dir).toBeUndefined();
    expect(gitEnv({ Git_Dir: "/elsewhere" }, "linux").Git_Dir).toBe("/elsewhere");
  });
});

describe("a read never writes the index", () => {
  it("leaves .git/index untouched and never creates index.lock, where plain git status rewrites it", async () => {
    const dir = track(repoWith({ "a.txt": "one\n", "b.txt": "two\n" }));
    const index = join(dir, ".git", "index");
    const stamp = () => ({ mtime: statSync(index).mtimeMs, hash: createHash("sha256").update(readFileSync(index)).digest("hex") });
    // Stat-dirty without a content change: the case status refreshes and
    // writes back. Pushed into the future so the index cannot be racily clean.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "a.txt"), future, future);
    write(dir, { "b.txt": "two, changed\n" });

    const watcher = await watchNames(join(dir, ".git"));
    let seen: string[] | null = null;
    try {
      const before = stamp();
      expect((await git("status", ["--porcelain=v2", "-z"], { cwd: dir })).ok).toBe(true);
      expect((await git("diff", ["--", "b.txt"], { cwd: dir })).ok).toBe(true);
      expect((await git("diff", ["--cached"], { cwd: dir })).ok).toBe(true);
      expect((await git("log", ["-n", "5", "--format=%H"], { cwd: dir })).ok).toBe(true);
      seen = await watcher.stop();
      expect(stamp()).toEqual(before);
      expect(existsSync(`${index}.lock`)).toBe(false);
      expect(seen.filter(n => n.includes("index.lock"))).toEqual([]);

      // And the trap was armed: plain git, asked the same question, rewrites it.
      sh(dir, ["status", "--porcelain"]);
      expect(stamp().hash).not.toBe(before.hash);
    } finally {
      if (seen === null) await watcher.stop();
    }
  });
});

describe("a diff never refreshes the index on its own", () => {
  it("leaves the index alone for a file whose timestamp moved and whose content did not", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const index = join(dir, ".git", "index");
    const hash = () => createHash("sha256").update(readFileSync(index)).digest("hex");
    const touch = () => { const t = new Date(Date.now() + 120_000 + Math.random() * 1000); utimesSync(join(dir, "a.txt"), t, t); };
    touch();
    const before = hash();
    const r = await git("diff", ["--", "a.txt"], { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("");
    expect(hash()).toBe(before);

    // Plain git, even told to take no optional locks, writes it back.
    sh(dir, ["--no-optional-locks", "diff", "--", "a.txt"]);
    expect(hash()).not.toBe(before);
  });
});

describe("a read never runs the repository's programs", () => {
  it("never runs core.fsmonitor", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const t = traps();
    const marker = join(t, "fsmonitor.ran");
    sh(dir, ["config", "core.fsmonitor", markerProgram(t, "fsmonitor", marker)]);
    write(dir, { "a.txt": "one, changed\n" });

    expect((await git("status", ["--porcelain=v2", "-z"], { cwd: dir })).ok).toBe(true);
    expect((await git("diff", [], { cwd: dir })).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);

    sh(dir, ["status", "--porcelain"]);
    expect(existsSync(marker), "plain git status should have run the hook").toBe(true);
  });

  it("never runs an external diff driver, from diff.external or from a diff attribute", async () => {
    const dir = track(repoWith({ "a.txt": "one\n", "c.dat": "x\n" }));
    const t = traps();
    const marker = join(t, "extdiff.ran");
    const program = markerProgram(t, "extdiff", marker);
    sh(dir, ["config", "diff.external", program]);
    sh(dir, ["config", "diff.dat.command", program]);
    write(dir, { ".gitattributes": "*.dat diff=dat\n" });
    commitAll(dir, "attributes");
    write(dir, { "a.txt": "one, changed\n", "c.dat": "y\n" });

    expect((await git("diff", [], { cwd: dir })).ok).toBe(true);
    expect((await git("log", ["-p", "-n", "2"], { cwd: dir })).ok).toBe(true);
    expect((await git("show", ["HEAD"], { cwd: dir })).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);

    sh(dir, ["diff"]);
    expect(existsSync(marker), "plain git diff should have run the driver").toBe(true);
  });

  it("never runs a textconv", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const t = traps();
    const marker = join(t, "textconv.ran");
    sh(dir, ["config", "diff.tc.textconv", markerProgram(t, "textconv", marker)]);
    write(dir, { ".gitattributes": "*.txt diff=tc\n", "a.txt": "two\n" });
    commitAll(dir, "attributes");
    write(dir, { "a.txt": "three\n" });

    expect((await git("diff", [], { cwd: dir })).ok).toBe(true);
    expect((await git("log", ["-p", "-n", "2"], { cwd: dir })).ok).toBe(true);
    expect((await git("show", ["HEAD"], { cwd: dir })).ok).toBe(true);
    expect((await git("diff-tree", ["-r", "-p", "--root", "HEAD"], { cwd: dir })).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);

    sh(dir, ["diff"]);
    expect(existsSync(marker), "plain git diff should have run the textconv").toBe(true);
  });

  it("never runs a clean filter once the configured drivers are emptied", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const t = traps();
    const marker = join(t, "clean.ran");
    const program = markerProgram(t, "clean", marker);
    sh(dir, ["config", "filter.evil.clean", program]);
    sh(dir, ["config", "filter.evil.smudge", program]);
    sh(dir, ["config", "filter.evil.required", "true"]);
    write(dir, { ".gitattributes": "*.txt filter=evil\n" });
    write(dir, { "a.txt": "one, changed\n" });

    // The system configuration may define more (git-lfs installs one there).
    const filters = await filterNames(dir);
    expect(filters).toContain("evil");
    expect((await git("status", ["--porcelain=v2", "-z"], { cwd: dir, filters })).ok).toBe(true);
    const d = await git("diff", ["--", "a.txt"], { cwd: dir, filters });
    expect(d.ok).toBe(true);
    expect(d.stdout).toContain("+one, changed");
    expect(existsSync(marker)).toBe(false);

    sh(dir, ["diff"]);
    expect(existsSync(marker), "plain git diff should have run the filter").toBe(true);
  });

  it("never runs a clean filter whose driver name holds an equals sign", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const t = traps();
    const marker = join(t, "clean-eq.ran");
    const program = markerProgram(t, "clean-eq", marker);
    sh(dir, ["config", "filter.a=b.clean", program]);
    write(dir, { ".gitattributes": "*.txt filter=a=b\n" });
    write(dir, { "a.txt": "one, changed\n" });

    const filters = await filterNames(dir);
    expect(filters).toContain("a=b");
    const st = await git("status", ["--porcelain=v2", "-z"], { cwd: dir, filters });
    const d = await git("diff", ["--", "a.txt"], { cwd: dir, filters });
    // Emptied on a git that reads GIT_CONFIG_COUNT; refused on one that does not.
    for (const r of [st, d]) expect(r.ok || classifyFailure(r) === "unsafe").toBe(true);
    if (d.ok) expect(d.stdout).toContain("+one, changed");
    expect(existsSync(marker)).toBe(false);

    sh(dir, ["-c", "filter.a=b.clean=", "diff"]);
    expect(existsSync(marker), "plain git diff should have run the filter, even with -c naming it").toBe(true);
  });
});

describe("a partial clone", () => {
  /** A program the clone's config names as its upload-pack: it leaves
   *  `marker` and then serves the fetch, the way a real remote would. */
  const uploadPack = (dir: string, marker: string) => {
    const path = join(dir, "upload-pack");
    writeFileSync(path, `#!/bin/sh\necho ran >> '${marker.replace(/\\/g, "/")}'\nexec git-upload-pack "$@"\n`);
    chmodSync(path, 0o755);
    return path.replace(/\\/g, "/");
  };
  /** A three-commit repository a filtered clone may be made from, and the clone. */
  const cloned = (filter: string) => {
    const src = track(repoWith({ "src/app.ts": "one\n", "f.txt": "one\n".repeat(40) }));
    sh(src, ["config", "uploadpack.allowFilter", "true"]);
    sh(src, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    write(src, { "src/app.ts": "two\n", "f.txt": "two\n".repeat(40) });
    const two = commitAll(src, "two");
    write(src, { "f.txt": "three\n".repeat(40) });
    commitAll(src, "three");
    const dst = join(track(tempDir("ccdeck-git-partial-")), "clone");
    sh(src, ["clone", "-q", `--filter=${filter}`, pathToFileURL(src).href, dst]);
    const t = traps();
    const marker = join(t, "upload-pack.ran");
    sh(dst, ["config", "remote.origin.uploadpack", uploadPack(t, marker)]);
    const packs = () => readdirSync(join(dst, ".git", "objects", "pack")).filter(n => n.endsWith(".pack")).length;
    return { dst, two, marker, packs };
  };

  it("lists an older commit's files without fetching their content, and says its diffs are not there", async () => {
    const { dst, two, marker, packs } = cloned("blob:none");
    const before = packs();
    const c = await readCommit(dst, two);
    expect(c.ok).toBe(true);
    expect(c.notDownloaded).toBe(true);
    expect(c.files.map((f: any) => f.path).sort()).toEqual(["f.txt", "src/app.ts"]);
    const d = await readCommitFileDiff(dst, c.commit, c.files[0]);
    expect(d).toEqual({ ok: false, reason: "not-downloaded" });
    expect(packs()).toBe(before);
    expect(existsSync(marker)).toBe(false);

    // Plain git, asked for the same counts, goes to the remote for them.
    try { sh(dst, ["diff-tree", "-r", "--numstat", `${two}~1`, two]); } catch { /* the fetch may fail; it was tried */ }
    expect(existsSync(marker), "plain git should have fetched").toBe(true);
  });

  it("says a treeless clone's older commit is not downloaded, which reading again cannot mend, and fetches nothing", async () => {
    const { dst, two, marker, packs } = cloned("tree:0");
    const before = packs();
    // Its trees, and its parent's, were never downloaded.
    expect(await readCommit(dst, two)).toEqual({ ok: false, reason: "not-downloaded" });
    expect(packs()).toBe(before);
    expect(existsSync(marker)).toBe(false);

    try { sh(dst, ["diff-tree", "-r", "--numstat", `${two}~1`, two]); } catch { /* tried */ }
    expect(existsSync(marker), "plain git should have fetched").toBe(true);
  });

  it("still calls a tree missing from an ordinary repository an error, not a download it never made", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    write(dir, { "a.txt": "two\n" });
    const two = commitAll(dir, "two");
    const tree = sh(dir, ["rev-parse", `${two}~1^{tree}`]).trim();
    const loose = join(dir, ".git", "objects", tree.slice(0, 2), tree.slice(2));
    chmodSync(loose, 0o644);
    unlinkSync(loose);
    expect(await readCommit(dir, two)).toEqual({ ok: false, reason: "error" });
  });

  it("never fetches old trees to tell when a file was last committed", async () => {
    const { dst, marker, packs } = cloned("tree:0");
    const before = packs();
    // Answers "could not tell" rather than fetching the trees it needs. The
    // fixture's commits are made on 2026-01-02.
    expect(await readLastCommitTime(dst, "src/app.ts", Date.parse("2026-01-01T00:00:00Z"))).toBeNull();
    expect(packs()).toBe(before);
    expect(existsSync(marker)).toBe(false);

    try { sh(dst, ["log", "-1", "--format=%ct", "--", "src/app.ts"]); } catch { /* tried */ }
    expect(existsSync(marker), "plain git should have fetched").toBe(true);
  });
});

describe("limits", () => {
  // Two hundred commits through fast-import, one process.
  const many = () => {
    const dir = track(repoWith({ "a.txt": "start\n" }));
    let stream = "";
    for (let i = 1; i <= 200; i++) {
      const body = `line ${i}\n`;
      stream += `commit refs/heads/main\ncommitter Ada <ada@example.com> ${1700000000 + i} +0000\ndata ${`commit ${i}`.length}\ncommit ${i}\n`
        + (i === 1 ? "from refs/heads/main^0\n" : "") + `M 100644 inline a.txt\ndata ${body.length}\n${body}\n`;
    }
    sh(dir, ["fast-import", "--quiet"], stream);
    sh(dir, ["reset", "-q", "--hard", "main"]);
    return dir;
  };

  it("stops a read whose output passes the cap, and says so rather than answering a fragment", async () => {
    const dir = many();
    const r = await git("log", ["--format=%H %s"], { cwd: dir, maxBytes: 1024 });
    expect(r.ok).toBe(false);
    expect(r.tooLarge).toBe(true);
    expect(classifyFailure(r)).toBe("too-large");
    const all = await git("log", ["--format=%H %s"], { cwd: dir });
    expect(all.ok).toBe(true);
    expect(all.stdout.trim().split("\n")).toHaveLength(201);
  });

  it("abandons a read at its deadline and reports a timeout, not an error", async () => {
    const dir = many();
    const asked = Date.now();
    const r = await git("log", ["-p", "--topo-order"], { cwd: dir, timeout: 1 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(classifyFailure(r)).toBe("timeout");
    expect(Date.now() - asked).toBeLessThan(5_000);
  });
});

describe("git missing from PATH", () => {
  it("is reported as no git, not as a folder that is not a repository", async () => {
    const dir = track(repoWith({ "a.txt": "one\n" }));
    const empty = traps();
    mkdirSync(join(empty, "bin"));
    writeFileSync(join(empty, "bin", "README"), "nothing to run here\n");
    process.env.PATH = join(empty, "bin");
    try {
      const r = await git("rev-parse", ["--show-toplevel"], { cwd: dir });
      expect(r.ok).toBe(false);
      expect(r.missing).toBe(true);
      expect(classifyFailure(r)).toBe("no-git");
    } finally {
      process.env.PATH = prev.PATH;
    }
  });
});
