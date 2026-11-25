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
import { FOLDER_PROBLEMS, UNREACHABLE, checkFolder, trimFolder } from "../../server/terminal-folder.mjs";

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

  it("says why not, in one of its five words", async () => {
    expect(await checkFolder(join(DIR, "gone"))).toEqual({ ok: false, code: "missing" });
    expect(await checkFolder(join(DIR, "a-file"))).toEqual({ ok: false, code: "not-folder" });
    for (const path of ["project", "~/project", "./project", "", `${PROJECT}\n`, 42]) {
      expect(await checkFolder(path), String(path)).toEqual({ ok: false, code: "relative" });
    }
    // CHANGED ON PURPOSE (folder unreachable): a fifth word, for a folder on a
    // disconnected drive or network folder, which is never "missing".
    expect(FOLDER_PROBLEMS).toEqual(["relative", "missing", "denied", "not-folder", "unreachable"]);
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

  // A disconnected mount: a FUSE or sshfs helper gone (ENOTCONN), an NFS
  // handle gone stale (ESTALE), a share whose host is down (EHOSTDOWN) or does
  // not answer (ETIMEDOUT), a drive that fails to read (EIO). No root here to
  // unmount anything, so the system's answer is given, at each question.
  it("tells a folder that is not reachable right now from one that is gone, at the stat and at the access", async () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    const dir = { isDirectory: () => true };
    expect(UNREACHABLE).toEqual(["ENOTCONN", "EIO", "ESTALE", "EHOSTDOWN", "ETIMEDOUT"]);
    for (const code of UNREACHABLE) {
      expect(await checkFolder("/mnt/nas/paycore", { statFn: async () => { throw err(code); } }), `stat ${code}`).toEqual({ ok: false, code: "unreachable" });
      expect(await checkFolder("/mnt/nas/paycore", { statFn: async () => dir, accessFn: async () => { throw err(code); } }), `access ${code}`)
        .toEqual({ ok: false, code: "unreachable" });
    }
    expect(await checkFolder("/mnt/nas/paycore", { statFn: async () => { throw err("ENOENT"); } }), "gone is still gone").toEqual({ ok: false, code: "missing" });
  });

  it("opens the folder, reads nothing and closes it, and takes only an unreachable answer from that open", async () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    const dir = { isDirectory: () => true };
    const there = { statFn: async () => dir, accessFn: async () => undefined };
    const closed: string[] = [];
    const opened = async (path: string) => ({ read: () => { throw new Error("never read"); }, close: async () => { closed.push(path); } });
    expect(await checkFolder("/mnt/nas/paycore", { ...there, opendirFn: opened })).toEqual({ ok: true, cwd: "/mnt/nas/paycore" });
    expect(closed, "closed again, nothing read").toEqual(["/mnt/nas/paycore"]);
    // The stat and the access answered from what the system remembered of a
    // mount whose helper had gone: the open is what says so.
    expect(await checkFolder("/mnt/nas/paycore", { ...there, opendirFn: async () => { throw err("ENOTCONN"); } })).toEqual({ ok: false, code: "unreachable" });
    // Any other refusal of the open is the agent's to meet, as before.
    for (const code of ["EACCES", "EPERM", "ENOENT", "EMFILE"]) {
      expect(await checkFolder("/mnt/nas/paycore", { ...there, opendirFn: async () => { throw err(code); } }), code).toEqual({ ok: true, cwd: "/mnt/nas/paycore" });
    }
    // A close that fails changes nothing.
    expect(await checkFolder("/x", { ...there, opendirFn: async () => ({ close: async () => { throw err("EBADF"); } }) })).toEqual({ ok: true, cwd: "/x" });
    // And the real open on a real folder.
    expect(await checkFolder(PROJECT)).toEqual({ ok: true, cwd: PROJECT });
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
