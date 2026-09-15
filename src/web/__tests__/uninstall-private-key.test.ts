// Reported (#959): `ccdeck --uninstall` leaves the deck's LAN private key on the
// machine and says nothing about it.
//
// WHAT WAS OBSERVED. A sandboxed HOME with a synthetic prefs.json in both places
// the deck keeps one, then the real CLI:
//
//     $ ccdeck --uninstall
//     ccdeck: no Claude hooks to remove
//     $ echo $?
//     0
//
// That is the whole output. Both files were still on the disk afterwards, both
// still holding `lan.secret`, and the command had exited 0 — while the README's
// uninstall paragraph told the reader that deleting `~/.claude/agent-dag/` and
// `~/.agents-deck/` "clears ccdeck's own files". Somebody who followed that to
// the letter believed the machine was clean.
//
// WHY THAT FILE IS DIFFERENT FROM THE REST OF WHAT AN UNINSTALL LEAVES. The
// event log and the port registry are data somebody may still want, and the
// command is deliberately narrow about them. `prefs.json` is not data: it holds
// this deck's LAN private key — deck-home.mjs names the 0600 mode as
// load-bearing and calls it "the one file with a private key in it" — and every
// deck paired with this one has PINNED that key. A credential that outlives the
// uninstall is a different class of thing from a log that does.
//
// AND IT IS IN TWO PLACES, which is the part nobody could have guessed from the
// documentation. `migrateDeckFiles` moved prefs.json to the platform data
// directory by COPYING it and leaving the original in `~/.claude/agent-dag`, on
// purpose, so a downgrade finds what it had. So an upgraded machine has the key
// twice and deleting one copy is not deleting the key.
//
// The rules these cases hold, in the order they matter:
//
//   1. `--uninstall` NAMES every file that still holds the key, resolved for
//      this machine, on a command that otherwise prints one line.
//   2. It does not delete them. prefs.json also holds the pairings and the
//      aliases, and a command documented as "hook entries only" deleting the
//      user's settings is a second complaint of the same size.
//   3. `--purge` deletes them, and says which.
//   4. Neither one ever prints the secret. The fix for "nobody knows where the
//      key is" must not be "the key is on the terminal".
//   5. A prefs.json with no key in it is not announced as holding one. Telling
//      somebody their private key is on the machine when it is not is the same
//      defect pointing the other way.
//
// The CLI is driven for real, in a child process, with every path pointed at a
// temp directory — the same shape uninstall-sound-hook.test.ts uses, and for
// the same reason: this is a command about where files are, so a fake
// filesystem would be testing the fake.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// Every path the deck resolves, pointed inside a temp directory BEFORE anything
// is imported: HOME and USERPROFILE for `os.homedir()` on either platform,
// CLAUDE_CONFIG_DIR for the legacy directory, and CCDECK_HOME for the platform
// data directory. The last one is what makes the two locations DIFFERENT here:
// with only CLAUDE_CONFIG_DIR set, `deckDataDir` deliberately answers the legacy
// directory, and the two-copy case this file is about would collapse to one.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-959-"));
const FAKE_CLAUDE = join(SANDBOX, ".claude");
const LEGACY_DIR = join(FAKE_CLAUDE, "agent-dag");
const DATA_DIR = join(SANDBOX, "deck-data");

const CHILD_ENV = {
  ...process.env,
  HOME: SANDBOX,
  USERPROFILE: SANDBOX,
  CLAUDE_CONFIG_DIR: FAKE_CLAUDE,
  CCDECK_HOME: DATA_DIR,
  // Nothing here should reach the network, and an uninstall does not start the
  // LAN listener anyway — set for the same reason the sandbox paths are.
  AGENTS_DECK_NO_LAN: "1",
};

// @ts-expect-error — .mjs server module, no types
const purgeMod = await import("../../server/purge-key.mjs");
const { keyDirs, findKeyFiles, purgeKeyFiles, KEY_FILE } = purgeMod;

// Belt and braces, the way uninstall-sound-hook.test.ts does it. If the module
// ever stopped honouring the environment this file would be listing — and then
// deleting — the developer's own prefs.json, so fail before a case gets the
// chance.
{
  const resolved = keyDirs({ env: CHILD_ENV, home: SANDBOX });
  for (const d of resolved) {
    if (!String(d).startsWith(SANDBOX)) {
      throw new Error(`refusing to run: resolved ${d}, outside ${SANDBOX}`);
    }
  }
}

const DECK_CLI = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));

/** The synthetic key. Not a real one and not shaped like one on purpose: what
 *  the cases assert about it is that it never reaches a terminal, and a value
 *  that is obviously a fixture makes a failure readable. */
const FAKE_SECRET = "SYNTHETIC-KEY-NOT-A-REAL-ONE";

const prefsWith = (secret: string) => JSON.stringify({
  notifications: false,
  autoUpdate: true,
  lan: { enabled: true, name: "sandbox", secret, shared: [], manual: [], trusted: [], port: 0 },
}, null, 2) + "\n";

const legacyPrefs = join(LEGACY_DIR, "prefs.json");
const dataPrefs = join(DATA_DIR, "prefs.json");

/** Run the real CLI. Returns stdout+stderr together and the exit code, because
 *  which stream a line went to is not what any of these cases is about. */
function runDeck(args: string[]) {
  try {
    const out = execFileSync(process.execPath, [DECK_CLI, ...args], {
      env: CHILD_ENV, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? -1 };
  }
}

beforeEach(() => {
  // `rmTempDir`, not a bare `rmSync`: the case before this one ran a child
  // process that had those very files open, and on Windows a name whose last
  // handle is still closing answers EPERM to the lstat `rm -r` does on its way
  // in. rm-temp-dir.ts paid for that knowledge twice.
  rmTempDir(LEGACY_DIR);
  rmTempDir(DATA_DIR);
  mkdirSync(LEGACY_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
});

afterAll(() => { rmTempDir(SANDBOX); });

describe("where the deck's private key is, resolved rather than described", () => {
  it("looks in both places, and says so only once when they are the same place", () => {
    const two = keyDirs({ env: CHILD_ENV, home: SANDBOX });
    expect(two).toContain(DATA_DIR);
    expect(two).toContain(LEGACY_DIR);
    expect(two).toHaveLength(2);

    // A machine with CLAUDE_CONFIG_DIR set and no CCDECK_HOME is ONE directory:
    // deck-home.mjs answers the legacy path for those people deliberately, so
    // they keep the profile they have. Reporting it twice would tell somebody
    // there are two copies of their key when there is one.
    const noCcdeckHome: Record<string, string | undefined> = { ...CHILD_ENV };
    delete noCcdeckHome.CCDECK_HOME;
    const one = keyDirs({ env: noCcdeckHome, home: SANDBOX });
    expect(one).toEqual([LEGACY_DIR]);
  });

  it("reports a file it cannot parse as unknown, never as key-free", async () => {
    // The direction this has to fail in. A prefs.json truncated by a power cut
    // is exactly the file nobody can rule a key out of — so it is offered for
    // removal like one that plainly has a key. The opposite reading would have
    // an uninstall skip the very file that was damaged while holding it.
    writeFileSync(dataPrefs, prefsWith(FAKE_SECRET).slice(0, 40));
    // The BOM written as an escape, never as the byte itself — see
    // source-nul-bytes.test.ts for what an invisible character does to grep.
    writeFileSync(legacyPrefs, `\uFEFF${prefsWith("")}`);

    const found: Array<{ path: string; holds: string }> = await findKeyFiles([DATA_DIR, LEGACY_DIR]);
    expect(found.find(f => f.path === dataPrefs)?.holds).toBe("unknown");
    // And the BOM is not damage: Notepad and `Set-Content` write one, and
    // installer.mjs has stripped it off settings.json since it was written. A
    // file that parses with no secret in it is "no-key", not "unknown".
    expect(found.find(f => f.path === legacyPrefs)?.holds).toBe("no-key");
  });

  it("does not list a file that is not there at all", async () => {
    // ENOENT is the ordinary answer on a machine where the deck never ran, and
    // an uninstall that announces the absence of a file is noise at the moment
    // somebody least wants it.
    expect(await findKeyFiles([DATA_DIR, LEGACY_DIR])).toEqual([]);
    expect(KEY_FILE).toBe("prefs.json");
  });
});

describe("`--uninstall`, on a machine that still has the key", () => {
  it("names both copies and deletes neither", () => {
    writeFileSync(dataPrefs, prefsWith(FAKE_SECRET));
    writeFileSync(legacyPrefs, prefsWith(FAKE_SECRET));

    const { out, code } = runDeck(["--uninstall"]);

    expect(code).toBe(0);
    // Resolved paths, not a description of where to look. The whole defect was
    // a document naming a directory that no longer held the file.
    expect(out).toContain(dataPrefs);
    expect(out).toContain(legacyPrefs);
    expect(out).toMatch(/private key/i);
    // Untouched: this command is still "hook entries only" about everything it
    // was before, and prefs.json holds the pairings and the aliases too.
    expect(existsSync(dataPrefs)).toBe(true);
    expect(existsSync(legacyPrefs)).toBe(true);
    // And it tells the reader the one thing they cannot work out: the command.
    expect(out).toContain("--purge");
  });

  it("never prints the key it is telling you about", () => {
    // The failure mode of the fix itself. `--uninstall` output is pasted into
    // bug reports; a command that answered "your key is <key>" would have made
    // a leak out of a disclosure.
    writeFileSync(dataPrefs, prefsWith(FAKE_SECRET));

    const { out } = runDeck(["--uninstall"]);
    expect(out).toContain(dataPrefs);
    expect(out).not.toContain(FAKE_SECRET);
  });

  it("says nothing about a private key when there is no key in the file", () => {
    // A deck that never turned LAN sync on. Telling somebody their private key
    // is on the machine when it is not is the same defect as the silence,
    // pointing the other way — and it is the version that gets ignored.
    writeFileSync(dataPrefs, prefsWith(""));

    const { out, code } = runDeck(["--uninstall"]);
    expect(code).toBe(0);
    expect(out).not.toMatch(/private key/i);
    expect(out).not.toContain(dataPrefs);
  });
});

describe("`--purge`, which is the sentence somebody types when they mean it", () => {
  it("removes every copy and names each one it removed", () => {
    writeFileSync(dataPrefs, prefsWith(FAKE_SECRET));
    writeFileSync(legacyPrefs, prefsWith(FAKE_SECRET));

    const { out, code } = runDeck(["--uninstall", "--purge"]);

    expect(code).toBe(0);
    expect(existsSync(dataPrefs)).toBe(false);
    expect(existsSync(legacyPrefs)).toBe(false);
    expect(out).toContain(`removed ${dataPrefs}`);
    expect(out).toContain(`removed ${legacyPrefs}`);
    expect(out).not.toContain(FAKE_SECRET);
  });

  it("runs the uninstall too, rather than only the deletion", () => {
    // `--purge` alone is `--uninstall --purge`. It is registered as a one-shot
    // for that reason: a flag that detached would print where somebody's
    // private key is into a log file and hand the terminal back empty.
    writeFileSync(dataPrefs, prefsWith(FAKE_SECRET));

    const { out, code } = runDeck(["--purge"]);
    expect(code).toBe(0);
    expect(existsSync(dataPrefs)).toBe(false);
    // The hook half still ran and still reported.
    expect(out).toMatch(/hooks/);
  });

  it("is quiet, and still succeeds, when there was nothing to remove", () => {
    const { out, code } = runDeck(["--uninstall", "--purge"]);
    expect(code).toBe(0);
    expect(out).toMatch(/no ccdeck state to purge/i);
  });

  it("reports a file it could not remove rather than claiming it went", async () => {
    // Driven through the module rather than the CLI, because producing a real
    // undeletable file means a platform-specific trick (a read-only parent on
    // POSIX, a held handle on Windows) and the rule being pinned is about the
    // SHAPE of the answer: a failure is reported with its path, never folded
    // into the removals.
    const boom = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    const res = await purgeKeyFiles(
      [{ path: dataPrefs }, { path: legacyPrefs }],
      { rm: async (p: string) => { if (p === dataPrefs) throw boom; } },
    );
    expect(res.removed).toEqual([legacyPrefs]);
    expect(res.failed).toEqual([{ path: dataPrefs, why: boom.message }]);
  });
});

describe("the documentation the reader is standing in when they type it", () => {
  const help = () => runDeck(["--help"]).out;

  it("names --purge in the shipped --help, beside --uninstall", () => {
    // The third of the three stale passages #959 lists is this text. It read
    // "the forwarder script, ~/.claude/agent-dag/, the events log … all stay"
    // and never mentioned that one of the things staying was a private key.
    const text = help();
    expect(text).toContain("--purge");
    expect(text).toMatch(/private key/i);
  });

  it("names it in the README's Options block too, where the flag list is scanned", () => {
    const readme = readFileSync(
      fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
    const block = readme.slice(readme.indexOf("## Options"), readme.indexOf("Anything else on the command line"));
    expect(block).toContain("--purge ");
  });
});
