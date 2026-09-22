// quota.mjs's two sources of its own, off the happy path (#1169).
//
// When claude-swap's store has nothing for the active account the Usage panel
// falls back to what quota.mjs can fetch itself: Anthropic's OAuth usage
// endpoint with the token Claude Code keeps in .credentials.json, and failing
// that `claude --print /usage`, parsed. Both spend a budget of roughly 28-30
// requests an hour per token that claude-swap shares, which is why a 429 arms a
// cooldown that no forced read may beat — and the cooldown is the part that had
// never run. The one OAuth test answered 200; the 429 tests in the suite are all
// codex-quota's.
//
// If the cooldown regresses the deck hammers the endpoint through a rate limit
// and starves claude-swap, the #742-era reports' shape; if it sticks, the panel
// says "waiting" forever. And the CLI parser is the ONLY source on a Mac whose
// credentials live in the Keychain: every CLI fixture in the suite carried a
// session line and a week line and nothing else, so the reset labels, the
// timezone suffix they carry, and the Sonnet and Opus lines were never read
// back by value from either source.
//
// Nothing here reaches the network or runs Claude Code: fetch is replaced, the
// `claude` CLI is exec.mjs's `run` answering from a script, claude-swap's store
// is replaced by one that has nothing, and the Claude config directory the
// credential is read from is a temp directory. The clock is frozen and moved by
// hand, and every case gets a fresh module, because the cooldown, the floor, the
// cache and the last good reading are all module state.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-quota-own-"));
const CREDENTIALS = join(SANDBOX, ".credentials.json");

const { cli } = vi.hoisted(() => ({
  cli: {
    calls: [] as string[][],
    reply: { ok: true, code: 0 as number | string, stdout: "", stderr: "" },
  },
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    run: async (cmd: string, args: string[] = []) => {
      cli.calls.push([cmd, ...args]);
      return { killed: false, timedOut: false, ...cli.reply };
    },
    pathLookup: (name: string) => `/usr/bin/${name}`,
  };
});

// claude-swap has nothing for this account, and is not asked to collect: the
// sources under test are the ones quota.mjs pays for itself.
vi.mock("../../server/claude-accounts.mjs", () => ({
  activeAccountUsage: async () => null,
  requestCollection: async () => false,
}));

vi.mock("../../server/claude-dir.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, claudeConfigDir: () => SANDBOX, claudeCliCandidates: () => ["claude"] };
});

// Anthropic's usage endpoint. `next` is what it does on the following request.
type Answer = { status: number; body?: unknown; retryAfter?: string } | "throw";
const api = { calls: 0, next: { status: 200, body: {} } as Answer };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = String((input as { url?: string })?.url ?? input);
  if (!url.startsWith("https://api.anthropic.com/api/oauth/usage")) throw new Error(`test: unexpected fetch ${url}`);
  api.calls++;
  if (api.next === "throw") throw new Error("test: connection reset");
  const { status, body = {}, retryAfter } = api.next;
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? retryAfter ?? null : null) },
    json: async () => body,
  };
}) as unknown as typeof globalThis.fetch;

let skew = 0;
const FROZEN_AT = Date.now();
vi.spyOn(Date, "now").mockImplementation(() => FROZEN_AT + skew);
const at = (ms: number) => { skew = ms; };
const SEC = 1000;

type Quota = {
  ok: boolean; reason?: string; source?: string; stale?: boolean;
  session5hPct?: number; session5hReset?: string; session5hResetAt?: number;
  week7dPct?: number; week7dReset?: string; weekSonnetPct?: number; weekOpusPct?: number;
};
type QuotaModule = {
  fetchClaudeQuota: (o?: { force?: boolean }) => Promise<Quota>;
  parseResetToSec: (s: string) => number | null;
};

async function freshQuota(): Promise<QuotaModule> {
  vi.resetModules();
  return await import("../../server/quota.mjs") as unknown as QuotaModule;
}

const force = (q: QuotaModule) => q.fetchClaudeQuota({ force: true });
const cliRuns = () => cli.calls.filter(c => c.includes("/usage"));

/** A signed-in Claude Code, as its credentials file says. */
function signedIn({ expiresAt = FROZEN_AT + 365 * 24 * 3600 * SEC } = {}) {
  writeFileSync(CREDENTIALS, JSON.stringify({ claudeAiOauth: { accessToken: "test-oauth-token", expiresAt } }));
}

/** What `claude --print /usage` prints when it can answer. */
const CLI_OK = "Claude Code usage\nCurrent subscription: Max\n"
  + "Current session: 37% used\nCurrent week (all models): 11% used\n";
/** A machine with no Claude Code: run normalises that to ENOENT everywhere. */
const CLI_MISSING = { ok: false, code: "ENOENT", stdout: "", stderr: "" };

beforeEach(() => {
  cli.calls.length = 0;
  cli.reply = { ok: true, code: 0, stdout: CLI_OK, stderr: "" };
  api.calls = 0;
  api.next = { status: 200, body: {} };
  rmSync(CREDENTIALS, { force: true });
  at(0);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  rmTempDir(SANDBOX);
});

describe("the OAuth usage endpoint answering 429", () => {
  it("falls through to the CLI in the same read", async () => {
    signedIn();
    api.next = { status: 429, retryAfter: "120" };
    const q = await freshQuota();
    expect(await force(q)).toMatchObject({ ok: true, source: "cli", session5hPct: 37 });
    expect(api.calls).toBe(1);
    expect(cliRuns()).toHaveLength(1);
  });

  it("asks nobody again until retry-after has passed, however hard it is forced", async () => {
    signedIn();
    api.next = { status: 429, retryAfter: "120" };
    cli.reply = CLI_MISSING;           // so no good reading is held to fall back on
    const q = await freshQuota();
    await force(q);
    expect(api.calls).toBe(1);

    // Past the minute a forced read is floored at, inside the two the server
    // asked for. Neither source is touched, and with nothing ever read the
    // panel is told why rather than shown a reading.
    at(90 * SEC);
    const refused = await force(q);
    expect(refused).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(api.calls).toBe(1);
    expect(cliRuns()).toHaveLength(1);

    at(121 * SEC);
    await force(q);
    expect(api.calls, "the cooldown never ended").toBe(2);
  });

  it("holds off at least thirty seconds when retry-after says zero", async () => {
    // A 0 would otherwise defeat the cooldown the 429 exists to impose. The
    // forced-read floor is a minute on its own, so the cooldown shows here as
    // the REASON a refused read gives: rate_limited inside it, waiting after.
    signedIn();
    api.next = { status: 429, retryAfter: "0" };
    cli.reply = CLI_MISSING;
    const q = await freshQuota();
    await force(q);

    at(29 * SEC);
    expect(await force(q)).toMatchObject({ ok: false, reason: "rate_limited" });
    at(31 * SEC);
    expect(await force(q)).toMatchObject({ ok: false, reason: "waiting" });
    expect(api.calls).toBe(1);
    at(61 * SEC);
    await force(q);
    expect(api.calls).toBe(2);
  });

  it("holds off at most an hour when retry-after says a day", async () => {
    // A legal header, and one that would otherwise freeze the panel for the
    // life of the process: nothing re-reads it.
    signedIn();
    api.next = { status: 429, retryAfter: "86400" };
    cli.reply = CLI_MISSING;
    const q = await freshQuota();
    await force(q);

    at(3599 * SEC);
    await force(q);
    expect(api.calls).toBe(1);
    at(3601 * SEC);
    await force(q);
    expect(api.calls).toBe(2);
  });
});

describe("the OAuth usage endpoint failing any other way", () => {
  it("arms no cooldown on a 401 and does not read the refusal as usage", async () => {
    // Shaped like a reading on purpose: a refusal's body is not a measurement,
    // whatever it happens to contain.
    signedIn();
    api.next = { status: 401, body: { five_hour: { utilization: 99 } } };
    const q = await freshQuota();
    expect(await force(q)).toMatchObject({ ok: true, source: "cli", session5hPct: 37 });

    at(61 * SEC);
    await force(q);
    expect(api.calls, "a 401 was treated as a rate limit").toBe(2);
  });

  it("uses the CLI when the request never comes back", async () => {
    signedIn();
    api.next = "throw";
    expect(await force(await freshQuota())).toMatchObject({ ok: true, source: "cli", session5hPct: 37 });
  });

  it("does not send a token that has already expired", async () => {
    signedIn({ expiresAt: FROZEN_AT - 1 });
    expect(await force(await freshQuota())).toMatchObject({ ok: true, source: "cli" });
    expect(api.calls).toBe(0);
  });
});

describe("the OAuth usage body, by value", () => {
  const read = async (body: unknown) => {
    signedIn();
    api.next = { status: 200, body };
    const r = await force(await freshQuota());
    expect(r.source).toBe("api");
    return r;
  };

  it("fills the five-hour bar from the seven-day window when there is no five-hour one", async () => {
    expect(await read({ five_hour: null, seven_day: { utilization: 62.6 } }))
      .toMatchObject({ session5hPct: 63, week7dPct: 63 });
  });

  it("reads a missing seven-day window as zero rather than as nothing", async () => {
    expect((await read({ five_hour: { utilization: 10 } })).week7dPct).toBe(0);
  });

  it("maps the per-model weekly windows, rounded", async () => {
    expect(await read({
      five_hour: { utilization: 10 }, seven_day: { utilization: 20 },
      seven_day_sonnet: { utilization: 12.4 }, seven_day_opus: { utilization: 3.6 },
    })).toMatchObject({ weekSonnetPct: 12, weekOpusPct: 4 });
  });

  it("clamps a reading over 100", async () => {
    expect((await read({ five_hour: { utilization: 104 }, seven_day: { utilization: 20 } })).session5hPct).toBe(100);
  });
});

describe("`claude --print /usage`, parsed", () => {
  // No credential on disk, so this is the source the panel reads — which is
  // every Mac whose Claude Code keeps its login in the Keychain.
  const cliSays = async (stdout: string) => {
    cli.reply = { ok: true, code: 0, stdout, stderr: "" };
    const q = await freshQuota();
    const r = await force(q);
    expect(r.source).toBe("cli");
    return { r, q };
  };

  const SCREEN = [
    "Current subscription: Max",
    "Current session: 84% used · resets Jun 18, 4:09pm (Europe/Chisinau)",
    "Current week (all models): 85% used · resets Jun 21, 8:59am (Europe/Chisinau)",
    "Current week (Sonnet only): 48% used · resets Jun 21, 9am (Europe/Chisinau)",
    "Current week (Opus only): 7% used",
  ].join("\n");

  it("reads every line, with reset labels that carry no timezone", async () => {
    const { r, q } = await cliSays(SCREEN);
    expect(r).toMatchObject({
      ok: true,
      session5hPct: 84, session5hReset: "Jun 18, 4:09pm",
      week7dPct: 85, week7dReset: "Jun 21, 8:59am",
      weekSonnetPct: 48, weekOpusPct: 7,
    });
    // The countdown is computed from this, so it must be the same instant the
    // label names.
    expect(r.session5hResetAt).toBe(q.parseResetToSec("Jun 18, 4:09pm"));
    expect(r.session5hResetAt).toEqual(expect.any(Number));
  });

  it("reads a week line that does not say which models it covers", async () => {
    const { r } = await cliSays("Current subscription: Pro\nCurrent session: 5% used\nCurrent week: 13% used\n");
    expect(r.week7dPct).toBe(13);
  });

  it("reads the same numbers through the colour codes a terminal build prints", async () => {
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
    const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
    const coloured = [
      "Current subscription: Max",
      `Current session: ${bold("84")}% used · ${dim("resets Jun 18, 4:09pm (Europe/Chisinau)")}`,
      `Current week (all models): ${bold("85")}% used · ${dim("resets Jun 21, 8:59am (Europe/Chisinau)")}`,
      `Current week (Sonnet only): ${bold("48")}% used · ${dim("resets Jun 21, 9am (Europe/Chisinau)")}`,
      `Current week (Opus only): ${bold("7")}% used`,
    ].join("\n");
    const plain = (await cliSays(SCREEN)).r;
    const { r } = await cliSays(coloured);
    for (const k of ["session5hPct", "session5hReset", "session5hResetAt", "week7dPct",
      "week7dReset", "weekSonnetPct", "weekOpusPct"] as const) {
      expect(r[k], k).toEqual(plain[k]);
    }
  });
});
