// A Claude account switch the deck did not make.
//
// The deck forgets the quota it holds when it switches accounts itself
// (invalidateQuotaCache, from the accounts panel and the auto-switch loop). A
// switch made anywhere else — `cswap switch` in a terminal, claude-swap's own
// auto-switch, `claude /login` as somebody else — reached none of that, and the
// floor that keeps the deck to one paid read every five minutes served the
// previous account's last reading, marked stale, until it lapsed: the usage
// panel said 80% for an account whose own numbers were 10%, beside an accounts
// panel that already showed the new account as live.
//
// A held reading is only served for the account it was read for. The account
// is claude-swap's active one where it knows it, and otherwise the token in
// Claude Code's credentials file; a change of either is a question only a new
// read can answer, so that read may go out on the refresh button's floor.
//
// Nothing here reaches the network, runs Claude Code or reads claude-swap's
// store: fetch is replaced, the `claude` CLI is exec.mjs's `run` answering from
// a script, the store is a stand-in, and the Claude config directory is a temp
// directory. The clock is frozen and moved by hand.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withGapsSkipped } from "./skip-gaps";

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-quota-external-"));
const CREDENTIALS = join(SANDBOX, ".credentials.json");

const { cli, swap } = vi.hoisted(() => ({
  cli: { calls: [] as string[][] },
  swap: { entry: null as unknown },
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    run: async (cmd: string, args: string[] = []) => {
      cli.calls.push([cmd, ...args]);
      return { ok: true, code: 0, killed: false, timedOut: false, stdout: "Claude Code usage\n", stderr: "" };
    },
    pathLookup: (name: string) => `/usr/bin/${name}`,
  };
});

vi.mock("../../server/claude-accounts.mjs", () => ({
  activeAccountUsage: async () => swap.entry,
  requestCollection: async () => false,
}));

vi.mock("../../server/claude-dir.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, claudeConfigDir: () => SANDBOX, claudeCliCandidates: () => ["claude"] };
});

let skew = 0;
const FROZEN_AT = Date.now();
vi.spyOn(Date, "now").mockImplementation(() => FROZEN_AT + skew);
const advance = (ms: number) => { skew += ms; };
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

// Anthropic's usage endpoint, answering for whichever token asks: each account
// has its own numbers. Every other URL is a 404.
const USAGE_BY_TOKEN: Record<string, number> = { "token-a": 80, "token-a2": 81, "token-b": 10 };
const api = { usageCalls: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
  const url = String((input as { url?: string })?.url ?? input);
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body,
  });
  if (!url.startsWith("https://api.anthropic.com/")) throw new Error(`test: unexpected fetch ${url}`);
  if (!url.startsWith("https://api.anthropic.com/api/oauth/usage?cedar_ember=1") || url.includes("skip_spend")) {
    return reply(404, {});
  }
  api.usageCalls++;
  const token = String(init?.headers?.Authorization ?? "").replace(/^Bearer /, "");
  return reply(200, {
    five_hour: { utilization: USAGE_BY_TOKEN[token], resets_at: iso(Date.now() + 200 * MIN) },
    seven_day: { utilization: 30, resets_at: iso(Date.now() + 3 * 24 * 60 * MIN) },
  });
}) as unknown as typeof globalThis.fetch;

/** Claude Code signed in with `token`, as its credentials file says. */
const signedIn = (token: string) => writeFileSync(CREDENTIALS, JSON.stringify({
  claudeAiOauth: { accessToken: token, expiresAt: FROZEN_AT + 365 * 24 * 60 * MIN },
}));

/** claude-swap's row for the active account, two hours old — too old to be
 *  the answer, so the deck reads for itself. */
const row = (who: "a" | "b", pct: number) => ({
  num: who === "a" ? 1 : 2,
  email: `${who}@b.c`,
  organizationUuid: `org-${who}`,
  fetchedAt: Date.now() - 120 * MIN,
  lastGood: {
    five_hour: { pct, resets_at: iso(Date.now() + 100 * MIN) },
    seven_day: { pct: 20, resets_at: iso(Date.now() + 3 * 24 * 60 * MIN) },
  },
});

type Quota = { ok: boolean; source?: string; stale?: boolean; session5hPct?: number };
type QuotaModule = { fetchClaudeQuota: (o?: { force?: boolean }) => Promise<Quota> };
let mod: QuotaModule;

beforeEach(async () => {
  swap.entry = null;
  cli.calls.length = 0;
  api.usageCalls = 0;
  rmSync(CREDENTIALS, { force: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.resetModules();
  mod = await import("../../server/quota.mjs") as unknown as QuotaModule;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  rmTempDir(SANDBOX);
});

const read = () => withGapsSkipped(() => mod.fetchClaudeQuota());

describe("a switch made outside the deck", () => {
  it("stops serving the previous account's reading after `cswap switch`", async () => {
    swap.entry = row("a", 70);
    signedIn("token-a");
    expect(await read()).toMatchObject({ source: "api", session5hPct: 80 });

    // claude-swap makes slot 2 active and puts its credential in place.
    swap.entry = row("b", 5);
    signedIn("token-b");
    advance(MIN + 1_000);   // past the result cache and the refresh floor, inside the five-minute one
    const q = await read();
    expect(q.session5hPct).not.toBe(80);
    expect(q).toMatchObject({ source: "api", session5hPct: 10 });
  });

  it("stops serving it after `claude /login` as somebody else, with no claude-swap", async () => {
    signedIn("token-a");
    expect(await read()).toMatchObject({ source: "api", session5hPct: 80 });

    signedIn("token-b");
    advance(MIN + 1_000);
    const q = await read();
    expect(q.session5hPct).not.toBe(80);
    expect(q).toMatchObject({ source: "api", session5hPct: 10 });
  });

  it("is not seen in a token refreshed for the same account claude-swap has active", async () => {
    swap.entry = row("a", 70);
    signedIn("token-a");
    expect(await read()).toMatchObject({ source: "api", session5hPct: 80 });

    // Claude Code rotated its token; the account is the same one.
    signedIn("token-a2");
    advance(MIN + 1_000);
    expect(await read()).toMatchObject({ source: "api", session5hPct: 80, stale: true });
    expect(api.usageCalls).toBe(1);   // the five-minute floor still holds
  });
});
