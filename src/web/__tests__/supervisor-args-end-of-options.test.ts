// A bare `--` in the user's argv hid the flags the supervisor adds.
//
// The supervisor builds the worker's command line from the user's argv and
// appends `--port <bound>` on a respawn, and the npx relaunch appends
// `--port <bound> --no-open` the same way. parseArgs reads a bare `--` as the
// end of options and drops everything after it, so `ccdeck --no-persist --`
// on a machine where 4317 was taken came back from a restart on a different
// random port, and an npx update opened a second tab. Reproduced before the
// fix:
//
//     parseArgs(workerArgs("w.js", ["--no-persist", "--"], { respawn: true, boundPort: 4350 }).slice(1)).port
//       -> undefined
//
// Now the supervisor's flags go in before the first `--`.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module, no types
import { npxRelaunchArgs, workerArgs } from "../../server/supervisor.mjs";
// @ts-expect-error — plain .mjs module, no types
import { parseArgs } from "../../server/args.mjs";

describe("the flags the supervisor adds, after a `--` the user typed", () => {
  it("still reach a respawned worker's parser", () => {
    const args = workerArgs("/w/deck.js", ["--no-persist", "--"], { respawn: true, boundPort: 4350 });
    expect(args[0]).toBe("/w/deck.js");
    const got = parseArgs(args.slice(1));
    expect(got.port).toBe("4350");
    expect(got.noPersist).toBe(true);
    // The user's argv is kept as typed, `--` and all.
    expect(args).toContain("--");
  });

  it("still reach the deck an npx update starts", () => {
    const args = npxRelaunchArgs("ccdeck@latest", ["--no-persist", "--"], 4350);
    expect(args.slice(0, 2)).toEqual(["-y", "ccdeck@latest"]);
    const got = parseArgs(args.slice(2));
    expect(got.port).toBe("4350");
    expect(got.noOpen).toBe(true);
  });

  it("leave a command line without `--` exactly as it was", () => {
    expect(workerArgs("/w/deck.js", ["--no-open"], { respawn: true, boundPort: 4317 }))
      .toEqual(["/w/deck.js", "--no-open", "--port", "4317"]);
    expect(npxRelaunchArgs("ccdeck@latest", ["--no-codex"], 4317))
      .toEqual(["-y", "ccdeck@latest", "--no-codex", "--port", "4317", "--no-open"]);
  });
});
