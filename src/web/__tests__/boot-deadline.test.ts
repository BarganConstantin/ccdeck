// The boot's deadline, as arithmetic (#742).
//
// The behaviour this supports is in boot-budget.test.ts, which spawns a real
// deck. This file is the part that can be checked in a millisecond: that a
// timeout is told apart from a job which answered `null`, that a rejection
// counts as an answer rather than as a timeout, and that one budget shared by
// four jobs does not quietly become four budgets.
//
// The distinction in the first of those is the whole point of the shape. Three
// of the jobs bin/deck.js hands this resolve to `null` on purpose — it is how
// each says "not attempted on this machine" — so a helper that answered `null`
// for a timeout as well would have reported a uv install still running as
// "claude-swap: skipped, accounts are Claude-only".
import { describe, it, expect } from "vitest";

// @ts-expect-error — a plain .mjs module, no types
const { within, budget, bootDeadlineMs, BOOT_DEADLINE_MS } =
  await import("../../server/boot-deadline.mjs");

const never = () => new Promise<never>(() => {});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("within", () => {
  it("tells a job that answered null apart from one that did not answer", async () => {
    expect(await within(Promise.resolve(null), 500)).toEqual({ done: true, value: null });
    expect(await within(never(), 20)).toEqual({ done: false, value: undefined });
  });

  it("passes the value through untouched", async () => {
    const v = { cs: { state: "present", version: "0.26.0" } };
    expect(await within(Promise.resolve(v), 500)).toEqual({ done: true, value: v });
  });

  it("counts a rejection as an answer, not as a timeout", async () => {
    // Every job in bin/deck.js attaches its own rejection handler where the
    // promise is created, so a throw has already been dealt with by the time it
    // reaches here. Re-throwing would turn a job that failed politely into a
    // boot that died — and waiting out the deadline for a promise that is
    // already settled would be eight seconds spent on a decided question.
    const started = Date.now();
    expect(await within(Promise.reject(new Error("no installer")), 5_000))
      .toEqual({ done: true, value: undefined });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("takes a plain value as readily as a promise", async () => {
    expect(await within(7, 500)).toEqual({ done: true, value: 7 });
  });

  it("answers once, whichever side is slower", async () => {
    // A job settling immediately after its own deadline is the case that
    // resolves a promise twice if the latch is missing. It is silent when it
    // happens — a second resolve is ignored — which is why it is asserted here
    // rather than left to be noticed.
    let calls = 0;
    const work = sleep(30).then(() => { calls++; return "late"; });
    expect(await within(work, 10)).toEqual({ done: false, value: undefined });
    await sleep(60);
    expect(calls).toBe(1);
  });

  it("clears its timer, so a fast job does not hold the deadline open", async () => {
    // Asserted through the clock rather than through the timer: `within` is
    // given its own setTimeout/clearTimeout so the pair can be counted.
    const cleared: unknown[] = [];
    const r = await within(Promise.resolve("x"), 60_000, {
      setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimer: (t: unknown) => { cleared.push(t); clearTimeout(t as any); },
    });
    expect(r).toEqual({ done: true, value: "x" });
    expect(cleared).toHaveLength(1);
  });

  it("gives a zero-length slice to the microtask, not to the next tick", async () => {
    // The last job in the report can reach a spent budget, and it is a promise
    // that has been settled for seconds by then. A `.then` is a microtask and a
    // `setTimeout(…, 0)` is a macrotask, so the answer wins — which is what
    // keeps a slow claude-swap from erasing the ccusage row behind it.
    expect(await within(Promise.resolve("ready"), 0)).toEqual({ done: true, value: "ready" });
  });
});

describe("budget", () => {
  it("is one budget for every job that draws on it", async () => {
    // The mistake this rules out: a deadline per job. Four jobs at eight
    // seconds each is a thirty-two second boot that no individual deadline
    // would object to, and the promise the deadline exists to make is about
    // the sum.
    let now = 1_000;
    const b = budget(100, () => now);
    now += 60;
    expect(b.left()).toBe(40);
    now += 60;
    expect(b.left()).toBe(0);
    expect(b.spent()).toBe(120);
  });

  it("never hands out a negative slice", async () => {
    let now = 0;
    const b = budget(50, () => now);
    now = 5_000;
    expect(b.left()).toBe(0);
    // A job reached after the budget is spent is reported as still working,
    // which it is — not awaited forever on a negative timeout.
    expect(await b.within(never())).toEqual({ done: false, value: undefined });
  });

  it("really does bound a job that never settles", async () => {
    const b = budget(40);
    const started = Date.now();
    expect(await b.within(never())).toEqual({ done: false, value: undefined });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("bootDeadlineMs", () => {
  it("defaults to the constant", () => {
    expect(bootDeadlineMs({})).toBe(BOOT_DEADLINE_MS);
    expect(bootDeadlineMs({ AGENTS_DECK_BOOT_DEADLINE_MS: "" })).toBe(BOOT_DEADLINE_MS);
  });

  it("is eight seconds, which is above every probe an honest boot pays", () => {
    // Not a free parameter. Below it are `cswap --version`, `uv --version` and
    // a PyPI lookup, which finish well under a second warm and in two or three
    // cold; a deadline under those would push every normal boot onto the
    // background path and move the rows out from where a reader looks for them.
    // Above it is a `uv tool install`, which is measured in minutes.
    expect(BOOT_DEADLINE_MS).toBe(8_000);
  });

  it("takes an override, so a test need not wait out the real one", () => {
    expect(bootDeadlineMs({ AGENTS_DECK_BOOT_DEADLINE_MS: "250" })).toBe(250);
    // Zero is a coherent ask — "give the jobs nothing" — and still runs the
    // timer path, so a test using it exercises what the product runs.
    expect(bootDeadlineMs({ AGENTS_DECK_BOOT_DEADLINE_MS: "0" })).toBe(0);
  });

  it("ignores anything it cannot use", () => {
    for (const bad of ["nope", "-1", "NaN", "1e999x"]) {
      expect(bootDeadlineMs({ AGENTS_DECK_BOOT_DEADLINE_MS: bad })).toBe(BOOT_DEADLINE_MS);
    }
  });
});
