// #1335, the third half. 3.29.4 repaired a prefs.json another user owns, and
// the Mac the issue came from still said "this deck cannot read its settings
// file" — with nothing on the screen to say WHICH of the remaining cases it was:
// a folder another user owns, a file the user owns and still cannot read, or a
// failure that has nothing to do with owners. The panel's sentence had to guess.
//
// Now the deck tells the page what blocked the read — an errno, who owns what
// blocked it, file or folder — from closed sets and never with a path, and the
// panel says the case it is in, so a screenshot is the whole bug report.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFailure } from "../components/LanSyncSection";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-prefs-detail-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
afterAll(() => rmTempDir(DIR));

// @ts-expect-error — plain .mjs server module, no types
const prefs = await import("../../server/deck-prefs.mjs");

let n = 0;
function home(): string {
  const dir = join(DIR, `deck-${n++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prefs.json"), '{"lan":{"secret":"FAKE-KEY-FOR-A-TEST"}}\n', { mode: 0o600 });
  return dir;
}

const ME = 501;
const ROOT = 0;
const fsError = (code: string) =>
  Object.assign(new Error(`${code}: fake, prefs-detail test`), { code });

/** The refusal a write throws, for a read refused with `readCode` on a file
 *  and folder owned as given. `statFile` makes the file itself un-stat-able,
 *  which is what a folder this user cannot enter does. */
async function refusal({ file = ME, folder = ME, readCode = "EACCES", statFile, noUid = false }: {
  file?: number; folder?: number; readCode?: string; statFile?: string; noUid?: boolean;
}) {
  const dir = home();
  const err = await prefs.writePrefs({ notifications: true }, dir, {
    warn: () => {},
    getuid: () => (noUid ? undefined : ME),
    readFile: async () => { throw fsError(readCode); },
    stat: async (p: string) => {
      if (p.endsWith("prefs.json")) {
        if (statFile) throw fsError(statFile);
        return { uid: file };
      }
      return { uid: folder };
    },
    rename: async () => { throw fsError("EACCES"); },
  }).then(() => null, (e: unknown) => e);
  return { dir, err };
}

describe("what the deck tells the page about a read it was refused", () => {
  it("a folder another user owns", async () => {
    const { err } = await refusal({ folder: ROOT, statFile: "EACCES" });
    expect(prefs.prefsRefusalDetail(err)).toEqual({ code: "EACCES", owner: "other", on: "folder" });
  });

  it("a folder this user owns and cannot enter", async () => {
    const { err } = await refusal({ statFile: "EACCES" });
    expect(prefs.prefsRefusalDetail(err)).toEqual({ code: "EACCES", owner: "you", on: "folder" });
  });

  it("a file this user owns and still cannot read", async () => {
    const { err } = await refusal({ readCode: "EPERM" });
    expect(prefs.prefsRefusalDetail(err)).toEqual({ code: "EPERM", owner: "you", on: "file" });
  });

  it("a file another user owns that could not be moved aside", async () => {
    const { err } = await refusal({ file: ROOT });
    expect(prefs.prefsRefusalDetail(err)).toEqual({ code: "EACCES", owner: "other", on: "file" });
  });

  it("a failure that is not about owners, and one where there is no uid", async () => {
    const { err: io } = await refusal({ readCode: "EMFILE", file: ROOT });
    expect(prefs.prefsRefusalDetail(io)).toEqual({ code: "EMFILE", owner: "unknown", on: "file" });
    const { err: win } = await refusal({ noUid: true });
    expect(prefs.prefsRefusalDetail(win)).toEqual({ code: "EACCES", owner: "unknown", on: "file" });
  });

  it("a file that is not JSON and could not be moved aside", async () => {
    const dir = home();
    writeFileSync(join(dir, "prefs.json"), "{ truncated", { mode: 0o600 });
    const err = await prefs.writePrefs({ notifications: true }, dir, {
      warn: () => {},
      rename: async () => { throw fsError("EPERM"); },
    }).then(() => null, (e: unknown) => e);
    expect(prefs.prefsRefusalDetail(err)).toEqual({ code: "BADJSON", owner: "unknown", on: "file" });
  });

  it("a folder the write itself was refused", () => {
    expect(prefs.prefsRefusalDetail(fsError("EROFS"))).toEqual({ code: "EROFS", owner: "unknown", on: "folder" });
  });

  it("nothing, for a failure that is not a refusal", () => {
    expect(prefs.prefsRefusalDetail(new Error("a bug"))).toBeNull();
    expect(prefs.prefsRefusalDetail(undefined)).toBeNull();
  });

  it("never the path, the uid or anything outside its closed sets", async () => {
    const { dir, err } = await refusal({ folder: ROOT, statFile: "EACCES" });
    const sent = JSON.stringify(prefs.prefsRefusalDetail(err));
    expect(sent).not.toContain(dir);
    expect(sent).not.toContain(DIR);
    // A refusal carrying something no read here produces is cut down, not echoed.
    const forged = Object.assign(fsError("PREFS_UNREADABLE"), {
      blocked: { code: `/Users/someone/${"x".repeat(40)}`, owner: "root", on: "disk" },
    });
    expect(prefs.prefsRefusalDetail(forged)).toEqual({ code: "", owner: "unknown", on: "file" });
  });
});

describe("what the panel says with it", () => {
  const say = (detail: object) =>
    writeFailure("share that account", { ok: false, reason: "prefs_unreadable", detail });

  it("names the case it is in, and the errno", () => {
    const folder = say({ code: "EACCES", owner: "other", on: "folder" });
    expect(folder).toMatch(/settings folder, which belongs to another user/);
    expect(folder).toMatch(/sudo/);
    expect(folder).toMatch(/Error code: EACCES\.$/);

    const yours = say({ code: "EPERM", owner: "you", on: "file" });
    expect(yours).toMatch(/although the file is yours/);
    expect(yours).toMatch(/Error code: EPERM\.$/);

    const other = say({ code: "EACCES", owner: "other", on: "file" });
    expect(other).toMatch(/belongs to another user and could not be moved aside/);
  });

  it("does not blame sudo when the owner is not the problem", () => {
    for (const detail of [
      { code: "EPERM", owner: "you", on: "file" },
      { code: "EMFILE", owner: "unknown", on: "file" },
      { code: "BADJSON", owner: "unknown", on: "file" },
    ]) {
      expect(say(detail), detail.code).not.toMatch(/sudo/);
    }
    expect(say({ code: "BADJSON", owner: "unknown", on: "file" })).toMatch(/damaged/);
    expect(say({ code: "BADJSON", owner: "unknown", on: "file" })).not.toMatch(/Error code/);
  });

  it("keeps the general sentence, plus the errno, when it cannot say more", () => {
    const general = writeFailure("share that account", { ok: false, reason: "prefs_unreadable" });
    const unknown = say({ code: "EACCES", owner: "unknown", on: "file" });
    expect(unknown).toBe(`${general} Error code: EACCES.`);
    // And a deck older than this, which sends no detail, reads exactly as before.
    expect(general).toMatch(/may belong to another user/);
  });

  it("adds the errno to a write the folder refused", () => {
    const said = writeFailure("share that account", {
      ok: false, reason: "prefs_not_writable", detail: { code: "EROFS", owner: "unknown", on: "folder" },
    });
    expect(said).toMatch(/not allowed to save its settings/);
    expect(said).toMatch(/Error code: EROFS\.$/);
  });
});
