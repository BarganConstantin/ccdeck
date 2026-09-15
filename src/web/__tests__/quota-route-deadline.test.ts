// GET /api/quota PINNED ITS CALLER FOR 47 SECONDS (#1011).
//
// Measured on a sandboxed deck — a temp HOME, no claude-swap store, no OAuth
// credential, and a fake `claude` on PATH that prints nothing and outlives the
// spawn deadline, so source 3 is the only path left and its timing is the
// test's to choose:
//
//   $ curl -s -m 120 -w "[%{http_code}] time_total=%{time_total}s" .../api/quota
//   {"ok":false,"reason":"cli_failed",...}
//   [200] time_total=47.411343s
//
// Three spawns under a 15-second deadline each with two 1.2-second sleeps
// between them — 3 × 15 + 2 × 1.2 = 47.4, to the tenth. Every step of that had
// a bound and the sum of them had none, because nobody had ever added it up.
// The route awaited fetchClaudeQuota and sent whatever came back, whenever.
//
// The rest of the deck stayed responsive throughout: /api/health answered in
// 0.0008s six times while that request was out. So what this is about is one
// pinned request rather than a stalled server — the usage panel reading
// "Checking…" for three quarters of a minute, and one fewer socket in the
// browser's six-per-origin pool for the whole of it.
//
// The shape of the fix is the reason this file is not about a number. A
// deadline that CANCELLED the read would spend a whole `claude --print /usage`
// and throw the answer away, against a budget of 28-30 requests an hour shared
// with claude-swap — the one thing this module is built not to do. So the read
// runs on, keeps `_inflight` filled so nothing spawns beside it, and publishes
// for whoever asks next. After the fix, on the same sandbox:
//
//   call 1                         [200] time_total=5.005133s  reason:"waiting"
//   call 2, five seconds later     [200] time_total=0.000983s  session5hPct:37
//   `claude` spawns for both       1
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const world = vi.hoisted(() => ({
  /** Every `run(cmd, args)` the module made. */
  calls: [] as string[][],
  /** What the next `run` answers WITH, once `let go` is called. Held open
   *  until then, which is how a slow Claude Code is spelled without a clock. */
  reply: { ok: true, code: 0, stdout: "", stderr: "" } as Record<string, unknown>,
  /** Resolved by the test to let every held `run` finish. */
  release: null as null | (() => void),
  held: null as null | Promise<void>,
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    run: async (cmd: string, args: string[] = []) => {
      world.calls.push([cmd, ...args]);
      if (world.held) await world.held;
      return { killed: false, timedOut: false, ...world.reply };
    },
  };
});

// The two sources ahead of the CLI, made to answer nothing — which is what
// sends _doFetch down to source 3, the only one with a cost worth bounding.
// Same arrangement as quota-quiet-failure.test.ts, for the same reason.
vi.mock("../../server/claude-accounts.mjs", () => ({
  activeAccountUsage: async () => null,
  requestCollection: async () => false,
}));

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-quota-deadline-"));
vi.mock("../../server/claude-dir.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, claudeConfigDir: () => SANDBOX, claudeCliCandidates: () => ["claude"] };
});

// @ts-expect-error — a plain .mjs module, no types
const quota = await import("../../server/quota.mjs");
const {
  fetchClaudeQuota, invalidateQuotaCache, forgetQuotaFailureNotice,
  resetQuotaPollFloor, QUOTA_DEADLINE_MS,
} = quota;

// Nothing here talks to a network, and a test that quietly did would be a test
// whose result depends on the machine it ran on.
const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("no network in this test"); }) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; rmTempDir(SANDBOX); });

/** The panel's shape, as far as this file needs it. */
type Quota = { ok: boolean; reason?: string; session5hPct?: number; fetchedAt: number; stale?: boolean };

/** What a Claude Code that answers looks like on stdout. */
const USAGE = "Claude Code usage\n"
  + "Current session: 37% used (resets in 2h 14m)\n"
  + "Current week: 11% used (resets in 4d)\n";

/** Hold every `run` open until the returned function is called. */
function holdTheCli() {
  let release!: () => void;
  world.held = new Promise<void>(r => { release = r; });
  world.release = () => { world.held = null; release(); };
  return world.release;
}

const claudeRuns = () => world.calls.filter(c => c.includes("/usage"));

beforeEach(() => {
  world.calls.length = 0;
  world.reply = { ok: true, code: 0, stdout: USAGE, stderr: "" };
  world.held = null;
  world.release = null;
  forgetQuotaFailureNotice();
  resetQuotaPollFloor();
  invalidateQuotaCache();
});

// The deadline these cases hand in. Short enough that waiting it out costs
// nothing; the five seconds the ROUTE spends is asserted separately, below.
const SOON = 80;

/**
 * A bounded answer, or a sentence saying one never came.
 *
 * The regression here is a promise that NEVER settles, and a test which merely
 * awaits one hangs until the suite's own budget expires — reported as a timeout,
 * on whichever file the runner happened to be in, rather than as this rule being
 * broken. So the wait is capped here instead, and the cap is what gets asserted
 * against.
 *
 * Deliberately far above SOON rather than just above it. What these cases claim
 * is that the wait is bounded AT ALL — the difference between five seconds and
 * forever — and not that an 80ms timer fires within 80ms on the third operating
 * system of a loaded CI matrix. A ceiling pinned near the deadline would fail
 * there for scheduling reasons and teach everyone to re-run it, and a flaky
 * ceiling bounds nothing.
 */
const SILENCE = "the read was never bounded — the caller is still waiting";
const PATIENCE = 5_000;
const orSilence = <T>(p: Promise<T>): Promise<T | string> =>
  Promise.race([p, new Promise<string>(r => { setTimeout(() => r(SILENCE), PATIENCE); })]);

describe("a read that outlives the caller's patience", () => {
  it("answers when the deadline says, not when the CLI does", async () => {
    // The whole of #1011 in one case: the read is held open for as long as this
    // test likes — standing in for three spawns and two sleeps — and the answer
    // still arrives. Without a deadline the `await` below never returns until
    // the release at the end, which is what 47 seconds felt like.
    const letGo = holdTheCli();
    const read = fetchClaudeQuota();               // no deadline: the raw read
    const started = Date.now();
    const answer = await orSilence(fetchClaudeQuota({ deadlineMs: SOON }));
    const spent = Date.now() - started;

    expect(answer, "not yet, rather than a held connection")
      .toMatchObject({ ok: false, reason: "waiting" });
    expect(spent, "bounded by the deadline, whatever the CLI is doing")
      .toBeLessThan(PATIENCE * 2);

    letGo();
    await read;
  });

  it("does not cancel the read — it publishes, and the next caller gets it", async () => {
    // The half that makes the deadline affordable. A cancel would spend a whole
    // `claude --print /usage` and throw the numbers away, against a budget of
    // 28-30 requests an hour that claude-swap is also drawing on. So the answer
    // the caller did not wait for is still collected, still cached, and still
    // the one the panel's next poll renders.
    const letGo = holdTheCli();
    const read = fetchClaudeQuota();
    expect(await orSilence(fetchClaudeQuota({ deadlineMs: SOON }))).toMatchObject({ reason: "waiting" });

    letGo();
    expect(await read, "the read finished behind the deadline")
      .toMatchObject({ ok: true, session5hPct: 37, week7dPct: 11 });
    expect(await fetchClaudeQuota({ deadlineMs: SOON }), "and it is what the cache now holds")
      .toMatchObject({ ok: true, session5hPct: 37 });
    expect(claudeRuns(), "one Claude Code for all three callers").toHaveLength(1);
  });

  it("bounds the caller who JOINS a read as well as the one who starts it", async () => {
    // The door the panel actually walks through. `_inflight` hands a second
    // caller the promise the first one is waiting on, so joining a read that
    // began 46 seconds ago was the same 47-second wait reached the other way —
    // and with a 60-second poll against a 47-second read, the arrival of a
    // request into an already-running one is the ordinary case, not the corner.
    const letGo = holdTheCli();
    const read = fetchClaudeQuota();
    const started = Date.now();
    const both = await orSilence(Promise.all([
      fetchClaudeQuota({ deadlineMs: SOON }),
      fetchClaudeQuota({ deadlineMs: SOON }),
    ]));
    expect(both, "both joiners answered").not.toBe(SILENCE);
    expect(Date.now() - started).toBeLessThan(PATIENCE * 2);
    for (const answer of both as Quota[]) expect(answer).toMatchObject({ ok: false, reason: "waiting" });
    expect(claudeRuns(), "and neither joiner spawned its own").toHaveLength(1);

    letGo();
    await read;
  });

  it("hands back the numbers it already holds rather than saying nothing", async () => {
    // A panel that has been showing 37% for a minute must not blank to "Quota
    // unavailable" because one read ran long. This is the same answer, in the
    // same shape, that the poll-floor branch of _doFetch already gives for the
    // same question — the freshest real reading, marked stale.
    await fetchClaudeQuota({ force: true });       // one good read, cached
    const letGo = holdTheCli();
    resetQuotaPollFloor();
    const read = fetchClaudeQuota({ force: true });

    const answer = await orSilence(fetchClaudeQuota({ force: true, deadlineMs: SOON }));
    expect(answer).toMatchObject({ ok: true, session5hPct: 37, stale: true });

    letGo();
    await read;
  });

  it("dates held numbers when they were taken, never when they were handed over", async () => {
    // quota-held-age.test.ts's rule, and a deadline is not a licence to break
    // it: re-stamping a held reading `now` puts "just now" over percentages
    // collected earlier, and the label then snaps back to the true age on the
    // next poll. An age indicator that oscillates vouches for numbers this
    // branch already knows are stale.
    const good = await fetchClaudeQuota({ force: true });
    const letGo = holdTheCli();
    resetQuotaPollFloor();
    const read = fetchClaudeQuota({ force: true });

    const held = await orSilence(fetchClaudeQuota({ force: true, deadlineMs: SOON })) as Quota;
    expect(held.fetchedAt).toBe(good.fetchedAt);

    letGo();
    await read;
  });

  it("waits as long as it takes when nobody asked for a deadline", async () => {
    // Every internal caller, and every test that drives the chain end to end,
    // wants the answer rather than a budget. An opt-in default is what keeps
    // this change to the one caller that has a connection open on the far side.
    const letGo = holdTheCli();
    let settled = false;
    const read = fetchClaudeQuota().then((r: unknown) => { settled = true; return r; });
    await new Promise(r => setTimeout(r, SOON * 3));
    expect(settled, "no deadline asked for, so none applied").toBe(false);

    letGo();
    expect(await read).toMatchObject({ ok: true, session5hPct: 37 });
  });
});

describe("the budget the route spends", () => {
  it("is five seconds", () => {
    // Not a guess at how long the CLI takes. A sandbox with a real `claude` and
    // no credentials answered in 4.19s and 4.52s, which is the slow end of the
    // good case — and the good case is already served from claude-swap's store
    // or the OAuth API in milliseconds. What is left above five seconds is a
    // CLI in trouble, and "not yet" is the honest thing to say about it.
    expect(QUOTA_DEADLINE_MS).toBe(5_000);
  });

  it("is what /api/quota actually passes", () => {
    // The route is where the 47 seconds were spent, so the route is where this
    // has to be read out of. A deadline the module offers and no caller uses
    // leaves the connection pinned exactly as before.
    const server = readFileSync(
      fileURLToPath(new URL("../../server/index.mjs", import.meta.url)), "utf8");
    expect(server).toContain("await fetchClaudeQuota({ force, deadlineMs: QUOTA_DEADLINE_MS })");
  });

  it("is matched by a client that gives up too", () => {
    // `useQuota` sent a bare `fetch(url)`, which has no deadline of any kind: a
    // request nobody will ever answer is held until the tab closes. The server
    // now bounds itself, so this is the outer net for a deck on a bad day —
    // comfortably above the server's five seconds rather than racing it, since
    // a client deadline that beat the answer would turn a slow success into a
    // failure.
    const panel = readFileSync(
      fileURLToPath(new URL("../components/UsagePanel.tsx", import.meta.url)), "utf8");
    expect(panel).toContain("await fetch(url, { signal: AbortSignal.timeout(QUOTA_REQUEST_MS) })");
  });
});
