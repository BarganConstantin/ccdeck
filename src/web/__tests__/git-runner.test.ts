// The deck reads repositories it does not own, often while an agent is writing
// in them. Every case here is a way an ordinary git read could write to the
// repository or start a program the repository's configuration names, and each
// is shown happening with plain git first, so the case cannot pass merely
// because the trap was never armed.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const { git, gitArgv, gitEnv, classifyFailure } = await import("../../server/git-run.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { filterNames } = await import("../../server/git-repo.mjs");

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
    const argv = gitArgv("status", [], { filters: ["lfs", "a.b"] }).join(" ");
    for (const d of ["lfs", "a.b"]) {
      expect(argv).toContain(`-c filter.${d}.clean= `);
      expect(argv).toContain(`-c filter.${d}.process= `);
      expect(argv).toContain(`-c filter.${d}.required=false`);
    }
  });

  it("refuses to start anything that writes", () => {
    for (const sub of ["commit", "checkout", "switch", "restore", "add", "rm", "mv", "reset", "stash", "fetch", "pull", "push",
      "merge", "rebase", "cherry-pick", "branch", "tag", "worktree", "gc", "update-index", "clean", "notes", "am", "apply"]) {
      expect(() => gitArgv(sub, []), sub).toThrow(/not a read/);
    }
  });

  it("hands the child none of the deck's GIT_* variables, and pins locks off", () => {
    const env = gitEnv({ PATH: "/bin", GIT_DIR: "/elsewhere", GIT_EXTERNAL_DIFF: "x", HOME: "/h" }, "linux");
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
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
