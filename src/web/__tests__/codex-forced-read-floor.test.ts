// #580. Reads on this server are deliberately open — `isTrustedRead` applies
// only the rebinding test, because a cross-site read of `http://127.0.0.1:4317`
// is an ordinary top-level navigation rather than an attack. #544 accepted that
// and put a ceiling on what two of those reads may cost LOCALLY, and
// read-cost-ceiling.test.ts is where that ceiling lives. This is the other kind
// of cost, and it is not local: what a forced Codex quota read spends is the
// user's ChatGPT session.
//
// `fetchCodexQuota({ force: true })` read `force` as "skip the cache", and the
// cache was the only thing between a caller and chatgpt.com:
//
//     if (!force && _cache && Date.now() - _cacheAt < CACHE_MS) return …;
//     _inflight ??= doFetchCodexQuota().finally(() => { _inflight = null; });
//
// `_inflight` deduplicates callers that OVERLAP and nothing else. A caller that
// waits for the previous fetch to settle and then asks again got a fresh
// `doFetchCodexQuota` every time, so
//
//     (async function spin() {
//       for (;;) await fetch("http://127.0.0.1:4317/api/codex-quota?refresh=1",
//                            { mode: "no-cors" });
//     })();
//
// from any page the user happens to have open was a sustained couple of requests
// per second against OpenAI, from the user's IP, on the user's account, for as
// long as the tab is open. Each turn is two authenticated HTTPS GETs carrying
// `Authorization: Bearer <the live ChatGPT access token>`; UsagePanel.tsx records
// the measured cost of one turn on this repo's own machine as 991-1299ms. Nothing
// needs to read the response — `no-cors` still delivers the request.
//
// ── the sharper half ────────────────────────────────────────────────────────
//
// The traffic is the visible cost. The credential is the expensive one. On a 401
// `doFetchCodexQuota` calls `forceCodexRefresh(auth.accessToken)`, which spends
// the SINGLE-USE refresh token and writes the rotated one back to auth.json.
// `refreshCredentials`'s `staleAccessToken` guard stops that happening twice for
// the same rejected token — and only for that token. Every turn of the loop
// re-reads auth.json through `getCodexAuth` and therefore sees the token the
// PREVIOUS turn rotated to, so the guard is satisfied again and a backend that
// keeps answering 401 (a suspended account, a revoked session) rotated a fresh
// single-use credential once per request, with the Codex CLI racing for the same
// file. codex-auth.mjs's own EXPIRY_SKEW_MS comment says what losing that race
// costs the user: a `refresh_token_reused` that reads as "your login is broken",
// and the recovery is `codex login`.
//
// ── the answer is the one the Claude half already had ───────────────────────
//
// quota.mjs declares `FORCE_POLL_MS = 60_000` with the comment "The refresh
// button may beat that floor, but not turn into a poll loop when held down", and
// `maySelfPoll` enforces it before anything leaves the machine, on top of a 429
// cooldown. `/api/quota?refresh=1` in a loop therefore spends nothing.
// `/api/codex-quota` is four lines away in the router and had no floor, no
// cooldown and no stamp at all. So codex-quota.mjs now carries the same number,
// the same predicate shape and the same answer to a refusal, rather than a second
// invention of its own.
//
// ── why this file is shaped this way ────────────────────────────────────────
//
// The assertions are behavioural: none of them reads `_lastFetchAt` or a counter
// out of the module. What a floor MEANS is how many requests reach the wire and
// what the caller is handed instead, so requests are counted at the transport and
// the refusal is asserted as the shape the panel receives.
//
// The clock is moved rather than waited on, the way read-cost-ceiling.test.ts
// moves it: a test that slept out a sixty-second floor would be a minute of CI
// per case.
//
// Every case gets a FRESH module — `vi.resetModules()` — because the floor, the
// cooldown and the cache are module state and a test that inherited the previous
// one's stamp would be asserting the previous one's history.
//
// PLAIN NODE, no DOM. `globalThis.fetch` is replaced wholesale, so nothing here
// reaches chatgpt.com or auth.openai.com, and CODEX_HOME points into a temp
// directory seeded with a made-up credential — no test in this file can read or
// spend the real login of whoever is running the suite.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The sandbox goes in before any import of the modules under test: both codex
// modules resolve their directory once, at module load.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-580-force-floor-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CODEX_HOME = join(DIR, "codex");
if (!resolve(process.env.CODEX_HOME).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const AUTH_PATH = join(process.env.CODEX_HOME, "auth.json");

/** A JWT-shaped access token that does not expire for the life of this file, so
 *  `shouldRefresh` answers false and nothing refreshes except on a real 401. */
function accessToken(tag: string): string {
  const exp = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;
  const payload = Buffer.from(JSON.stringify({ exp, email: "sandbox@example.invalid" }))
    .toString("base64url");
  return `header.${payload}.${tag}`;
}

/** Put a known credential on disk. Returns the refresh token it holds. */
function seedAuth(): string {
  writeFileSync(AUTH_PATH, JSON.stringify({
    tokens: { access_token: accessToken("first"), refresh_token: "refresh-token-1" },
  }));
  return "refresh-token-1";
}

/** The refresh token auth.json currently holds — the thing #580 was burning. */
const storedRefreshToken = (): string =>
  JSON.parse(readFileSync(AUTH_PATH, "utf8")).tokens.refresh_token;

const USAGE = {
  plan_type: "pro",
  rate_limit: {
    primary_window:   { used_percent: 42, limit_window_seconds: 18_000, resets_at: 1_800_000_000 },
    secondary_window: { used_percent: 7,  limit_window_seconds: 604_800, resets_at: 1_800_600_000 },
  },
};

/** The transport, recorded and answerable. Nothing here touches a network. */
const wire = {
  /** Every URL asked for, in order — the whole cost of a read, in one list. */
  calls: [] as string[],
  /** What `/wham/usage` answers with. 401 is the case that rotates a token. */
  usageStatus: 200,
  /** `retry-after`, in seconds, when the status carries one. */
  retryAfter: null as number | null,
  /** Each refresh token actually POSTed to the token endpoint. One entry per
   *  single-use credential spent, which is the number #580 is about. */
  spent: [] as string[],
};

const usageCalls  = () => wire.calls.filter(u => u.includes("/wham/usage"));
const tokenCalls  = () => wire.calls.filter(u => u.includes("/oauth/token"));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String((input as { url?: string })?.url ?? input);
  wire.calls.push(url);

  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  });

  if (url.includes("/oauth/token")) {
    const sent = JSON.parse(String(init?.body ?? "{}")).refresh_token;
    wire.spent.push(sent);
    // A rotating endpoint, like the real one: the reply carries a NEW refresh
    // token, and codex-auth writes it over the one just spent.
    return reply(200, {
      access_token:  accessToken(`rotated-${wire.spent.length}`),
      refresh_token: `refresh-token-${wire.spent.length + 1}`,
    });
  }
  // Best-effort and not the subject here; answered 404 so it costs one request
  // and returns null, which is what a real account without grants does.
  if (url.includes("rate-limit-reset-credits")) return reply(404, {});

  return reply(
    wire.usageStatus,
    USAGE,
    wire.retryAfter == null ? {} : { "retry-after": String(wire.retryAfter) },
  );
}) as unknown as typeof globalThis.fetch;

// The clock every case drives. `Date.now` is what the floor, the cooldown and the
// cache all read, and nothing in the fetch path waits on a real timer that a jump
// forward could outrun.
//
// FROZEN, not merely offset. A clock that still ran underneath would add the
// milliseconds each `await` really took to every measurement, and the cases here
// are written to the millisecond either side of the floor — "one short of it"
// would drift over the line on a slow machine and pass for the wrong reason on a
// fast one. Time moves only when a case says it does.
let skew = 0;
const FROZEN_AT = Date.now();
vi.spyOn(Date, "now").mockImplementation(() => FROZEN_AT + skew);
const advance = (ms: number) => { skew += ms; };

/** The module under test, with no memory of the previous case. */
async function freshModule() {
  vi.resetModules();
  // @ts-expect-error — .mjs server module, no types
  return await import("../../server/codex-quota.mjs");
}

beforeEach(() => {
  wire.calls.length = 0;
  wire.spent.length = 0;
  wire.usageStatus = 200;
  wire.retryAfter = null;
  seedAuth();
});

afterAll(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  for (const k of ["HOME", "USERPROFILE", "CODEX_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmSync(DIR, { recursive: true, force: true });
});

// The floor's own number, restated once so the cases read as intentions rather
// than as arithmetic. It is quota.mjs's FORCE_POLL_MS, which is the point.
const FLOOR_MS = 60_000;

describe("mayFetchQuota, the rule on its own", () => {
  it("is the same shape and the same minute as the Claude half's maySelfPoll", async () => {
    const { mayFetchQuota } = await freshModule();
    const now = 10_000_000;
    expect(mayFetchQuota({ now, lastFetchAt: now - FLOOR_MS, rateLimitedUntil: 0 })).toBe(true);
    expect(mayFetchQuota({ now, lastFetchAt: now - (FLOOR_MS - 1), rateLimitedUntil: 0 })).toBe(false);
    expect(mayFetchQuota({ now, lastFetchAt: 0, rateLimitedUntil: 0 })).toBe(true);
  });

  it("is never beaten by a cooldown having been set, however old the last read is", async () => {
    // quota.mjs says of its own floor: "It never beats the 429 cooldown." A
    // backend that is refusing us must not be asked because a minute went by.
    const { mayFetchQuota } = await freshModule();
    const now = 10_000_000;
    expect(mayFetchQuota({ now, lastFetchAt: 0, rateLimitedUntil: now + 1 })).toBe(false);
    expect(mayFetchQuota({ now, lastFetchAt: 0, rateLimitedUntil: now })).toBe(true);
  });
});

describe("a burst of forced reads, the shape any open page can produce", () => {
  it("costs one request upstream however many times it is asked", async () => {
    // The issue's own reproduction, sequential — which is the case `_inflight`
    // never covered, because each turn waits for the last one to settle before
    // asking again.
    const { fetchCodexQuota } = await freshModule();
    for (let i = 0; i < 12; i++) await fetchCodexQuota({ force: true });

    expect(usageCalls()).toHaveLength(1);
    // And the whole cost of the twelve, reset-credits included: two requests,
    // which is one read. Before the floor it was twenty-four.
    expect(wire.calls).toHaveLength(2);
  });

  it("still lets concurrent callers share the one run rather than refusing them", async () => {
    // The floor must not turn the in-flight dedupe into a refusal: five tabs
    // mounting at once get the reading, not four stale copies of nothing.
    const { fetchCodexQuota } = await freshModule();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => fetchCodexQuota({ force: true })),
    );

    expect(usageCalls()).toHaveLength(1);
    for (const r of results) expect(r).toBe(results[0]);
    expect(results[0].ok).toBe(true);
  });

  it("asks again once the floor has elapsed, because refresh still means refresh", async () => {
    // A floor is not a mute button. The button the user clicks has to work; what
    // it may not do is turn into a poll loop when it is held down.
    const { fetchCodexQuota } = await freshModule();
    await fetchCodexQuota({ force: true });
    expect(usageCalls()).toHaveLength(1);

    advance(FLOOR_MS - 1);
    await fetchCodexQuota({ force: true });
    expect(usageCalls(), "one millisecond short of the floor").toHaveLength(1);

    advance(1);
    const fresh = await fetchCodexQuota({ force: true });
    expect(usageCalls(), "and exactly on it").toHaveLength(2);
    expect(fresh.ok).toBe(true);
  });
});

describe("what a refused forced read is handed", () => {
  it("is the reading it already has, not an error", async () => {
    // The half of the fix that decides whether this is a defence or a bug. A user
    // who clicks ↻ twice in a second gets the numbers they are looking at; if the
    // refusal came back `{ok: false}` the panel would replace real gauges with
    // "ChatGPT API unreachable" for a minute, which is worse than the loop.
    const { fetchCodexQuota } = await freshModule();
    const first = await fetchCodexQuota({ force: true });
    expect(first.ok).toBe(true);

    advance(1_000);
    const again = await fetchCodexQuota({ force: true });

    expect(again.ok).toBe(true);
    expect(again.reason).toBeUndefined();
    expect(again.windows).toEqual(first.windows);
    expect(again.planLabel).toBe(first.planLabel);
    expect(usageCalls()).toHaveLength(1);
  });

  it("says it is stale, and keeps the timestamp of the data rather than of the read", async () => {
    // The age label on the panel is drawn from `fetchedAt`. Re-stamping it `now`
    // would put "just now" over numbers nobody re-read — quota.mjs already learned
    // that one and left the note about an age indicator that oscillates.
    const { fetchCodexQuota } = await freshModule();
    const first = await fetchCodexQuota({ force: true });

    advance(30_000);
    const again = await fetchCodexQuota({ force: true });

    expect(again.stale).toBe(true);
    expect(first.stale).toBeUndefined();
    expect(again.fetchedAt).toBe(first.fetchedAt);
  });

  it("serves a cached failure as itself, so a real problem still reads as one", async () => {
    // Marking it stale must not launder it into a success. `no_token`, an
    // untrusted base URL or an http_500 is the reading, and the panel's hint for
    // it is the right thing to keep showing.
    wire.usageStatus = 500;
    const { fetchCodexQuota } = await freshModule();
    const first = await fetchCodexQuota({ force: true });
    expect(first).toMatchObject({ ok: false, reason: "http_500" });

    const again = await fetchCodexQuota({ force: true });
    expect(again).toMatchObject({ ok: false, reason: "http_500", stale: true });
    expect(usageCalls()).toHaveLength(1);
  });
});

describe("a backend that keeps answering 401, which is the credential half", () => {
  it("spends one single-use refresh token, not one per request", async () => {
    // The whole point. Every turn re-reads auth.json and sees the token the
    // previous turn rotated to, so `staleAccessToken` is satisfied every time and
    // this loop used to rotate a fresh credential once per request — racing the
    // Codex CLI for the file each time, with `codex login` as the recovery.
    wire.usageStatus = 401;
    const { fetchCodexQuota } = await freshModule();

    for (let i = 0; i < 12; i++) await fetchCodexQuota({ force: true });

    expect(wire.spent).toEqual(["refresh-token-1"]);
    expect(tokenCalls()).toHaveLength(1);
    expect(storedRefreshToken()).toBe("refresh-token-2");
  });

  it("keeps its hands off the credential for the cooldown, not merely for the floor", async () => {
    // A second 401 after a successful rotation means the account is gone rather
    // than the token being stale, so the ordinary minute is not long enough: the
    // next attempt would rotate again on a credential the CLI may still be
    // holding.
    wire.usageStatus = 401;
    const { fetchCodexQuota } = await freshModule();
    const first = await fetchCodexQuota({ force: true });
    expect(first).toMatchObject({ ok: false, reason: "refresh_rejected" });
    expect(wire.spent).toHaveLength(1);

    advance(FLOOR_MS);
    await fetchCodexQuota({ force: true });
    expect(wire.spent, "past the floor, still inside the cooldown").toHaveLength(1);
    expect(usageCalls()).toHaveLength(2);   // the pre-refresh and post-refresh reads of the first turn

    advance(5 * FLOOR_MS);
    await fetchCodexQuota({ force: true });
    expect(wire.spent, "and past the cooldown, the deck tries again").toHaveLength(2);
  });

  it("honours a retry-after on a 429 rather than guessing at it", async () => {
    // The backend saying the ordinary thing in the ordinary way. quota.mjs reads
    // the same header for the same reason: it knows better than the constant.
    wire.usageStatus = 429;
    wire.retryAfter = 600;
    const { fetchCodexQuota } = await freshModule();
    expect(await fetchCodexQuota({ force: true })).toMatchObject({ ok: false, reason: "http_429" });
    expect(usageCalls()).toHaveLength(1);

    advance(9 * FLOOR_MS);           // nine minutes: past the floor, inside the 600s
    await fetchCodexQuota({ force: true });
    expect(usageCalls()).toHaveLength(1);

    advance(2 * FLOOR_MS);
    await fetchCodexQuota({ force: true });
    expect(usageCalls()).toHaveLength(2);
  });
});

describe("the unforced background poll", () => {
  it("is answered from the cache and costs nothing, as it always did", async () => {
    const { fetchCodexQuota } = await freshModule();
    const first = await fetchCodexQuota({ force: true });

    advance(30_000);
    const polled = await fetchCodexQuota();
    expect(polled).toBe(first);              // the cache entry itself, untouched
    expect(usageCalls()).toHaveLength(1);
  });

  it("goes out again once its own cache has expired, which the floor must not block", async () => {
    // CACHE_MS and FORCE_POLL_MS are the same minute, so a poll arriving with an
    // expired cache is always past the floor as well. Asserted rather than
    // reasoned about, because a floor that outlived the cache would freeze the
    // panel at the first reading it ever took.
    const { fetchCodexQuota } = await freshModule();
    await fetchCodexQuota({ force: true });

    advance(FLOOR_MS + 1_000);
    const polled = await fetchCodexQuota();
    expect(usageCalls()).toHaveLength(2);
    expect(polled.ok).toBe(true);
  });
});
