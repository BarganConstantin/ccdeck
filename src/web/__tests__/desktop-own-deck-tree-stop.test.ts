// Windows: stopping the app's own deck ended only its supervisor.
//
// The app starts bin/agent-dag.js, which starts the worker that holds the
// port. Restart ccdeck on a hung deck — and Quit — stop it through stopChild,
// which called `child.kill()`. On POSIX that is a signal the supervisor passes
// on to its worker. On Windows it is TerminateProcess on the supervisor alone:
// nothing is passed on, and the worker, a grandchild of the app, is not in the
// kill. A hung worker never handles the disconnect that would end it, so it
// kept 4317 and its record, and the deck started in its place took a random
// port. Reproduced before the fix:
//
//     stopChild(<deck child, pid 4242>, { platform: "win32" })
//       -> child.kill() twice, nothing else
//
// Now Windows ends the whole tree with `taskkill /T /F`, the way stop-deck.mjs
// and exec.mjs end theirs, and keeps child.kill() for a taskkill that cannot
// run.
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
// @ts-expect-error — plain .mjs, no types
import { stopChild } from "../../../desktop/own-deck.mjs";

/** The deck's supervisor as the app holds it: a ChildProcess with a pid. */
function deckChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kills: 0,
    kill() { child.kills++; return true; },
  });
  return child;
}

/** A spawn that records what it was asked to run, and a taskkill that ends the
 *  tree it was pointed at with `code`. */
function fakeSpawn(child: ReturnType<typeof deckChild>, code = 0) {
  const calls: { file: string; args: string[] }[] = [];
  const spawnFn = (file: string, args: string[]) => {
    calls.push({ file, args });
    const killer = Object.assign(new EventEmitter(), { unref() {} });
    setTimeout(() => {
      killer.emit("exit", code);
      if (code === 0) { child.exitCode = 1; child.emit("exit", 1, null); }
    }, 1);
    return killer;
  };
  return { calls, spawnFn };
}

describe("stopping the app's own deck on Windows", () => {
  it("ends the supervisor and everything under it", async () => {
    const child = deckChild();
    const { calls, spawnFn } = fakeSpawn(child);
    expect(await stopChild(child, { graceMs: 10, platform: "win32", spawnFn })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toMatch(/taskkill(\.exe)?$/i);
    expect(calls[0].args).toEqual(["/pid", "4242", "/T", "/F"]);
    expect(child.kills).toBe(0);
  });

  it("still kills the supervisor when taskkill cannot do it", async () => {
    const child = deckChild();
    const { calls, spawnFn } = fakeSpawn(child, 1);
    expect(await stopChild(child, { graceMs: 10, platform: "win32", spawnFn })).toBe(false);
    expect(calls).toHaveLength(2);
    expect(child.kills).toBe(2);
  });

  it("is a signal to the supervisor everywhere else, which passes it on", async () => {
    const child = deckChild();
    const { calls, spawnFn } = fakeSpawn(child);
    expect(await stopChild(child, { graceMs: 10, platform: "linux", spawnFn })).toBe(false);
    expect(calls).toHaveLength(0);
    expect(child.kills).toBe(2);
  });
});
