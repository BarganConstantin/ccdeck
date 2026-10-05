// What the Codex half does with a credential OpenAI has refused.
//
// A refresh token the token endpoint has answered `refresh_token_expired`,
// `invalid_grant` or a bare 401 for is dead: only `codex login` brings the
// login back, and it does that by writing a different one into auth.json.
// codex-quota.mjs states the rule — a backend that is refusing us must not be
// asked once per request — and the expiry-driven path broke it. With the
// access token past its `exp`, every 60-second poll asked codex-auth for a
// credential, which refreshed, which POSTed the same dead refresh token to
// auth.openai.com again, for as long as the panel stayed mounted.
//
// PLAIN NODE, no DOM. CODEX_HOME is a temp directory; `globalThis.fetch` is
// replaced wholesale, so nothing reaches auth.openai.com or chatgpt.com; the
// clock is frozen and moved by hand; and every case gets fresh modules, since
// the refresh queue, the quota cache, its floor and its cooldown are all
// module state.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-refused-"));
const prevEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CODEX_HOME = join(DIR, "codex");
if (!resolve(process.env.CODEX_HOME).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const AUTH_PATH = join(process.env.CODEX_HOME, "auth.json");

let skew = 0;
const FROZEN_AT = Date.now();
vi.spyOn(Date, "now").mockImplementation(() => FROZEN_AT + skew);
const advance = (ms: number) => { skew += ms; };

const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;

/** A JWT-shaped access token expiring at `expAt` (epoch ms). */
function jwt(tag: string, expAt: number): string {
  return `header.${Buffer.from(JSON.stringify({ sub: tag, exp: Math.floor(expAt / 1000) })).toString("base64url")}.${tag}`;
}

const seedAuth = (auth: Record<string, unknown>) => writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2));

type Reply = { status: number; body: unknown; retryAfter?: string };

/** The transport: the token endpoint answers `token`, the usage endpoint
 *  `usage` with `usedPercent` in its session lane; reset credits are a 404. */
const wire = {
  calls: [] as string[],
  token: { status: 200, body: {} } as Reply,
  usage: { status: 200, body: {} } as Reply,
  usedPercent: 5,
};
const tokenCalls = () => wire.calls.filter(u => u.includes("/oauth/token"));
const usageCalls = () => wire.calls.filter(u => u.includes("/wham/usage"));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = String((input as { url?: string })?.url ?? input);
  wire.calls.push(url);
  const reply = ({ status, body, retryAfter }: Reply) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? retryAfter ?? null : null) },
    json: async () => body,
  });
  if (url.includes("/oauth/token")) return reply(wire.token);
  if (url.includes("rate-limit-reset-credits")) return reply({ status: 404, body: {} });
  if (wire.usage.status !== 200) return reply(wire.usage);
  return reply({ status: 200, body: { rate_limit: { primary_window: { used_percent: wire.usedPercent, limit_window_seconds: 18_000 } } } });
}) as unknown as typeof globalThis.fetch;

const rotates = (tag: string): Reply => ({
  status: 200, body: { access_token: jwt(tag, Date.now() + 10 * DAY), refresh_token: `refresh-${tag}`, id_token: "id.x.y" },
});
const DEAD: Reply = { status: 400, body: { error: "refresh_token_expired" } };

type Reading = { ok: boolean; reason?: string; stale?: boolean; windows?: { pct: number }[] };
type QuotaModule = { fetchCodexQuota: (o?: { force?: boolean }) => Promise<Reading> };

async function freshQuota(): Promise<QuotaModule> {
  vi.resetModules();
  // @ts-expect-error — .mjs server module, no types
  return await import("../../server/codex-quota.mjs") as QuotaModule;
}

beforeEach(() => {
  wire.calls.length = 0;
  wire.token = rotates("rotated");
  wire.usage = { status: 200, body: {} };
  wire.usedPercent = 5;
  skew += 10 * MIN;
  vi.spyOn(console, "error").mockImplementation(() => {});
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

describe("a refresh token the token endpoint has refused", () => {
  /** An access token past its `exp` beside the given refresh token. */
  const expiredWith = (refresh: string) =>
    seedAuth({ tokens: { access_token: jwt("old", Date.now() - 60 * MIN), refresh_token: refresh } });

  it("is not POSTed again on every poll", async () => {
    expiredWith("refresh-dead");
    wire.token = DEAD;
    const quota = await freshQuota();
    for (let i = 0; i < 5; i++) {
      expect(await quota.fetchCodexQuota()).toMatchObject({ ok: false, reason: "refresh_rejected" });
      advance(61 * SEC);
    }
    expect(tokenCalls()).toHaveLength(1);
    expect(usageCalls()).toHaveLength(0);
  });

  it("is not POSTed again by the refresh a 401 forces either", async () => {
    // The access token looks valid; the backend says otherwise, and the refresh
    // that follows is refused. Past the five-minute cooldown the usage read is
    // tried again — and the refresh token it would spend is the same dead one.
    seedAuth({ tokens: { access_token: jwt("cur", Date.now() + 10 * DAY), refresh_token: "refresh-dead" } });
    wire.usage = { status: 401, body: {} };
    wire.token = DEAD;
    const quota = await freshQuota();
    expect(await quota.fetchCodexQuota({ force: true })).toMatchObject({ ok: false, reason: "refresh_rejected" });
    advance(5 * MIN + SEC);
    expect(await quota.fetchCodexQuota({ force: true })).toMatchObject({ ok: false, reason: "refresh_rejected" });
    expect(tokenCalls()).toHaveLength(1);
  });

  it("stops counting as refused the moment codex login writes a different one", async () => {
    expiredWith("refresh-dead");
    wire.token = DEAD;
    const quota = await freshQuota();
    expect(await quota.fetchCodexQuota()).toMatchObject({ ok: false, reason: "refresh_rejected" });

    expiredWith("refresh-new");
    wire.token = rotates("after-login");
    advance(61 * SEC);
    expect(await quota.fetchCodexQuota()).toMatchObject({ ok: true });
    expect(tokenCalls()).toHaveLength(2);
  });

  it("is only a refusal the endpoint said was final — a bad minute is tried again", async () => {
    expiredWith("refresh-1");
    wire.token = { status: 503, body: {} };
    const quota = await freshQuota();
    expect(await quota.fetchCodexQuota()).toMatchObject({ ok: false, reason: "refresh_failed" });
    advance(61 * SEC);
    expect(await quota.fetchCodexQuota()).toMatchObject({ ok: false, reason: "refresh_failed" });
    expect(tokenCalls()).toHaveLength(2);
  });
});

// The cooldown a refused login sets is five minutes long, and nothing could end
// it early: the panel's own hint says "run codex login", the user does, presses
// ↻, and is answered with the cached refusal until the five minutes are up. A
// wait that guards a dead credential is about that credential, and ends with
// it.
describe("the cooldown after a refused login", () => {
  /** A usage read refused, and the refresh it forces refused too. */
  async function refusedLogin(): Promise<QuotaModule> {
    seedAuth({ tokens: { access_token: jwt("cur", Date.now() + 10 * DAY), refresh_token: "refresh-1" } });
    wire.usage = { status: 401, body: {} };
    wire.token = { status: 400, body: { error: "invalid_grant" } };
    const quota = await freshQuota();
    expect(await quota.fetchCodexQuota({ force: true })).toMatchObject({ ok: false, reason: "refresh_rejected" });
    return quota;
  }

  it("ends as soon as codex login writes a new credential", async () => {
    const quota = await refusedLogin();
    seedAuth({ tokens: { access_token: jwt("new", Date.now() + 10 * DAY), refresh_token: "refresh-new" } });
    wire.usage = { status: 200, body: {} };
    wire.usedPercent = 12;
    advance(2 * MIN);
    const r = await quota.fetchCodexQuota({ force: true });
    expect(r).toMatchObject({ ok: true });
    expect(r.windows?.[0]?.pct).toBe(12);
  });

  it("holds, and asks nobody, while auth.json still carries the refused one", async () => {
    const quota = await refusedLogin();
    wire.calls.length = 0;
    advance(2 * MIN);
    expect(await quota.fetchCodexQuota({ force: true })).toMatchObject({ ok: false, reason: "refresh_rejected", stale: true });
    expect(wire.calls).toEqual([]);
  });
});

// A 429 used to replace the last good lanes with the failure, and then hold
// that failure through a cooldown of up to an hour under the panel's default
// hint — "ChatGPT API unreachable — click ↻ to retry" — which the cooldown
// refuses. The lanes the deck already read are still the best thing it has.
describe("a 429 from the usage endpoint", () => {
  it("keeps the last good lanes, marked stale, through the cooldown", async () => {
    seedAuth({ tokens: { access_token: jwt("cur", Date.now() + 10 * DAY), refresh_token: "refresh-1" } });
    wire.usedPercent = 42;
    const quota = await freshQuota();
    expect(await quota.fetchCodexQuota({ force: true })).toMatchObject({ ok: true });

    advance(61 * SEC);
    wire.usage = { status: 429, body: {}, retryAfter: "3600" };
    const limited = await quota.fetchCodexQuota({ force: true });
    expect(limited).toMatchObject({ ok: true, stale: true });
    expect(limited.windows?.[0]?.pct).toBe(42);

    advance(2 * MIN);
    const held = await quota.fetchCodexQuota({ force: true });
    expect(held).toMatchObject({ ok: true, stale: true });
    expect(held.windows?.[0]?.pct).toBe(42);
  });

  it("says the deck is waiting when it has no reading to hold", async () => {
    seedAuth({ tokens: { access_token: jwt("cur", Date.now() + 10 * DAY), refresh_token: "refresh-1" } });
    wire.usage = { status: 429, body: {} };
    const quota = await freshQuota();
    expect(await quota.fetchCodexQuota({ force: true })).toMatchObject({ ok: false, reason: "rate_limited" });
  });
});
