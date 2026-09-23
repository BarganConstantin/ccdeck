// What the Codex panel prints comes out of one JSON body, field by field (#1169).
//
// `/wham/usage` is OpenAI's payload and the deck parses it defensively on
// purpose: new plan types, new limit families and new numeric encodings arrive
// unannounced, so every section is optional and a `partial` flag says when
// something was dropped. That leniency is also why a wrong field name or a
// wrong clamp ships without a sound — the panel still draws, just the wrong
// thing. A spend cap reading "$0 of $200" or "$200 of $200", a monthly limit
// labelled "7-day window", a model-specific lane that silently is not there, a
// "$0" credits line, a reset-grant count or expiry that is off by one grant.
//
// Until this file the only 200 body any test sent had two windows and
// `plan_type: "pro"`, and what was asserted about it was that a second read
// returned the same object as the first. `individual_limit`, `spend_control`,
// `additional_rate_limits` and the reset-credits endpoint appeared in no test at
// all. So each case below sends one body and reads one field back by value.
//
// PLAIN NODE, no DOM. CODEX_HOME is a temp directory holding a made-up login
// whose access token does not expire for ten years, so nothing refreshes;
// `globalThis.fetch` is replaced wholesale, so nothing reaches chatgpt.com; and
// every case gets a fresh module, because the cache and the forced-read floor
// would otherwise answer the second case with the first one's body.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-mapping-"));
const prevEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CODEX_HOME = join(DIR, "codex");
if (!resolve(process.env.CODEX_HOME).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const CONFIG = join(process.env.CODEX_HOME, "config.toml");

// A JWT-shaped access token ten years from expiry: shouldRefresh answers false.
const exp = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;
const ACCESS = `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;
writeFileSync(join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({
  tokens: { access_token: ACCESS, refresh_token: "test-refresh-token", account_id: "acct-test" },
}));

/** The transport. `usage` is `/wham/usage`'s body; `reset` is the reset-credits
 *  endpoint's answer, 404 unless a case says otherwise. */
const wire = {
  calls: [] as string[],
  usage: {} as unknown,
  reset: { status: 404, body: {} as unknown },
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = String((input as { url?: string })?.url ?? input);
  wire.calls.push(url);
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: () => null },
    json: async () => body,
  });
  if (url.includes("/oauth/token")) throw new Error("test: nothing here may refresh");
  if (url.includes("rate-limit-reset-credits")) return reply(wire.reset.status, wire.reset.body);
  return reply(200, wire.usage);
}) as unknown as typeof globalThis.fetch;

type Window = { id: string; key: string; label: string; pct: number; windowSec: number | null; family?: string };
type Result = {
  ok: boolean;
  windows: Window[];
  extraWindows: Window[];
  plan: string | null;
  planLabel: string | null;
  creditsBalance: string | null;
  creditLimit: { limit: number; used: number; usedPct: number; remaining: number } | null;
  spendControlReached: boolean;
  resetCredits: { availableCount: number; nextExpiryAt: number | null } | null;
  partial: boolean;
};

/** Two ordinary windows, so a body that adds one field is otherwise a
 *  healthy reading and `partial` is about that field alone. */
const WINDOWS = {
  primary_window:   { used_percent: 42, limit_window_seconds: 18_000 },
  secondary_window: { used_percent: 7,  limit_window_seconds: 604_800 },
};

/** Send one body, read it back through a fresh module. */
async function read(body: Record<string, unknown>): Promise<Result> {
  wire.usage = { rate_limit: WINDOWS, ...body };
  vi.resetModules();
  // @ts-expect-error — .mjs server module, no types
  const { fetchCodexQuota } = await import("../../server/codex-quota.mjs");
  const r = await fetchCodexQuota({ force: true });
  expect(r.ok, `the read failed: ${r.reason}`).toBe(true);
  return r;
}

beforeEach(() => {
  wire.calls.length = 0;
  wire.reset = { status: 404, body: {} };
});

afterEach(() => { rmSync(CONFIG, { force: true }); });

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTempDir(DIR);
});

describe("the monthly spend cap", () => {
  // UsagePanel draws this as "spend cap · $used of $limit", so each of these
  // is a dollar figure on the user's screen.

  it("derives what was spent from the percentage left", async () => {
    const r = await read({ individual_limit: { limit: 200, remaining_percent: 25 } });
    expect(r.creditLimit).toMatchObject({ limit: 200, used: 150, usedPct: 75, remaining: 50 });
  });

  it("takes a spend it is given outright, numeric string and all", async () => {
    // Team and enterprise payloads send numbers as strings.
    const r = await read({ individual_limit: { limit: 200, used: "40" } });
    expect(r.creditLimit).toMatchObject({ limit: 200, used: 40, usedPct: 20, remaining: 160 });
  });

  it("draws no cap at all for a limit of zero", async () => {
    // "$0 of $0" is not a cap; it is an account with no spend control.
    expect((await read({ individual_limit: { limit: 0, remaining_percent: 100 } })).creditLimit).toBeNull();
  });

  it("clamps a percentage left that is out of range, both ways", async () => {
    expect((await read({ individual_limit: { limit: 200, remaining_percent: 120 } })).creditLimit)
      .toMatchObject({ used: 0, usedPct: 0, remaining: 200 });
    expect((await read({ individual_limit: { limit: 200, remaining_percent: -5 } })).creditLimit)
      .toMatchObject({ used: 200, usedPct: 100, remaining: 0 });
  });

  it("finds the cap wherever the payload puts it, top level first", async () => {
    const cap = { limit: 200, remaining_percent: 25 };
    expect((await read({ rate_limit: { ...WINDOWS, individual_limit: cap } })).creditLimit)
      .toMatchObject({ limit: 200, used: 150 });
    expect((await read({ spend_control: { individual_limit: cap } })).creditLimit)
      .toMatchObject({ limit: 200, used: 150 });
    // Two answers in one body: the top-level one is the one drawn.
    expect((await read({
      individual_limit: { limit: 500, remaining_percent: 50 },
      spend_control: { individual_limit: cap },
    })).creditLimit).toMatchObject({ limit: 500, used: 250 });
  });

  it("says when the spend control has been reached", async () => {
    expect((await read({ spend_control: { reached: true } })).spendControlReached).toBe(true);
    expect((await read({ spend_control: { reached: false } })).spendControlReached).toBe(false);
  });
});

describe("the rate-limit windows", () => {
  it("labels each window by its length, not by the slot it arrived in", async () => {
    const r = await read({});
    expect(r.windows.map(w => [w.key, w.label])).toEqual([
      ["session", "5-hour window"],
      ["weekly", "7-day window"],
    ]);
  });

  it("calls a thirty-day window a thirty-day window", async () => {
    // A monthly limit labelled "7-day window" is the regression this is for.
    const r = await read({ rate_limit: {
      primary_window: { used_percent: 11, limit_window_seconds: 2_592_000 },
    } });
    expect(r.windows).toEqual([expect.objectContaining({ key: "monthly", label: "30-day window", pct: 11 })]);
  });

  it("still draws a window whose length it was not told", async () => {
    const r = await read({ rate_limit: { primary_window: { used_percent: 11 } } });
    expect(r.windows).toEqual([expect.objectContaining({ key: "unknown", label: "Rate limit", windowSec: null })]);
  });

  it("reads a percentage sent as a string, and never clamps one over 100", async () => {
    // Over quota is real information: a bar pinned at 100 would hide by how much.
    const r = await read({ rate_limit: {
      primary_window:   { used_percent: "42.5", limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 130, limit_window_seconds: 604_800 },
    } });
    expect(r.windows.map(w => w.pct)).toEqual([42.5, 130]);
  });

  it("puts the session window first when the weekly one comes in the primary slot", async () => {
    // Free plans do exactly this.
    const r = await read({ rate_limit: {
      primary_window:   { used_percent: 60, limit_window_seconds: 604_800 },
      secondary_window: { used_percent: 20, limit_window_seconds: 18_000 },
    } });
    expect(r.windows.map(w => [w.key, w.pct])).toEqual([["session", 20], ["weekly", 60]]);
  });
});

describe("model-specific limits", () => {
  it("turns each additional limit into a lane named for its model", async () => {
    const r = await read({ additional_rate_limits: [{
      limit_name: "GPT-5 Codex Mini",
      metered_feature: "codex_mini",
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } },
    }] });
    expect(r.extraWindows).toHaveLength(1);
    expect(r.extraWindows[0]).toMatchObject({
      id: "codex-mini-session",
      family: "codex-mini",
      label: "GPT-5 Codex Mini · 5-hour window",
      pct: 10,
    });
    expect(r.partial).toBe(false);
  });

  it("says the reading is partial when that section is not a list it can read", async () => {
    // The windows above it are fine, so `partial` here is about the lanes that
    // could not be drawn — not an empty panel.
    const r = await read({ additional_rate_limits: "garbage" });
    expect(r.extraWindows).toEqual([]);
    expect(r.windows).toHaveLength(2);
    expect(r.partial).toBe(true);
  });
});

describe("credits and plan", () => {
  it("shows no credits line for a zero balance, and the balance as sent otherwise", async () => {
    expect((await read({ credits: { balance: "0" } })).creditsBalance).toBeNull();
    expect((await read({ credits: { balance: "12.50" } })).creditsBalance).toBe("12.50");
  });

  it("names the plan the way OpenAI markets it", async () => {
    expect(await read({ plan_type: "prolite" })).toMatchObject({ plan: "prolite", planLabel: "Pro 5x" });
    expect((await read({ plan_type: "k12" })).planLabel).toBe("K12");
    // An initialism, which title case would spell "Cbp".
    expect((await read({ plan_type: "cbp" })).planLabel).toBe("CBP");
    expect((await read({ plan_type: "team_enterprise" })).planLabel).toBe("Team Enterprise");
  });
});

describe("reset credits", () => {
  it("counts the grants and names the earliest one still available to expire", async () => {
    wire.reset = { status: 200, body: {
      available_count: 2,
      credits: [
        { status: "available", expires_at: "2026-10-01T00:00:00Z" },
        { status: "used",      expires_at: "2026-09-22T00:00:00Z" },   // earlier, but spent
        { status: "available", expires_at: "2026-09-25T00:00:00Z" },
      ],
    } };
    expect((await read({})).resetCredits)
      .toEqual({ availableCount: 2, nextExpiryAt: Date.parse("2026-09-25T00:00:00Z") });
  });

  it("draws nothing from a count that cannot be a count", async () => {
    wire.reset = { status: 200, body: { available_count: -1, credits: [] } };
    expect((await read({})).resetCredits).toBeNull();
  });
});

describe("the base URL a config file names", () => {
  it("adds /backend-api to a bare chatgpt.com, as the Codex CLI does", async () => {
    // Without it the base speaks /api/codex/*, a path chatgpt.com does not
    // serve, and the panel goes dark on a config the CLI itself accepts.
    writeFileSync(CONFIG, 'chatgpt_base_url = "https://chatgpt.com"\n');
    await read({});
    expect(wire.calls[0]).toBe("https://chatgpt.com/backend-api/wham/usage");
  });
});
