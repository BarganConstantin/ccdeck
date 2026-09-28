// Claude's saved limit resets, as quota.mjs gets them onto the Usage panel's
// Claude card (#1308) — from which source, for which account, at what cost, and
// what happens to the ordinary quota when that goes wrong.
//
// Two routes, and the second is the one that needs guarding:
//
//   * Source 2, the OAuth usage endpoint, asks for the `cedar_ember` block in
//     the same request as the windows. One response, so one account.
//   * Source 1, claude-swap's store, has windows and no resets, so the deck
//     reads them separately with Claude Code's token. The store's active
//     account and the token's owner are two different facts, and a reset
//     published on the wrong one is another account's data on this card.
//
// Nothing here reaches the network, runs Claude Code or reads a real store:
// fetch answers from a table, `claude` is missing, claude-swap's store is a
// value, and the Claude config dir is a temp directory holding an obviously
// fake token. The clock is frozen and moved by hand, and every case gets a
// fresh module, because the floors, the held inventory and the token's owner
// are all module state.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-reset-credits-"));
const CREDENTIALS = join(SANDBOX, ".credentials.json");
const TOKEN = "test-token-that-must-not-leak";
const GRANT_ID = "test-grant-id-that-must-not-leak";
const GRANT_LABEL = "Test launch promo";

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    // No Claude Code on this machine: source 3 never produces a reading, so
    // every answer below came from the store or the API.
    run: async () => ({ ok: false, code: "ENOENT", stdout: "", stderr: "", killed: false, timedOut: false }),
    pathLookup: () => null,
  };
});

// claude-swap's store, as activeAccountUsage answers it. Its row is always a
// second old, so it stays the trusted source however far the clock is moved.
const { swap } = vi.hoisted(() => ({
  swap: { entry: null as null | { email: string; organizationUuid: string | null; five: number } },
}));
vi.mock("../../server/claude-accounts.mjs", () => ({
  activeAccountUsage: async () => swap.entry && {
    num: 1,
    email: swap.entry.email,
    organizationUuid: swap.entry.organizationUuid,
    lastGood: { five_hour: { pct: swap.entry.five }, seven_day: { pct: 12 } },
    fetchedAt: Date.now() - 1000,
  },
  requestCollection: async () => false,
}));

vi.mock("../../server/claude-dir.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, claudeConfigDir: () => SANDBOX, claudeCliCandidates: () => ["claude"] };
});

// Anthropic, as a table: what each of the three URLs quota.mjs may ask
// answers, and a record of every request, headers included.
type Answer = { status: number; body?: unknown; retryAfter?: string } | "throw";
const USAGE = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1";
const RESETS = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";
const PROFILE = "https://api.anthropic.com/api/oauth/profile";
const api = {
  calls: [] as { url: string; headers: Record<string, string> }[],
  answers: {} as Record<string, Answer>,
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init: { headers?: Record<string, string> } = {}) => {
  const url = String(input);
  const answer = api.answers[url];
  if (!answer) throw new Error(`test: unexpected fetch ${url}`);
  api.calls.push({ url, headers: init.headers ?? {} });
  if (answer === "throw") throw new Error("test: connection reset");
  const { status, body = {}, retryAfter } = answer;
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? retryAfter ?? null : null) },
    json: async () => body,
  };
}) as unknown as typeof globalThis.fetch;
const asked = (url: string) => api.calls.filter(c => c.url === url).length;

let skew = 0;
const FROZEN_AT = Date.parse("2026-09-28T12:00:00Z");
vi.spyOn(Date, "now").mockImplementation(() => FROZEN_AT + skew);
const at = (ms: number) => { skew = ms; };
const SEC = 1000, MIN = 60 * SEC, DAY = 24 * 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

const ALICE = { email: "alice@example.test", organizationUuid: "org-alice" };
const BOB   = { email: "bob@example.test",   organizationUuid: "org-bob" };

/** A cedar_ember block holding `n` one-reset grants, the first ending soonest. */
const resets = (n: number, firstEndsIn = 6 * DAY) => ({
  eligible: true,
  ineligible_reason: null,
  next_grant_id: GRANT_ID,
  event_props: { surface: "claude_code_cli" },
  grants: Array.from({ length: n }, (_, i) => ({
    id: GRANT_ID, label: GRANT_LABEL,
    resets_total: 1, resets_left: 1,
    starts_at: iso(FROZEN_AT - DAY), ends_at: iso(FROZEN_AT + firstEndsIn + i * DAY),
    paused: false, usable_now: false,
  })),
});
const profileOf = (who: typeof ALICE) =>
  ({ status: 200, body: { account: { uuid: "acct", email: who.email }, organization: { uuid: who.organizationUuid } } });

type Credits = { availableCount: number; nextExpiryAt: number | null };
type Quota = {
  ok: boolean; reason?: string; source?: string; stale?: boolean;
  session5hPct?: number; week7dPct?: number; resetCredits?: Credits | null;
};
type QuotaModule = {
  fetchClaudeQuota: (o?: { force?: boolean }) => Promise<Quota>;
  invalidateQuotaCache: () => void;
  resetCreditsSettled: () => Promise<void>;
  resetCreditsDue: (o: { now: number; force: boolean; triedAt: number; rateLimitedUntil: number; triedThisAccount: boolean }) => boolean;
  sameAccount: (a: unknown, b: unknown) => boolean;
};

async function freshQuota(): Promise<QuotaModule> {
  vi.resetModules();
  return await import("../../server/quota.mjs") as unknown as QuotaModule;
}

/** A read, and the inventory read it may have started, both landed. */
async function read(q: QuotaModule, o?: { force?: boolean }) {
  const r = await q.fetchClaudeQuota(o);
  await q.resetCreditsSettled();
  return r;
}

const signedIn = () =>
  writeFileSync(CREDENTIALS, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: FROZEN_AT + 365 * DAY } }));

const logged: string[] = [];

beforeEach(() => {
  api.calls.length = 0;
  api.answers = {};
  swap.entry = null;
  rmSync(CREDENTIALS, { force: true });
  at(0);
  logged.length = 0;
  for (const level of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  }
});

afterAll(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  rmTempDir(SANDBOX);
});

describe("source 2: the resets arrive with the windows", () => {
  const WINDOWS = {
    five_hour: { utilization: 41, resets_at: "2026-09-28T14:40:00Z" },
    seven_day: { utilization: 18, resets_at: "2026-10-02T04:00:00Z" },
  };

  it("counts them from the same single request, with the nearest expiry", async () => {
    signedIn();
    api.answers[USAGE] = { status: 200, body: { ...WINDOWS, cedar_ember: resets(2) } };
    const q = await freshQuota();
    const r = await read(q, { force: true });
    expect(r).toMatchObject({ ok: true, source: "api", session5hPct: 41, week7dPct: 18 });
    expect(r.resetCredits).toEqual({ availableCount: 2, nextExpiryAt: FROZEN_AT + 6 * DAY });
    // One request, and no identity lookup: the response is the token's own.
    expect(api.calls.map(c => c.url)).toEqual([USAGE]);
  });

  it("asks the way Claude Code asks, since the endpoint withholds grants from anything else", async () => {
    signedIn();
    api.answers[USAGE] = { status: 200, body: WINDOWS };
    await read(await freshQuota(), { force: true });
    expect(api.calls[0].headers["User-Agent"]).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
    expect(api.calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    ["no block at all", undefined],
    ["a client the endpoint did not recognise", { eligible: false, ineligible_reason: "surface" }],
    ["a block that is not an object", "cedar"],
    ["grants that are not a list", { eligible: true, grants: "none" }],
  ])("maps the windows exactly as before, and says nothing about resets, for %s", async (_why, block) => {
    signedIn();
    api.answers[USAGE] = { status: 200, body: { ...WINDOWS, cedar_ember: block } };
    const r = await read(await freshQuota(), { force: true });
    expect(r).toMatchObject({ ok: true, source: "api", session5hPct: 41, week7dPct: 18 });
    expect(r).not.toHaveProperty("resetCredits");
  });

  it("never reads the windows' own resets_at as a saved reset", async () => {
    // Those say when a window rolls over by itself. A panel that counted them
    // would promise a reset on every account there is.
    signedIn();
    api.answers[USAGE] = { status: 200, body: WINDOWS };
    expect(await read(await freshQuota(), { force: true })).not.toHaveProperty("resetCredits");
  });
});

describe("source 1: claude-swap has the windows, and the resets are read beside them", () => {
  it("reads them once the token's owner is the store's active account, and shows them on the next read", async () => {
    signedIn();
    swap.entry = { ...ALICE, five: 63 };
    api.answers[PROFILE] = profileOf(ALICE);
    api.answers[RESETS] = { status: 200, body: { cedar_ember: resets(1) } };
    const q = await freshQuota();

    // The store answers straight away, as it always has; the inventory read
    // runs behind it and does not hold it up.
    const first = await read(q);
    expect(first).toMatchObject({ ok: true, source: "claude-swap", session5hPct: 63 });
    expect(first).not.toHaveProperty("resetCredits");
    expect(api.calls.map(c => c.url)).toEqual([PROFILE, RESETS]);

    at(61 * SEC);
    const second = await read(q);
    expect(second).toMatchObject({ ok: true, source: "claude-swap", session5hPct: 63 });
    expect(second.resetCredits).toEqual({ availableCount: 1, nextExpiryAt: FROZEN_AT + 6 * DAY });
  });

  it("never asks for another account's resets when the token belongs to someone else", async () => {
    // claude-swap says Alice is active; Claude Code is signed in as Bob, as it
    // is after a `claude auth login` done in a terminal.
    signedIn();
    swap.entry = { ...ALICE, five: 63 };
    api.answers[PROFILE] = profileOf(BOB);
    api.answers[RESETS] = { status: 200, body: { cedar_ember: resets(3) } };
    const q = await freshQuota();
    await read(q);
    at(61 * SEC);
    expect(await read(q)).not.toHaveProperty("resetCredits");
    expect(asked(RESETS), "Bob's inventory was requested for Alice's card").toBe(0);
  });

  it("tells one address under two organizations apart", async () => {
    signedIn();
    swap.entry = { ...ALICE, five: 63 };
    api.answers[PROFILE] = profileOf({ ...ALICE, organizationUuid: "org-alice-team" });
    api.answers[RESETS] = { status: 200, body: { cedar_ember: resets(1) } };
    const q = await freshQuota();
    await read(q);
    expect(asked(RESETS)).toBe(0);
  });

  it("does not carry one account's resets onto the next account's card, however the switch was made", async () => {
    signedIn();
    swap.entry = { ...ALICE, five: 63 };
    api.answers[PROFILE] = profileOf(ALICE);
    api.answers[RESETS] = { status: 200, body: { cedar_ember: resets(2) } };
    const q = await freshQuota();
    await read(q);
    at(61 * SEC);
    expect((await read(q)).resetCredits).toMatchObject({ availableCount: 2 });

    // `cswap switch` in a terminal: the deck is never told, so nothing is
    // invalidated, and the next store read is simply about Bob. The token is
    // still Alice's, so Bob's inventory is not read either.
    swap.entry = { ...BOB, five: 7 };
    at(122 * SEC);
    const bob = await read(q);
    expect(bob).toMatchObject({ ok: true, source: "claude-swap", session5hPct: 7 });
    expect(bob).not.toHaveProperty("resetCredits");
    expect(asked(RESETS)).toBe(1);
  });

  it("reads nothing, and changes nothing, on a machine with no readable token", async () => {
    // The macOS case: Claude Code keeps the token in the Keychain.
    swap.entry = { ...ALICE, five: 63 };
    const q = await freshQuota();
    const r = await read(q);
    expect(r).toMatchObject({ ok: true, source: "claude-swap", session5hPct: 63 });
    expect(r).not.toHaveProperty("resetCredits");
    expect(api.calls).toEqual([]);
  });
});

describe("an inventory read that fails", () => {
  it.each([
    ["the profile lookup is refused", { [PROFILE]: { status: 401 } }],
    ["the profile lookup cannot connect", { [PROFILE]: "throw" }],
    ["the profile names nobody", { [PROFILE]: { status: 200, body: { account: {} } } }],
    ["the inventory request errors", { [PROFILE]: profileOf(ALICE), [RESETS]: { status: 500 } }],
    ["the inventory request cannot connect", { [PROFILE]: profileOf(ALICE), [RESETS]: "throw" }],
    ["the inventory is malformed", { [PROFILE]: profileOf(ALICE), [RESETS]: { status: 200, body: { cedar_ember: { eligible: "yes" } } } }],
  ])("leaves the quota exactly as it was when %s", async (_why, answers) => {
    signedIn();
    swap.entry = { ...ALICE, five: 63 };
    api.answers = answers as Record<string, Answer>;
    const q = await freshQuota();
    for (const t of [0, 61 * SEC]) {
      at(t);
      const r = await read(q);
      expect(r).toMatchObject({ ok: true, source: "claude-swap", session5hPct: 63, week7dPct: 12 });
      expect(r).not.toHaveProperty("resetCredits");
    }
    expect(logged).toEqual([]);
  });

  it("spends the same 429 cooldown source 2 does, because it is the same token's budget", async () => {
    signedIn();
    swap.entry = { ...ALICE, five: 63 };
    api.answers[PROFILE] = profileOf(ALICE);
    api.answers[RESETS] = { status: 429, retryAfter: "600" };
    api.answers[USAGE] = { status: 200, body: { five_hour: { utilization: 5 } } };
    const q = await freshQuota();
    await read(q);

    // The store goes quiet, and a forced read would normally fall through to
    // source 2. Inside the cooldown it may not.
    swap.entry = null;
    at(2 * MIN);
    expect(await read(q, { force: true })).toMatchObject({ source: "claude-swap", stale: true });
    expect(asked(USAGE)).toBe(0);
    at(11 * MIN);
    await read(q, { force: true });
    expect(asked(USAGE)).toBe(1);
  });

  it("stops vouching for an inventory no read has confirmed in an hour and a half", async () => {
    // A reset redeemed in Claude only leaves the inventory when a read says
    // so; one that keeps failing must not keep promising it.
    signedIn();
    swap.entry = { ...ALICE, five: 63 };
    api.answers[PROFILE] = profileOf(ALICE);
    api.answers[RESETS] = { status: 200, body: { cedar_ember: resets(1) } };
    const q = await freshQuota();
    await read(q);
    api.answers[RESETS] = { status: 500 };
    at(89 * MIN);
    expect((await read(q)).resetCredits).toMatchObject({ availableCount: 1 });
    at(91 * MIN);
    expect(await read(q)).not.toHaveProperty("resetCredits");
  });
});

describe("what the store path spends", () => {
  async function aliceWithOneReset() {
    signedIn();
    swap.entry = { ...ALICE, five: 63 };
    api.answers[PROFILE] = profileOf(ALICE);
    api.answers[RESETS] = { status: 200, body: { cedar_ember: resets(1) } };
    const q = await freshQuota();
    await read(q);
    return q;
  }

  it("reads the inventory at most every thirty minutes, and looks the token's owner up once", async () => {
    const q = await aliceWithOneReset();
    for (let t = 1; t < 30; t++) { at(t * MIN + SEC); await read(q); }
    expect(asked(RESETS)).toBe(1);
    at(30 * MIN + SEC);
    await read(q);
    expect(asked(RESETS)).toBe(2);
    expect(asked(PROFILE)).toBe(1);
  });

  it("lets the refresh button beat that, but not by more than the five-minute floor", async () => {
    const q = await aliceWithOneReset();
    at(4 * MIN);
    await read(q, { force: true });
    expect(asked(RESETS)).toBe(1);
    at(5 * MIN);
    await read(q, { force: true });
    expect(asked(RESETS)).toBe(2);
  });

  it("shows a used reset gone after the next read that says so", async () => {
    const q = await aliceWithOneReset();
    at(61 * SEC);
    expect((await read(q)).resetCredits).toMatchObject({ availableCount: 1 });
    // Redeemed in Claude: the grant is still listed, with nothing left in it.
    api.answers[RESETS] = { status: 200, body: { cedar_ember: { ...resets(1), grants: [{ ...resets(1).grants[0], resets_left: 0 }] } } };
    at(6 * MIN);
    await read(q, { force: true });
    at(7 * MIN + SEC);
    expect((await read(q)).resetCredits).toEqual({ availableCount: 0, nextExpiryAt: null });
  });

  it("stops counting a held reset the moment it ends, without spending a request", async () => {
    signedIn();
    swap.entry = { ...ALICE, five: 63 };
    api.answers[PROFILE] = profileOf(ALICE);
    api.answers[RESETS] = { status: 200, body: { cedar_ember: resets(1, 10 * MIN) } };
    const q = await freshQuota();
    await read(q);
    at(9 * MIN);
    expect((await read(q)).resetCredits).toMatchObject({ availableCount: 1 });
    at(11 * MIN);
    expect((await read(q)).resetCredits).toEqual({ availableCount: 0, nextExpiryAt: null });
    expect(asked(RESETS)).toBe(1);
  });

  it("reads a switched-to account on the short floor, not the long one", async () => {
    const q = await aliceWithOneReset();
    // A switch the deck made: the token moves to Bob with it.
    swap.entry = { ...BOB, five: 7 };
    api.answers[PROFILE] = profileOf(BOB);
    writeFileSync(CREDENTIALS, JSON.stringify({ claudeAiOauth: { accessToken: `${TOKEN}-bob`, expiresAt: FROZEN_AT + 365 * DAY } }));
    q.invalidateQuotaCache();
    at(5 * MIN);
    await read(q);
    expect(asked(RESETS)).toBe(2);
    at(6 * MIN + SEC);
    expect((await read(q)).resetCredits).toMatchObject({ availableCount: 1 });
  });

  it("is a pure rule, and the cooldown beats every floor", async () => {
    const { resetCreditsDue } = await freshQuota();
    const base = { now: 100 * MIN, force: false, triedAt: 100 * MIN - 29 * MIN, rateLimitedUntil: 0, triedThisAccount: true };
    expect(resetCreditsDue(base)).toBe(false);
    expect(resetCreditsDue({ ...base, force: true })).toBe(true);
    expect(resetCreditsDue({ ...base, triedThisAccount: false })).toBe(true);
    expect(resetCreditsDue({ ...base, triedAt: 100 * MIN - 4 * MIN, force: true })).toBe(false);
    expect(resetCreditsDue({ ...base, triedAt: 0, rateLimitedUntil: 100 * MIN + 1 })).toBe(false);
  });
});

describe("which accounts are the same account", () => {
  it("needs both halves to match, the address without case", async () => {
    const { sameAccount } = await freshQuota();
    expect(sameAccount(ALICE, { ...ALICE, email: "Alice@Example.test" })).toBe(true);
    expect(sameAccount(ALICE, { ...ALICE, organizationUuid: "ORG-ALICE" })).toBe(false);
    expect(sameAccount(ALICE, BOB)).toBe(false);
    expect(sameAccount(ALICE, null)).toBe(false);
    expect(sameAccount(null, null)).toBe(false);
  });
});

describe("what leaves the server", () => {
  it("carries no token, grant id or grant label in any answer or any log line", async () => {
    signedIn();
    const answers: Quota[] = [];

    // Both routes, including the failures, since an error path is where a
    // request tends to get printed.
    api.answers[USAGE] = { status: 200, body: { five_hour: { utilization: 3 }, cedar_ember: resets(2) } };
    let q = await freshQuota();
    answers.push(await read(q, { force: true }));

    swap.entry = { ...ALICE, five: 63 };
    api.answers[PROFILE] = profileOf(ALICE);
    api.answers[RESETS] = { status: 200, body: { cedar_ember: resets(2) } };
    q = await freshQuota();
    answers.push(await read(q));
    at(61 * SEC);
    answers.push(await read(q));
    api.answers[RESETS] = "throw";
    at(7 * MIN);
    answers.push(await read(q, { force: true }));

    expect(answers[0].resetCredits).toMatchObject({ availableCount: 2 });
    expect(answers[2].resetCredits).toMatchObject({ availableCount: 2 });
    const everything = JSON.stringify(answers) + logged.join("\n");
    for (const secret of [TOKEN, GRANT_ID, GRANT_LABEL, ALICE.organizationUuid]) {
      expect(everything).not.toContain(secret);
    }
    // And the answer names nobody: the card already knows whose it is.
    expect(everything).not.toContain(ALICE.email);
  });
});
