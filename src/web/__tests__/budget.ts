// #499: a case measured at 5999ms against vitest's 5000ms default — and it
// passed.
//
// That is not a rounding artefact and it is not vitest being wrong. A timeout
// is a timer, a timer needs the event loop, and a case whose work is a
// synchronous CPU loop never yields — so the timer never fires and the case
// runs to completion however long it takes. The budget only ever applied to
// tests that await something.
//
// The consequence is the one that matters for a CI matrix: a green run does not
// mean every case finished inside its budget. The cases that cannot be caught
// are exactly the CPU-bound ones, which are the ones a shared runner with fewer
// cores slows down most, and whatever a hosted runner does to them the failure
// will not look like a timeout. It will look like a slow suite, or like nothing
// at all.
//
// So the budget is checked after the fact as well. Vitest records when a case
// started before it runs a single hook; this file reads the clock again once
// the case is over and compares. A synchronous loop cannot dodge that, because
// the check does not need the event loop until the case has already let go
// of it.
//
// What it measures is what the reporter prints. Vitest's own per-case duration
// runs from just before `beforeEach` to just after `afterEach`, and so does
// this — a `beforeEach` that takes eleven seconds is eleven seconds a reader
// watching the run has to wait for that case, whichever budget the framework
// would file it under.
//
// It reads the clock through a reference taken at module load, before any test
// can reach it. Three suites here call `vi.useFakeTimers()`, which replaces the
// global `Date` outright: a case that moved the system clock forty days to
// watch a quota window reset would otherwise be reported as having taken forty
// days. All three put the real timers back before this hook runs, so today the
// reference changes nothing — and depending on that would be depending on a
// habit rather than on a rule.
//
// Registered from vite.config.ts as a setup file, so it applies to every case
// in the suite rather than to the file somebody remembered to add it to.
import { afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { withoutComments } from "./tsx-scan";

/** The real clock, captured before a test can fake it. */
const realNow = Date.now;

/** The project default, if the running config cannot be read. Kept in step with
 *  vite.config.ts by a test — see test-budget.test.ts, which fails if the two
 *  drift or if vitest stops exposing the number at all. */
export const FALLBACK_TEST_TIMEOUT = 20_000;

/**
 * A test budget, as opposed to a number that happens to sit where one would.
 *
 * The lower end keeps `expect(f({…}, 3)).toBe(…)` out; the upper end keeps
 * `quota-source.test.ts`'s `}, 1_700_000_000_000)` out, which is a Unix instant
 * being handed to a helper and would otherwise excuse that whole file from
 * every budget forever. Ten minutes is longer than the longest budget anyone
 * has written here by a factor of five.
 */
const PLAUSIBLE = { min: 1_000, max: 600_000 };

/**
 * The largest budget a test file states anywhere in its own source.
 *
 * Vitest bakes a per-case timeout into the wrapped function and does not keep
 * it on the task, so there is nowhere at runtime to ask what `it(…, 40_000)`
 * asked for. The file itself is the only place that still knows, and this suite
 * reads its own source in thirty other places, so it reads it here too.
 *
 * Deliberately the file's MAXIMUM, and deliberately counting a hook's budget as
 * well as a case's. Both make the guard more generous than a per-case reading
 * would be, and generous is the safe direction: over-estimating costs teeth on
 * one file, under-estimating fails an honest test on a slow runner. The claim
 * this file is willing to make is the modest one — no case takes longer than
 * the longest budget its own file asks for.
 *
 * Comments and string contents come out first. This suite's prose quotes the
 * code it retired and its fixtures hold snippets of other files, so a budget
 * written inside a comment or inside a quoted example is text about a budget
 * and not one.
 */
export function statedBudget(raw: string): number {
  const source = withoutComments(raw, true);
  const numbers = [
    // `it("…", async () => { … }, 40_000);` and `beforeAll(async () => { … }, 90_000);`
    // — the form every explicit budget in this suite is written in.
    ...source.matchAll(/\}\s*\)?\s*,\s*([0-9][0-9_]*)\s*\)/g),
    // `it("…", { timeout: 40_000 }, …)`, which nothing here uses yet.
    ...source.matchAll(/\btimeout\s*:\s*([0-9][0-9_]*)/g),
  ].map(m => Number(m[1].replace(/_/g, "")))
    .filter(n => n >= PLAUSIBLE.min && n <= PLAUSIBLE.max);
  return numbers.length ? Math.max(...numbers) : 0;
}

/** Read once per file, not once per case. */
const stated = new Map<string, number>();
function statedFor(filepath: string | undefined): number {
  if (!filepath) return 0;
  const known = stated.get(filepath);
  if (known !== undefined) return known;
  let value = 0;
  try {
    value = statedBudget(readFileSync(filepath, "utf8"));
  } catch {
    // A file the guard cannot read is a file the guard has nothing to say
    // about. The project default still applies.
    value = 0;
  }
  stated.set(filepath, value);
  return value;
}

/** What vitest is running with right now, which is what `vi.setConfig` moves.
 *  Not part of the published API, so the fallback above is real and a test
 *  below fails the day this stops answering. */
export function configuredTestTimeout(): number {
  const worker = (globalThis as Record<string, any>).__vitest_worker__;
  const configured = worker?.config?.testTimeout;
  return typeof configured === "number" && configured > 0 ? configured : FALLBACK_TEST_TIMEOUT;
}

/** The message, built here so a test can read it without running slowly. */
export function overrunMessage(name: string, took: number, budget: number, fileBudget: number): string {
  const source = fileBudget >= budget && fileBudget > 0
    ? `the largest budget its own file states (${fileBudget}ms)`
    : `the project default in vite.config.ts (${budget}ms)`;
  return [
    `${name} took ${took}ms, over ${source}.`,
    "Vitest did not fail it on its own: a timeout is a timer, and a case that",
    "never yields to the event loop never lets one fire. Either the work",
    "belongs inside a smaller budget, or the budget belongs in the file.",
  ].join(" ");
}

/** When each case started, by task id — one entry at a time in a sequential
 *  run, and correct even if a suite ever goes concurrent. Registered here, so
 *  it runs before any hook a test file writes for itself. */
const startedAt = new Map<string, number>();

beforeEach(context => {
  const task = (context as { task?: any }).task;
  if (task?.id) startedAt.set(task.id, realNow());
});

afterEach(context => {
  const task = (context as { task?: any }).task;
  const started = task?.id ? startedAt.get(task.id) : undefined;
  if (task?.id) startedAt.delete(task.id);
  if (started === undefined) return;
  // A case that has already failed does not need a second opinion about why —
  // including one vitest's own timeout already caught.
  if (task.result?.state === "fail") return;
  const fileBudget = statedFor(task?.file?.filepath);
  const budget = Math.max(configuredTestTimeout(), fileBudget);
  const took = realNow() - started;
  if (took <= budget) return;
  throw new Error(overrunMessage(task.name ?? "this case", took, budget, fileBudget));
});
