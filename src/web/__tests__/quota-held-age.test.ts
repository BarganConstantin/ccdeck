// `claude --print /usage` routinely answers without its "Current session/week"
// lines — a cold invocation, or right after a hard refresh — and the branch that
// handles it keeps serving the last reading the deck did get rather than
// regressing the panel to 0%. It used to re-stamp that reading with
// `fetchedAt: now`, and fetchedAt is the age of the DATA, not of our read of it:
// the usage panel printed "just now" over percentages collected hours earlier,
// held it for a full poll cycle, then snapped back to the true age — an age
// label that oscillates and periodically vouches for numbers the deck itself has
// already marked stale. self-update.mjs keeps `at` (when npm answered) apart
// from `failedAt` (when the last attempt failed) for exactly this reason; a held
// quota reading has to carry the timestamp of the answer it actually is.
//
// Nothing here spawns the claude CLI, reads claude-swap's store or reaches the
// network: child_process and claude-accounts.mjs are replaced wholesale, and
// every home the module resolves at import time points into a temp directory.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-quota-held-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ENV_KEYS) {
  if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}=${process.env[k]}`);
}
// quota.mjs builds ~/.claude/.credentials.json out of homedir() at import time,
// and homedir() reads HOME on POSIX and USERPROFILE on Windows — both are set
// above, so this holds on all three platforms. Stop before the import if not.
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);

// claude-swap's store, as activeAccountUsage() answers it. Replaced entirely, so
// no test here reads the real store and the age of the row is ours to choose.
// `entry` may be a function of how many times the store has been read, which is
// how a collection landing between two re-reads is spelled.
const { swap } = vi.hoisted(() => ({
  swap: { entry: null as unknown, collections: 0, reads: 0, collects: false },
}));
vi.mock("../../server/claude-accounts.mjs", () => ({
  activeAccountUsage: async () => {
    swap.reads++;
    return typeof swap.entry === "function" ? swap.entry(swap.reads) : swap.entry;
  },
  // The collector declines unless a case says it asked — nothing in this file
  // may touch the network either way.
  requestCollection: async () => { swap.collections++; return swap.collects; },
}));

// The `claude` CLI, which must never actually run. The seam is exec.mjs's `run`:
// quota.mjs used to build a shell command line and hand it to `exec()`, which is
// how a home directory containing `$(…)` became shell code (see
// no-shell-hook-commands.test.ts), and it now spawns an argument vector instead.
// `run` never rejects and never throws, so the stand-in answers the shape it
// does rather than raising. Replaced rather than wrapped, so nothing in this
// file can reach a real child process by any route.
const { cli } = vi.hoisted(() => ({ cli: { stdout: "", stderr: "", calls: [] as string[][] } }));
vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    cli.calls.push([cmd, ...args]);
    return { ok: true, code: 0, killed: false, timedOut: false, stdout: cli.stdout, stderr: cli.stderr };
  },
  // quotaClaudeBin asks PATH whether the bare `claude` is really there before it
  // falls back to the install directories it knows (#553). Answering yes is what
  // keeps this file's subject — what the poller does with the CLI's OUTPUT —
  // independent of whether the machine running the suite happens to have a
  // claude in ~/.local/bin. No child process is reachable through it either.
  pathLookup: (name: string) => `/usr/bin/${name}`,
}));

type Quota = {
  ok: boolean;
  fetchedAt: number;
  source?: string;
  stale?: boolean;
  session5hPct?: number;
  week7dPct?: number;
};
type QuotaModule = { fetchClaudeQuota: (o?: { force?: boolean }) => Promise<Quota> };

const MIN = 60_000;
// Inside STORE_TRUSTED_MS, so the row is served and remembered — and far enough
// from "now" that a re-stamped timestamp cannot pass for the real one.
const STORE_AGE = 40 * MIN;

/** claude-swap's row for the active account, collected `ageMs` ago. */
const row = (ageMs: number) => ({
  num: 2,
  email: "a@b.c",
  fetchedAt: Date.now() - ageMs,
  lastGood: {
    five_hour: { pct: 63, resets_at: "2026-08-14T18:00:00Z" },
    seven_day: { pct: 18, resets_at: "2026-08-19T04:00:00Z" },
  },
});

let mod: QuotaModule;

beforeEach(async () => {
  swap.entry = null;
  swap.collections = 0;
  swap.reads = 0;
  swap.collects = false;
  cli.calls.length = 0;
  // What the CLI prints on the cold invocation this branch exists for: the
  // preamble that proves it ran, and not one quota line.
  cli.stdout = "Claude Code usage\nCurrent subscription: Max\n";
  cli.stderr = "";
  // A fresh module per test — the last-known-good reading, the result cache and
  // the self-poll floor are all module state.
  vi.resetModules();
  mod = await import("../../server/quota.mjs") as unknown as QuotaModule;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  rmTempDir(DIR);
});

/** Serve one good store row, then take the store away and let the CLI answer
 *  with nothing the parser recognises. */
async function heldAfterEmptyCli() {
  swap.entry = row(STORE_AGE);
  const good = await mod.fetchClaudeQuota();
  expect(good.source).toBe("claude-swap");   // this is the reading that gets held
  swap.entry = null;
  // `force` skips the 60s result cache, and the self-poll floor has not been
  // spent yet, so this call really does reach the CLI.
  return { good, held: await mod.fetchClaudeQuota({ force: true }) };
}

describe("a quota reading held through an empty `claude --print /usage`", () => {
  it("keeps the age of the numbers, not the age of the read that found none", async () => {
    const { good, held } = await heldAfterEmptyCli();

    expect(cli.calls).toHaveLength(3);            // the retry loop ran, and found nothing
    expect(held.fetchedAt).toBe(good.fetchedAt);  // the defect: this used to be `now`
    expect(Date.now() - held.fetchedAt).toBeGreaterThanOrEqual(STORE_AGE);
  });

  it("still serves the numbers it holds rather than regressing the panel to 0%", async () => {
    const { held } = await heldAfterEmptyCli();

    expect(held).toMatchObject({
      ok: true, source: "claude-swap", session5hPct: 63, week7dPct: 18, stale: true,
    });
  });

  it("ages the same as the reading the self-poll floor serves without a CLI at all", async () => {
    // The sibling fallback, one poll later: the floor was just spent, so this
    // one hands back what it holds without spawning anything. The two branches
    // serve the same reading, and one of them re-stamping it is precisely how
    // the panel came to flip to "just now" every five minutes.
    const { held } = await heldAfterEmptyCli();
    const spent = cli.calls.length;

    const floored = await mod.fetchClaudeQuota({ force: true });

    expect(cli.calls).toHaveLength(spent);
    expect(floored.fetchedAt).toBe(held.fetchedAt);
    expect(floored.stale).toBe(true);
  });
});

// The refresh button's other route to fresher numbers, which every test that
// drives fetchClaudeQuota had switched off by making requestCollection answer
// false (#1169). A forced read whose store row is more than a minute old asks
// claude-swap to collect and then re-reads the store — up to three times,
// REREAD_GAP_MS apart — adopting the first row that is newer than the one it
// started with. Broken, the button either hands back the old row every time or
// never adopts the new one, and nothing about either looks like an error.
//
// The gaps are real `setTimeout`s, so they are faked here and only they are:
// Date.now keeps running, which is what the rows' ages are measured against.
describe("a refresh that asks claude-swap to collect", () => {
  async function refresh(): Promise<Quota> {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const pending = mod.fetchClaudeQuota({ force: true });
      await vi.advanceTimersByTimeAsync(10_000);
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  }

  it("adopts the row the collection wrote as soon as a re-read finds it", async () => {
    const old = row(STORE_AGE);
    const fresh = { ...row(5_000), lastGood: { ...old.lastGood, five_hour: { pct: 71, resets_at: "2026-08-14T18:00:00Z" } } };
    swap.collects = true;
    // The first read and the first re-read find the old row; the collection
    // lands before the second re-read.
    swap.entry = (reads: number) => (reads < 3 ? old : fresh);

    const r = await refresh();
    expect(r).toMatchObject({ ok: true, source: "claude-swap", session5hPct: 71, fetchedAt: fresh.fetchedAt });
    expect(swap.reads, "the initial read and two re-reads, and no more once it had the row").toBe(3);
    expect(cli.calls).toEqual([]);
  });

  it("gives up after three re-reads and serves what it had, with that row's own age", async () => {
    // Inside STORE_TRUSTED_MS, so what it had is still claude-swap's answer
    // and is served as one rather than marked stale; the point is that the
    // loop ends and nothing is re-stamped on the way out.
    const old = row(STORE_AGE);
    swap.collects = true;
    swap.entry = old;

    const r = await refresh();
    expect(swap.reads).toBe(4);
    expect(r).toMatchObject({ ok: true, source: "claude-swap", session5hPct: 63, fetchedAt: old.fetchedAt });
  });

  it("does not re-read at all when claude-swap was not asked", async () => {
    // Nothing was due, or the collector's throttle held the ask back: there is
    // no newer row coming, and waiting 2.4 seconds for one is a stuck button.
    swap.collects = false;
    swap.entry = row(STORE_AGE);

    await refresh();
    expect(swap.collections).toBe(1);
    expect(swap.reads).toBe(1);
  });
});
