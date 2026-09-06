// A child that was killed and exited 0 was reported as a clean run.
//
// #787. `runInteractive`'s settle read
//
//     ok: code === 0 && !err && !timedOut
//
// with `killed` in scope and not consulted — while the memo guard eleven lines
// below already distrusted a kill for the same reason:
//
//     if (code === 0 && !killed && !timedOut) resolved.set(cmd, raw);
//
// so the two halves of one function disagreed about what a killed exit means.
//
// THE SHAPE THAT MAKES IT REACHABLE is a TUI that traps SIGTERM to put the
// terminal back and then exits 0 — `run`'s own header calls it "the
// well-behaved kind", and `claude auth login` is exactly it.
//
// What it cost: the user presses Escape during a sign-in. `cancelLogin` kills
// the child and queues `restoreActive` behind the store lock, clearing `_login`
// only after that. The child exits 0. `spawnLogin`'s handler still sees
// `flow === _login` and `state === "awaiting_code"`, and its gate is
// `if (identity && (r.ok || identity.email !== flow.previousEmail))` — `r.ok`
// is now true, so it runs `registerSignedIn`: a `cswap add` for the account the
// user just cancelled, racing cancelLogin's own restore, with the dialog
// flipping to `done`.
//
// WHY THE SUITE WAS GREEN. interactive-deadline-614.test.ts does assert
// `ok === false` after `kill()` — but its fixture holds a grandchild and does
// not trap SIGTERM, so it dies BY SIGNAL: `code` is null, the first term of the
// old expression was already false, and the branch this issue is about was
// never reached. The fixture below is the missing one.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-killed-ok-"));
afterAll(() => rmTempDir(SANDBOX));

// @ts-expect-error — plain .mjs server module, no types
const { runInteractive, run } = await import("../../server/exec.mjs");

/**
 * A well-behaved TUI: it traps SIGTERM, tidies up, and exits ZERO.
 *
 * A file rather than `node -e` for the reason interactive-deadline-614 gives —
 * a path this test chose inside a `-e` string is a Windows quoting problem with
 * nothing to teach. It announces itself on stdout first so the case can wait
 * for a process that demonstrably exists rather than guessing with a clock.
 */
const POLITE = join(SANDBOX, "polite-787.cjs");
writeFileSync(POLITE, [
  'process.on("SIGTERM", () => { process.exit(0); });',
  'process.on("SIGINT", () => { process.exit(0); });',
  'process.stdout.write("ready\\n");',
  "setInterval(() => {}, 1000);",
].join("\n") + "\n");

/**
 * Windows has no SIGTERM. `process.kill` terminates the process, the trap never
 * runs, and the child exits 1 — so on Windows `code === 0` was already false
 * and `ok` was already false with it. THE DEFECT WAS POSIX-ONLY.
 *
 * That is why the case below is NOT gated and not in skip-gates.mjs. The claim
 * "a killed child is never a clean run" is true on every platform and is
 * asserted on every platform; only the exit code the kill produces differs, and
 * that difference is the operating system's, not a case being skipped. A
 * `runIf(posix)` here would have been a register entry, a count in the
 * inventory and a number in the workflow, all to say something the platform
 * already says for itself.
 */
const posix = process.platform !== "win32";

const after = <T>(ms: number, value: T) => new Promise<T>(r => setTimeout(() => r(value), ms));
const NEVER = Symbol("never settled");

describe("a child that traps SIGTERM and exits 0", () => {
  it("is not reported as a clean run once it has been killed", async () => {
    const child = runInteractive(process.execPath, [POLITE], { timeout: 5 * 60_000 });
    const ready = new Promise<void>(res => child.onLine((line: string) => {
      if (line.includes("ready")) res();
    }));
    const heard = await Promise.race([ready.then(() => true), after(20_000, false)]);
    expect(heard, "the fixture never announced itself").toBe(true);

    child.kill();
    const settled = await Promise.race([child.done, after(20_000, NEVER)]);
    expect(settled, "the kill never settled").not.toBe(NEVER);

    const r = settled as { ok: boolean; code: number; killed: boolean; timedOut: boolean };
    // True everywhere, and the whole issue: a child the deck stopped is not a
    // child that finished.
    expect(r.killed).toBe(true);
    expect(r.ok, "a cancelled child was reported as a clean run").toBe(false);
    // The branch marker, on the platforms that have one. Where the trap runs,
    // the exit code is 0 and `ok` was TRUE before the fix — that is the case
    // this file exists for. On Windows the kill terminates and the code is 1,
    // so the assertion above already held; asserting 0 there would be asserting
    // that Windows has SIGTERM.
    if (posix) expect(r.code, "the fixture did not exit 0, so the branch was not reached").toBe(0);
    else expect(r.code).not.toBe(0);
    // And a cancel is still not a deadline.
    expect(r.timedOut).toBe(false);
  }, 60_000);

  it("is still ok when nobody killed it", async () => {
    // The other direction, so the fix cannot be "always false". A child that
    // exits 0 on its own is a clean run and the sign-in must still register.
    const r = await run(process.execPath, ["-e", "process.exit(0)"], { timeout: 30_000 });
    expect(r.ok).toBe(true);
    expect(r.killed).toBe(false);
  }, 40_000);
});

describe("the two halves of the same function", () => {
  it("agree that a killed exit is not a clean one", () => {
    // The memo guard had this right and the settle did not. Pinned together so
    // a later edit to one is made against the other rather than beside it.
    const src = readSrc();
    expect(src).toContain("ok: code === 0 && !err && !timedOut && !killed");
    expect(src).toContain("if (code === 0 && !killed && !timedOut) resolved.set(cmd, raw);");
  });
});

function readSrc(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { fileURLToPath } = require("node:url") as typeof import("node:url");
  return readFileSync(fileURLToPath(new URL("../../server/exec.mjs", import.meta.url)), "utf8");
}
