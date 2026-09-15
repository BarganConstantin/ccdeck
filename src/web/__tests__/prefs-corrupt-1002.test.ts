// A truncated prefs.json was read as "nothing chosen yet" and then written over,
// and prefs.json is where this deck's LAN identity lives.
//
// #1002. `readPrefs` caught every failure the same way — `catch { return
// { ...DEFAULTS }; }` — which is a defensible answer to a question about VALUES
// and a catastrophic one as the merge base of a write, because `writePrefs`
// asked it that question on every single write. So a file that merely failed to
// parse was not just unread: it was replaced by defaults on the next write, and
// the LAN merge that exists to PRESERVE what a page did not send preserved
// nothing.
//
// WHAT WAS OBSERVED, end to end, against a prefs.json truncated the way a power
// cut between the write and the rename leaves one — 407 of 497 bytes, with the
// key, both pairings, both shared accounts and the dialled address all still
// legible in what remained:
//
//   boot 1 (whole file)    GET /api/prefs -> trusted: laptop, desktop;
//                          shared: acct-1, acct-2; manual: 10.0.0.5:4318
//   truncate
//   boot 2 (407 bytes)     GET /api/prefs -> trusted: []; shared: []; manual: []
//   one POST /api/prefs {"notifications":true} later
//   on disk                every one of those fields at its default, the
//                          recoverable bytes gone, nothing on stderr
//
// The next write is not hypothetical either, and nobody has to press anything
// for it: the empty `lan.secret` reads as "no identity yet", so the boot's own
// `onIdentity` generates a new key and calls `writePrefs({ lan: { secret } })`.
// The file that could have been repaired by hand is overwritten before anybody
// can look at it, every peer that pinned this deck has to accept it again, and
// nothing on stderr, in the log or in the panel says why.
//
// The rule these cases hold down: ENOENT — and only ENOENT — is a fresh start.
// Anything else is a file whose contents cannot be re-derived, so it is moved
// aside and named out loud before anything can merge over it, and a write that
// cannot even do that refuses rather than land.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-prefs-corrupt-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
afterAll(() => rmTempDir(DIR));

// @ts-expect-error — plain .mjs server module, no types
const prefs = await import("../../server/deck-prefs.mjs");
// @ts-expect-error — ditto; the real temp-file maker, wrapped below
const { createTemp } = await import("../../server/installer.mjs");

/** A deck home of its own per case, so one quarantine cannot be another's. */
let n = 0;
function homeWith(body: string | null): string {
  const home = join(DIR, `deck-${n++}`);
  mkdirSync(home, { recursive: true });
  if (body !== null) writeFileSync(join(home, "prefs.json"), body, { mode: 0o600 });
  return home;
}

/** A whole, healthy prefs.json: a key, two pairings, two shared accounts and an
 *  address somebody typed. Every field here is one a truncation loses. */
const WHOLE = JSON.stringify({
  notifications: true,
  autoUpdate: false,
  lan: {
    enabled: true, name: "sandbox-deck", secret: "FAKE-KEY-FOR-A-TEST",
    shared: ["acct-1", "acct-2"], manual: ["10.0.0.5:4318"],
    trusted: [
      { fp: "aaa-bbb-ccc-ddd", pub: "FAKE-PUB-1", name: "laptop" },
      { fp: "eee-fff-000-111", pub: "FAKE-PUB-2", name: "desktop" },
    ],
    port: 4318,
  },
}, null, 2) + "\n";

/** The same file with its tail lost, which is what a machine that died between
 *  the write and the rename leaves: still-legible settings, unparseable JSON.
 *  Cut at `port` so everything that makes the file worth rescuing — the key,
 *  both pairings, the shared accounts, the dialled address — is in what is
 *  left, exactly as it was in the file the issue was reported against. */
const TRUNCATED = WHOLE.slice(0, WHOLE.lastIndexOf(`"port"`));

const sidecars = (home: string) => readdirSync(home).filter(f => f.includes(".corrupt-"));
const said = () => {
  const lines: string[] = [];
  return { warn: (line: string) => lines.push(line), lines };
};

/** An fs failure shaped the way `node:fs/promises` raises one — `code` and all,
 *  which is the field the read now turns on. */
const fsError = (code: string) =>
  Object.assign(new Error(`${code}: fake, prefs-corrupt test`), { code });

describe("a prefs.json that cannot be parsed", () => {
  it("is kept, rather than replaced by the defaults on the next write", async () => {
    const home = homeWith(TRUNCATED);
    const log = said();

    await prefs.writePrefs({ notifications: true }, home, { warn: log.warn });

    // The bytes the truncation left are still on disk, unchanged, under a name
    // nothing else writes. Byte-identical rather than merely present: a copy
    // that had been through JSON.parse would not carry the fields that made the
    // file worth keeping.
    const [kept] = sidecars(home);
    expect(kept, "nothing was kept").toBeTruthy();
    const rescued = readFileSync(join(home, kept), "utf8");
    expect(rescued).toBe(TRUNCATED);
    // And each of the things the old path destroyed is still recoverable from
    // it by hand, which is the whole reason for keeping it. Named one by one
    // rather than as a byte count, because the byte count is the part nobody
    // would notice going wrong.
    for (const lost of ["FAKE-KEY-FOR-A-TEST", "laptop", "desktop", "acct-1", "10.0.0.5:4318"]) {
      expect(rescued, lost).toContain(lost);
    }
    // And none of it is in the file the deck went on to write, which is what
    // makes the sidecar the only copy there is.
    expect(readFileSync(prefs.prefsPath(home), "utf8")).not.toContain("FAKE-KEY-FOR-A-TEST");
  });

  it("says so on stderr, naming both the file and where it went", async () => {
    // Silence is half the defect: the old path destroyed the identity every
    // paired machine had pinned and printed nothing anywhere, so the first sign
    // was a colleague's deck no longer recognising this one.
    const home = homeWith(TRUNCATED);
    const log = said();

    await prefs.readPrefs(home, { warn: log.warn });

    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain(prefs.prefsPath(home));
    expect(log.lines[0]).toContain(join(home, sidecars(home)[0]));
  });

  it("moves it aside on the READ, before any write can merge over it", async () => {
    // The ordering is the fix. `writePrefs` takes its merge base from this same
    // read, and the boot's identity write is the one that used to land first —
    // so a read that leaves the damaged file in place has already lost the race
    // however carefully the write behaves afterwards.
    const home = homeWith(TRUNCATED);

    const { prefs: values, source, quarantined } = await prefs.loadPrefs(home, { warn: () => {} });

    expect(source).toBe("corrupt");
    expect(quarantined).toBe(join(home, sidecars(home)[0]));
    expect(values.lan.secret).toBe("");
    // The name is prefs.json's plus `.corrupt-<ms>`: it sits beside the file it
    // came from so nobody has to be told where to look, and the stamp is
    // milliseconds rather than an ISO timestamp because an ISO timestamp has
    // colons in it, Windows forbids those in a filename, and a quarantine that
    // cannot be created on one of the platforms it protects is not a quarantine.
    //
    // ON THE BASENAME, and the first version of this was not — it asked whether
    // the whole PATH held a colon, which every absolute Windows path does
    // (`C:\Users\RUNNER~1\AppData\Local\Temp\…`), so it went red on the
    // windows-latest runner for exactly the reason the rule exists. Do not
    // re-scope it back to the path. The set is every character Windows forbids
    // in a filename rather than the colon alone, because the rule being
    // protected is "a name that file system will accept", and `Date.now()` is
    // only one of the ways a future edit could stop satisfying it.
    const WINDOWS_FORBIDS = /[<>:"\/\\|?*]/;
    // Not vacuous: the ISO spelling this rule rejects is caught by it.
    expect("prefs.json.corrupt-2026-09-15T05:12:00.000Z").toMatch(WINDOWS_FORBIDS);

    expect(prefs.quarantinePath(home, 1_700_000_000_000))
      .toBe(`${prefs.prefsPath(home)}.corrupt-1700000000000`);
    expect(basename(quarantined)).not.toMatch(WINDOWS_FORBIDS);
  });

  it.skipIf(process.platform === "win32")("keeps it readable by nobody else", async () => {
    // It still holds the private key. A quarantine that widened the mode would
    // hand it to every other account on a shared machine, which is the thing
    // PREFS_MODE exists to prevent and is not less true of a copy.
    const home = homeWith(TRUNCATED);

    await prefs.readPrefs(home, { warn: () => {} });

    expect(statSync(join(home, sidecars(home)[0])).mode & 0o077).toBe(0);
  });

  it("lets the deck start clean once those bytes are safe", async () => {
    // Quarantining is not refusing. The deck still has to run, take a new
    // identity and pair again — what it must not do is destroy the old one on
    // the way, and the file it starts is a normal one.
    const home = homeWith(TRUNCATED);

    const written = await prefs.writePrefs({ notifications: true }, home, { warn: () => {} });

    expect(written.notifications).toBe(true);
    expect(JSON.parse(readFileSync(prefs.prefsPath(home), "utf8")).notifications).toBe(true);
    expect((await prefs.readPrefs(home, { warn: () => {} })).notifications).toBe(true);
  });
});

describe("the three other things a read can find", () => {
  it("treats a file that is simply not there as a fresh start, silently", async () => {
    // The half that must NOT change. A first start has no prefs.json and is not
    // an event: no warning, no sidecar, just the defaults.
    const home = homeWith(null);
    const log = said();

    const { prefs: values, source, quarantined } = await prefs.loadPrefs(home, { warn: log.warn });

    expect(source).toBe("missing");
    expect(quarantined).toBe("");
    expect(values).toEqual(prefs.DEFAULTS);
    expect(log.lines).toEqual([]);
    expect(sidecars(home)).toEqual([]);
  });

  it("reads a file Notepad saved, rather than quarantining it for a BOM", async () => {
    // `Set-Content` and Notepad write UTF-8 with a byte-order mark and
    // JSON.parse throws on it, so a perfectly good hand-edited file looks
    // exactly like a truncated one from here. installer.mjs has stripped it off
    // settings.json since it was written; without the same call the fix for
    // #1002 would quarantine a file with nothing wrong with it.
    const home = homeWith("﻿" + WHOLE);
    const log = said();

    const { prefs: values, source } = await prefs.loadPrefs(home, { warn: log.warn });

    expect(source).toBe("file");
    expect(values.lan.secret).toBe("FAKE-KEY-FOR-A-TEST");
    expect(sidecars(home)).toEqual([]);
    expect(log.lines).toEqual([]);
  });

  it("refuses to write at all over a file it could not read for some other reason", async () => {
    // EACCES, EISDIR, a hardware error: the file is still there, still holding
    // the key, and still unread. Renaming it aside would be moving bytes nobody
    // has looked at, and merging onto the defaults would destroy them — so the
    // write throws and the file is left exactly as it was found. Same policy
    // installer.mjs's readSettingsForWrite applies to settings.json.
    const home = homeWith(WHOLE);
    const log = said();

    await expect(prefs.writePrefs({ notifications: true }, home, {
      warn: log.warn,
      readFile: async () => { throw fsError("EACCES"); },
    })).rejects.toMatchObject({ code: "PREFS_UNREADABLE" });

    expect(readFileSync(prefs.prefsPath(home), "utf8")).toBe(WHOLE);
    expect(sidecars(home)).toEqual([]);
    expect(log.lines.join("\n")).toContain("EACCES");
  });

  it("refuses when the damaged file could not be moved aside either", async () => {
    // The quarantine is what makes starting clean safe, so a quarantine that
    // failed is not a detail: the bytes are still in prefs.json and a write
    // would still be the thing that destroys them.
    const home = homeWith(TRUNCATED);

    await expect(prefs.writePrefs({ notifications: true }, home, {
      warn: () => {},
      rename: async () => { throw fsError("EPERM"); },
    })).rejects.toMatchObject({ code: "PREFS_UNREADABLE" });

    expect(readFileSync(prefs.prefsPath(home), "utf8")).toBe(TRUNCATED);
  });
});

describe("the temp file the key is staged through", () => {
  it("is not left behind holding the key when the write does not land", async () => {
    // A staged prefs.json is a second copy of the private key in cleartext. The
    // old writer never unlinked one, so every failed rename — a full disk, a
    // Windows share violation the ladder could not outlast — left one lying
    // there under a name derived from the pid, for the next deck to be handed
    // that pid and adopt.
    const home = homeWith(null);

    await expect(prefs.writePrefs({ lan: { secret: "FAKE-KEY-FOR-A-TEST" } }, home, {
      warn: () => {},
      rename: async () => { throw fsError("ENOSPC"); },
    })).rejects.toBeTruthy();

    expect(readdirSync(home).filter(f => f.endsWith(".tmp"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("is never readable by another account, not for an instant", async () => {
    // Measured on the real file the real `createTemp` makes, at the moment it
    // exists — a mode checked after a follow-up chmod would prove nothing about
    // the window the key is actually exposed in.
    const home = homeWith(null);
    const staged: number[] = [];

    await prefs.writePrefs({ lan: { secret: "FAKE-KEY-FOR-A-TEST" } }, home, {
      warn: () => {},
      createTemp: async (target: string, opts: { mode?: number }) => {
        const made = await createTemp(target, opts);
        staged.push(statSync(made.tmp).mode & 0o777);
        return made;
      },
    });

    expect(staged).toHaveLength(1);
    expect(staged[0] & 0o077).toBe(0);
  });

  it("comes from the installer's createTemp, which is the one that uses O_EXCL", async () => {
    // Read off the source because the property that matters cannot be seen from
    // outside: a leftover at a taken name is an EEXIST the helper handles, and
    // a plain create would adopt that file whole — keeping its permissions,
    // because open() honours the mode it is given only when it is the call that
    // creates the file. A name built from the pid alone is one a crashed run
    // can hand back to a later deck the OS gives that pid to.
    const text = readFileSync(new URL("../../server/deck-prefs.mjs", import.meta.url), "utf8");
    expect(text).toMatch(/deps\.createTemp \?\? createTemp/);
    expect(text).not.toMatch(/\$\{prefsPath\(home\)\}\.\$\{process\.pid\}/);
  });
});
