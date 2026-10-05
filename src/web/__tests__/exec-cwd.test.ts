// run()'s working directory. Every caller before the repository reads ran its
// tool wherever the deck itself was started, which is the right default and is
// still the default: a read of a project's history has to run inside that
// project, and a folder that has gone away must not read as a missing tool.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs server module, no types
const { run } = await import("../../server/exec.mjs");

const DIR = realpathSync(mkdtempSync(join(tmpdir(), "ccdeck-exec-cwd-")));
afterAll(() => rmTempDir(DIR));

const printCwd = ["-e", "process.stdout.write(process.cwd())"];

describe("run() with a working directory", () => {
  it("starts the child in the folder it was given", async () => {
    const r = await run(process.execPath, printCwd, { cwd: DIR });
    expect(r.ok).toBe(true);
    expect(realpathSync(r.stdout)).toBe(DIR);
  });

  it("leaves the child in the deck's own folder when none is given", async () => {
    const r = await run(process.execPath, printCwd);
    expect(r.ok).toBe(true);
    expect(realpathSync(r.stdout)).toBe(realpathSync(process.cwd()));
  });

  it("answers a folder that is not there without spawning, and never as a missing tool", async () => {
    const r = await run(process.execPath, printCwd, { cwd: join(DIR, "gone") });
    expect(r).toMatchObject({ ok: false, code: "ENOCWD", stdout: "" });
  });

  it("does not take a file for a folder", async () => {
    const r = await run(process.execPath, printCwd, { cwd: process.execPath });
    expect(r).toMatchObject({ ok: false, code: "ENOCWD" });
  });
});
