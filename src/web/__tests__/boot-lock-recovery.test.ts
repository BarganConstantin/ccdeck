import { describe, expect, it } from "vitest";
import { execFile, type ExecFileException } from "node:child_process";
import * as nodeFs from "node:fs";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — plain .mjs server module, no types
import { takeBootLock, BOOT_LOCK_FILE } from "../../server/boot-lock.mjs";

const permissionChecks = process.platform !== "win32" && process.getuid?.() !== 0;
const moduleUrl = new URL("../../server/boot-lock.mjs", import.meta.url).href;

// The deadline belongs to the parent: a synchronous retry loop in the child
// cannot run its own timers. This child only touches its supplied fixture.
function permissionProbe(dir: string) {
  const script = `
    import { writeSync } from "node:fs";
    const { takeBootLock } = await import(process.argv[1]);
    writeSync(1, "ready\\n");
    const lock = await takeBootLock({ dir: process.argv[2] });
    console.log(JSON.stringify({ held: lock.held, waited: lock.waited, reason: lock.reason, released: lock.release() }));
  `;
  return new Promise<{ error: ExecFileException | null; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ["--input-type=module", "-e", script, moduleUrl, dir], {
      timeout: 3_000, maxBuffer: 16_384,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

describe("boot lock recovery", () => {
  it.skipIf(!permissionChecks)("returns the unlink refusal for a stale lock instead of blocking startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-boot-lock-permission-"));
    const file = join(dir, BOOT_LOCK_FILE);
    const stale = JSON.stringify({ pid: 424242, at: 0, nonce: "fixture-stale" });
    try {
      chmodSync(dir, 0o500);
      const absent = await takeBootLock({ dir });
      expect(absent).toMatchObject({ held: false, waited: false, reason: "EACCES" });
      expect(absent.release()).toBe(false);
      chmodSync(dir, 0o700);
      writeFileSync(file, stale, { mode: 0o600 });
      chmodSync(dir, 0o500);

      const result = await permissionProbe(dir);
      expect(result.stdout).toContain("ready\n");
      expect(result.error).toBeNull();
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout.trim().split("\n")[1])).toEqual({
        held: false, waited: false, reason: "EACCES", released: false,
      });
      expect(readFileSync(file, "utf8")).toBe(stale);

      chmodSync(dir, 0o700);
      const recovered = await takeBootLock({ dir });
      expect(recovered.held).toBe(true);
      expect(recovered.release()).toBe(true);
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("retries exclusive acquisition when another starter already removed the stale lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-boot-lock-race-"));
    const file = join(dir, BOOT_LOCK_FILE);
    try {
      writeFileSync(file, JSON.stringify({ pid: 424242, at: 0, nonce: "fixture-stale" }));
      let raced = false;
      const fs = { ...nodeFs, unlinkSync: (path: string) => {
        nodeFs.unlinkSync(path);
        if (!raced) {
          raced = true;
          throw Object.assign(new Error("removed by another starter"), { code: "ENOENT" });
        }
      } };
      const lock = await takeBootLock({ dir, fs });
      expect(raced).toBe(true);
      expect(lock).toMatchObject({ held: true, waited: false });
      expect(JSON.parse(readFileSync(file, "utf8")).nonce).not.toBe("fixture-stale");
      expect(lock.release()).toBe(true);
      expect(lock.release()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["EPERM", undefined])("returns a permanent unlink failure (%s) without retrying it", async (code) => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-boot-lock-refusal-"));
    const file = join(dir, BOOT_LOCK_FILE);
    const stale = JSON.stringify({ pid: 424242, at: 0, nonce: "fixture-stale" });
    try {
      writeFileSync(file, stale);
      let opens = 0;
      let unlinks = 0;
      const fs = { ...nodeFs,
        openSync: (...args: Parameters<typeof nodeFs.openSync>) => {
          // Bound a regression on platforms without POSIX permissions too.
          if (++opens > 1) throw Object.assign(new Error("unexpected retry"), { code: "TEST_RETRY" });
          return nodeFs.openSync(...args);
        },
        unlinkSync: () => {
          unlinks++;
          throw Object.assign(new Error("fixture refusal"), { code });
        },
      };
      const lock = await takeBootLock({ dir, fs });
      expect(lock).toMatchObject({ held: false, waited: false, reason: code ?? "unlink_failed" });
      expect(lock.release()).toBe(false);
      expect(unlinks).toBe(1);
      expect(readFileSync(file, "utf8")).toBe(stale);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
