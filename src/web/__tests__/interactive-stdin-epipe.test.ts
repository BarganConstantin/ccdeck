// A child that stops reading must not take the deck down with it.
//
// `runInteractive` is the one primitive in this repo that holds a child's stdin
// open: the account login writes an OAuth code into `claude auth login`, and
// `cswap import -` gets up to 2 MB of shared-account bundle. Both write to a
// process that may decide it has read enough.
//
// A broken pipe is asynchronous. It arrives as an 'error' event on the stdin
// Writable, NOT as a throw from `write`, so the try/catch around the write
// cannot see it — and an unhandled 'error' on a stream is an uncaught
// exception, with no `process.on("uncaughtException")` anywhere in bin/,
// src/server/ or hook/. So a paste cswap rejected before draining exited the
// whole dashboard.
//
// Real children: this is a test about what the OS does to a pipe, and a fake
// spawn has no pipe to break.
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — .mjs server module, no types
const { runInteractive } = await import("../../server/exec.mjs");

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-epipe-"));
afterAll(() => rmTempDir(DIR));

/** A child that exits at once, having read nothing. Written as a .js file and
 *  launched through this process's own node, so the case runs identically on
 *  Windows — where a `#!/bin/sh` fixture would simply not execute, and the test
 *  would pass by not running. */
function quitter(): { cmd: string; args: string[] } {
  const js = join(DIR, "quit.js");
  writeFileSync(js, 'process.exit(3);\n');
  return { cmd: process.execPath, args: [js] };
}

/**
 * Every uncaught exception raised while a case runs.
 *
 * A listener of our own is what makes this assertable rather than merely fatal:
 * with one attached Node no longer aborts, so the case can finish and SAY that
 * an EPIPE escaped instead of taking the whole vitest worker with it. Removing
 * the guard in exec.mjs turns both cases below red on this array rather than on
 * a stack trace in the runner's summary.
 */
const escaped: Error[] = [];
const catchAll = (err: Error) => { escaped.push(err); };
beforeEach(() => { escaped.length = 0; process.on("uncaughtException", catchAll); });
afterEach(() => { process.off("uncaughtException", catchAll); });

describe("writing to a child that has stopped reading", () => {
  it("settles with the child's own exit code instead of crashing the deck", async () => {
    const { cmd, args } = quitter();
    const session = runInteractive(cmd, args, { timeout: 10_000 });

    // Big enough that the pipe cannot swallow it: SHARE_MAX_BYTES is 2 MB and
    // a pipe buffer is 64 KiB, so this is the real import's shape.
    const bundle = "x".repeat(2 << 20);
    // Written after the child has had a chance to be gone. Both orders are
    // legal and both used to be fatal; this is the one that reliably reproduces
    // it, because the write then lands on a pipe with no reader at all.
    await new Promise(r => setTimeout(r, 150));
    session.write(bundle);
    session.write(bundle);

    const r = await session.done;
    expect(r.code).toBe(3);
    expect(r.ok).toBe(false);
    expect(escaped.map(e => (e as NodeJS.ErrnoException).code)).toEqual([]);
  }, 30_000);

  it("survives a close arriving mid-write", async () => {
    // The other interleaving: the child is still alive when the first write is
    // queued and exits while the kernel is draining it.
    const { cmd, args } = quitter();
    const session = runInteractive(cmd, args, { timeout: 10_000 });
    for (let i = 0; i < 8; i++) session.write("y".repeat(512 << 10));
    const r = await session.done;
    expect(typeof r.code).toBe("number");
    expect(escaped.map(e => (e as NodeJS.ErrnoException).code)).toEqual([]);
  }, 30_000);

  it("keeps the guard the sibling primitive already had", () => {
    // `run` has carried `cp.stdin?.on("error", () => {})` since it was written;
    // the asymmetry is what this file is about, so it is pinned in both places.
    const src = readFileSync(new URL("../../server/exec.mjs", import.meta.url), "utf8");
    expect(src).toContain('cp.stdin?.on("error", () => {})');
    expect(src).toContain('proc.stdin?.on("error", () => {})');
  });
});
