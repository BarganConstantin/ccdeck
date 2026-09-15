// The update that installs a pointer where the deck used to be.
//
// This deck has been published under three names — `ccdeck`, `agents-deck` and
// `agent-dag`. Only the first is still released; the other two stopped at
// 3.22.8, and what they stopped AT is not a deck. Read off the live registry
// while this was written:
//
//     $ npm view agents-deck@latest version dist.unpackedSize bin dependencies
//     '3.22.8'
//     5441
//     { 'agents-deck': 'shim.js' }
//     { ccdeck: '^3' }
//
//     $ npm view ccdeck@latest version dist.unpackedSize
//     '3.22.15'
//     2918701
//
// 5 KB of shim.js against 2.9 MB of deck. The shim is a good thing and it works:
// it depends on `ccdeck`, and running it spawns the deck out of its own
// node_modules. What it is not is a drop-in replacement for the DIRECTORY a
// flat install occupies.
//
// `npm i -g agents-deck` at 3.22.1 or earlier installed the deck flat:
// `<prefix>/lib/node_modules/agents-deck` WAS the deck, bin/ and src/ and hook/
// and all. Reinstalling that name now makes npm's reify empty the directory and
// write 5 KB into it. And the deck did that to itself: `autoUpdate` defaults to
// true (deck-prefs.mjs), so with no tab open and no agent mid-turn the server
// ran the install unattended. What the user got was:
//
//   · every lazy `import(join(PKG_ROOT, "src/server/…"))` throwing, so the
//     accounts, quota and Browser Watch routes started 500-ing;
//   · installedVersion reading 3.22.8 off the shim's manifest, pickNotice
//     calling it a restart, and the worker exiting 75 to get it;
//   · the supervisor spawning `<PKG_ROOT>/bin/deck.js`, which npm had just
//     deleted — `Cannot find module`, exit 1, five crash restarts over ten
//     minutes, and then `the deck has stopped 5 times in 10 minutes`.
//
// A background deck the user was not watching, gone, over a message that never
// mentions an upgrade.
//
// The guard written for exactly this could not fire. successorRoot is guarded on
// our own manifest being unreadable, and npm had left one there — the shim's —
// so it answered null, replacedNote was handed `moved: null` and stayed silent,
// and nothing between the install and the crash loop had a word to say.
//
// Two halves here. The install is refused before it can run, with the command
// that actually migrates the machine; and if one is performed by hand anyway,
// the supervisor recognises the deck one directory down and says so instead of
// spawning a corpse.
//
// Nothing in this file touches the network or the machine's npm. The registry
// answer is injected, npm is a recording fake, and every layout is built in a
// temp sandbox.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The marker lives under homedir(), and the one test here that runs a real
// versionReport would otherwise write into the ~/.agents-deck of whoever is
// running the suite. Same shape as global-alias-name.test.ts's, re-declared
// rather than imported.
const { homeRef } = vi.hoisted(() => ({ homeRef: { dir: null as string | null } }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const patched = { ...actual, homedir: () => homeRef.dir ?? actual.homedir() };
  return { ...patched, default: patched };
});

// npm is never executed. Every refusal below is asserted twice — once on what
// the function returned, and once on this array — because a refusal that
// reported itself correctly after npm had already been spawned is still the bug.
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
  frozenNameInstall, installedVersion, pickNotice, registryName, startUpgrade, successorRoot,
  // @ts-expect-error — plain JS module, no types
  upgradeBlock, upgradeCommand, upgradeMode, upgradeName,
} from "../../server/self-update.mjs";
// @ts-expect-error — plain JS module, no types
import { replacedNote } from "../../server/supervisor.mjs";
// @ts-expect-error — plain JS module, no types
import { awayUpdateStep } from "../../server/auto-update.mjs";
// @ts-expect-error — plain JS module, no types
import { installFailure } from "../../server/global-install.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));

const SANDBOX = mkdtempSync(join(tmpdir(), "frozen-name-shim-"));
afterAll(() => rmTempDir(SANDBOX));

// The version the affected population is on, and the ccdeck their check finds.
const OLD = "3.22.1";
const DECK = "3.22.15";
// The version both retired names stopped at — and therefore the version of the
// shim, which is what an install of either name writes today.
const SHIM = "3.22.8";

// No registry lookup outside the one test that stubs fetch, and no marker
// written under the real home while that is true.
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

const manifest = (dir: string, meta: Record<string, unknown>) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(meta));
};

function sandboxed(tag: string): string {
  const root = mkdtempSync(join(SANDBOX, `${tag}-`));
  // Every path below is derived from mkdtemp's answer; one wrong join would
  // have this file writing into the developer's own tree.
  if (!root.startsWith(SANDBOX)) throw new Error(`refusing to write: ${root} is outside ${SANDBOX}`);
  return root;
}

/**
 * `npm i -g agents-deck` (or agent-dag) as it worked up to 3.22.1: the deck
 * itself directly under the global node_modules, with nothing above it that is
 * a package. This directory is the whole install.
 */
function flat(name: string, version = OLD): string {
  const pkgRoot = join(sandboxed("flat"), "lib", "node_modules", name);
  manifest(pkgRoot, { name, version, bin: { ccdeck: "bin/agent-dag.js", [name]: "bin/agent-dag.js" } });
  mkdirSync(join(pkgRoot, "bin"), { recursive: true });
  writeFileSync(join(pkgRoot, "bin", "deck.js"), "// the worker\n");
  return pkgRoot;
}

/**
 * What `npm i -g <retired name>@latest` leaves behind today, applied to the
 * directory above: the deck's own files gone, the shim's manifest written where
 * the deck's was, and the real deck resolved one level down as a dependency.
 *
 * Returns where the deck went, which is the whole question the supervisor asks.
 */
function replaceWithShim(pkgRoot: string): string {
  const name = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).name as string;
  rmTempDir(join(pkgRoot, "bin"));
  manifest(pkgRoot, {
    name, version: SHIM, bin: { [name]: "shim.js" }, dependencies: { ccdeck: "^3" },
  });
  writeFileSync(join(pkgRoot, "shim.js"), "// the door to ccdeck\n");
  const deck = join(pkgRoot, "node_modules", "ccdeck");
  manifest(deck, { name: "ccdeck", version: DECK, bin: { ccdeck: "bin/agent-dag.js" } });
  mkdirSync(join(deck, "bin"), { recursive: true });
  writeFileSync(join(deck, "bin", "deck.js"), "// the worker, one level down\n");
  return deck;
}

/** The layout a fresh `npm i -g agents-deck` builds today, and the one the deck
 *  has always been fine in: the retired name is the wrapper, and the running
 *  deck is its dependency. */
function nested(host: string): string {
  const outer = join(sandboxed("nested"), "lib", "node_modules", host);
  manifest(outer, { name: host, version: SHIM, bin: { [host]: "shim.js" }, dependencies: { ccdeck: "^3" } });
  const pkgRoot = join(outer, "node_modules", "ccdeck");
  manifest(pkgRoot, { name: "ccdeck", version: DECK });
  return pkgRoot;
}

beforeEach(() => { spawns.length = 0; });

describe("a flat install of a retired name will not reinstall itself", () => {
  for (const name of ["agents-deck", "agent-dag"]) {
    it(`recognises ${name} as the package it would be replaced by`, () => {
      expect(frozenNameInstall(flat(name))).toBe(name);
    });

    it(`refuses the install and names the migration for ${name}`, () => {
      const pkgRoot = flat(name);
      // The reason is named, not merely "blocked". `not_writable` here would
      // send the user to their npm prefix, which has nothing wrong with it.
      expect(upgradeBlock(pkgRoot)).toBe("retired_name");
      // What the Update button reads. null is no button; "install" is the
      // regression, one click from emptying the directory it runs out of.
      expect(upgradeMode(upgradeBlock(pkgRoot))).toBeNull();
      expect(startUpgrade({ pkgRoot })).toMatchObject({ ok: false, reason: "retired_name" });
      expect(spawns, "a frozen name must never reach npm i -g").toHaveLength(0);
      // The removal is not decoration. The retired packages declare `ccdeck` in
      // their own bin map, so `<prefix>/bin/ccdeck` already belongs to this
      // install and `npm i -g ccdeck` on its own has a command file to link and
      // something sitting on it.
      expect(upgradeCommand(pkgRoot)).toBe(`npm rm -g ${name} && npm i -g ccdeck`);
    });

    it(`still asks npm about ccdeck for ${name}, so the user learns a release shipped`, () => {
      // The refusal is about the command, not about the question. A deck that
      // stopped checking would be a deck that never tells anybody they are
      // eleven versions behind.
      const pkgRoot = flat(name);
      expect(registryName(pkgRoot)).toBe("ccdeck");
      // And which package this install IS stays readable — `npm rm -g` needs it.
      expect(upgradeName(pkgRoot)).toBe(name);
    });
  }

  it("gives the browser a sentence for the reason, not the generic one", () => {
    // `upgradeBlocked` is a string off /api/version and the banner looks it up
    // in UPGRADE_BLOCK_TEXT; a reason with no entry renders "cannot install
    // from here", which is true of a checkout, an npx run and an unwritable
    // prefix as well and so explains none of them. Read out of the source
    // because the map is a module-level constant in a file this suite does not
    // mount, the way prototype-keys-474.test.ts reads the lookup beside it.
    const app = readFileSync(join(repo, "src", "web", "App.tsx"), "utf8");
    expect(app).toMatch(/^\s*retired_name: "[^"]+",$/m);
  });

  it("keeps the unattended path away from it too", () => {
    // autoUpdate is on by default and needs no tab, which is what turned a bad
    // command into a deck that disappeared overnight. awayUpdateStep acts on an
    // `upgrade` notice only for a mode it can actually perform, so the block
    // above is the whole of the fix for the unattended path — this pins that
    // the two are wired to each other rather than merely both correct.
    const notice = { kind: "upgrade", from: OLD, to: DECK };
    const mode = upgradeMode(upgradeBlock(flat("agents-deck")));
    expect(awayUpdateStep({ notice, mode, installing: false, lastTry: null, now: 1_000 }))
      .toMatchObject({ act: null });
    expect(spawns).toHaveLength(0);
  });

  it("reports the whole thing through /api/version, against an injected registry", async () => {
    // The end-to-end shape, with the registry answer handed in rather than
    // fetched: ccdeck's dist-tag has moved, the retired name's has not, and the
    // deck has to come out of that with a notice, no button, and a command that
    // is not the one that would delete it.
    const home = sandboxed("home");
    homeRef.dir = home;
    const was = process.env.AGENTS_DECK_NO_UPDATE_CHECK;
    delete process.env.AGENTS_DECK_NO_UPDATE_CHECK;
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      asked.push(String(url));
      if (String(url).endsWith("/dist-tags")) {
        // What the registry says today: ccdeck moves, the retired names do not.
        return { ok: true, status: 200, json: async () => ({ latest: String(url).includes("/ccdeck/") ? DECK : SHIM }) };
      }
      return { ok: true, status: 200, json: async () => ({ name: "ccdeck", version: DECK }) };
    }));
    try {
      // MARKER_DIR is resolved at import time, so the module has to be built
      // again now that homedir() answers with the sandbox.
      vi.resetModules();
      const mod = await import("../../server/self-update.mjs") as unknown as {
        versionReport: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const report = await mod.versionReport({ running: OLD, pkgRoot: flat("agents-deck") });

      expect(report.latest).toBe(DECK);
      expect(report.notice).toEqual({ kind: "upgrade", from: OLD, to: DECK });
      expect(report.upgradeBlocked).toBe("retired_name");
      expect(report.upgradeMode).toBeNull();
      expect(report.command).toBe("npm rm -g agents-deck && npm i -g ccdeck");
      // The one line that used to be here was `npm i -g agents-deck@latest`,
      // and the browser renders `command` as a copy button.
      expect(report.command).not.toMatch(/agents-deck@latest/);
      expect(asked).toContain("https://registry.npmjs.org/-/package/ccdeck/dist-tags");
      expect(spawns).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
      homeRef.dir = null;
      if (was === undefined) delete process.env.AGENTS_DECK_NO_UPDATE_CHECK;
      else process.env.AGENTS_DECK_NO_UPDATE_CHECK = was;
    }
  });
});

describe("the shapes that must keep updating exactly as they did", () => {
  it("leaves the plain ccdeck global install alone", () => {
    const pkgRoot = join(sandboxed("ccdeck"), "lib", "node_modules", "ccdeck");
    manifest(pkgRoot, { name: "ccdeck", version: DECK });
    expect(frozenNameInstall(pkgRoot)).toBeNull();
    expect(upgradeBlock(pkgRoot)).toBeNull();
    expect(upgradeCommand(pkgRoot)).toBe("npm i -g ccdeck@latest");
  });

  it("leaves a deck nested inside a retired name alone", () => {
    // The layout registryName's exception was written for, and the one a fresh
    // `npm i -g agents-deck` builds. Reinstalling the wrapper re-resolves its
    // `ccdeck@^3` to the newest deck, so that install is the right act and must
    // stay offered — the retired name here is the door, not the deck.
    for (const host of ["agents-deck", "agent-dag"]) {
      const pkgRoot = nested(host);
      expect(frozenNameInstall(pkgRoot), host).toBeNull();
      expect(upgradeBlock(pkgRoot), host).toBeNull();
      expect(upgradeCommand(pkgRoot), host).toBe(`npm i -g ${host}@latest`);
      expect(registryName(pkgRoot), host).toBe("ccdeck");
    }
  });

  it("leaves a deck vendored into somebody else's project alone", () => {
    // Identical on disk to the nested layout apart from the manifest above it,
    // and `npm i -g` from inside one writes a global tree the project never
    // reads. Whatever is wrong there, it is not answered by telling somebody to
    // uninstall a package they may not have.
    const outer = join(sandboxed("project"), "my-app");
    manifest(outer, { name: "my-app", version: "0.1.0", dependencies: { "agents-deck": "^3" } });
    const pkgRoot = join(outer, "node_modules", "agents-deck");
    manifest(pkgRoot, { name: "agents-deck", version: OLD });
    expect(frozenNameInstall(pkgRoot)).toBeNull();
  });

  it("leaves a checkout and an npx run to the rules that already own them", () => {
    // Both are refused before this in every caller, and the predicate says so
    // itself as well — a rule that is only right in the order it is asked is a
    // rule the next caller gets wrong.
    const checkout = sandboxed("checkout");
    manifest(checkout, { name: "agents-deck", version: OLD });
    mkdirSync(join(checkout, ".git"), { recursive: true });
    expect(frozenNameInstall(checkout)).toBeNull();
    expect(upgradeCommand(checkout)).toBe("git pull && npm run build");

    const npx = join(sandboxed("npx"), "_npx", "9a1c", "node_modules", "agents-deck");
    manifest(npx, { name: "agents-deck", version: OLD });
    expect(frozenNameInstall(npx)).toBeNull();
    expect(upgradeCommand(npx)).toBe("npx -y ccdeck@latest");
  });
});

describe("when the install is performed by hand anyway", () => {
  // Half two, and it reaches only decks already running this code — which is
  // why it is the second half. A user can type `npm i -g agents-deck@latest`
  // themselves at any time, and after #975 the deck should explain that rather
  // than crash-loop over it.

  it("finds the deck one directory down, where the guard used to see nothing", () => {
    const pkgRoot = flat("agents-deck");
    // Intact, and answering for itself: the state every flat install is in
    // right now, and the one that must not change.
    expect(successorRoot(pkgRoot)).toBeNull();
    const deck = replaceWithShim(pkgRoot);
    // The shim's package.json is still readable at pkgRoot, which is exactly
    // why the original guard answered null here.
    expect(successorRoot(pkgRoot)).toBe(deck);
  });

  it("wants all three facts, not a directory that merely looks like it", () => {
    // Our name retired, our manifest declaring the published name, and that
    // package really under us. A deck that vendors something, or a retired-name
    // package from before the pointer, matches none of them — and answering
    // `moved` for one of those would kill a healthy deck with a note telling it
    // to restart somewhere it is not.
    const noDep = flat("agents-deck");
    manifest(join(noDep, "node_modules", "ccdeck"), { name: "ccdeck", version: DECK });
    expect(successorRoot(noDep), "no dependency declared").toBeNull();

    const noDeck = flat("agent-dag");
    manifest(noDeck, { name: "agent-dag", version: SHIM, dependencies: { ccdeck: "^3" } });
    expect(successorRoot(noDeck), "dependency declared, nothing under us").toBeNull();

    const published = nested("agents-deck");
    expect(successorRoot(published), "the running deck is ccdeck, not a retired name").toBeNull();
  });

  it("prints the note instead of spawning the worker npm deleted", () => {
    // What the supervisor does with the two answers. `workerExists` is false
    // because bin/deck.js went with the rest of the deck; before this,
    // `moved` was null beside it and replacedNote returned null, so launch()
    // fell straight through to spawning a path that no longer existed — exit 1,
    // read as a crash, five times in ten minutes and then a deck that stays
    // down.
    const pkgRoot = flat("agents-deck");
    const deck = replaceWithShim(pkgRoot);
    const note = replacedNote({
      workerExists: false,
      moved: successorRoot(pkgRoot),
      product: "ccdeck",
      command: "agents-deck",
    });
    expect(note).toContain("cannot restart in place");
    expect(note).toContain(deck);
    // The command they actually type, which on these machines is the old name —
    // and it still works, because the shim npm just installed spawns the deck
    // sitting in the directory named above.
    expect(note).toContain("run `agents-deck` again");
  });

  it("still reads a version off the shim, and that no longer costs anything", () => {
    // Worth pinning because it is the surprising half. The manifest npm left
    // behind carries the SHIM's version, so the deck sees 3.22.8 where it was
    // running 3.22.1 and pickNotice calls that a restart. It is not wrong to
    // want a restart — the code on disk did change — and the note above is what
    // that request now meets, so nothing downstream has to unpick the number.
    const pkgRoot = flat("agents-deck");
    replaceWithShim(pkgRoot);
    expect(installedVersion(pkgRoot)).toBe(SHIM);
    expect(pickNotice({ running: OLD, installed: SHIM, latest: DECK }))
      .toEqual({ kind: "restart", from: OLD, to: SHIM });
  });
});

describe("the manual recovery, when npm refuses it", () => {
  it("names the package to remove instead of handing back npm's first line", () => {
    // `<prefix>/bin/ccdeck` is listed in the retired packages' own bin maps, so
    // on exactly these machines `npm i -g ccdeck` has a command file to link and
    // another package's file sitting on it. npm's raw complaint is an errno and
    // a path; it says nothing about which package has to come off first, and
    // this is the one command that would have got these users out.
    const said = { code: 1, stderr: "npm ERR! EEXIST: file already exists\nnpm ERR! File: /usr/local/bin/ccdeck" };
    const msg = installFailure(said, { pkg: "ccdeck" });
    expect(msg).toContain("npm rm -g agents-deck agent-dag");
    expect(msg).toContain("npm i -g ccdeck");

    // And the branches above it keep their own answers: a permission problem is
    // not solved by uninstalling anything, and saying so would send the user
    // down a road that ends in the same EACCES.
    expect(installFailure({ code: 1, stderr: "npm ERR! EACCES: permission denied" }))
      .toMatch(/global prefix/);
    expect(installFailure({ code: "ENOENT" })).toMatch(/npm is not on PATH/);
    expect(installFailure({ timedOut: true })).toMatch(/took too long/);
    // An unrelated failure still surfaces npm's own sentence rather than a
    // guess about which of these it might have been.
    expect(installFailure({ code: 1, stderr: "npm ERR! code ETARGET\nnpm ERR! notarget No matching version" }))
      .toBe("npm ERR! code ETARGET");
  });
});
