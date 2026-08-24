// #499, from the other side: the budget guard, and whether it has teeth.
//
// `duplicated-helpers.test.ts` had a case measured at 5999ms against vitest's
// 5000ms default and it passed, because a timeout is a timer and a case whose
// work is a synchronous CPU loop never yields to let one fire. So a green run
// did not mean every case finished inside its budget, and the cases that could
// not be caught were exactly the CPU-bound ones — the ones a shared runner with
// fewer cores slows down most, and the ones whose failure would not look like a
// timeout.
//
// `__tests__/budget.ts` closes that by re-reading the clock after every case.
// This file is what says so out loud: the numbers vite.config.ts states are the
// numbers the run is actually using, the extractor that reads a file's own
// stated budget reads the forms this suite writes and ignores the numbers that
// merely look like one, and — last, and the only part that could not be faked —
// a synchronous case that overruns really does fail.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FALLBACK_TEST_TIMEOUT, configuredTestTimeout, overrunMessage, statedBudget,
} from "./budget";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const config = read("../../../vite.config.ts");
const here = read("./test-budget.test.ts");

// The fixtures below are built with the number kept out of the brace that
// precedes it — `"…}" + ", 40_000)"` — for a reason worth reading. The
// extractor blanks string contents before it looks, precisely so a quoted
// example is not mistaken for a budget; these are written this way as well so
// that the file's OWN stated budget stays zero either way, which is what lets
// the overrun case at the bottom run against a 20ms one.
const CASE_BUDGET = "it(\"a slow one\", async () => { await go(); }" + ", 40_000);";
const HOOK_BUDGET = "beforeAll(async () => { await boot(); }" + ", 90_000);";
const OPTIONS_FORM = "it(\"a slow one\", { timeou" + "t: 25_000 }, async () => {});";

beforeEach(() => {
  // The overrun case below lowers the budget for itself. Put it back before
  // anything else runs, so one case cannot quietly change another's rules.
  vi.resetConfig();
});

describe("the budgets the project states are the budgets the run uses", () => {
  it("has a test block at all, which is the thing #499 found missing", () => {
    expect(config).toMatch(/\btest:\s*\{/);
    expect(config).toMatch(/testTimeout:\s*20_000/);
    expect(config).toMatch(/hookTimeout:\s*30_000/);
    expect(config).toMatch(/setupFiles:\s*\["\.\/__tests__\/budget\.ts"\]/);
  });

  it("is running with them, rather than with a default nobody chose", () => {
    // Not a re-reading of the file: this is what vitest says it is enforcing,
    // and it is the number the guard compares against. If the test block ever
    // stops being applied — a renamed key, a config file that stopped being
    // loaded — this is where it shows.
    expect(configuredTestTimeout()).toBe(20_000);
    const worker = (globalThis as Record<string, any>).__vitest_worker__;
    expect(worker?.config?.hookTimeout).toBe(30_000);
  });

  it("keeps the guard's fallback in step with the number vite.config.ts states", () => {
    // `configuredTestTimeout` reads a global vitest does not publish. The day it
    // stops answering, the guard drops to this constant rather than to nothing —
    // and this assertion is what stops the two drifting apart in the meantime.
    expect(FALLBACK_TEST_TIMEOUT).toBe(20_000);
  });
});

describe("what a test file states as its own budget", () => {
  it("reads the forms this suite actually writes", () => {
    expect(statedBudget(CASE_BUDGET)).toBe(40_000);
    expect(statedBudget(HOOK_BUDGET)).toBe(90_000);
    expect(statedBudget(OPTIONS_FORM)).toBe(25_000);
    // The largest wins: a file gets the ceiling it asks for anywhere in it.
    expect(statedBudget([CASE_BUDGET, HOOK_BUDGET].join("\n"))).toBe(90_000);
  });

  it("does not mistake data for a budget", () => {
    // `quota-source.test.ts` hands a helper a Unix instant in the position a
    // timeout would sit in. Read as a budget it would excuse that whole file
    // from every check for the next fifty thousand years.
    expect(statedBudget("expect(quota({ fetchedAt: 1 }" + ", 1_700_000_000_000));")).toBe(0);
    // And a small number in the same position is an argument, not a budget.
    expect(statedBudget("expect(shortAgo({ now: 0 }" + ", 3));")).toBe(0);
  });

  it("ignores a budget written in prose or quoted in a fixture", () => {
    expect(statedBudget("// it(\"…\", fn" + ", 60_000) was what this used to say.")).toBe(0);
    expect(statedBudget("const retired = \"beforeAll(fn" + ", 60_000)\";")).toBe(0);
    // Which is why this very file states none, and the case below can lower
    // its own budget to twenty milliseconds and mean it.
    expect(statedBudget(here)).toBe(0);
  });

  it("says where the budget came from when it fails a case", () => {
    expect(overrunMessage("a case", 9_000, 20_000, 0)).toContain("the project default in vite.config.ts (20000ms)");
    expect(overrunMessage("a case", 70_000, 60_000, 60_000)).toContain("the largest budget its own file states (60000ms)");
    expect(overrunMessage("a case", 9_000, 20_000, 0)).toContain("never yields to the event loop");
  });
});

describe("the guard itself", () => {
  it.fails("fails a synchronous case that overran, which vitest on its own cannot", () => {
    // The whole issue, as one case. `it.fails` inverts the result, so this
    // passes only because the guard threw: the body below does nothing wrong
    // except take too long, and it never awaits, so vitest's own timer has no
    // moment in which to fire. Delete the `afterEach` in budget.ts and this
    // case starts passing on its own — and therefore failing here.
    vi.setConfig({ testTimeout: 20 });
    const started = Date.now();
    // A spin, not a sleep. A sleep would yield and be caught the ordinary way,
    // which would prove the opposite of what this is for.
    let sink = 0;
    while (Date.now() - started < 120) sink += Math.sqrt(sink + 1);
    expect(sink).toBeGreaterThan(0);
  });
});
