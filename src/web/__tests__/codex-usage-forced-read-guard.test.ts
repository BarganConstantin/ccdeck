// #600. The third endpoint of a shape this repo has now fixed twice.
//
// Reads on this server are deliberately open. `isTrustedRead` does not apply the
// `Sec-Fetch-Site` test that `isTrustedMutation` does, and the comment above it
// explains why: a cross-site read of `http://127.0.0.1:4317` is an ordinary
// top-level navigation and not an attack. #544 accepted that and put a ceiling on
// what `/api/ccusage` and `/api/system/processes` may COST — read-cost-ceiling
// .test.ts. #580 put a floor under `/api/codex-quota`, whose cost is not local at
// all but the user's ChatGPT session — codex-forced-read-floor.test.ts.
// `/api/codex-usage` got neither, and its admission control was one line:
//
//     if (!force && _cache && now - _cacheAt < CACHE_MS) return _cache;
//
// What one forced call buys is `listRolloutFiles(WINDOW_7D_MS)` and then a read
// of every rollout file that walk returns. Measured on this repo's machine
// against 280 rollouts of ~90KB each — a week of ordinary Codex use — one forced
// call is 685ms, 280 file opens, and a peak of four descriptors. The cost of N of
// them was exactly N times that, because nothing bounded how many were running:
// 16 concurrent forced reads were 4,480 opens and 64 descriptors; 128 were 35,840
// opens, 512 descriptors and 54.7 seconds of wall time.
//
// So any page the user has open could run
//
//     for (;;) fetch("http://127.0.0.1:4317/api/codex-usage?refresh=1",
//                    { mode: "no-cors" });
//
// and get a full-week walk of the user's disk per request, concurrently.
// `forEachLimited(files, MAX_PARALLEL_READS, …)` exists precisely because opening
// a week of rollouts at once risked EMFILE — and it bounds the fan-out INSIDE one
// call only, so unbounded calls let that EMFILE back in through the door the pool
// does not cover. Its failure mode is the bad kind: `readTokenSeries` catches and
// returns null, so an exhausted descriptor table shows up as a token count that is
// quietly too low rather than as an error anybody sees.
//
// ── why the suite missed it ─────────────────────────────────────────────────
//
// codex-usage-bounded-reads.test.ts pinned the fan-out within one call, under a
// header note that read "Every call below passes `force: true` — the same thing
// /api/codex-usage does for ?refresh=1". That reads `force` as a settled property
// of the route. It is not: it is an argument the CALLER supplies, once per
// request and as often as it likes. Believing the first reading is why that file
// asked what one forced scan costs and never asked what a hundred of them cost.
// The note is corrected there; the question it did not ask is asked here.
//
// ── why this file is shaped this way ────────────────────────────────────────
//
// The assertions are behavioural: nothing below reads `_lastScanAt` or a counter
// out of the module. What a guard MEANS is how many walks of the disk happen and
// what the caller is handed instead, so the walks are counted at the filesystem —
// every `open` the module performs, and the most it ever held at once — and the
// refusal is asserted as the shape the panel receives.
//
// The clock is moved rather than waited on, the way read-cost-ceiling.test.ts and
// codex-forced-read-floor.test.ts move it: a case that slept out a sixty-second
// floor would be a minute of CI apiece. Every case gets a FRESH module, because
// the floor and the cache are module state and a case that inherited the previous
// one's stamp would be asserting the previous one's history.
//
// The last describe is a census rather than a case, and it is the part of this
// change that is not about Codex at all. Three endpoints have now needed the same
// guard and each was written separately, which is why the third went unnoticed for
// as long as it did. The census enumerates every route that lets a caller say
// `?refresh=1`, resolves the module and function each one forces, and records what
// each of those modules keeps between a forced caller and the work — the way
// cswap-argv-position.test.ts enumerates argv slots rather than testing the two
// fields somebody happened to name. There turn out to be six such routes, not
// three.
//
// It earned its keep immediately: the two routes it found that were in nobody's
// list — `/api/version` and `/api/claude-accounts` — were reported as #604 and
// fixed there, and their rows below record what they hold now rather than the
// gap they held when this file was written.
//
// PLAIN NODE, no DOM. Everything is read out of a temp CODEX_HOME seeded by this
// file, and both home variables are redirected before the module loads, so no
// case here can reach the real ~/.codex of whoever is running the suite.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withoutComments } from "./tsx-scan";

// The filesystem, counted. `opens` is one walk's worth of work — the module opens
// each rollout exactly once — and `peakOpen` is the descriptor pressure the pool
// exists to bound. Hoisted because a vi.mock factory runs before the module body.
const probe = vi.hoisted(() => ({
  open: 0,
  peakOpen: 0,
  opens: 0,
  reset() { this.open = 0; this.peakOpen = 0; this.opens = 0; },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const fh = await actual.open(...args);
      probe.open++;
      probe.opens++;
      probe.peakOpen = Math.max(probe.peakOpen, probe.open);
      const close = fh.close.bind(fh);
      Object.assign(fh, { close: () => { probe.open--; return close(); } });
      return fh;
    },
  };
});

// The sandbox goes in before any import of the module under test: codex-dir.mjs
// resolves CODEX_HOME once, at module load.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-600-usage-guard-"));
const CODEX_HOME = join(DIR, "codex-home");
const SESSIONS = join(CODEX_HOME, "sessions");
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CODEX_HOME = CODEX_HOME;
if (!resolve(CODEX_HOME).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// FROZEN, not merely offset. The cases below are written to the millisecond
// either side of the floor, and a clock still running underneath would add the
// milliseconds each `await` really took to every measurement — "one short of it"
// would drift over the line on a slow machine and pass for the wrong reason on a
// fast one. `budget.ts` captured the real `Date.now` at load, so the skew here
// cannot make a case look as though it overran.
let skew = 0;
const FROZEN_AT = Date.now();
vi.spyOn(Date, "now").mockImplementation(() => FROZEN_AT + skew);
const advance = (ms: number) => { skew += ms; };

// The floor's own number, restated once so the cases read as intentions rather
// than as arithmetic. It is quota.mjs's FORCE_POLL_MS and codex-quota.mjs's,
// which is the point of it.
const FLOOR_MS = 60_000;

// An hour before the frozen instant: inside both the 5h and the 7d window, and
// far enough from either edge that the few minutes a run of cases skews the clock
// cannot move a file out of the window it was written into.
const AT = new Date(FROZEN_AT - 60 * 60 * 1000);

/** One cumulative token_count event, the only line kind this module folds. */
function tokenCount(total: number): string {
  return JSON.stringify({
    timestamp: AT.toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: total, output_tokens: 0, cached_input_tokens: 0, total_tokens: total,
        },
      },
    },
  }) + "\n";
}

/** A week of rollouts, in the sessions/<year>/<month>/<day> layout the walker
 *  expects. Rebuilt from nothing per case, so a count is never inherited. */
const FILES = 12;
function seedRollouts(count = FILES): void {
  rmTempDir(SESSIONS);
  const [date, time] = AT.toISOString().slice(0, 19).split("T");
  const [y, m, d] = date.split("-");
  const dir = join(SESSIONS, y, m, d);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    // Dashes in the time part — the filename shape is Windows-safe by design.
    const name = `rollout-${date}T${time.replace(/:/g, "-")}-session-${String(i).padStart(2, "0")}.jsonl`;
    writeFileSync(join(dir, name), tokenCount(1_000), "utf8");
  }
}

/** The module under test, with no memory of the previous case. */
async function freshModule() {
  vi.resetModules();
  // @ts-expect-error — .mjs server module, no types
  return await import("../../server/codex-usage.mjs");
}

beforeEach(() => {
  seedRollouts();
  probe.reset();
  // Each case starts past the floor of whatever the last one did, so a fresh
  // module's very first read is never the one being refused.
  advance(FLOOR_MS + 1_000);
});

afterAll(() => {
  vi.restoreAllMocks();
  for (const k of ["HOME", "USERPROFILE", "CODEX_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

describe("mayScanUsage, the rule on its own", () => {
  it("is the same shape and the same minute as the two endpoints beside it", async () => {
    const { mayScanUsage } = await freshModule();
    const now = 10_000_000;
    expect(mayScanUsage({ now, lastScanAt: now - FLOOR_MS })).toBe(true);
    expect(mayScanUsage({ now, lastScanAt: now - (FLOOR_MS - 1) })).toBe(false);
    // Nothing has ever been scanned in this process, so the first read goes.
    expect(mayScanUsage({ now, lastScanAt: 0 })).toBe(true);
  });
});

describe("a burst of forced reads, the shape any open page can produce", () => {
  it("costs one walk of the week however many times it is asked in a row", async () => {
    // The issue's own reproduction, sequential — the case an in-flight guard
    // alone never covers, because every turn waits for the last one to settle
    // before asking again. Twelve turns used to be twelve full-week walks.
    const { fetchCodexUsage } = await freshModule();
    const first = await fetchCodexUsage({ force: true });
    expect(first.ok).toBe(true);
    expect(probe.opens).toBe(FILES);

    for (let i = 0; i < 11; i++) await fetchCodexUsage({ force: true });
    expect(probe.opens, "twelve forced reads, one walk of the disk").toBe(FILES);
  });

  it("hands concurrent callers the one walk already running rather than starting theirs", async () => {
    // Five tabs mounting at once, or one loop that does not wait. Before #600
    // this was five simultaneous walks of the same tree, each with its own pool
    // of open descriptors.
    const { fetchCodexUsage } = await freshModule();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => fetchCodexUsage({ force: true })),
    );

    expect(probe.opens).toBe(FILES);
    // The same object, not merely an equal one — they were one scan.
    for (const r of results) expect(r).toBe(results[0]);
    expect(results[0].ok).toBe(true);
    expect(results[0].window7d.sessionCount).toBe(FILES);
  });

  it("keeps the per-call descriptor bound the pool exists for, across calls as well as within one", async () => {
    // The bound codex-usage-bounded-reads.test.ts pins is MAX_PARALLEL_READS
    // inside ONE call. This is the same number asserted of the whole process
    // while sixteen forced reads are outstanding, which is what an unguarded
    // module turned into sixteen times MAX_PARALLEL_READS — measured at 64
    // descriptors for sixteen callers and 512 for a hundred and twenty-eight.
    // EMFILE here is not an error anybody sees: readTokenSeries catches it and
    // returns null, so the panel would show a number that is simply too low.
    const { fetchCodexUsage } = await freshModule();
    await Promise.all(Array.from({ length: 16 }, () => fetchCodexUsage({ force: true })));

    expect(probe.peakOpen).toBeGreaterThan(0);
    expect(probe.peakOpen, "sixteen callers, one pool").toBeLessThanOrEqual(8);
    expect(probe.open, "and nothing left open").toBe(0);
  });

  it("walks again once the floor has elapsed, because refresh still means refresh", async () => {
    // A floor is not a mute button. What it may not do is let the button turn
    // into a poll loop when it is held down.
    const { fetchCodexUsage } = await freshModule();
    await fetchCodexUsage({ force: true });
    expect(probe.opens).toBe(FILES);

    advance(FLOOR_MS - 1);
    await fetchCodexUsage({ force: true });
    expect(probe.opens, "one millisecond short of the floor").toBe(FILES);

    advance(1);
    const fresh = await fetchCodexUsage({ force: true });
    expect(probe.opens, "and exactly on it").toBe(FILES * 2);
    expect(fresh.ok).toBe(true);
    expect(fresh.stale).toBeUndefined();
  });
});

describe("what a refused forced read is handed", () => {
  it("is the reading it already has, not an error", async () => {
    // The half of the fix that decides whether this is a defence or a second
    // bug. The panel draws the 7-day token line from `ok && window7d
    // .sessionCount > 0`, so a refusal returned as `{ ok: false }` would make
    // that line disappear for a minute — the deck teaching itself a new failure
    // mode in order to defend against a loop nobody ran.
    const { fetchCodexUsage } = await freshModule();
    const first = await fetchCodexUsage({ force: true });
    expect(first.ok).toBe(true);

    advance(1_000);
    const again = await fetchCodexUsage({ force: true });

    expect(again.ok).toBe(true);
    expect(again.reason).toBeUndefined();
    expect(again.window7d).toEqual(first.window7d);
    expect(again.window5h).toEqual(first.window5h);
    expect(probe.opens).toBe(FILES);
  });

  it("says it is stale, and keeps the timestamp of the data rather than of the read", async () => {
    // `fetchedAt` is what an age label is drawn from. Re-stamping it `now` would
    // put "just now" over numbers nobody re-read — quota.mjs learned that one
    // first, and codex-quota.mjs restates it.
    const { fetchCodexUsage } = await freshModule();
    const first = await fetchCodexUsage({ force: true });

    advance(30_000);
    const again = await fetchCodexUsage({ force: true });

    expect(again.stale).toBe(true);
    expect(first.stale).toBeUndefined();
    expect(again.fetchedAt).toBe(first.fetchedAt);
    // And the cache entry itself was not edited on the way past: the next
    // caller to get a real answer must not inherit a `stale` flag.
    expect(first.stale).toBeUndefined();
  });

  it("does not refuse a caller who has never been handed anything", async () => {
    // A fresh process's first read is never refused, whatever the clock says —
    // otherwise a deck that has just booted would answer `{ ok: false }` to the
    // panel's first poll and show nothing for a minute.
    const { fetchCodexUsage } = await freshModule();
    const first = await fetchCodexUsage({ force: true });
    expect(first.ok).toBe(true);
    expect(first.window7d.sessionCount).toBe(FILES);
  });
});

describe("the unforced background poll, which the guard must not break", () => {
  it("is answered from the cache and walks nothing, as it always did", async () => {
    const { fetchCodexUsage } = await freshModule();
    const first = await fetchCodexUsage({ force: true });

    advance(30_000);
    const polled = await fetchCodexUsage();
    expect(polled).toBe(first);              // the cache entry itself, untouched
    expect(probe.opens).toBe(FILES);
  });

  it("goes out again once its own cache has expired, which the floor must not outlive", async () => {
    // CACHE_MS and FORCE_POLL_MS are the same minute and both run from the same
    // instant, so a poll arriving with an expired cache is always past the floor
    // as well. Asserted rather than reasoned about: a floor that outlived the
    // cache would freeze the panel on the first reading it ever took. UsagePanel
    // polls this endpoint every 60s and never sends ?refresh=1 at all, so this
    // is the only path the feature actually uses.
    const { fetchCodexUsage } = await freshModule();
    await fetchCodexUsage({ force: true });

    advance(FLOOR_MS + 1_000);
    const polled = await fetchCodexUsage();
    expect(probe.opens).toBe(FILES * 2);
    expect(polled.ok).toBe(true);
    expect(polled.stale).toBeUndefined();
  });
});

// ── the census ──────────────────────────────────────────────────────────────
//
// Five endpoints have now needed this guard and each got its own hand-written
// copy, which is why nobody noticed the third was missing and why nobody had
// looked at the fourth and fifth at all. The durable answer to that is not a
// sixth copy and — see #604's pull request, which re-tested the question at six
// routes rather than inheriting #600's answer at three — not a shared helper
// either. What the five share is a three-line sequence, `cache → join → floor`,
// and what they do not share is everything around it: quota.mjs carries
// `_lastGood`, a 429 cooldown, a self-poll floor with a second interval and a
// generation guard; codex-quota.mjs a refresh-token cooldown; self-update.mjs a
// window that lives in a FILE shared between processes, with a retry window and
// a pending-version window on top of it and a version string rather than a
// reading as its answer; claude-accounts.mjs a generation guard of its own, for
// the nine call sites that invalidate it. A helper covering the common part would
// fit two of the six cleanly and would have to be escaped from by the other four,
// and it would not have prevented a single one of the omissions — every one of
// them was a route nobody had counted.
//
// So this block enumerates instead of asserting about the endpoints somebody
// happened to name. It reads index.mjs, finds every handler that turns
// `?refresh=1` into a `force` argument, resolves the module and the exported
// function each one forces, and then reads those modules and records what each
// keeps between a forced caller and the work.
//
// The table below is a census of what IS, not a list of what is permitted — with
// one rule on top of it, which is the part that stands in for the helper: a
// forcible route either has a floor, or carries a written reason it does not need
// one. `/api/ccusage` is the single exemption and its reason is on its row. A row
// that stops matching — because an endpoint gained a guard, or lost one — is the
// census asking to be updated, and updating it is a one-line edit.

/** Read a server module the way the rest of this suite reads them. */
const serverSource = (name: string): string =>
  readFileSync(new URL(`../../server/${name}`, import.meta.url), "utf8");

/**
 * What a module keeps between a forced caller and the work.
 *
 * Deliberately only the mechanisms that SURVIVE `force`. Every one of these
 * modules has a TTL cache, and the cache is precisely the thing `?refresh=1`
 * walks past, so listing it would say nothing about the question being asked.
 *
 * Detected by the names the repo has settled on, which is half the point: three
 * modules spelling one idea three ways is how the third came to be missing, and
 * a fourth that wants a floor should spell it `FORCE_POLL_MS` too. Comments come
 * out first — every one of these files discusses the others in prose.
 */
function guardsSurvivingForce(source: string): string[] {
  const code = withoutComments(source);
  const found: string[] = [];
  // A promise slot a concurrent caller is handed instead of starting its own.
  if (/\b_inflight\b/.test(code)) found.push("inflight");
  // A minimum interval between two reads we pay for. quota.mjs's constant,
  // adopted by codex-quota.mjs in #597 and by codex-usage.mjs in #600.
  if (/\bFORCE_POLL_MS\b/.test(code)) found.push("floor");
  // A hard ceiling on distinct runs accepted at once, with a refusal returned in
  // the shape the caller already renders. ccusage.mjs's, from #544.
  if (/\bMAX_OUTSTANDING\b/.test(code)) found.push("outstanding");
  return found.sort();
}

/** Every route that lets its caller say `?refresh=1`, read out of the router. */
function forcedReadRoutes(indexSource: string) {
  const code = withoutComments(indexSource);
  // Handler bodies, sliced between one `async function handleX(` and the next.
  const marks = [...code.matchAll(/\basync function (handle[A-Za-z0-9_]*)\s*\(/g)]
    .map(m => ({ name: m[1], at: m.index! }));
  const rows = [];
  for (let i = 0; i < marks.length; i++) {
    const body = code.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : code.length);
    if (!/searchParams\.get\("refresh"\)\s*===\s*"1"/.test(body)) continue;

    const modules = [...body.matchAll(/src\/server\/([A-Za-z0-9-]+\.mjs)/g)].map(m => m[1]);
    // The function the handler hands `force` to, whether that is written as its
    // own statement or inline inside a `send(…)`.
    const forced = [...body.matchAll(/\b([A-Za-z0-9_]+)\(\s*\{[^}]*\bforce\b/g)].map(m => m[1]);
    const route = [...code.matchAll(
      new RegExp(`req\\.method === "(\\w+)"\\s*&& url\\.pathname === "([^"]+)"[^\\n]*\\b${marks[i].name}\\(`, "g"),
    )].map(m => ({ method: m[1], path: m[2] }));
    rows.push({ handler: marks[i].name, modules, forced, route });
  }
  return rows;
}

/**
 * The census. One row per route that accepts `?refresh=1`.
 *
 * `predicate` is the exported rule that applies the floor — the one name per
 * module a test can point at, and the one place FORCE_POLL_MS is turned into a
 * yes or a no. `insteadOfFloor` is the only way a row is allowed to have no
 * floor at all, and it has to say what bounds the cost instead.
 */
const CENSUS: Record<string, {
  module: string; fn: string; guards: string[]; note: string;
  predicate?: string; insteadOfFloor?: string;
}> = {
  "/api/version": {
    module: "self-update.mjs", fn: "versionReport", guards: ["floor", "inflight"],
    predicate: "mayAskNpm",
    note: "#604. Joined a check already running, but `checkDue` returns true on "
        + "`force` before anything else is asked, so a sequential ?refresh=1 loop "
        + "was one npm registry GET per request — #580's shape with the cost "
        + "pointed at a third party. The floor is in memory rather than in the "
        + "marker file, because a home directory that cannot be written makes the "
        + "marker's hour vanish and would take the floor with it.",
  },
  "/api/quota": {
    module: "quota.mjs", fn: "fetchClaudeQuota", guards: ["floor", "inflight"],
    predicate: "maySelfPoll",
    note: "The original. Also carries a 429 cooldown, a longer self-poll floor in "
        + "the same predicate, `_lastGood` and the generation guard #582 added — "
        + "the four parts that keep this from being a helper the others could "
        + "share.",
  },
  "/api/codex-usage": {
    module: "codex-usage.mjs", fn: "fetchCodexUsage", guards: ["floor", "inflight"],
    predicate: "mayScanUsage",
    note: "#600. Had neither until that change; one forced read is a walk of "
        + "every rollout file of the last seven days.",
  },
  "/api/codex-quota": {
    module: "codex-quota.mjs", fn: "fetchCodexQuota", guards: ["floor", "inflight"],
    predicate: "mayFetchQuota",
    note: "#580/#597. Plus a cooldown set from a 429 or a rejected refresh, "
        + "because what a forced read spends here is the user's ChatGPT session.",
  },
  "/api/browser-watch": {
    module: "browser-watch.mjs", fn: "fetchBrowserWatch", guards: ["floor", "inflight"],
    predicate: "mayForceRead",
    note: "Browser Watch. One forced read drops the mtime cache and COPIES every "
        + "Chromium profile's History database, because the live file is locked "
        + "while the browser holds it — 21MB and 168ms for one browser on the "
        + "machine this was tuned on, and a history only grows. The cost is the "
        + "user's own disk rather than a third party's API, which is the one way "
        + "it is gentler than #580's shape and no reason at all to leave it "
        + "unbounded: a page they are not looking at can send this in a loop.",
  },
  "/api/ccusage": {
    module: "ccusage.mjs", fn: "fetchCcusageDaily", guards: ["inflight", "outstanding"],
    insteadOfFloor:
      "MAX_OUTSTANDING plus a queue. The cost here is keyed by range rather than "
      + "shared, so a ceiling on distinct runs in flight bounds it harder than an "
      + "interval would — an interval would have to be per key, and the key space "
      + "is 10^8.",
    note: "#544. The one row with no floor, and the only exemption this census "
        + "grants; see insteadOfFloor.",
  },
  "/api/claude-accounts": {
    module: "claude-accounts.mjs", fn: "fetchClaudeAccounts", guards: ["floor", "inflight"],
    predicate: "mayReadAccounts",
    note: "#604. Had a 5s cache and nothing else. The work is two local JSON "
        + "reads plus a throttled collector nudge, so it is the cheapest of the "
        + "six by a wide margin and was fixed for the shape rather than the cost "
        + "— except for one part that is not shape at all: it is the only one of "
        + "the six whose cache is invalidated from outside, from nine call sites "
        + "in four modules, so the in-flight slot arrived with #582's generation "
        + "guard rather than without it.",
  },
};

describe("every route that lets a caller force a read", () => {
  const discovered = forcedReadRoutes(serverSource("index.mjs"));

  it("is one of exactly seven, and an eighth has to be named here before it ships", () => {
    // The assertion #600 is really about. Nobody was counting: `?refresh=1` was
    // added an endpoint at a time and each one decided for itself what a forced
    // read costs, so the answer to "which of them has a guard" lived nowhere.
    // A new forced-read route fails this line by name.
    expect(discovered.map(r => r.route[0]?.path).sort()).toEqual(Object.keys(CENSUS).sort());
  });

  it("is a GET, which is why any page the user has open can send it", () => {
    // The premise under all of this. A GET needs no CORS, no preflight and no
    // ability to read the response, and `isTrustedRead` deliberately does not
    // apply the `Sec-Fetch-Site` test that would stop one.
    for (const row of discovered) {
      expect(row.route, `${row.handler} is routed exactly once`).toHaveLength(1);
      expect(row.route[0].method, row.handler).toBe("GET");
    }
  });

  for (const [path, expected] of Object.entries(CENSUS)) {
    describe(path, () => {
      const row = discovered.find(r => r.route[0]?.path === path);

      it(`hands ?refresh=1 to ${expected.fn} in ${expected.module}`, () => {
        // The fact codex-usage-bounded-reads.test.ts's header note used to deny.
        // The route does not force anything on its own — it passes through
        // whatever the caller asked for.
        expect(row, `${path} is routed by a handler that reads ?refresh=1`).toBeTruthy();
        expect(row!.modules).toContain(expected.module);
        expect(row!.forced).toContain(expected.fn);
      });

      it(`keeps ${expected.guards.length ? expected.guards.join(" + ") : "nothing"} between a forced caller and the work`, () => {
        // A row that stops matching is the census asking to be updated — see the
        // note above the table. `expected.note` says why this row reads as it
        // does; it is asserted on nowhere, and it is the reason the row is
        // trustworthy.
        expect(expected.note.length, `${path} needs a reason on record`).toBeGreaterThan(0);
        expect(guardsSurvivingForce(serverSource(expected.module))).toEqual(expected.guards);
      });
    });
  }

  it("has a floor, or a written reason it does not need one", () => {
    // The rule that stands in for the shared helper, and the one assertion here
    // that is about what SHOULD be rather than what is. Every guard in this table
    // was written after somebody read that one file and noticed, and each of the
    // routes that had none went unnoticed for as long as it did because nothing
    // anywhere said a forcible route owes an answer to this question. Now
    // something does.
    //
    // A seventh route has to be named in this table before it ships — the first
    // case above is what says so — and this line is what it then has to satisfy:
    // apply the rule, or write down what bounds the cost instead. That is the
    // whole of what a helper would have enforced, minus the four escape hatches a
    // helper would have needed.
    for (const [path, row] of Object.entries(CENSUS)) {
      if (row.guards.includes("floor")) continue;
      expect(row.insteadOfFloor?.length ?? 0,
             `${path} has no floor and no recorded reason it does not need one`)
        .toBeGreaterThan(0);
    }
    // And the exemption stays rare enough to read: one row, not a habit.
    expect(Object.values(CENSUS).filter(r => !r.guards.includes("floor")))
      .toHaveLength(1);
  });

  it("spells one idea one way across every module that has it", () => {
    // The other half of "a missing call rather than a missing idea". Five modules
    // invented the same floor separately; they at least agree on its name and its
    // number now, and a sixth that needs one has a name to reuse.
    const withFloor = Object.values(CENSUS).filter(r => r.guards.includes("floor"));
    expect(withFloor.map(r => r.module).sort()).toEqual([
      "browser-watch.mjs", "claude-accounts.mjs", "codex-quota.mjs",
      "codex-usage.mjs", "quota.mjs", "self-update.mjs",
    ]);
    for (const row of withFloor) {
      expect(withoutComments(serverSource(row.module)), row.module)
        .toMatch(/const FORCE_POLL_MS = 60_000;/);
    }
  });

  it("applies that floor in one exported, testable rule per module", () => {
    // `maySelfPoll`, `mayFetchQuota`, `mayScanUsage`, `mayAskNpm`,
    // `mayReadAccounts`: five spellings of one idea, which is the strongest
    // argument the helper case has and still not enough of one — see the note
    // above the table. What they do share is a shape, and the shape is worth
    // pinning: the decision is pure, it is exported so a test can drive it
    // without driving the work it guards, and the module's floor lives in it
    // rather than inline at the call site that applies it. A floor written into
    // the entry point instead would fail this line.
    for (const row of Object.values(CENSUS)) {
      if (!row.guards.includes("floor")) continue;
      const code = withoutComments(serverSource(row.module));
      const at = code.indexOf(`export function ${row.predicate}(`);
      expect(at, `${row.module} exports ${row.predicate}`).toBeGreaterThan(-1);
      const end = code.indexOf("\n}", at);
      const body = end === -1 ? code.slice(at) : code.slice(at, end + 2);
      expect(body, `${row.predicate} is where ${row.module} reads FORCE_POLL_MS`)
        .toMatch(/\bFORCE_POLL_MS\b/);
    }
  });
});
