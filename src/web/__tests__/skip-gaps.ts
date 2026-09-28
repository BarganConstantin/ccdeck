// A module's own retry gaps, skipped rather than slept through (#994).
//
// quota.mjs waits between tries with plain `setTimeout`s: CLI_RETRY_GAP_MS
// between runs of `claude --print /usage`, REREAD_GAP_MS between re-reads of
// claude-swap's store. A case whose CLI answers without its quota lines sits
// through two 1.2s gaps per read and does nothing else in them, and the three
// quota suites did that about a dozen times over. So the timers are faked for
// the length of one call, and each one fires as soon as it has been set.
//
// ONE AT A TIME, IN ORDER, AND ONLY ONCE SET. `advanceTimersToNextTimerAsync`
// rather than a jump of the clock, because a jump taken before the code under
// test has reached its first gap passes that gap by: the read may be opening a
// file first, which is real I/O and not a microtask, and the gap is then set
// on a fake clock nothing will move again. Between steps the loop yields with
// `setImmediate`, which is not faked, so that I/O can finish.
//
// Only `setTimeout` and `clearTimeout` are faked. `Date.now` keeps real time,
// which is what a stored row's age is measured against. A call made with a
// deadline must not come through here: its bell is a `setTimeout` too, and it
// would ring at once.
import { vi } from "vitest";

/** `call()`, awaited with every timer it sets fired as soon as it is set. */
export async function withGapsSkipped<T>(call: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let settled = false;
    const pending = call().finally(() => { settled = true; });
    // Handled here as well as below, so a rejection that lands between two
    // steps of the loop is not reported as unhandled before it is awaited.
    pending.catch(() => {});
    while (!settled) {
      await vi.advanceTimersToNextTimerAsync();
      await new Promise(r => setImmediate(r));
    }
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}
