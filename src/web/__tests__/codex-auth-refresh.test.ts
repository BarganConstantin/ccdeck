// How the deck spends the Codex refresh token, and what it concludes when that
// fails (#1169).
//
// OpenAI rotates the refresh token and it is single-use, so each of the
// decisions below costs the user something real when it is made wrong:
//
//   - WHEN to refresh. codex-auth refreshes ahead of use when the access
//     token's `exp` is inside 90 seconds, or — with no readable `exp` — when
//     the CLI last refreshed more than eight days ago. Get that wrong one way
//     and every quota read opens with a 401; the other way and the deck spends
//     a token nobody needed spent, racing the Codex CLI for it.
//   - WHAT A FAILURE MEANS. `invalid_grant`, `refresh_token_reused` and a 401
//     are a dead credential that only `codex login` brings back; a 503 is
//     auth.openai.com having a bad minute. Calling a 503 "sign in again" sends
//     the user to re-login for nothing; calling `invalid_grant` transient
//     re-POSTs a dead token every poll.
//   - WHO IT IS. An API-key install has no ChatGPT session at all, and sending
//     its key to chatgpt.com only produces a confusing 401.
//
// The only token endpoint any test had faked always answered 200 with a
// rotated token, so none of the failure paths, and neither proactive rule, had
// ever run. Here the endpoint answers whatever each case needs.
//
// PLAIN NODE, no DOM. CODEX_HOME is a temp directory; `globalThis.fetch` is
// replaced wholesale, so nothing reaches auth.openai.com or chatgpt.com; the
// clock is frozen and moved by hand; and every case gets fresh modules, since
// the refresh queue, the quota cache, its floor and its cooldown are all
// module state.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-refresh-"));
const prevEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CODEX_HOME = join(DIR, "codex");
if (!resolve(process.env.CODEX_HOME).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const AUTH_PATH = join(process.env.CODEX_HOME, "auth.json");

// The clock, frozen. Every `exp` below is written relative to it, and the
// quota cases move it across the sixty-second floor and the five-minute
// cooldown instead of waiting them out.
let skew = 0;
const FROZEN_AT = Date.now();
vi.spyOn(Date, "now").mockImplementation(() => FROZEN_AT + skew);
const advance = (ms: number) => { skew += ms; };

const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;

/** A JWT-shaped access token. `expAt` is epoch ms, or null for no `exp` claim. */
function jwt(tag: string, expAt: number | null): string {
  const claims = expAt == null ? { sub: tag } : { sub: tag, exp: Math.floor(expAt / 1000) };
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${tag}`;
}

/** Put a credential on disk and return its bytes, for "left untouched" checks. */
function seedAuth(auth: Record<string, unknown>): string {
  const text = JSON.stringify(auth, null, 2);
  writeFileSync(AUTH_PATH, text);
  return text;
}
const onDisk = () => readFileSync(AUTH_PATH, "utf8");

type Reply = { status: number; body: unknown } | "throw";

/** The transport. `token` is what the token endpoint does next; the usage
 *  endpoint answers `usage`, and reset credits always answer 404. */
const wire = {
  calls: [] as string[],
  token: { status: 200, body: {} } as Reply,
  usage: 200,
};
const tokenCalls = () => wire.calls.filter(u => u.includes("/oauth/token"));
const usageCalls = () => wire.calls.filter(u => u.includes("/wham/usage"));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = String((input as { url?: string })?.url ?? input);
  wire.calls.push(url);
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: () => null },
    json: async () => body,
  });
  if (url.includes("/oauth/token")) {
    if (wire.token === "throw") throw new Error("test: connection reset");
    return reply(wire.token.status, wire.token.body);
  }
  if (url.includes("rate-limit-reset-credits")) return reply(404, {});
  return reply(wire.usage, { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18_000 } } });
}) as unknown as typeof globalThis.fetch;

/** A token endpoint that works, rotating to a fresh pair. */
const ROTATED = jwt("rotated", Date.now() + 10 * DAY);
const rotates = (): Reply => ({ status: 200, body: { access_token: ROTATED, refresh_token: "refresh-2", id_token: "id.x.y" } });

type Auth = { ok: boolean; reason?: string; code?: string | null; refreshed?: boolean; accessToken?: string | null; apiKeyMode?: boolean };
type AuthModule = {
  getCodexAuth: () => Promise<Auth>;
  forceCodexRefresh: (token: string | null) => Promise<Auth>;
};
type QuotaModule = { fetchCodexQuota: (o?: { force?: boolean }) => Promise<{ ok: boolean; reason?: string; stale?: boolean }> };

async function fresh(): Promise<{ auth: AuthModule; quota: QuotaModule }> {
  vi.resetModules();
  // @ts-expect-error — .mjs server module, no types
  const quota = await import("../../server/codex-quota.mjs") as QuotaModule;
  // @ts-expect-error — .mjs server module, no types
  const auth = await import("../../server/codex-auth.mjs") as AuthModule;
  return { auth, quota };
}

beforeEach(() => {
  wire.calls.length = 0;
  wire.token = rotates();
  wire.usage = 200;
  skew += 10 * MIN;   // clear of whatever floor the previous case stamped
});

afterAll(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTempDir(DIR);
});

describe("refreshing before the token is used", () => {
  it("spends the refresh token once for an access token that has already expired, and keeps what came back", async () => {
    seedAuth({ tokens: { access_token: jwt("old", Date.now() - 60 * MIN), refresh_token: "refresh-1" } });
    const { auth } = await fresh();

    const r = await auth.getCodexAuth();
    expect(r).toMatchObject({ ok: true, refreshed: true, accessToken: ROTATED });
    expect(tokenCalls()).toEqual(["https://auth.openai.com/oauth/token"]);
    // The rotated pair is on disk before anything uses it — the old refresh
    // token is already spent server-side, so this write is the login.
    const saved = JSON.parse(onDisk());
    expect(saved.tokens).toMatchObject({ access_token: ROTATED, refresh_token: "refresh-2" });
    // Stamped, so the eight-day fallback below has something true to read.
    expect(Date.parse(saved.last_refresh)).not.toBeNaN();
  });

  it("refreshes inside the ninety-second skew, and not a minute outside it", async () => {
    seedAuth({ tokens: { access_token: jwt("soon", Date.now() + 60 * SEC), refresh_token: "refresh-1" } });
    await (await fresh()).auth.getCodexAuth();
    expect(tokenCalls()).toHaveLength(1);

    wire.calls.length = 0;
    seedAuth({ tokens: { access_token: jwt("later", Date.now() + 10 * MIN), refresh_token: "refresh-1" } });
    expect(await (await fresh()).auth.getCodexAuth()).toMatchObject({ ok: true, refreshed: false });
    expect(tokenCalls()).toEqual([]);
  });

  it("falls back to the age of the last refresh when the token carries no expiry", async () => {
    const noExp = jwt("opaque", null);
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

    seedAuth({ tokens: { access_token: noExp, refresh_token: "refresh-1" }, last_refresh: at(9) });
    await (await fresh()).auth.getCodexAuth();
    expect(tokenCalls(), "nine days: past the eight-day fallback").toHaveLength(1);

    for (const lastRefresh of [at(7), "garbage"]) {
      wire.calls.length = 0;
      seedAuth({ tokens: { access_token: noExp, refresh_token: "refresh-1" }, last_refresh: lastRefresh });
      await (await fresh()).auth.getCodexAuth();
      // An unreadable date is not evidence of age: refreshing on it would
      // spend a token on every read of a file the deck did not write.
      expect(tokenCalls(), `last_refresh ${lastRefresh}`).toEqual([]);
    }
  });
});

describe("what a failed refresh means", () => {
  const CURRENT = jwt("current", Date.now() + 10 * DAY);

  /** Refresh because the backend rejected CURRENT, against an endpoint that
   *  answers `reply`, and check the credential on disk was not touched. */
  async function refreshAgainst(reply: Reply): Promise<Auth> {
    const before = seedAuth({ tokens: { access_token: CURRENT, refresh_token: "refresh-1" } });
    wire.token = reply;
    const r = await (await fresh()).auth.forceCodexRefresh(CURRENT);
    expect(tokenCalls(), "the token was spent exactly once").toHaveLength(1);
    // Nothing is written on any failure: either the server did not rotate, or
    // the outcome is unknown and the next attempt must retry with what is here.
    expect(onDisk()).toBe(before);
    return r;
  }

  it("is a dead login for invalid_grant", async () => {
    expect(await refreshAgainst({ status: 400, body: { error: "invalid_grant" } }))
      .toEqual({ ok: false, reason: "refresh_rejected", code: "invalid_grant" });
  });

  it("is a dead login for a reused token, whatever case the code comes back in", async () => {
    expect(await refreshAgainst({ status: 400, body: { error: { code: "REFRESH_TOKEN_REUSED" } } }))
      .toEqual({ ok: false, reason: "refresh_rejected", code: "refresh_token_reused" });
  });

  it("is a dead login for a bare 401, code or no code", async () => {
    expect(await refreshAgainst({ status: 401, body: {} }))
      .toEqual({ ok: false, reason: "refresh_rejected", code: null });
  });

  it("is a bad minute, not a dead login, for a 5xx", async () => {
    expect(await refreshAgainst({ status: 503, body: {} })).toMatchObject({ ok: false, reason: "refresh_failed" });
    wire.calls.length = 0;
    expect(await refreshAgainst({ status: 500, body: { code: "server_error" } }))
      .toEqual({ ok: false, reason: "refresh_failed", code: "server_error" });
  });

  it("is a bad minute when the request never came back", async () => {
    expect(await refreshAgainst("throw")).toEqual({ ok: false, reason: "refresh_failed" });
  });

  it("is not a success when a 200 carries no access token", async () => {
    // A captive portal, a proxy's error page, a truncated body. Writing here
    // would persist the spent refresh token beside a fresh last_refresh.
    expect(await refreshAgainst({ status: 200, body: {} }))
      .toEqual({ ok: false, reason: "refresh_failed", code: "no_access_token" });
  });
});

describe("an API-key install", () => {
  it("is reported as one and never sent to chatgpt.com", async () => {
    // With a ChatGPT session still on disk from an earlier `codex login`, so
    // `auth_mode` is the only thing saying which credential this install uses
    // — and an expired access token beside it, so a mode read the other way
    // round would be visible as a refresh rather than as silence.
    seedAuth({
      auth_mode: "apikey",
      OPENAI_API_KEY: "sk-test-not-a-real-key",
      tokens: { access_token: jwt("stale", Date.now() - 60 * MIN), refresh_token: "refresh-1" },
    });
    const { auth, quota } = await fresh();
    expect(await auth.getCodexAuth()).toMatchObject({ ok: true, apiKeyMode: true, accessToken: null });
    expect(await quota.fetchCodexQuota({ force: true })).toMatchObject({ ok: false, reason: "api_key_mode" });
    expect(wire.calls).toEqual([]);
  });

  it("is recognised by a key with no ChatGPT tokens beside it, whatever auth_mode says", async () => {
    seedAuth({ OPENAI_API_KEY: "sk-test-not-a-real-key" });
    expect(await (await fresh()).auth.getCodexAuth()).toMatchObject({ ok: true, apiKeyMode: true });
    expect(wire.calls).toEqual([]);
  });
});

describe("the quota read after a 401", () => {
  const CURRENT = jwt("current", Date.now() + 10 * DAY);

  it("backs off for five minutes when the refresh says the login is dead", async () => {
    // Rotating another single-use token a minute later would burn the one the
    // Codex CLI is still holding, for a login only `codex login` can fix.
    seedAuth({ tokens: { access_token: CURRENT, refresh_token: "refresh-1" } });
    wire.usage = 401;
    wire.token = { status: 400, body: { error: "invalid_grant" } };
    const { quota } = await fresh();

    expect(await quota.fetchCodexQuota({ force: true })).toMatchObject({ ok: false, reason: "refresh_rejected" });
    expect(tokenCalls()).toHaveLength(1);

    wire.calls.length = 0;
    advance(61 * SEC);   // past the forced-read floor, inside the cooldown
    await quota.fetchCodexQuota({ force: true });
    expect(wire.calls, "a dead login was asked about again inside its cooldown").toEqual([]);

    advance(5 * MIN);
    await quota.fetchCodexQuota({ force: true });
    expect(usageCalls(), "and asked again once the cooldown ran out").toHaveLength(1);
  });

  it("tries again after the ordinary floor when the refresh only failed", async () => {
    seedAuth({ tokens: { access_token: CURRENT, refresh_token: "refresh-1" } });
    wire.usage = 401;
    wire.token = { status: 503, body: {} };
    const { quota } = await fresh();

    expect(await quota.fetchCodexQuota({ force: true })).toMatchObject({ ok: false, reason: "refresh_failed" });

    wire.calls.length = 0;
    advance(61 * SEC);
    await quota.fetchCodexQuota({ force: true });
    expect(usageCalls()).toHaveLength(1);
    expect(tokenCalls()).toHaveLength(1);
  });
});
