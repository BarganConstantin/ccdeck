// The deck's wall clock, stepped forward instead of waited out.
//
// The transcript reads behind a hook event are throttled per session by
// session-read-gate.mjs, which compares `Date.now()` against when the last read
// began (MODEL_READ_THROTTLE_MS, 2.5s). A suite that needs a SECOND read of the
// same session — a resumed session, a recap the next turn retires — slept about
// three seconds of real time per read and did nothing else in them (#994). The
// server runs in the test's own process, so moving `Date.now()` past the
// throttle is the same event to the gate, and costs nothing.
//
// Only `Date.now` moves. Timers, sockets, the event loop and `performance.now`
// keep real time, so everything the server does on its own schedule — the
// output watch's poll, a drain budget — is exactly as slow as it was: this is
// for gates that compare wall-clock stamps, not for waiting on work. The clock
// only ever moves forward, because a gate shown an earlier time than one it has
// already stamped would be a different test. `budget.ts` reads the real clock
// through a reference it took first, so a stepped case is not billed for the
// time it skipped.
import { afterAll, vi } from "vitest";

/** Installs the stepped clock for the rest of the file and returns the step.
 *  Call it once, at module level, before anything under test stamps a time. */
export function steppedClock(): (ms: number) => void {
  const realNow = Date.now;
  let skew = 0;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow.call(Date) + skew);
  afterAll(() => { spy.mockRestore(); });
  return ms => {
    if (!(ms > 0)) throw new Error(`the clock only steps forward, not by ${ms}ms`);
    skew += ms;
  };
}
