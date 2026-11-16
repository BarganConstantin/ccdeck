// The deck's answer to the New session picker's question (internal #106): can
// an agent start in this folder? On real folders in a scratch directory: one
// that is there, one that went away, a file and a path that is not full; one
// this account may not open by the system's own answer. It never lists or
// reads what a folder holds.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs server module, no types
import { FOLDER_PROBLEMS, checkFolder, trimFolder } from "../../server/terminal-folder.mjs";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-terminal-folder-"));
const PROJECT = join(DIR, "project");
mkdirSync(PROJECT);
writeFileSync(join(DIR, "a-file"), "x");
afterAll(() => rmTempDir(DIR));

describe("checkFolder", () => {
  it("says yes for a folder an agent can work in, trimmed of a trailing separator and nothing else", async () => {
    expect(await checkFolder(PROJECT)).toEqual({ ok: true, cwd: PROJECT });
    expect(await checkFolder(`${PROJECT}/`)).toEqual({ ok: true, cwd: PROJECT });
  });

  it("says why not, in one of its four words", async () => {
    expect(await checkFolder(join(DIR, "gone"))).toEqual({ ok: false, code: "missing" });
    expect(await checkFolder(join(DIR, "a-file"))).toEqual({ ok: false, code: "not-folder" });
    for (const path of ["project", "~/project", "./project", "", `${PROJECT}\n`, 42]) {
      expect(await checkFolder(path), String(path)).toEqual({ ok: false, code: "relative" });
    }
    expect(FOLDER_PROBLEMS).toEqual(["relative", "missing", "denied", "not-folder"]);
  });

  // A folder this account may not open is denied, never missing. Told by the
  // system's own answer, given here, so it runs on every leg: a real chmod
  // 000 folder denies nothing to root, nor on Windows, and would need a gate.
  // The real one is the browser QA's (a 000 folder in the lab, on Linux).
  it("tells denied from missing by the system's own answer", async () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    const dir = { isDirectory: () => true };
    // A folder inside one it may not enter: stat itself is refused.
    expect(await checkFolder("/x/inner", { statFn: async () => { throw err("EACCES"); } })).toEqual({ ok: false, code: "denied" });
    expect(await checkFolder("/x", { statFn: async () => { throw err("EPERM"); } })).toEqual({ ok: false, code: "denied" });
    expect(await checkFolder("/x", { statFn: async () => { throw err("ENOTDIR"); } })).toEqual({ ok: false, code: "missing" });
    expect(await checkFolder("/x", { statFn: async () => dir, accessFn: async () => { throw err("EACCES"); } })).toEqual({ ok: false, code: "denied" });
    expect(await checkFolder("/x", { statFn: async () => dir, accessFn: async () => undefined })).toEqual({ ok: true, cwd: "/x" });
  });
});

describe("trimFolder", () => {
  it("takes trailing separators off, and keeps a root and a drive's root", () => {
    expect(trimFolder("/srv/a//")).toBe("/srv/a");
    expect(trimFolder("/")).toBe("/");
    expect(trimFolder("C:\\work\\")).toBe("C:\\work");
    expect(trimFolder("C:\\")).toBe("C:\\");
    expect(trimFolder("C:")).toBe("C:");
    expect(trimFolder(undefined)).toBe("");
  });
});
