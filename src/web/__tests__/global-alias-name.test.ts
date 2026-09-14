// Which package a deck names, for every way it can have been installed — now
// that only one of its three names is published.
//
// The deck went out as `ccdeck`, `agents-deck` and `agent-dag`. From 3.22.3 the
// last two were small packages that depended on ccdeck; since then they are not
// published at all, and stay on the registry at their last version. So two
// questions that used to share one answer now have two:
//
//   · which package to INSTALL — the one that owns the directory this deck runs
//     out of, so the install rewrites the code this process restarts into
//     (#358). For a deck nested inside the retired agents-deck package that is
//     agents-deck, and reinstalling it resolves its `ccdeck@^3` dependency to
//     the newest ccdeck.
//   · which package to ASK npm about — ccdeck, always, because a retired name's
//     dist-tag never moves again and a deck asking about it would never see
//     another release.
//
// npx is the exception to the first: `npx agents-deck@latest` resolves to the
// same last-published package forever, so npx would reuse its cached copy. An
// npx run of a retired name relaunches as `npx ccdeck`.
//
// The layouts are built on disk in a temp sandbox, the way
// stub-global-upgrade.test.ts builds them — nothing is installed, nothing is
// downloaded, and npm is a recording fake that never runs.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The marker lives under homedir(), and one test here is about which file gets
// written there. The real ~/.agents-deck/ is shared with every deck on the
// machine running the suite, so homedir() answers with a temp directory for as
// long as one is set and with the real one otherwise — same shape as
// self-update.test.ts's, re-declared rather than imported.
const { homeRef } = vi.hoisted(() => ({ homeRef: { dir: null as string | null } }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const patched = { ...actual, homedir: () => homeRef.dir ?? actual.homedir() };
  return { ...patched, default: patched };
});

// npm is never executed: the install child is recorded and handed back as a
// fake, so no test in this file can install anything onto the machine running
// the suite.
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
    // exec.mjs names this import; nothing here should reach it.
    execFile: () => { throw new Error("test: execFile blocked"); },
  };
});

import {
  // @ts-expect-error — plain JS module, no types
  ALIAS_PACKAGES, PUBLISHED_NAME, RETIRED_NAMES, hostPackage, installedName, markerFileName, registryName,
  // @ts-expect-error — plain JS module, no types
  startUpgrade, upgradeBlock, upgradeCommand, upgradeMode, upgradeName,
} from "../../server/self-update.mjs";

import { spawnedArgv } from "./spawned-argv";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), "utf8");

const SANDBOX = mkdtempSync(join(tmpdir(), "global-alias-name-"));
afterAll(() => rmTempDir(SANDBOX));

// The registry is not asked by anything except the one version-check test
// below, which stubs fetch and clears this for its own duration. Everything
// else here is about a name and a command, which need no lookup.
const prevEnv = {
  AGENTS_DECK_NO_UPDATE_CHECK: process.env.AGENTS_DECK_NO_UPDATE_CHECK,
  AGENTS_DECK_NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
};
process.env.AGENTS_DECK_NO_UPDATE_CHECK = "1";
delete process.env.AGENTS_DECK_NO_INSTALL;
afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

const VERSION = "1.33.152";
const NEXT = "1.33.153";

/** Writes the `.git` git itself would have written, in whichever of its two
 *  shapes is asked for: a directory for a clone, a one-line file naming the
 *  real repository for a linked worktree or a submodule (#587). */
function plantDotGit(dir: string, worktree: boolean) {
  if (!worktree) { mkdirSync(join(dir, ".git"), { recursive: true }); return; }
  const real = join(dir, "..", ".git", "worktrees", "wt");
  mkdirSync(real, { recursive: true });
  writeFileSync(join(dir, ".git"), `gitdir: ${real}\n`);
}

/** The two shapes, and the sentence each one adds to a test name. Every
 *  checkout case in this file runs over both, so neither "a checkout is a
 *  directory" nor "a checkout is a file" can be believed by mistake. */
const GIT_SHAPES = [
  ["an ordinary clone", false],
  ["a linked worktree, whose .git is a file", true],
] as const;

/**
 * Writes one real install layout under a fresh sandbox directory and returns
 * the pkgRoot the deck would be running out of — the directory holding the
 * package.json every one of these functions is asked about.
 *
 *   "global"   — `npm i -g <pkg>`: the deck itself directly under the global
 *                node_modules, with no host above it.
 *   "stub"     — the deck nested inside another of its own names: the retired
 *                agents-deck or agent-dag package from 3.22.3 on, or the ccdeck
 *                launcher from before #340. What npm >= 7 builds for a global
 *                install with a dependency.
 *   "npx"      — `npx <typed>`: the deck in a content-addressed cache with
 *                npm's own record of the typed spec one level up.
 *   "project"  — a package that merely depends on the deck. Identical in shape
 *                to the stub layout, and not one of this deck's names.
 *   "checkout" — the maintainer's own tree: a manifest and a .git beside it.
 *                `worktree` picks which of the two shapes a real `.git` takes.
 *                False is an ordinary clone, where it is a directory; true is a
 *                linked worktree or a submodule, where it is a FILE holding one
 *                `gitdir:` line — the shape this repo's own agents run in, and
 *                the one #587 found every fixture in the suite was blind to.
 *                The path in that line is built with join, so it carries the
 *                host's separator; nothing reads it, which is what keeps this
 *                identical on all three platforms.
 *
 * Re-declared here rather than imported from stub-global-upgrade.test.ts on
 * purpose — a helper shared between two test files is a place a fix can hide.
 */
function layout(
  shape: "global" | "stub" | "npx" | "project" | "checkout",
  { host = "agents-deck", pkg = "ccdeck", worktree = false }:
    { host?: string; pkg?: string; worktree?: boolean } = {},
): string {
  const root = mkdtempSync(join(SANDBOX, `${shape}-`));
  // Every path is derived from mkdtemp's answer, and one wrong join would have
  // this file writing into the developer's own tree.
  if (!root.startsWith(SANDBOX)) throw new Error(`refusing to write: ${root} is outside ${SANDBOX}`);
  const manifest = (dir: string, body: Record<string, unknown>) =>
    writeFileSync(join(dir, "package.json"), JSON.stringify(body));

  if (shape === "checkout") {
    plantDotGit(root, worktree);
    manifest(root, { name: pkg, version: VERSION });
    return root;
  }

  if (shape === "global") {
    const pkgRoot = join(root, "lib", "node_modules", pkg);
    mkdirSync(pkgRoot, { recursive: true });
    manifest(pkgRoot, { name: pkg, version: VERSION });
    return pkgRoot;
  }

  if (shape === "npx") {
    // `_npx/<hash>/package.json` is npm's own record of the spec the user
    // typed, and the only place it survives an npx run.
    const cache = join(root, "_npx", "9a1c");
    const pkgRoot = join(cache, "node_modules", pkg);
    mkdirSync(pkgRoot, { recursive: true });
    mkdirSync(join(cache, "node_modules", host), { recursive: true });
    writeFileSync(join(cache, "package.json"), JSON.stringify({ _npx: { packages: [host] } }));
    manifest(pkgRoot, { name: pkg, version: VERSION });
    return pkgRoot;
  }

  // stub and project are the same shape on disk; only the manifest above
  // differs, which is the entire point of testing both.
  const outer = shape === "stub" ? join(root, "lib", "node_modules", host) : join(root, host);
  const pkgRoot = join(outer, "node_modules", pkg);
  mkdirSync(pkgRoot, { recursive: true });
  manifest(outer, shape === "stub"
    // What CI published: one of our names, depending on the deck.
    ? { name: host, version: VERSION, bin: { [host]: "shim.js" }, dependencies: { [pkg]: VERSION } }
    : { name: host, version: "0.1.0", dependencies: { [pkg]: "^1.33.0" } });
  manifest(pkgRoot, { name: pkg, version: VERSION });
  return pkgRoot;
}

/** The argv npm was handed, for the one install this file allows to start. */
function npmArgv(pkgRoot: string): string[] {
  spawns.length = 0;
  const out = startUpgrade({ pkgRoot });
  expect(out, "the install was refused, so there is no argv to read").toMatchObject({ ok: true });
  expect(spawns).toHaveLength(1);
  // startUpgrade allows one install at a time per process and answers every
  // later call with `already` until this one settles — so the fake reports the
  // clean exit npm would have, and the next test starts from an idle module.
  spawns[0].child.emit("close", 0);
  // Through spawnedArgv, because since #535 this vector has two shapes. On
  // POSIX npm is a real executable and the arguments are the array as given; on
  // Windows npm is a .cmd shim, so the whole call arrives as cmd.exe's own
  // `/d /s /c` plus one quoted string. The program itself is dropped: every
  // assertion here is about the arguments.
  return spawnedArgv(spawns[0]).slice(1);
}

beforeEach(() => { spawns.length = 0; });

// Every global shape a deck can be running in, and the package whose install
// replaces the code it runs out of.
const GLOBAL_NAMES = [
  {
    typed: "npm i -g ccdeck",
    // The deck itself, directly under the global node_modules.
    pkgRoot: () => layout("global", { pkg: "ccdeck" }),
    installs: "ccdeck",
  },
  {
    typed: "npm i -g agents-deck, 3.22.3 or later",
    // The retired package, with the deck nested inside it as its dependency.
    pkgRoot: () => layout("stub", { host: "agents-deck", pkg: "ccdeck" }),
    installs: "agents-deck",
  },
  {
    typed: "npm i -g agent-dag, 3.22.3 or later",
    pkgRoot: () => layout("stub", { host: "agent-dag", pkg: "ccdeck" }),
    installs: "agent-dag",
  },
  {
    typed: "npm i -g ccdeck, before #340",
    // The old launcher, with the deck nested inside it under its old name.
    pkgRoot: () => layout("stub", { host: "ccdeck", pkg: "agents-deck" }),
    installs: "ccdeck",
  },
] as const;

describe("npm i -g, in every shape a deck can be running in", () => {
  it("installs the package that owns the directory, and only that one", () => {
    for (const { typed, pkgRoot: build, installs } of GLOBAL_NAMES) {
      const pkgRoot = build();
      // The user is shown upgradeCommand and npm is spawned with the argv, and
      // those two have to be the same answer.
      expect(upgradeName(pkgRoot), typed).toBe(installs);
      expect(upgradeCommand(pkgRoot), typed).toBe(`npm i -g ${installs}@latest`);
      expect(npmArgv(pkgRoot), typed)
        .toEqual(["install", "-g", `${installs}@latest`, "--no-audit", "--no-fund", "--loglevel", "error"]);
      // And the in-app button stays offered in every one of them.
      expect(upgradeBlock(pkgRoot), typed).toBeNull();
      expect(upgradeMode(upgradeBlock(pkgRoot)), typed).toBe("install");
    }
  });

  it("asks npm about ccdeck in every one of them, and caches the answer under ccdeck", () => {
    // A retired name's dist-tag stopped at its last publish. A deck asking about
    // it would compare itself to that version forever and never offer another.
    for (const { typed, pkgRoot: build } of GLOBAL_NAMES) {
      const pkgRoot = build();
      expect(registryName(pkgRoot), typed).toBe("ccdeck");
      expect(markerFileName(registryName(pkgRoot)), typed).toBe(".self-update-check-ccdeck");
    }
  });

  it("reaches the answer the same way on every platform", () => {
    // The mechanism is a manifest read and path arithmetic, and neither knows
    // what platform it is on — which is the point. The name the user TYPED is
    // unreadable on Windows, where npm's .cmd/.ps1 shims never pass it on (see
    // invoked-as.mjs), so an answer that depended on the platform would be an
    // answer Windows does not get.
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      for (const os of ["win32", "linux", "darwin"]) {
        Object.defineProperty(process, "platform", { value: os, configurable: true });
        for (const { typed, pkgRoot: build, installs } of GLOBAL_NAMES) {
          const pkgRoot = build();
          expect(upgradeName(pkgRoot), `${typed} on ${os}`).toBe(installs);
          expect(registryName(pkgRoot), `${typed} on ${os}`).toBe("ccdeck");
        }
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("writes a marker name Windows will accept for each name", () => {
    // The marker is a real path under the user's home, and `/`, `\` and `:` are
    // a separator or outright illegal in a Windows file name.
    for (const name of ALIAS_PACKAGES) {
      expect(markerFileName(name), name).toMatch(/^\.self-update-check-[a-z0-9._-]+$/);
    }
  });

  it("finds no host above a Windows global prefix, so it cannot invent one", () => {
    // Where npm puts a global package on Windows. The directory above its
    // node_modules is the prefix itself, which holds no manifest — so a plain
    // global install can never be mistaken for the nested layout.
    expect(hostPackage("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\ccdeck")).toBeNull();
    expect(hostPackage("/usr/local/lib/node_modules/ccdeck")).toBeNull();
  });
});

describe("the version check, for a deck inside a retired package", () => {
  it("asks about ccdeck, caches under ccdeck, and reinstalls the package it is inside", async () => {
    // The half registryName alone cannot show: this runs a real versionReport
    // and looks at what was asked and what appeared under the home directory.
    // The registry is a stub — nothing here reaches the network — and the
    // module is imported fresh because MARKER_DIR is resolved at import time.
    const home = mkdtempSync(join(SANDBOX, "home-"));
    homeRef.dir = home;
    const was = process.env.AGENTS_DECK_NO_UPDATE_CHECK;
    delete process.env.AGENTS_DECK_NO_UPDATE_CHECK;
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      asked.push(String(url));
      if (String(url).endsWith("/dist-tags")) {
        // The retired name's tag is where its last publish left it.
        const latest = String(url).includes("/ccdeck/") ? NEXT : VERSION;
        return { ok: true, status: 200, json: async () => ({ latest }) };
      }
      return { ok: true, status: 200, json: async () => ({ name: "ccdeck", version: NEXT }) };
    }));
    try {
      vi.resetModules();
      const mod = await import("../../server/self-update.mjs") as unknown as {
        versionReport: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const pkgRoot = layout("stub", { host: "agent-dag", pkg: "ccdeck" });
      const report = await mod.versionReport({ running: VERSION, pkgRoot });

      expect(report.latest).toBe(NEXT);
      expect(report.notice).toEqual({ kind: "upgrade", from: VERSION, to: NEXT });
      expect(report.command).toBe("npm i -g agent-dag@latest");
      expect(asked).toContain("https://registry.npmjs.org/-/package/ccdeck/dist-tags");
      expect(asked.some(u => u.includes("agent-dag"))).toBe(false);

      expect(existsSync(join(home, ".agents-deck", ".self-update-check-ccdeck"))).toBe(true);
      expect(existsSync(join(home, ".agents-deck", ".self-update-check-agent-dag"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      homeRef.dir = null;
      if (was === undefined) delete process.env.AGENTS_DECK_NO_UPDATE_CHECK;
      else process.env.AGENTS_DECK_NO_UPDATE_CHECK = was;
    }
  });
});

describe("npx, checkouts, and somebody else's project", () => {
  it("re-runs ccdeck through npx, whichever name was typed", () => {
    // npx unpacks each spec into its own content-addressed directory, so the
    // update IS the relaunch. `npx agents-deck` hoists ccdeck beside the old
    // package, and relaunching `agents-deck@latest` would resolve to that same
    // last-published package and reuse the cached copy — so it relaunches as
    // ccdeck.
    for (const typed of ALIAS_PACKAGES) {
      const pkgRoot = layout("npx", { host: typed, pkg: "ccdeck" });
      expect(upgradeName(pkgRoot), typed).toBe("ccdeck");
      expect(upgradeCommand(pkgRoot), typed).toBe("npx -y ccdeck@latest");
      expect(upgradeMode(upgradeBlock(pkgRoot)), typed).toBe("npx");
      expect(startUpgrade({ pkgRoot }), typed).toMatchObject({ ok: false, reason: "npx" });
      expect(spawns, "npx must never reach npm i -g").toHaveLength(0);
    }
  });

  it("falls back to this build's own name when the npx cache has no spec to read", () => {
    // The metadata is the better answer and is missing here, so what is left is
    // the manifest — and a retired name there still relaunches as ccdeck.
    for (const name of ALIAS_PACKAGES) {
      const cache = mkdtempSync(join(SANDBOX, "npx-bare-"));
      const bare = join(cache, "_npx", "9a1c", "node_modules", name);
      mkdirSync(bare, { recursive: true });
      writeFileSync(join(bare, "package.json"), JSON.stringify({ name, version: VERSION }));
      expect(upgradeName(bare), name).toBe("ccdeck");
      expect(upgradeCommand(bare), name).toBe("npx -y ccdeck@latest");
    }
  });

  for (const [what, worktree] of GIT_SHAPES) {
    it(`still tells ${what} to pull, and installs nothing over the working copy`, () => {
      const pkgRoot = layout("checkout", { worktree });
      expect(upgradeName(pkgRoot)).toBe("ccdeck");
      expect(upgradeCommand(pkgRoot)).toBe("git pull && npm run build");
      expect(startUpgrade({ pkgRoot })).toMatchObject({ ok: false, reason: "git_checkout" });
      expect(spawns).toHaveLength(0);
    });

    it(`says the same about ${what} that happens to sit inside a node_modules`, () => {
      // A checkout linked into a project — `npm link`, or a workspace — is still
      // the maintainer's own tree, and the git test has to outrank both the
      // layout rule and the manifest one.
      const pkgRoot = layout("stub", { host: "agents-deck", pkg: "ccdeck" });
      plantDotGit(pkgRoot, worktree);
      expect(upgradeName(pkgRoot)).toBe("ccdeck");
      expect(upgradeCommand(pkgRoot)).toBe("git pull && npm run build");
    });
  }

  it("refuses to name somebody else's project, whatever the layout looks like", () => {
    // A workspace, a CI job or a tool that embeds the deck puts it in exactly
    // the nested shape on disk, and `npm i -g their-app@latest` is a package
    // the deck has no business installing.
    const pkgRoot = layout("project", { host: "my-app", pkg: "ccdeck" });
    expect(upgradeName(pkgRoot)).toBe("ccdeck");
    expect(npmArgv(pkgRoot)[2]).toBe("ccdeck@latest");
  });
});

describe("the manifest this all reads", () => {
  it("answers with the name in it, when that is one of ours", () => {
    for (const name of ALIAS_PACKAGES) {
      expect(installedName(layout("global", { pkg: name })), name).toBe(name);
    }
  });

  it("falls back to ccdeck rather than handing npm a name nothing vouched for", () => {
    // The answer becomes an argument in the `npm i -g` this process spawns, so
    // it is confined to our own names — a directory on disk must not be able to
    // name a fourth package for npm to fetch.
    const foreign = layout("global", { pkg: "evil-package" });
    expect(installedName(foreign)).toBe("ccdeck");
    expect(upgradeName(foreign)).toBe("ccdeck");
    expect(upgradeCommand(foreign)).toBe("npm i -g ccdeck@latest");
    // And the caller's own fallback is what it falls back TO, so a caller that
    // knows better than the disk still wins.
    expect(installedName(foreign, "agent-dag")).toBe("agent-dag");
  });

  it("survives a manifest that is missing, unreadable or not an object", () => {
    const pkgRoot = layout("global", { pkg: "ccdeck" });
    const manifest = join(pkgRoot, "package.json");
    for (const body of ["", "{", "null", '"ccdeck"', "[]", '{"name":42}', '{"version":"1.0.0"}']) {
      writeFileSync(manifest, body);
      expect(installedName(pkgRoot), body).toBe("ccdeck");
      expect(upgradeName(pkgRoot), body).toBe("ccdeck");
    }
    rmSync(manifest);
    expect(installedName(pkgRoot)).toBe("ccdeck");
    // And a directory that is not a path at all is not a name either.
    expect(installedName(null)).toBe("ccdeck");
    expect(installedName(undefined)).toBe("ccdeck");
    expect(installedName("")).toBe("ccdeck");
  });

  it("matches what this repo actually ships", () => {
    // The premise everything above rests on: the manifest names the published
    // package, so a global install of this tarball reads `ccdeck` off disk, and
    // the only command it provides is that one.
    const manifest = JSON.parse(read("package.json"));
    expect(PUBLISHED_NAME).toBe("ccdeck");
    expect(manifest.name).toBe(PUBLISHED_NAME);
    expect(installedName(resolve(repo))).toBe("ccdeck");
    expect(Object.keys(manifest.bin)).toEqual(["ccdeck"]);
    expect([...ALIAS_PACKAGES].sort()).toEqual([PUBLISHED_NAME, ...RETIRED_NAMES].sort());
  });

  it("publishes ccdeck and nothing else", () => {
    // A retired name published again — by renaming this manifest, by a built
    // directory, or by a step somebody restored — is a second product on the
    // registry again, which is the one thing this workflow now exists to avoid.
    const publish = read(".github", "workflows", "publish.yml");
    expect([...publish.matchAll(/^\s+npm publish\b/gm)], "publish.yml runs more than one npm publish").toHaveLength(1);
    expect(publish).not.toMatch(/npm pkg set name=/);
    expect(publish).not.toContain("build-legacy");
    for (const name of RETIRED_NAMES) {
      expect(publish, name).not.toMatch(new RegExp(`Publish to npm \\(${name}`));
    }
  });
});
