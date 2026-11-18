// The Windows ACL reader (windows-acl.mjs) on the machine it is written for. On
// Windows it asks the real tools; elsewhere the one case asserts that the same
// reader refuses, since there is no whoami.exe or PowerShell there. It does not
// assert elevated === false: hosted Windows runners run elevated. The platform
// choice is made when the file is collected rather than by a skip, so no case
// is skipped on any leg.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain server module
import { createWindowsAcl, boundedRun } from "../../server/windows-acl.mjs";

type RunOptions = { env: Record<string, string>; timeoutMs: number; maxBytes: number };
/** The deck's own `run`, with a note of how each call ended, so a refusal on
 *  the real machine says whether the tool timed out or exited, and what it
 *  wrote to stderr. */
function noted() {
  const notes: string[] = [];
  const run = async (file: string, args: string[], options: RunOptions) => {
    const started = Date.now();
    try {
      const answer = await boundedRun(file, args, options);
      let note = `exit ${answer.code} after ${Date.now() - started} ms`;
      if (answer.code !== 0) {
        const again = spawnSync(file, args, { env: options.env, input: "", timeout: options.timeoutMs, windowsHide: true, encoding: "utf8" });
        note += `, stderr: ${String(again.stderr ?? "").slice(0, 600)}`;
      }
      notes.push(note);
      return answer;
    } catch (error) {
      notes.push(`no answer after ${Date.now() - started} ms`);
      throw error;
    }
  };
  return { run, notes };
}

const roots: string[] = [];
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
});
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "ccdeck-acl-real-")); roots.push(dir); return dir; };
const quiet = (file: string, args: string[]) => execFileSync(file, args, { stdio: "ignore", windowsHide: true });

if (process.platform !== "win32") {
  describe("the Windows ACL reader off Windows", () => {
    it("refuses, as there is no system folder to run its tools from", async () => {
      const acl = createWindowsAcl({ env: {} });
      await expect(acl.identity()).rejects.toThrow();
      await expect(acl.inspect(await temp())).rejects.toThrow();
    });
  });
} else {
  describe("the Windows ACL reader on Windows", () => {
    const { run, notes } = noted();
    const reader = createWindowsAcl({ run });
    const why = (error: unknown) => { throw new Error(`${(error as Error).message} (${notes.join("; ")})`); };
    const acl = {
      identity: () => reader.identity().catch(why),
      inspect: (target: string) => reader.inspect(target).catch(why),
    };

    it("names this user by SID and says whether it is elevated", async () => {
      const me = await acl.identity();
      expect(me.user).toMatch(/^S-1-5-/);
      expect(typeof me.elevated).toBe("boolean");
    }, 30_000);

    it("reads a fresh folder: a SID owner, SID writers, no reparse point", async () => {
      const dir = await temp();
      const info = await acl.inspect(dir);
      expect(info.owner).toMatch(/^S-1-/);
      expect(Array.isArray(info.writers)).toBe(true);
      for (const writer of info.writers) expect(writer).toMatch(/^S-1-/);
      expect(info.reparsePoint).toBe(false);
    }, 30_000);

    it("sees a write grant to Everyone", async () => {
      const dir = await temp();
      quiet("icacls", [dir, "/grant", "*S-1-1-0:(W)"]);
      expect((await acl.inspect(dir)).writers).toContain("S-1-1-0");
    }, 30_000);

    it("reports a junction as a reparse point", async () => {
      const dir = await temp();
      const junction = join(dir, "link");
      quiet("cmd", ["/c", "mklink", "/J", junction, dir]);
      expect((await acl.inspect(junction)).reparsePoint).toBe(true);
    }, 30_000);
  });
}
