// #1335, the second half. 3.29.3 made the refusal say its name — a Mac's share
// tick now answered "this deck cannot read its settings file" — but the deck
// still could not get out of it: a prefs.json another user owns, which is what
// a `sudo ccdeck` run leaves, is refused on every read, so every settings write
// is refused, so the deck keeps nothing and takes a new LAN identity on every
// start. Nobody affected reads the log, and nobody knows how many there are.
//
// The rule these cases hold down: a file whose owner is KNOWN to be another
// user is moved aside — renamed, never read or rewritten — and the deck starts
// clean. Everything else that refuses the read still refuses the write.
//
// Ownership is faked through `deps.stat` and `deps.getuid` rather than made
// with chown, which needs root and does nothing on Windows. The rename, the
// write and the bytes on disk are all real.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-prefs-foreign-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
afterAll(() => rmTempDir(DIR));

// @ts-expect-error — plain .mjs server module, no types
const prefs = await import("../../server/deck-prefs.mjs");

let n = 0;
function homeWith(body: string): string {
  const home = join(DIR, `deck-${n++}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "prefs.json"), body, { mode: 0o600 });
  return home;
}

const WHOLE = JSON.stringify({
  notifications: false,
  lan: { enabled: true, name: "sandbox-deck", secret: "FAKE-KEY-FOR-A-TEST", shared: ["acct-1"] },
}, null, 2) + "\n";

const ME = 501;
const ROOT = 0;
const fsError = (code: string) =>
  Object.assign(new Error(`${code}: fake, prefs-foreign test`), { code });
const sidecars = (home: string) => readdirSync(home).filter(f => f.includes(".foreign-"));
const said = () => {
  const lines: string[] = [];
  return { warn: (line: string) => lines.push(line), lines };
};

/** A read that is refused the way a root-owned 0600 file refuses this user,
 *  and a stat that says who owns what. The prefs.json and its folder are told
 *  apart so the folder case can be staged on its own. */
function owned({ file, folder = ME, readCode = "EACCES", statFile }: {
  file: number; folder?: number; readCode?: string; statFile?: string;
}) {
  const log = said();
  return {
    log,
    deps: {
      warn: log.warn,
      getuid: () => ME,
      readFile: async () => { throw fsError(readCode); },
      stat: async (p: string) => {
        if (p.endsWith("prefs.json")) {
          if (statFile) throw fsError(statFile);
          return { uid: file };
        }
        return { uid: folder };
      },
    },
  };
}

describe("a prefs.json another user owns", () => {
  it("is moved aside whole, and the write that was refused lands", async () => {
    const home = homeWith(WHOLE);
    const { deps } = owned({ file: ROOT });

    const written = await prefs.writePrefs({ lan: { shared: ["acct-2"] } }, home, deps);

    // The bytes are the other user's and are kept as they were: renamed, not
    // read and rewritten, so the key in them is still there to be taken back.
    const [kept] = sidecars(home);
    expect(kept, "nothing was kept").toBeTruthy();
    expect(readFileSync(join(home, kept), "utf8")).toBe(WHOLE);
    // And the deck can keep a setting again, which is what it could not do.
    expect(written.lan.shared).toEqual(["acct-2"]);
    const now = JSON.parse(readFileSync(prefs.prefsPath(home), "utf8"));
    expect(now.lan.shared).toEqual(["acct-2"]);
    expect(now.lan.secret).not.toBe("FAKE-KEY-FOR-A-TEST");
  });

  it("is moved on the READ, so the boot's identity write cannot race it", async () => {
    const home = homeWith(WHOLE);
    const { deps } = owned({ file: ROOT });

    const { source, quarantined } = await prefs.loadPrefs(home, deps);

    expect(source).toBe("foreign");
    expect(quarantined).toBe(join(home, sidecars(home)[0]));
    expect(prefs.foreignPath(home, 1_700_000_000_000))
      .toBe(`${prefs.prefsPath(home)}.foreign-1700000000000`);
  });

  it("says so once, naming both files and how to have the old key back", async () => {
    const home = homeWith(WHOLE);
    const { deps, log } = owned({ file: ROOT });

    const { quarantined } = await prefs.loadPrefs(home, deps);

    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain(prefs.prefsPath(home));
    expect(log.lines[0]).toContain(quarantined);
    expect(log.lines[0]).toContain("uid 0");
    expect(log.lines[0]).toContain("sudo chown");
  });

  it("counts as missing when a second deck moved it first", async () => {
    const home = homeWith(WHOLE);
    const { deps, log } = owned({ file: ROOT, statFile: "ENOENT" });

    const { source } = await prefs.loadPrefs(home, deps);

    expect(source).toBe("missing");
    expect(log.lines).toEqual([]);
  });
});

describe("what is still refused, and left exactly where it is", () => {
  async function refused(home: string, deps: object) {
    await expect(prefs.writePrefs({ notifications: true }, home, deps))
      .rejects.toMatchObject({ code: "PREFS_UNREADABLE" });
    expect(readFileSync(prefs.prefsPath(home), "utf8")).toBe(WHOLE);
    expect(sidecars(home)).toEqual([]);
  }

  it("a file this user owns and still cannot read", async () => {
    const home = homeWith(WHOLE);
    await refused(home, owned({ file: ME }).deps);
  });

  it("a failure that is not a permission, whoever owns the file", async () => {
    for (const readCode of ["EISDIR", "EIO", "EMFILE"]) {
      const home = homeWith(WHOLE);
      await refused(home, owned({ file: ROOT, readCode }).deps);
    }
  });

  it("anything, where there is no uid to compare", async () => {
    // Windows: EPERM there is usually another program holding the file, and a
    // deck that moved it would be moving a healthy user's settings.
    const home = homeWith(WHOLE);
    await refused(home, { ...owned({ file: ROOT, readCode: "EPERM" }).deps, getuid: () => undefined });
  });

  it("a file another user owns that could not be moved aside either", async () => {
    const home = homeWith(WHOLE);
    const { deps, log } = owned({ file: ROOT });
    await refused(home, { ...deps, rename: async () => { throw fsError("EACCES"); } });
    expect(log.lines.join("\n")).toContain("uid 0");
  });

  it("a folder another user owns, naming the folder and the command", async () => {
    // Nothing inside a folder this user cannot enter can be looked at or
    // moved, so this one stays with the person — but the log says exactly what
    // to run rather than leaving them to guess.
    const home = homeWith(WHOLE);
    const { deps, log } = owned({ file: ROOT, folder: ROOT, statFile: "EACCES" });
    await refused(home, deps);
    const line = log.lines.join("\n");
    expect(line).toContain(home);
    expect(line).toContain("sudo chown -R");
  });
});
