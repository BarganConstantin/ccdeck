// A Claude quota reading whose window has reset since it was taken.
//
// Every percentage quota.mjs serves belongs to a window with an end: a reading
// of 92% with "resets 1:11am" says nothing true once 1:11am has passed — the
// window it measured is over and a new one has started near empty. The server
// still handed such a reading out as current in two places. A claude-swap row
// is trusted for 45 minutes, and its 5-hour window can reset inside that age
// (claude-swap's collector backs off after a 429, which is exactly when its
// rows get old); and the minute-long result cache served whatever it held
// whether or not the reset had come and gone in the meantime. The panel drew
// the old number in red under a reset time already in the past.
//
// What is pinned here: a reading that has crossed its reset is not served as
// the answer. The deck asks for a new one — from claude-swap, and on its own
// floor from the usage endpoint — and when nothing newer can be had, the old
// one goes out marked stale, which is what it is.
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

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-quota-lapsed-"));
const CREDENTIALS = join(SANDBOX, ".credentials.json");

const { cli, swap } = vi.hoisted(() => ({
  cli: { calls: [] as string[][], stdout: "" },
  swap: { entry: null as unknown, collections: 0 },
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    run: async (cmd: string, args: string[] = []) => {
      cli.calls.push([cmd, ...args]);
      return { ok: true, code: 0, killed: false, timedOut: false, stdout: cli.stdout, stderr: "" };
    },
    pathLookup: (name: string) => `/usr/bin/${name}`,
  };
});

// claude-swap's store, answering whatever the case put in it. Asked to collect,
// it declines: a new row only appears when a case writes one.
vi.mock("../../server/claude-accounts.mjs", () => ({
  activeAccountUsage: async () => swap.entry,
  requestCollection: async () => { swap.collections++; return false; },
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

// Anthropic's usage endpoint, answering a reading taken after the reset. Every
// other URL — the profile and inventory reads behind a store answer — is a 404.
const api = { usageCalls: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = String((input as { url?: string })?.url ?? input);
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body,
  });
  if (!url.startsWith("https://api.anthropic.com/")) throw new Error(`test: unexpected fetch ${url}`);
  if (!url.startsWith("https://api.anthropic.com/api/oauth/usage?cedar_ember=1")
      || url.includes("skip_spend")) return reply(404, {});
  api.usageCalls++;
  return reply(200, {
    five_hour: { utilization: 3, resets_at: iso(Date.now() + 290 * MIN) },
    seven_day: { utilization: 40, resets_at: iso(Date.now() + 3 * 24 * 60 * MIN) },
  });
}) as unknown as typeof globalThis.fetch;

/** claude-swap's row for the active account: collected `ageMs` ago, with its
 *  5-hour window resetting `resetInMs` from now (negative: already reset). */
const row = (pct: number, ageMs: number, resetInMs: number) => ({
  num: 1,
  email: "a@b.c",
  organizationUuid: "org-1",
  fetchedAt: Date.now() - ageMs,
  lastGood: {
    five_hour: { pct, resets_at: iso(Date.now() + resetInMs) },
    seven_day: { pct: 30, resets_at: iso(Date.now() + 3 * 24 * 60 * MIN) },
  },
});

type Quota = { ok: boolean; source?: string; stale?: boolean; session5hPct?: number; session5hResetAt?: number };
type QuotaModule = { fetchClaudeQuota: (o?: { force?: boolean }) => Promise<Quota> };
let mod: QuotaModule;

beforeEach(async () => {
  swap.entry = null;
  swap.collections = 0;
  cli.calls.length = 0;
  // A CLI that runs and prints no windows: nothing it says can stand in for a
  // reading, so what a case gets back is what the other sources gave.
  cli.stdout = "Claude Code usage\nCurrent subscription: Max\n";
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

describe("a reading whose window has reset since it was taken", () => {
  it("is not served from claude-swap's store as the current reading", async () => {
    // 40 minutes old — inside the 45 the store is trusted for — with the
    // 5-hour window having reset 20 minutes ago.
    swap.entry = row(92, 40 * MIN, -20 * MIN);
    const q = await read();
    expect(swap.collections).toBeGreaterThan(0);   // claude-swap was asked for a new one
    // Nothing newer could be had, so the old row is what there is — and it
    // says it is stale rather than passing for the current window.
    expect(q).toMatchObject({ ok: true, source: "claude-swap", session5hPct: 92, stale: true });
  });

  it("sends the deck to read the window again itself", async () => {
    writeFileSync(CREDENTIALS, JSON.stringify({ claudeAiOauth: { accessToken: "test-token", expiresAt: FROZEN_AT + 365 * 24 * 60 * MIN } }));
    swap.entry = row(92, 40 * MIN, -20 * MIN);
    const q = await read();
    expect(api.usageCalls).toBe(1);
    expect(q).toMatchObject({ ok: true, source: "api", session5hPct: 3 });
    expect(q.stale).toBeFalsy();
  });

  it("is not served from the result cache once its reset has passed", async () => {
    // A row collected a minute ago, its window resetting in thirty seconds.
    swap.entry = row(92, MIN, 30_000);
    expect(await read()).toMatchObject({ source: "claude-swap", session5hPct: 92 });
    // Forty seconds on — well inside the minute the answer is cached for, and
    // past the reset — claude-swap has collected again.
    advance(40_000);
    swap.entry = row(4, 5_000, 299 * MIN);
    expect(await read()).toMatchObject({ source: "claude-swap", session5hPct: 4 });
  });

  it("leaves a reading whose window is still running exactly as it was", async () => {
    swap.entry = row(92, 40 * MIN, 20 * MIN);
    const q = await read();
    expect(q).toMatchObject({ ok: true, source: "claude-swap", session5hPct: 92 });
    expect(q.stale).toBeFalsy();
    expect(cli.calls).toHaveLength(0);
  });
});
