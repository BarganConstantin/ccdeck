// The upgrade that lands and the deck that cannot see it.
//
// `npm i -g ccdeck` performed before #340 installed a launcher package with the
// deck nested inside it:
//
//     <prefix>/lib/node_modules/ccdeck/                            the launcher
//     <prefix>/lib/node_modules/ccdeck/node_modules/agents-deck/   pkgRoot
//
// upgradeName reads the launcher's declared dependency and correctly answers
// `ccdeck`, so the in-app button runs `npm i -g ccdeck@latest`. Before #340 that
// reinstalled the launcher, which re-created the nested directory underneath it,
// and every reader downstream went on working. After #340 it installs the deck
// itself over the launcher — and npm's reify removes everything that was under
// it, including the directory the running process was started from.
//
// Nothing crashes. The modules are loaded, and on POSIX an open inode outlives
// its name. What breaks is every question answered by reading that directory
// back, and the answers were wrong in the two worst directions at once: the
// upgrade was offered again forever with no restart notice, and the prefix the
// user could plainly write to was reported as not writable.
//
// This file builds the layout on disk, deletes the nested package the way npm
// does, and pins what each reader says afterwards. Nothing is installed and npm
// is never spawned — every function under test answers from the filesystem.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  // @ts-expect-error — plain JS module, no types
  installedVersion, pickNotice, successorRoot, upgradeBlock, upgradeName,
} from "../../server/self-update.mjs";
// @ts-expect-error — plain JS module, no types
import { replacedNote } from "../../server/supervisor.mjs";

const SANDBOX = mkdtempSync(join(tmpdir(), "nested-upgrade-"));
afterAll(() => rmTempDir(SANDBOX));

const manifest = (dir: string, meta: Record<string, unknown>) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(meta));
};

/**
 * The pre-#340 global layout: a launcher named `ccdeck` that declares the deck
 * as a dependency, with the deck nested inside its node_modules.
 *
 * Returns both directories, because every assertion here is about which of the
 * two a reader consults.
 */
function nested(name: string, version = "1.43.0") {
  const prefix = mkdtempSync(join(SANDBOX, `${name}-`));
  const host = join(prefix, "lib", "node_modules", "ccdeck");
  const pkgRoot = join(host, "node_modules", "agents-deck");
  manifest(host, { name: "ccdeck", version, dependencies: { "agents-deck": version } });
  manifest(pkgRoot, { name: "agents-deck", version });
  return { host, pkgRoot };
}

/** What npm does to that layout when it installs the flat tarball over it:
 *  the launcher directory is rewritten, and everything under it goes. */
function upgradeOverIt(host: string, version: string) {
  rmTempDir(join(host, "node_modules"));
  manifest(host, { name: "ccdeck", version });   // no dependency any more
}

describe("successorRoot", () => {
  it("is null while the install is intact, so nothing changes for anyone else", () => {
    const { pkgRoot } = nested("intact");
    // The ordinary nested layout BEFORE an upgrade answers for itself. This is
    // the case that must stay untouched: it is every pre-#340 ccdeck install on
    // the planet, running normally.
    expect(successorRoot(pkgRoot)).toBeNull();
  });

  it("finds the package that replaced us once our own directory is gone", () => {
    const { host, pkgRoot } = nested("replaced");
    upgradeOverIt(host, "1.44.0");
    expect(successorRoot(pkgRoot)).toBe(host);
  });

  it("refuses a host that is not one of the three names we publish", () => {
    // The directory above us is not evidence on its own. A deck vendored into
    // somebody else's package as a dependency has a host, and that host is not
    // an upgrade of anything — answering it would report a stranger's version
    // as this install's own.
    const prefix = mkdtempSync(join(SANDBOX, "foreign-"));
    const host = join(prefix, "node_modules", "some-app");
    const pkgRoot = join(host, "node_modules", "agents-deck");
    manifest(host, { name: "some-app", version: "9.9.9" });
    mkdirSync(pkgRoot, { recursive: true });   // present, but no manifest
    expect(successorRoot(pkgRoot)).toBeNull();
  });

  it("is null when there is no host at all", () => {
    // `npm i -g agents-deck` and `npm i -g agent-dag` sit directly under the
    // global node_modules. There is nothing above them to be replaced BY.
    const prefix = mkdtempSync(join(SANDBOX, "flat-"));
    const pkgRoot = join(prefix, "lib", "node_modules", "agents-deck");
    mkdirSync(pkgRoot, { recursive: true });
    expect(successorRoot(pkgRoot)).toBeNull();
  });
});

describe("what the deck reports after that upgrade", () => {
  it("reads the new version instead of answering null", () => {
    const { host, pkgRoot } = nested("version", "1.43.0");
    expect(installedVersion(pkgRoot)).toBe("1.43.0");
    upgradeOverIt(host, "1.44.0");
    expect(installedVersion(pkgRoot)).toBe("1.44.0");
  });

  it("turns the notice into a restart rather than the same upgrade forever", () => {
    // The whole point of the module, and the thing that was lost. With
    // `installed` null, pickNotice falls to `have = running` and returns the
    // upgrade that has already been performed — every poll, with nothing on a
    // quiet deck ever moving it, and no restart prompt at any point.
    const { host, pkgRoot } = nested("notice", "1.43.0");
    upgradeOverIt(host, "1.44.0");
    const running = "1.43.0";
    const installed = installedVersion(pkgRoot);
    expect(pickNotice({ running, installed, latest: "1.44.0" }))
      .toEqual({ kind: "restart", from: "1.43.0", to: "1.44.0" });
  });

  it("stops claiming a writable npm prefix is not writable", () => {
    // upgradeBlock asks whether the tree `npm i -g` would rewrite can be
    // written. hostPackage cannot find that tree any more — the host has just
    // stopped declaring a dependency on us, which is exactly how it recognised
    // one — so the question fell back to the deleted pkgRoot and accessSync
    // answered ENOENT. The user was told their prefix was read-only.
    const { host, pkgRoot } = nested("writable", "1.43.0");
    upgradeOverIt(host, "1.44.0");
    expect(upgradeBlock(pkgRoot)).toBeNull();
  });

  it("still names ccdeck as the package to install, before and after", () => {
    // The name is the half that was already right, and it has to stay right:
    // upgradeName reads the launcher's dependency before the upgrade, and the
    // manifest's own name after it. Both answers are `ccdeck`, so the command
    // the user is shown does not change under them mid-session.
    const { host, pkgRoot } = nested("name", "1.43.0");
    expect(upgradeName(pkgRoot)).toBe("ccdeck");
    upgradeOverIt(host, "1.44.0");
    expect(upgradeName(pkgRoot)).toBe("ccdeck");
  });
});

describe("the restart that cannot follow that upgrade", () => {
  // The supervisor spawns bin/deck.js by path. After the upgrade that path is
  // gone, and the ENOENT reached the user as `could not start …/bin/deck.js`
  // plus an exit 1: a dead deck and an errno, one click after an upgrade that
  // reported success.
  //
  // The decision is pure and is handed its two filesystem answers, because the
  // state it describes only exists in a process whose own files were deleted
  // after it started — a fresh spawn cannot reach it. Trying to reproduce it by
  // deleting bin/deck.js and running the supervisor does not work either: with
  // its package.json still in place successorRoot correctly answers null, and
  // with the manifest removed node will not load the supervisor at all.

  it("says nothing while the worker is where it was", () => {
    expect(replacedNote({ workerExists: true, moved: "/anything" })).toBeNull();
  });

  it("says nothing when the worker is gone for some other reason", () => {
    // A broken or half-removed install is not this. Claiming an upgrade
    // replaced it would send the user to a directory that does not hold one,
    // and the generic spawn error is the honest answer there.
    expect(replacedNote({ workerExists: false, moved: null })).toBeNull();
  });

  it("names the directory and the command, and nothing else", () => {
    const note = replacedNote({
      workerExists: false,
      moved: "/usr/local/lib/node_modules/ccdeck",
      product: "ccdeck",
      command: "ccdeck",
    });
    expect(note).toContain("cannot restart in place");
    expect(note).toContain("/usr/local/lib/node_modules/ccdeck");
    expect(note).toContain("run `ccdeck` again");
    // Not an error the user is meant to act on by reinstalling: the install
    // already happened, which is the whole reason they are reading this.
    expect(note).not.toMatch(/npm i|reinstall|failed/i);
  });

  it("uses the command the user actually typed, not the promoted one", () => {
    // invokedAs answers null on a Windows global install and in a checkout, and
    // the caller falls back to the product name there. When it does have an
    // answer, telling an `agent-dag` user to run `ccdeck` would be telling them
    // to run a command they may not have reached for in years.
    const note = replacedNote({
      workerExists: false, moved: "/p/ccdeck", product: "ccdeck", command: "agent-dag",
    });
    expect(note).toContain("run `agent-dag` again");
  });
});
