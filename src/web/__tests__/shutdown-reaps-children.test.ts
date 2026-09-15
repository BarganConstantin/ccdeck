// CTRL+C LEFT A WHOLE CLAUDE CODE RUNNING (#1012).
//
// Every deadline in exec.mjs lives in a timer in the deck's own process: `run`
// states the outcome on that timer and only then kills, and `runInteractive`
// does the same. Kill the deck and the timer dies with it — so the one case a
// deadline exists for, a tool that has hung, is the one case where nothing
// anywhere is left that would ever stop it.
//
// Observed on a sandboxed deck with a fake `claude` that never returns, pids
// and timestamps as they were read:
//
//   children of the deck while claude runs
//     2914642  2914328  .../claude --print /usage      (spawned 05:26:18.078)
//   SIGINT to the deck at 05:26:22.706
//   deck gone at 05:26:22.180, reparented child to init
//   at 05:26:35.204  STILL ALIVE: 2914642
//
// Seventeen seconds after the spawn, past the 15-second deadline the now-dead
// parent would have enforced, and it would have stayed that way until the
// machine was rebooted. Hundreds of MB resident, doing nothing anybody wanted.
//
// shutdown() closed the listener and unlinked the discovery file, and reaped
// nothing. killTree already existed one file over — the supervisor used it for
// its own child — so what was missing was only the answer to "which children".
//
// After the fix, same sandbox, same SIGINT:
//
//   deck gone after 0.109s        REAPED: claude child 2963089
//
// The exit stayed fast, which was worth keeping: SIGTERM and SIGINT both got
// out in ~200ms before this change, and a shutdown that waited for corpses
// would have spent that. Nothing here waits for one — a POSIX signal lands
// synchronously, and killTree's Windows answer (taskkill /T /F, spawned from
// System32) is a process of its own that CreateProcess has already started by
// the time spawn() returns and that outlives the deck.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error — a plain .mjs server module, no types
const { run, runInteractive, killLiveChildren, liveChildPids } =
  await import("../../server/exec.mjs");

/**
 * A child that will not end on its own.
 *
 * `process.execPath` rather than `sleep`, and that is a portability choice
 * rather than a stylistic one: Windows has no `sleep`, and it is the node this
 * suite is already running. It is also the honest shape of the thing being
 * reaped — the real `claude` is a node process, so the child the deck spawns
 * IS the work, with no shell wrapper between them.
 */
const FOREVER = ["-e", "setTimeout(() => {}, 600000)"];

/** A child that ends the instant it starts. */
const AT_ONCE = ["-e", "0"];

describe("the children a deck still has running", () => {
  it("names the one a quota poll is waiting on", async () => {
    // The set is the answer to "which children" that shutdown had no way to
    // ask. It is also, as #1012 notes, the honest answer to "what is this deck
    // still doing" that a future --status wants.
    const settled = run(process.execPath, FOREVER, { timeout: 60_000 });
    const pids = liveChildPids();
    expect(pids.length, "the child is registered by the time run() returns")
      .toBeGreaterThanOrEqual(1);

    expect(killLiveChildren()).toBeGreaterThanOrEqual(1);
    const r = await settled;
    expect(r.ok, "the run settled because the child died, not because it finished")
      .toBe(false);
    expect(r.timedOut, "and not because its own deadline ran out").toBe(false);
  }, 30_000);

  it("forgets one that ended by itself, so the set is not a leak", async () => {
    // Tracked children accumulate on a poll otherwise: /api/quota alone can
    // spawn three a minute. Removal is on 'close' rather than on 'exit', and
    // the difference is Windows': a batch candidate runs THROUGH cmd.exe, the
    // tool is a grandchild, and the wrapper can exit while the tool underneath
    // goes on holding the inherited stdio — which is the exact case killTree's
    // `taskkill /T` exists for. 'exit' there means the wrapper is gone; 'close'
    // means so is everything it started.
    const before = liveChildPids().length;
    const r = await run(process.execPath, AT_ONCE, { timeout: 30_000 });
    expect(r.ok).toBe(true);
    expect(liveChildPids().length, "nothing left behind by a run that ended well")
      .toBe(before);
  }, 30_000);

  it("includes the login that is blocked on a pipe only this deck holds", async () => {
    // runInteractive is the other spawn in that file, and it has more at stake
    // rather than less: its deadline is five minutes, and the thing under it is
    // a `claude auth login` reading a stdin pipe that dies with the deck. An
    // orphan there waits for a writer that can never arrive.
    const session = runInteractive(process.execPath, FOREVER, { timeout: 60_000 });
    expect(liveChildPids().length).toBeGreaterThanOrEqual(1);

    killLiveChildren();
    const r = await session.done;
    expect(r.ok).toBe(false);
  }, 30_000);

  it("has nothing to do the second time, because shutdown can be reached twice", () => {
    // SIGINT, SIGTERM and the restart path all call shutdown(), and a deck can
    // take two of those. Clearing the set before the loop is also what stops a
    // 'close' arriving mid-kill from mutating what is being iterated.
    expect(killLiveChildren()).toBe(0);
  });
});

describe("what shutdown does with them", () => {
  const deck = readFileSync(
    fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");

  it("reaps them, ahead of every way out", () => {
    // Both exits, not just the orderly one: shutdown returns early through
    // `if (!server) return process.exit(code)` on a boot that never bound, and
    // a deck that got far enough to spawn a quota probe can be one of those.
    expect(deck).toContain("killLiveChildren();");
    const reap = deck.indexOf("killLiveChildren();");
    expect(reap).toBeGreaterThan(-1);
    expect(reap, "before the early exit").toBeLessThan(deck.indexOf("if (!server) return process.exit(code);"));
    expect(reap, "and before the orderly one").toBeLessThan(deck.indexOf("server.close(() => process.exit(code));"));
  });

  it("does not wait for the corpses", () => {
    // The part of shutdown that was already good and had to stay good: both
    // signals got out in ~200ms, the port rebound immediately, and the
    // measurement after this change was 0.109s. An `await` on a kill would have
    // spent that for nothing — POSIX delivers the signal synchronously, and on
    // Windows the taskkill that does the work outlives the deck by design.
    expect(deck).not.toContain("await killLiveChildren");
  });
});
