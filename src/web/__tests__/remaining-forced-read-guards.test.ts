// #604. The last two routes of a shape this repo has now fixed four times, and
// the first two it did not have to read a file to find.
//
// Reads on this server are deliberately open. `isTrustedRead` does not apply the
// `Sec-Fetch-Site` test that `isTrustedMutation` does, because a cross-site read
// of `http://127.0.0.1:4317` is an ordinary top-level navigation and not an
// attack. #544 put a ceiling on what `/api/ccusage` and `/api/system/processes`
// may COST, #580 put a floor under `/api/codex-quota`, and #600 put one under
// `/api/codex-usage` — and then #600 stopped writing endpoints down one at a
// time and counted instead. The census at the end of
// codex-usage-forced-read-guard.test.ts reads the router, finds every handler
// that turns `?refresh=1` into a `force` argument, and records what each module
// keeps between a forced caller and the work. It found six routes, not three.
// These are the two it found that were in nobody's list.
//
// ── /api/version ────────────────────────────────────────────────────────────
//
// self-update.mjs already dedupes callers who overlap: `_inflight` is a Map
// keyed by package name, and two tabs mounting at once share one lookup. What it
// had no answer for is a caller that WAITS. `checkDue` returns `true` on `force`
// before it asks anything else, so
//
//     (async function spin() {
//       for (;;) await fetch("http://127.0.0.1:4317/api/version?refresh=1",
//                            { mode: "no-cors" });
//     })();
//
// was one `https://registry.npmjs.org/-/package/<name>/dist-tags` per request,
// as fast as the round trip allows, plus a second request to the version
// document every time the tag moves. That is #580's shape with the cost pointed
// outwards: the requests are ~20 bytes each, but they leave the user's address
// with this deck's user-agent on them and they land on npm rather than on the
// machine running the loop.
//
// The hour that was supposed to be there is written to a marker FILE, and on a
// machine where `~/.agents-deck` cannot be written `writeMarker` swallows the
// failure — so `checkDue` sees "never checked" on every call and the window is
// not really there for the unforced poll either. The floor therefore lives in
// this process's memory, under every rule that admitted the check.
//
// ── /api/claude-accounts ────────────────────────────────────────────────────
//
// A 5-second cache and nothing else: no in-flight slot, no floor. The work is
// the cheapest of the six and this file does not pretend otherwise — two small
// local JSON reads and a collector nudge that is throttled on its own terms and
// spawns nothing when nothing is due. Nobody would have noticed the traffic.
//
// What makes it worth fixing is the second half. This is the only one of the six
// whose cache is invalidated from outside: `invalidateClaudeAccountsCache` is
// called from nine places in four modules, once per `cswap` mutation the deck
// performs. #582 has already shown what a read that STARTED before such a call
// does when it lands after one — it writes the pre-switch answer straight back
// over the cleared cache, and the invalidation is undone before the next poll
// can observe it. Adding an in-flight slot without a generation guard would have
// made that sharper rather than safer: a caller arriving after the switch would
// be handed the read that began before it. So both arrive together, and the
// three cases at the end of this file are the reason.
//
// ── why this file is shaped this way ────────────────────────────────────────
//
// The assertions are behavioural. Nothing below reads `_lastAskAt`, `_lastReadAt`
// or a counter out of either module: what a floor MEANS is how much work happens
// and what the caller is handed instead, so registry requests are counted at the
// transport, roster reads are counted at the filesystem, and every refusal is
// asserted as the shape the surface receives.
//
// The clock is moved rather than waited on, the way read-cost-ceiling.test.ts,
// codex-forced-read-floor.test.ts and codex-usage-forced-read-guard.test.ts move
// it: a case that slept out a sixty-second floor would be a minute of CI apiece.
// Every case gets a FRESH module, because the floor, the cache and the
// generation counter are module state, and a case that inherited the previous
// one's stamp would be asserting the previous one's history.
//
// PLAIN NODE, no DOM. `globalThis.fetch` is replaced wholesale, so nothing here
// reaches registry.npmjs.org; HOME, USERPROFILE and CLAUDE_SWAP_BACKUP all point
// into a temp directory this file seeds, so no case can read the real account
// roster, the real credential store or the real update markers of whoever is
// running the suite; and the store is seeded with nothing due, so nothing here
// can spawn a `cswap` on a machine that happens to have one installed.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The filesystem, counted — one roster read is exactly two of these, sequence
// .json and cache/usage.json. `hold` is how a case keeps a read open across an
// invalidation: the gated call has already been recorded and has not yet
// touched the disk, so the reading it goes on to build is the one it started.
// Hoisted because a vi.mock factory runs before the module body.
const probe = vi.hoisted(() => ({
  reads: [] as string[],
  gateOn: null as string | null,
  gate: null as Promise<void> | null,
  open: null as null | (() => void),
  reset() { this.reads.length = 0; this.gateOn = null; this.gate = null; this.open = null; },
  hold(needle: string) {
    this.gateOn = needle;
    this.gate = new Promise<void>((r) => {
      this.open = () => { this.gateOn = null; this.gate = null; this.open = null; r(); };
    });
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async readFile(...args: Parameters<typeof actual.readFile>) {
      const path = String(args[0]);
      probe.reads.push(path);
      const gate = probe.gate;
      if (gate && probe.gateOn && path.includes(probe.gateOn)) await gate;
      return actual.readFile(...args);
    },
  };
});

// The sandbox goes in before any import of the modules under test: self-update
// .mjs resolves its marker directory from homedir() once, at module load.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-604-forced-reads-"));
const STORE = join(DIR, "cswap-store");
const PKG_ROOT = join(DIR, "lib", "node_modules", "agents-deck");
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_SWAP_BACKUP = STORE;
// Nothing in this file is about the collector, and this is the belt to the
// braces of seeding a store with nothing due: with the freshen path off, no case
// here can reach `cswapBin()` and spawn a subprocess.
process.env.AGENTS_DECK_NO_FRESHEN = "1";
// Both of these silence the registry half of versionReport entirely, and one of
// them is set by other suites in this repo.
delete process.env.AGENTS_DECK_NO_UPDATE_CHECK;
delete process.env.AGENTS_DECK_NO_INSTALL;
// A note on disk is addressed to a supervisor pid; with none, none is read.
delete process.env.AGENTS_DECK_SUPERVISOR_PID;
if (!resolve(STORE).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
mkdirSync(PKG_ROOT, { recursive: true });

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
// than as arithmetic. It is quota.mjs's FORCE_POLL_MS, codex-quota.mjs's and
// codex-usage.mjs's, which is the whole point of it.
const FLOOR_MS = 60_000;

afterAll(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  for (const k of [
    "HOME", "USERPROFILE", "CLAUDE_SWAP_BACKUP", "AGENTS_DECK_NO_FRESHEN",
    "AGENTS_DECK_NO_UPDATE_CHECK", "AGENTS_DECK_NO_INSTALL", "AGENTS_DECK_SUPERVISOR_PID",
  ]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmSync(DIR, { recursive: true, force: true });
});

// ── /api/version ────────────────────────────────────────────────────────────

const INSTALLED = "1.33.27";
const NEXT = "1.33.28";

/** A registry that exists only in this file. Every URL asked for is recorded,
 *  which is the whole cost of a check in one list. */
const registry = {
  calls: [] as string[],
  latest: NEXT,
  published: new Set<string>([`agents-deck@${NEXT}`]),
  /** A registry that is down — the case `checkDue`'s retry window covers for an
   *  unforced poll and never covered for a forced one. */
  failing: false,
};

const tagCalls = () => registry.calls.filter(u => u.includes("/dist-tags"));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = String((input as { url?: string })?.url ?? input);
  registry.calls.push(url);
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  if (registry.failing) return reply(503, {});
  const tags = /^https:\/\/registry\.npmjs\.org\/-\/package\/(.+)\/dist-tags$/.exec(url);
  if (tags) return reply(200, { latest: registry.latest });
  const doc = /^https:\/\/registry\.npmjs\.org\/([^/]+)\/([^/]+)$/.exec(url);
  if (doc) {
    return registry.published.has(`${doc[1]}@${doc[2]}`)
      ? reply(200, { name: doc[1], version: doc[2] })
      : reply(404, {});
  }
  throw new Error(`test: unexpected registry request ${url}`);
}) as unknown as typeof globalThis.fetch;

type VersionModule = {
  mayAskNpm: (o: { now: number; lastAskAt: number }) => boolean;
  versionReport: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

/** The module under test, with no memory of the previous case — neither in
 *  variables nor on disk, since the marker outlives an import. */
async function freshVersionModule(): Promise<VersionModule> {
  rmSync(join(DIR, ".agents-deck"), { recursive: true, force: true });
  vi.resetModules();
  return await import("../../server/self-update.mjs") as unknown as VersionModule;
}

/** One /api/version call, with the arguments index.mjs's handler passes. */
const report = (mod: VersionModule, force = false) =>
  mod.versionReport({ running: INSTALLED, pkgRoot: PKG_ROOT, force });

describe("mayAskNpm, the rule on its own", () => {
  it("is the same shape and the same minute as the three endpoints beside it", async () => {
    const { mayAskNpm } = await freshVersionModule();
    const now = 10_000_000;
    expect(mayAskNpm({ now, lastAskAt: now - FLOOR_MS })).toBe(true);
    expect(mayAskNpm({ now, lastAskAt: now - (FLOOR_MS - 1) })).toBe(false);
    // Nothing has been asked in this process, so the first check goes.
    expect(mayAskNpm({ now, lastAskAt: 0 })).toBe(true);
  });

  it("reads a stamp from the future as a moved clock rather than as a recent check", async () => {
    // `checkDue` answers this case twice, once for `at` and once for the
    // unsettled pair, and gives the same answer both times: a marker from the
    // future is a clock that moved. A floor without the rule would go a whole
    // backwards jump — an hour, a timezone fix, an NTP correction — without ever
    // asking npm again.
    const { mayAskNpm } = await freshVersionModule();
    const now = 10_000_000;
    expect(mayAskNpm({ now, lastAskAt: now + 3600_000 })).toBe(true);
  });
});

describe("a burst of forced version checks, the shape any open page can produce", () => {
  beforeEach(() => {
    registry.calls.length = 0;
    registry.failing = false;
    registry.latest = NEXT;
    registry.published = new Set([`agents-deck@${NEXT}`]);
    writeFileSync(join(PKG_ROOT, "package.json"),
                  JSON.stringify({ name: "agents-deck", version: INSTALLED }));
    // Each case starts past the floor of whatever the last one did, so a fresh
    // module's very first check is never the one being refused.
    advance(FLOOR_MS + 1_000);
  });

  it("costs one dist-tags request however many times it is asked in a row", async () => {
    // The issue's own reproduction, sequential — the case an in-flight slot
    // alone never covers, because every turn waits for the last one to settle
    // before asking again. Twelve turns used to be twelve registry GETs.
    const mod = await freshVersionModule();
    const first = await report(mod, true);
    expect(first.latest).toBe(NEXT);
    // Two: the tag, and the confirmation `runCheck` makes once per release that
    // this deck has not already seen resolve.
    expect(registry.calls).toHaveLength(2);

    for (let i = 0; i < 11; i++) await report(mod, true);
    expect(tagCalls(), "twelve forced checks, one dist-tags GET").toHaveLength(1);
    expect(registry.calls, "and nothing else went out either").toHaveLength(2);
  });

  it("costs one request against a registry that is refusing, which force used to walk past", async () => {
    // A failed lookup takes the five-minute retry window rather than the hour —
    // and `checkDue` answers `force` before it looks at that window at all, so a
    // forced loop against an npm outage was a request per turn for as long as the
    // outage lasted. The floor is the only thing that was ever going to bound it.
    registry.failing = true;
    const mod = await freshVersionModule();
    for (let i = 0; i < 12; i++) await report(mod, true);
    expect(registry.calls, "twelve forced checks at a registry that is down").toHaveLength(1);
  });

  it("hands concurrent callers the one check already running rather than starting theirs", async () => {
    // The half self-update.mjs already had, asserted so that the floor cannot
    // quietly replace it with a refusal: five tabs mounting at once get the
    // answer, not four copies of nothing.
    const mod = await freshVersionModule();
    const results = await Promise.all(Array.from({ length: 5 }, () => report(mod, true)));
    expect(tagCalls()).toHaveLength(1);
    for (const r of results) expect(r.latest).toBe(NEXT);
  });

  it("asks again once the floor has elapsed, because refresh still means refresh", async () => {
    // A floor is not a mute button. What it may not do is let the button turn
    // into a poll loop when it is held down.
    const mod = await freshVersionModule();
    await report(mod, true);
    expect(tagCalls()).toHaveLength(1);

    advance(FLOOR_MS - 1);
    await report(mod, true);
    expect(tagCalls(), "one millisecond short of the floor").toHaveLength(1);

    advance(1);
    const fresh = await report(mod, true);
    expect(tagCalls(), "and exactly on it").toHaveLength(2);
    expect(fresh.latest).toBe(NEXT);
  });
});

describe("what a refused forced version check is handed", () => {
  beforeEach(() => {
    registry.calls.length = 0;
    registry.failing = false;
    registry.latest = NEXT;
    registry.published = new Set([`agents-deck@${NEXT}`]);
    writeFileSync(join(PKG_ROOT, "package.json"),
                  JSON.stringify({ name: "agents-deck", version: INSTALLED }));
    advance(FLOOR_MS + 1_000);
  });

  it("is the reading it already has, not an error", async () => {
    // The half of the fix that decides whether this is a defence or a second
    // bug. The chip is drawn from `latest` and the banner from `notice`, so a
    // refusal that answered `{ latest: null }` would retract an upgrade the user
    // was being offered a second ago — the deck teaching itself a new failure
    // mode in order to defend against a loop nobody ran.
    const mod = await freshVersionModule();
    const first = await report(mod, true);
    expect(first.notice).toEqual({ kind: "upgrade", from: INSTALLED, to: NEXT });

    advance(1_000);
    const again = await report(mod, true);

    expect(again.latest).toBe(NEXT);
    expect(again.notice).toEqual(first.notice);
    expect(again.checkFailedAt, "and it did not learn a failure it never had").toBeNull();
    expect(tagCalls()).toHaveLength(1);
  });

  it("keeps the timestamp of the answer rather than of the read that was refused", async () => {
    // `checkedAt` is what "checked 2 minutes ago" is drawn from, and it is the
    // one field this report must never move without a lookup behind it — the
    // rule the module's own comment states as "a lookup that failed does not
    // move this". A refused forced check is a lookup that did not happen at all.
    const mod = await freshVersionModule();
    const first = await report(mod, true);
    expect(typeof first.checkedAt).toBe("number");

    advance(30_000);
    const again = await report(mod, true);

    expect(again.checkedAt).toBe(first.checkedAt);
    expect(tagCalls()).toHaveLength(1);
  });

  it("does not refuse the first check of a process, whatever the clock says", async () => {
    // A deck that has just booted answers the panel's first poll with a real
    // number. `_lastAskAt` is per process and starts empty, so `first` and the
    // floor agree without either one knowing about the other.
    const mod = await freshVersionModule();
    const first = await report(mod, true);
    expect(first.latest).toBe(NEXT);
    expect(tagCalls()).toHaveLength(1);
  });
});

describe("the unforced version poll, which the guard must not break", () => {
  beforeEach(() => {
    registry.calls.length = 0;
    registry.failing = false;
    registry.latest = NEXT;
    registry.published = new Set([`agents-deck@${NEXT}`]);
    writeFileSync(join(PKG_ROOT, "package.json"),
                  JSON.stringify({ name: "agents-deck", version: INSTALLED }));
    advance(FLOOR_MS + 1_000);
  });

  it("is answered from the marker on disk and asks nothing, as it always did", async () => {
    const mod = await freshVersionModule();
    const first = await report(mod, true);

    advance(30_000);
    const polled = await report(mod);
    expect(tagCalls()).toHaveLength(1);
    expect(polled.latest).toBe(first.latest);
    expect(polled.checkedAt).toBe(first.checkedAt);
  });

  it("goes out again once the marker's own hour has expired, which the floor must not outlive", async () => {
    // CHECK_MS is an hour and the floor is a minute, so a poll arriving with an
    // expired marker is always past the floor as well. Asserted rather than
    // reasoned about: a floor that outlived the window it sits under would
    // freeze the version chip on the first answer it ever got. App.tsx polls
    // this endpoint every five minutes and only forces every fifteen, so this
    // is the path the feature actually runs on.
    const mod = await freshVersionModule();
    await report(mod, true);
    expect(tagCalls()).toHaveLength(1);

    advance(3600_000 + 1_000);
    registry.latest = "1.33.29";
    registry.published.add("agents-deck@1.33.29");
    const polled = await report(mod);
    expect(tagCalls()).toHaveLength(2);
    expect(polled.latest).toBe("1.33.29");
  });

  it("still looks again five minutes after a failure rather than waiting out the hour", async () => {
    // The retry window `force` used to make irrelevant. It is shorter than the
    // hour and longer than the floor, so the floor changes nothing about it.
    registry.failing = true;
    const mod = await freshVersionModule();
    await report(mod, true);
    expect(registry.calls).toHaveLength(1);

    advance(60_000);
    await report(mod);
    expect(registry.calls, "inside the retry window").toHaveLength(1);

    advance(240_000);
    registry.failing = false;
    const polled = await report(mod);
    expect(polled.latest).toBe(NEXT);
  });
});

// ── /api/claude-accounts ────────────────────────────────────────────────────

type Roster = {
  ok: boolean;
  accounts?: { num: number; active: boolean; fetchedAt: number | null }[];
  activeNum?: number | null;
  fetchedAt: number;
  stale?: boolean;
  reason?: string;
};
type AccountsModule = {
  mayReadAccounts: (o: { now: number; force: boolean; lastReadAt: number }) => boolean;
  fetchClaudeAccounts: (o?: { force?: boolean }) => Promise<Roster>;
  invalidateClaudeAccountsCache: () => void;
};

/** One roster read is exactly these two files. */
const rosterReads = () =>
  probe.reads.filter(p => p.endsWith("sequence.json") || p.endsWith("usage.json"));

/**
 * A store with two accounts, one of them active, and nothing whatever due.
 *
 * `nextPollAt` an hour out and `fetchedAt` a minute back is claude-swap's own
 * quiet state: `collectionDue` answers false, `freshenDue` answers false, and
 * `nudgeCollector` returns before it resolves a binary. No case in this file is
 * about the collector, and none of them may spawn one.
 */
function seedStore(activeNum = 2): void {
  const sec = Math.floor(Date.now() / 1000);
  const acct = (n: number) => ({
    email: `acct${n}@example.invalid`,
    alias: `slot-${n}`,
    organizationUuid: `org-${n}`,
    organizationName: `Org ${n}`,
  });
  const row = (n: number) => ({
    email: `acct${n}@example.invalid`,
    organizationUuid: `org-${n}`,
    fetchedAt: sec - 60,
    nextPollAt: sec + 3600,
    consecutiveFailures: 0,
    lastGood: {
      five_hour: { pct: 40 + n, resets_at: new Date((sec + 7200) * 1000).toISOString() },
      seven_day: { pct: 10 + n, resets_at: new Date((sec + 86400) * 1000).toISOString() },
    },
  });
  mkdirSync(join(STORE, "cache"), { recursive: true });
  writeFileSync(join(STORE, "sequence.json"), JSON.stringify({
    activeAccountNumber: activeNum,
    sequence: [2, 3],
    accounts: { 2: acct(2), 3: acct(3) },
  }));
  writeFileSync(join(STORE, "cache", "usage.json"), JSON.stringify({
    schemaVersion: 2,
    accounts: { 2: row(2), 3: row(3) },
  }));
}

/** The module under test, with no memory of the previous case. */
async function freshAccountsModule(): Promise<AccountsModule> {
  vi.resetModules();
  return await import("../../server/claude-accounts.mjs") as unknown as AccountsModule;
}

/** One turn of the event loop. A microtask drain is not enough to wait for a
 *  read that is really on the disk — `await Promise.resolve()` in a loop starves
 *  the loop that would deliver it — and the timers here are real, since it is
 *  `Date.now` that this file freezes and not `setTimeout`. */
const tick = () => new Promise<void>(r => { setTimeout(r, 0); });

/** Wait until the held read has reached the gate, so nothing moves under it
 *  before it is genuinely holding the reading it started with. */
async function atTheGate(): Promise<void> {
  for (let i = 0; i < 500 && !probe.reads.some(p => p.endsWith("usage.json")); i++) await tick();
  expect(probe.reads.some(p => p.endsWith("usage.json")),
         "the held read reached the gate").toBe(true);
}

describe("mayReadAccounts, the rule on its own", () => {
  beforeEach(() => { probe.reset(); seedStore(); advance(FLOOR_MS + 1_000); });

  it("is quota.mjs's maySelfPoll: one minute forced, the cache's own interval otherwise", async () => {
    const { mayReadAccounts } = await freshAccountsModule();
    const now = 10_000_000;
    expect(mayReadAccounts({ now, force: true, lastReadAt: now - FLOOR_MS })).toBe(true);
    expect(mayReadAccounts({ now, force: true, lastReadAt: now - (FLOOR_MS - 1) })).toBe(false);
    // The unforced arm is the 5s cache restated from the start of a read rather
    // than from its end, so an ordinary poll is admitted exactly where the cache
    // above it would have let one through.
    expect(mayReadAccounts({ now, force: false, lastReadAt: now - 5_000 })).toBe(true);
    expect(mayReadAccounts({ now, force: false, lastReadAt: now - 4_999 })).toBe(false);
    // Nothing has been read in this process, so the first read goes.
    expect(mayReadAccounts({ now, force: true, lastReadAt: 0 })).toBe(true);
  });
});

describe("a burst of forced roster reads, the shape any open page can produce", () => {
  beforeEach(() => { probe.reset(); seedStore(); advance(FLOOR_MS + 1_000); });

  it("costs one pair of file reads however many times it is asked in a row", async () => {
    // Sequential, which is the case an in-flight slot alone never covers. Twelve
    // turns used to be twelve trips to the store.
    const { fetchClaudeAccounts } = await freshAccountsModule();
    const first = await fetchClaudeAccounts({ force: true });
    expect(first.ok).toBe(true);
    expect(rosterReads()).toHaveLength(2);

    for (let i = 0; i < 11; i++) await fetchClaudeAccounts({ force: true });
    expect(rosterReads(), "twelve forced reads, one trip to the store").toHaveLength(2);
  });

  it("hands concurrent callers the one read already running rather than starting theirs", async () => {
    // Five tabs mounting at once, or one loop that does not wait. This module
    // had no in-flight slot at all, so this was five simultaneous readings of
    // the same two files.
    const { fetchClaudeAccounts } = await freshAccountsModule();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => fetchClaudeAccounts({ force: true })),
    );

    expect(rosterReads()).toHaveLength(2);
    // The same object, not merely an equal one — they were one read.
    for (const r of results) expect(r).toBe(results[0]);
    expect(results[0].ok).toBe(true);
    expect(results[0].activeNum).toBe(2);
  });

  it("reads again once the floor has elapsed, because refresh still means refresh", async () => {
    const { fetchClaudeAccounts } = await freshAccountsModule();
    await fetchClaudeAccounts({ force: true });
    expect(rosterReads()).toHaveLength(2);

    advance(FLOOR_MS - 1);
    await fetchClaudeAccounts({ force: true });
    expect(rosterReads(), "one millisecond short of the floor").toHaveLength(2);

    advance(1);
    const fresh = await fetchClaudeAccounts({ force: true });
    expect(rosterReads(), "and exactly on it").toHaveLength(4);
    expect(fresh.ok).toBe(true);
    expect(fresh.stale).toBeUndefined();
  });
});

describe("what a refused forced roster read is handed", () => {
  beforeEach(() => { probe.reset(); seedStore(); advance(FLOOR_MS + 1_000); });

  it("is the reading it already has, not an error", async () => {
    // AccountsPanel renders `data.accounts` and nothing else, so an
    // `{ ok: false }` refusal would empty the roster for a minute — every
    // account row, every lane and every switch button gone because somebody
    // pressed ↻ twice.
    const { fetchClaudeAccounts } = await freshAccountsModule();
    const first = await fetchClaudeAccounts({ force: true });
    expect(first.ok).toBe(true);

    advance(1_000);
    const again = await fetchClaudeAccounts({ force: true });

    expect(again.ok).toBe(true);
    expect(again.reason).toBeUndefined();
    expect(again.accounts).toEqual(first.accounts);
    expect(again.activeNum).toBe(first.activeNum);
    expect(rosterReads()).toHaveLength(2);
  });

  it("says it is stale, and keeps the timestamp of the data rather than of the read", async () => {
    // `fetchedAt` is what an age label is drawn from, at the top level and on
    // every row. Re-stamping it `now` would put "just now" over numbers nobody
    // re-read — quota.mjs learned that one first and the other two restate it.
    const { fetchClaudeAccounts } = await freshAccountsModule();
    const first = await fetchClaudeAccounts({ force: true });

    advance(30_000);
    const again = await fetchClaudeAccounts({ force: true });

    expect(again.stale).toBe(true);
    expect(first.stale).toBeUndefined();
    expect(again.fetchedAt).toBe(first.fetchedAt);
    expect(again.accounts?.map(a => a.fetchedAt)).toEqual(first.accounts?.map(a => a.fetchedAt));
    // And the cache entry itself was not edited on the way past: the next caller
    // to get a real answer must not inherit a `stale` flag.
    expect(first.stale).toBeUndefined();
  });

  it("does not refuse a caller who has never been handed anything", async () => {
    const { fetchClaudeAccounts } = await freshAccountsModule();
    const first = await fetchClaudeAccounts({ force: true });
    expect(first.ok).toBe(true);
    expect(first.accounts).toHaveLength(2);
  });
});

describe("the unforced roster poll, which the guard must not break", () => {
  beforeEach(() => { probe.reset(); seedStore(); advance(FLOOR_MS + 1_000); });

  it("is answered from the cache and reads nothing, as it always did", async () => {
    const { fetchClaudeAccounts } = await freshAccountsModule();
    const first = await fetchClaudeAccounts({ force: true });

    advance(1_000);
    const polled = await fetchClaudeAccounts();
    expect(polled).toBe(first);              // the cache entry itself, untouched
    expect(rosterReads()).toHaveLength(2);
  });

  it("goes out again once its own five seconds are up, which the floor must not outlive", async () => {
    // The case the floor could most easily have broken, and the reason
    // `mayReadAccounts` takes `force` at all. CACHE_MS is five seconds and the
    // forced floor is a minute; a poll arriving with an expired cache is inside
    // that minute twelve times out of twelve, so a floor that did not tell the
    // two apart would have frozen the panel on its first reading and left the ↻
    // as the only way to move it.
    const { fetchClaudeAccounts } = await freshAccountsModule();
    await fetchClaudeAccounts({ force: true });

    advance(5_000);
    const polled = await fetchClaudeAccounts();
    expect(rosterReads()).toHaveLength(4);
    expect(polled.ok).toBe(true);
    expect(polled.stale).toBeUndefined();
  });
});

describe("a switch that lands while a roster read is already running", () => {
  beforeEach(() => { probe.reset(); seedStore(2); advance(FLOOR_MS + 1_000); });

  /**
   * Start a read that cannot finish, move the store underneath it, invalidate,
   * then let it finish — the same shape as the real window, where the deck POSTs
   * `/api/claude-accounts/switch`, `cswap` rewrites sequence.json, and the
   * handler calls `invalidateClaudeAccountsCache` while the panel's own poll may
   * already be in flight.
   *
   * The gate is on usage.json, so the held read has ALREADY taken sequence.json
   * and is genuinely holding the pre-switch roster rather than re-reading the
   * post-switch one after the release.
   */
  async function readHeldAcrossSwitch(mod: AccountsModule) {
    probe.hold("usage.json");
    const held = mod.fetchClaudeAccounts({ force: true });
    await atTheGate();

    seedStore(3);
    mod.invalidateClaudeAccountsCache();
    probe.open!();
    return held;
  }

  it("does not let the pre-switch reading land in the cache the switch just cleared", async () => {
    // #582, in the module #582 did not touch. Without the generation stamp the
    // read that started first writes the old roster straight back over the
    // cleared cache, and the invalidation is undone milliseconds after it ran —
    // so the next poll shows the account the user has just switched AWAY from,
    // under a cache entry that looks perfectly fresh.
    const mod = await freshAccountsModule();
    const held = await readHeldAcrossSwitch(mod);

    // Whoever asked is still owed an answer, and this one is not wrong — it is
    // about a roster that has since moved.
    expect((await held).activeNum).toBe(2);

    probe.reset();
    const polled = await mod.fetchClaudeAccounts();
    expect(polled.activeNum, "the poll after a switch describes the new account").toBe(3);
    expect(rosterReads(), "and it went to disk for it").toHaveLength(2);
  });

  it("does not hand a caller arriving after the switch the read that began before it", async () => {
    // The half that only exists because the in-flight slot does. Joining a run
    // is free exactly while the run is still about the right thing, and an
    // invalidation is the announcement that it is not.
    const mod = await freshAccountsModule();
    probe.hold("usage.json");
    const held = mod.fetchClaudeAccounts({ force: true });
    await atTheGate();

    seedStore(3);
    mod.invalidateClaudeAccountsCache();
    const after = mod.fetchClaudeAccounts({ force: true });
    probe.open!();

    expect((await held).activeNum).toBe(2);
    expect((await after).activeNum, "the caller that arrived after the switch").toBe(3);
  });

  it("never answers the reload that follows a switch with a refusal", async () => {
    // Every one of the nine `invalidateClaudeAccountsCache` call sites is a
    // mutation the panel follows with `load(true)` — a `?refresh=1` arriving
    // milliseconds after the read that preceded it. A floor that counted that as
    // a burst would answer the switch with the pre-switch roster, or with
    // nothing at all, which would make the guard the bug it was added to
    // prevent.
    const mod = await freshAccountsModule();
    const before = await mod.fetchClaudeAccounts({ force: true });
    expect(before.activeNum).toBe(2);

    seedStore(3);
    mod.invalidateClaudeAccountsCache();

    advance(50);
    const reloaded = await mod.fetchClaudeAccounts({ force: true });
    expect(reloaded.activeNum).toBe(3);
    expect(reloaded.stale, "and it is a reading, not a held one").toBeUndefined();
  });
});
