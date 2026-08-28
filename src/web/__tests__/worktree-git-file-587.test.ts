// #587. `isGitCheckout` is the one predicate that decides whether the deck
// offers to `npm i -g` over the tree it is running from, and it asks the right
// question — `existsSync(join(pkgRoot, ".git"))`, which is true whether `.git`
// is a directory or a file. Nothing in the suite was in a position to notice
// that it asks the right one. Every fixture that had ever exercised the
// predicate built `.git` with `mkdirSync`, in six places across four files, and
// the two cases that met a real `.git` rather than a fabricated one read the
// tree the suite happened to be running in — which, run the ordinary way, is
// the main worktree, where `.git` is a directory too. So the whole suite agreed
// on one shape, and agreed silently.
//
// A `.git` FILE is not a corner case. Git writes one for a linked worktree
// (`git worktree add`) and for a submodule, and its entire content is a single
// `gitdir:` line pointing at the real repository directory elsewhere. This repo
// is worked on almost entirely in linked worktrees — one per agent, thirty of
// them under `.claude/worktrees/` — so the file shape is not the exotic case
// here, it is the common one.
//
// What the gap cost: a well-meaning hardening pass that reads "a checkout has a
// `.git` directory" and rewrites the predicate as
// `statSync(join(pkgRoot, ".git")).isDirectory()` passes the entire suite —
// 3355 tests, including all six upgrade suites — while turning every linked
// worktree and every submodule checkout into what the deck believes is a plain
// global install. `upgradeCommand` starts answering `npm i -g agents-deck@latest`
// instead of `git pull && npm run build`; `upgradeBlock` stops returning the
// `git_checkout` refusal, so `upgradeMode` says "install" and the in-app Update
// button goes live. Pressing it installs a published tarball over the global
// package while the user goes on running the source in front of them, and the
// deck reports success. Nothing was updated: there is no installed copy of a
// checkout to update, which is precisely why the refusal exists.
//
// So this file states the shape rule directly, and states it in both directions.
// Every on-disk form a real checkout takes is built in a temp sandbox and driven
// through the same four answers the deck actually shows a user — the name it
// would install, the command it prints, the reason it refuses, and the mode the
// button reads — and beside them sits the tree with no `.git` at all, which must
// still be installable. A mutation that accepts only directories fails the
// worktree and submodule rows; a mutation that accepts only files fails the
// clone row; a predicate that stopped looking at `.git` entirely fails the
// no-`.git` row. None of the three can pass.
//
// Two shapes here are deliberate rather than incidental.
//
// The dangling `gitdir:` — a worktree whose main checkout was deleted, moved or
// pruned — is a state that really happens, and the answer for it is chosen: it
// is still a checkout. The file is the tree's own statement that it is a working
// copy, the source is still sitting there, and the recovery is `git worktree
// repair` or a fresh clone, not a tarball unpacked over the top. The two
// directions are not symmetric in cost either. Refusing is recoverable — the
// user gets a command and runs it themselves — while offering is not: it
// rewrites a global package on the strength of a guess about somebody else's
// broken repository.
//
// The `gitdir:` spellings are here for the same reason. Git writes a native
// absolute path on Windows, with a drive letter and backslashes; it writes
// POSIX-style forward slashes on Linux and macOS, and a relative path for a
// submodule. The predicate reads none of it — it stats the entry and stops —
// and that indifference is the property worth pinning, because it is what makes
// the rule identical on all three platforms. So all three spellings are written
// and all three must answer the same. The fixture builds its own paths with
// `join`, so the file it writes carries whatever separator the host uses, and
// asserts nothing about path text.
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

// npm is never executed. The install child is recorded and handed back as a
// fake, so no case in this file can install anything onto the machine running
// the suite — including the one whose whole point is that the install must not
// be reached.
type FakeChild = { emit: (event: string, ...args: unknown[]) => void };
const { spawns } = vi.hoisted(() => ({
  spawns: [] as { cmd: string; args: string[]; child: FakeChild }[],
}));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  class Fake extends EventEmitter {
    pid = 4242;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    kill() { return true; }
    unref() { /* the real one is unref'd so it cannot hold the process open */ }
  }
  return {
    spawn: (cmd: string, args: string[] = []) => {
      const child = new Fake();
      spawns.push({ cmd, args, child: child as unknown as FakeChild });
      return child;
    },
    execFile: () => { throw new Error("test: execFile blocked"); },
  };
});

// @ts-expect-error — plain JS module, no types
import { upgradeBlock, upgradeCommand, upgradeMode, upgradeName, startUpgrade } from "../../server/self-update.mjs";

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-git-shape-587-"));
afterAll(() => rmTempDir(SANDBOX));

// `opted_out` outranks `git_checkout` in upgradeBlockedReason, so a developer
// with AGENTS_DECK_NO_INSTALL=1 in their shell would have every refusal below
// come back for the wrong reason and every assertion still pass. The env is
// pinned for the file and restored after it.
const prevOptOut = process.env.AGENTS_DECK_NO_INSTALL;
delete process.env.AGENTS_DECK_NO_INSTALL;
afterAll(() => {
  if (prevOptOut === undefined) delete process.env.AGENTS_DECK_NO_INSTALL;
  else process.env.AGENTS_DECK_NO_INSTALL = prevOptOut;
});

const VERSION = "1.33.152";

/**
 * Builds one real on-disk checkout shape and returns the pkgRoot the deck would
 * be running out of.
 *
 *   "clone"     — an ordinary `git clone`: `.git` is a directory.
 *   "worktree"  — `git worktree add`: `.git` is a FILE holding one `gitdir:`
 *                 line, an absolute native path to `<main>/.git/worktrees/<name>`
 *                 that exists.
 *   "submodule" — a submodule checkout: `.git` is a FILE too, but its `gitdir:`
 *                 is RELATIVE, the way git writes it there.
 *   "dangling"  — a worktree whose main checkout is gone: `.git` is a file and
 *                 the directory it names does not exist.
 *   "slashes"   — the worktree shape with a POSIX-style `gitdir:` written on
 *                 whatever platform is running, so the two spellings git uses
 *                 across the three operating systems both appear here.
 *   "installed" — no `.git` at all: the control row, and the only one the deck
 *                 may offer to install over.
 */
function checkout(shape: "clone" | "worktree" | "submodule" | "dangling" | "slashes" | "installed"): string {
  const root = mkdtempSync(join(SANDBOX, `${shape}-`));
  // Every path below is derived from mkdtemp's answer; one wrong join would
  // have this file writing into the developer's own tree.
  if (!root.startsWith(SANDBOX)) throw new Error(`refusing to write: ${root} is outside ${SANDBOX}`);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agents-deck", version: VERSION }));

  const dotGit = join(root, ".git");
  // The repository directory a `gitdir:` line points at. Built with join, so it
  // carries the host's own separator — and a drive letter on Windows, which is
  // exactly the path text the predicate must not care about.
  const real = join(root, "..", ".git", "worktrees", "wt");

  if (shape === "installed") return root;
  if (shape === "clone") { mkdirSync(dotGit, { recursive: true }); return root; }

  if (shape !== "dangling") mkdirSync(real, { recursive: true });
  const target = shape === "submodule" ? join("..", "..", ".git", "modules", "deck")
    : shape === "slashes" ? real.split(/[\\/]/).join("/")
    : real;
  writeFileSync(dotGit, `gitdir: ${target}\n`);
  return root;
}

beforeEach(() => { spawns.length = 0; });

// startUpgrade holds one install per process and answers `already` to every
// call until that one settles, so a case that reached npm when it should not
// have would otherwise silence every case after it — the next assertion would
// see no spawn and read as "correctly refused". Settling whatever leaked keeps
// each failure below about its own row.
afterEach(() => { for (const s of spawns) s.child.emit("close", 0); });

/** The four answers a user can see, for one pkgRoot, in one place. */
function answersFor(pkgRoot: string) {
  const blocked = upgradeBlock(pkgRoot);
  return {
    name: upgradeName(pkgRoot),
    command: upgradeCommand(pkgRoot),
    blocked,
    mode: upgradeMode(blocked),
    start: startUpgrade({ pkgRoot }),
  };
}

// The four shapes a `.git` takes in a tree somebody is actually developing in.
// "clone" is the one the suite already had; the other three are what #587 was
// about.
const CHECKOUTS = [
  ["an ordinary clone, where .git is a directory", "clone"],
  ["a linked worktree, where .git is a file naming the real repository", "worktree"],
  ["a submodule, where that file's gitdir is relative", "submodule"],
  ["a worktree spelled with forward slashes, as git writes it off Windows", "slashes"],
  ["a worktree whose main checkout has been deleted", "dangling"],
] as const;

describe("a checkout is a checkout whether git left a directory or a file behind", () => {
  for (const [what, shape] of CHECKOUTS) {
    it(`tells ${what} to pull and rebuild, and installs nothing over it`, () => {
      const answers = answersFor(checkout(shape));
      // The command the user is shown. `npm run build` is half of it because
      // dist/ is built, not shipped, so a pull alone leaves the old bundle.
      expect(answers.command).toBe("git pull && npm run build");
      // The registry side is skipped for a checkout, so the published name is
      // the only sensible subject left for the version question.
      expect(answers.name).toBe("agents-deck");
      // The reason, named — not merely "blocked". `not_writable` here would
      // mean the sandbox was read-only rather than that this is a checkout, and
      // would satisfy a test that only asked whether something refused.
      expect(answers.blocked).toBe("git_checkout");
      // What the in-app Update button reads. null is the button not rendering
      // at all; "install" is the regression, live and one click from running.
      expect(answers.mode).toBeNull();
      expect(answers.start).toMatchObject({ ok: false, reason: "git_checkout" });
      // And the fake is the proof, not the return value: even a refusal that
      // reported itself correctly would still be a bug if npm had already been
      // spawned by the time it did.
      expect(spawns, "a checkout must never reach npm i -g").toHaveLength(0);
    });
  }

  it("still offers the install to a tree that has no .git at all", () => {
    // The control. Without it every assertion above is satisfied by a predicate
    // that answers "checkout" to everything, which would refuse to update the
    // installs that are the only ones an update was ever for.
    const answers = answersFor(checkout("installed"));
    expect(answers.command).toBe("npm i -g agents-deck@latest");
    expect(answers.blocked).toBeNull();
    expect(answers.mode).toBe("install");
    expect(answers.start).toMatchObject({ ok: true });
    expect(spawns).toHaveLength(1);
  });
});

describe("the shape rule outranks everything else the layout could suggest", () => {
  it("keeps refusing when the checkout is linked into somebody's node_modules", () => {
    // `npm link`, or a workspace: on disk this is the stub layout exactly, and
    // the git test has to beat both the layout rule and the manifest one or the
    // deck offers to install a published tarball over a working copy. Built in
    // the file shape, because the directory shape is already covered elsewhere
    // and this is the pairing that was missing.
    const root = mkdtempSync(join(SANDBOX, "linked-"));
    const pkgRoot = join(root, "node_modules", "agents-deck");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "ccdeck", version: VERSION, dependencies: { "agents-deck": VERSION },
    }));
    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "agents-deck", version: VERSION }));
    writeFileSync(join(pkgRoot, ".git"), "gitdir: /somewhere/else/.git/worktrees/wt\n");

    expect(upgradeName(pkgRoot)).toBe("agents-deck");
    expect(upgradeCommand(pkgRoot)).toBe("git pull && npm run build");
    expect(upgradeBlock(pkgRoot)).toBe("git_checkout");
    expect(spawns).toHaveLength(0);
  });

  it("does not read the gitdir line, so no path spelling can change the answer", () => {
    // The cross-platform guarantee, stated as the thing it actually rests on.
    // A Windows worktree's gitdir carries a drive letter and backslashes, a
    // submodule's is relative, a repaired one may be neither — and none of it
    // is parsed, so none of it can behave differently on one operating system.
    // The empty file is the limit case: git never writes one, but a truncated
    // write or an interrupted `git worktree add` can leave it, and the answer
    // must not depend on having got a line out of it.
    const lines = [
      "gitdir: C:\\Users\\dev\\repo\\.git\\worktrees\\wt\n",
      "gitdir: C:/Users/dev/repo/.git/worktrees/wt\n",
      "gitdir: /home/dev/repo/.git/worktrees/wt\n",
      "gitdir: ../../.git/modules/deck\n",
      "",
    ];
    for (const line of lines) {
      const root = mkdtempSync(join(SANDBOX, "spelling-"));
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agents-deck", version: VERSION }));
      writeFileSync(join(root, ".git"), line);
      expect(upgradeCommand(root), JSON.stringify(line)).toBe("git pull && npm run build");
      expect(upgradeBlock(root), JSON.stringify(line)).toBe("git_checkout");
    }
    expect(spawns).toHaveLength(0);
  });
});
