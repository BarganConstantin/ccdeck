// claude-swap reuses slot numbers, and a removed account leaves its usage row
// behind (#1169).
//
// cache/usage.json is keyed by SLOT, and a slot is a position in one store —
// `cswap remove 2` and a later `cswap add` put somebody else at 2 while the
// old occupant's row stays where it was. claude-swap guards its own reads on
// identity for exactly that reason, and so do the deck's two readers of the
// file: readRoster, which draws every account's bars and headroom in the
// accounts panel, and activeAccountUsage, which quota.mjs turns into the Usage
// panel's 5h/7d bars. Headroom is the number a user picks a switch target by,
// and the Usage panel labels its bars "claude-swap" — so a guard that slipped
// would show the previous occupant's percentages as this account's, in both
// places, with nothing to say they were anyone else's.
//
// Every fixture that wrote usage.json before this file copied the account's
// own email and org into the row and used schemaVersion 2, so none of those
// guards had ever been handed a row it should refuse. These are.
//
// The store is a real one in a temp CLAUDE_SWAP_BACKUP, every case gets fresh
// modules, and exec.mjs is replaced so the collector nudge a roster read may
// start — and the `claude --print /usage` the end-to-end case falls back to —
// are answered by a script and never spawned.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-row-identity-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_SWAP_BACKUP", "CLAUDE_CONFIG_DIR",
  "AGENTS_DECK_CSWAP", "AGENTS_DECK_CLAUDE"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap");
// No .credentials.json in here, so quota.mjs's OAuth source has no token and
// the end-to-end case below falls through to the (scripted) CLI.
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.AGENTS_DECK_CSWAP = join(DIR, "no-such-cswap");
process.env.AGENTS_DECK_CLAUDE = join(DIR, "no-such-claude");

const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ENV_KEYS) {
  if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}=${process.env[k]}`);
}
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);

const STORE = join(DIR, "cswap");

/** What `claude --print /usage` prints for the account that is really active. */
const CLI_USAGE = "Claude Code usage\nCurrent subscription: Max\n"
  + "Current session: 12% used\nCurrent week (all models): 4% used\n";

const { proc } = vi.hoisted(() => ({ proc: { calls: [] as string[][] } }));
vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
  return {
    ...real,
    run: async (_cmd: string, args: string[] = []) => {
      proc.calls.push(args);
      if (args[0] === "--print") return { ...okay, stdout: CLI_USAGE };
      return okay;
    },
    runDetached: (_cmd: string, args: string[] = []) => { proc.calls.push(args); },
    // quotaClaudeBin asks PATH whether a bare `claude` is there; the answer
    // must not depend on the machine running the suite.
    pathLookup: (name: string) => `/usr/bin/${name}`,
  };
});

type Lane = { id: string; pct: number };
type Row = { num: number; email: string; lanes: Lane[]; headroom: number | null; fetchedAt: number | null; stale: boolean };
type Roster = { ok: boolean; accounts: Row[] };
type Accounts = {
  fetchClaudeAccounts: (o?: { force?: boolean }) => Promise<Roster>;
  activeAccountUsage: () => Promise<{ num: number; email: string; fetchedAt: number; lastGood: unknown } | null>;
};

type Account = { email: string; organizationUuid?: string };
type UsageRow = Account & { fetchedAt?: unknown; nextPollAt?: number; lastGood?: unknown };

const NOW_S = () => Math.floor(Date.now() / 1000);

/**
 * A usage row claude-swap collected a minute ago, 80% into the five-hour
 * window. Next poll an hour out and no failures, so a roster read finds nothing
 * due and asks no collector for anything.
 */
const collected = (who: Account, extra: Partial<UsageRow> = {}): UsageRow => ({
  ...who,
  fetchedAt: NOW_S() - 60,
  nextPollAt: NOW_S() + 3600,
  consecutiveFailures: 0,
  lastGood: {
    five_hour: { pct: 80, resets_at: new Date(Date.now() + 2 * 3600_000).toISOString() },
    seven_day: { pct: 30, resets_at: new Date(Date.now() + 4 * 86400_000).toISOString() },
  },
  ...extra,
} as UsageRow);

/** Write sequence.json and cache/usage.json as claude-swap would. */
function seed({ accounts, usage = {}, sequence, active = 2, schemaVersion = 2 }: {
  accounts: Record<number, Account>;
  usage?: Record<number, UsageRow>;
  sequence?: number[];
  active?: number;
  schemaVersion?: number;
}) {
  rmTempDir(STORE);
  mkdirSync(join(STORE, "cache"), { recursive: true });
  writeFileSync(join(STORE, "sequence.json"), JSON.stringify({
    activeAccountNumber: active,
    ...(sequence ? { sequence } : {}),
    accounts,
  }));
  writeFileSync(join(STORE, "cache", "usage.json"), JSON.stringify({ schemaVersion, accounts: usage }));
}

async function freshAccounts(): Promise<Accounts> {
  vi.resetModules();
  return await import("../../server/claude-accounts.mjs") as unknown as Accounts;
}

const ALICE = { email: "alice@x", organizationUuid: "org-a" };
const BOB = { email: "bob@x", organizationUuid: "org-a" };
const CAROL = { email: "carol@x", organizationUuid: "org-c" };

/** The previous occupant's numbers, drawn as nobody's. */
const NOBODYS = { lanes: [], headroom: null, fetchedAt: null, stale: true };

beforeEach(() => { proc.calls.length = 0; });

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k]!;
  }
  rmTempDir(DIR);
});

describe("the accounts panel and a row left behind by a reused slot", () => {
  it("draws nothing from a row written for another address", async () => {
    // Slot 2 was bob's and is alice's now; bob's row is still under 2. Slot 3
    // is here as the control: a row that IS its account's is drawn in full,
    // so the empty one above it is the guard and not a fixture that draws
    // nothing for anybody.
    seed({
      accounts: { 2: ALICE, 3: CAROL },
      usage: { 2: collected(BOB), 3: collected(CAROL) },
    });
    const { fetchClaudeAccounts } = await freshAccounts();
    const roster = await fetchClaudeAccounts({ force: true });
    expect(roster.ok).toBe(true);
    const [two, three] = roster.accounts;
    expect(two).toMatchObject({ num: 2, email: "alice@x", ...NOBODYS });
    expect(three).toMatchObject({ num: 3, headroom: 20, stale: false });
    expect(three.lanes.map(l => l.pct)).toEqual([80, 30]);
  });

  it("draws nothing from a row for the same address under another organization", async () => {
    // One address in two orgs is two accounts to claude-swap, on purpose.
    seed({ accounts: { 2: ALICE }, usage: { 2: collected({ ...ALICE, organizationUuid: "org-b" }) } });
    const { fetchClaudeAccounts } = await freshAccounts();
    expect((await fetchClaudeAccounts({ force: true })).accounts[0]).toMatchObject(NOBODYS);
  });

  it("still matches a row when neither side carries an organization", async () => {
    // Stores written before claude-swap recorded orgs. Missing on both sides
    // is agreement, not a mismatch — refusing it would blank every row there.
    const bare = { email: "alice@x" };
    seed({ accounts: { 2: bare }, usage: { 2: collected(bare) } });
    const { fetchClaudeAccounts } = await freshAccounts();
    const [row] = (await fetchClaudeAccounts({ force: true })).accounts;
    expect(row.lanes.map(l => l.pct)).toEqual([80, 30]);
    expect(row.headroom).toBe(20);
  });

  it("reads no rows at all from a usage file of another schema version", async () => {
    // A schema bump means the fields may not mean what this code thinks. The
    // roster is still worth drawing — it comes from sequence.json — but not
    // one number from a file this code cannot vouch for.
    seed({ accounts: { 2: ALICE, 3: CAROL }, usage: { 2: collected(ALICE), 3: collected(CAROL) }, schemaVersion: 3 });
    const { fetchClaudeAccounts } = await freshAccounts();
    const roster = await fetchClaudeAccounts({ force: true });
    expect(roster.ok).toBe(true);
    expect(roster.accounts.map(a => a.num)).toEqual([2, 3]);
    for (const a of roster.accounts) expect(a).toMatchObject(NOBODYS);
  });

  it("orders slots by number when the store has no sequence", async () => {
    // By NUMBER: 10 after 2, which a string sort would put the other way round.
    // (Dropping the sort outright would still pass here — JSON.parse already
    // hands integer-like keys back in ascending order — so what this pins is
    // that the sort, where there is one, is a numeric one.)
    seed({ accounts: { 10: CAROL, 2: ALICE, 1: BOB } });
    const { fetchClaudeAccounts } = await freshAccounts();
    expect((await fetchClaudeAccounts({ force: true })).accounts.map(a => a.num)).toEqual([1, 2, 10]);
  });

  it("skips a slot the sequence still names after its account has gone", async () => {
    // `cswap remove` and a sequence that has not caught up — or was edited
    // by hand. One row for the one account, and no throw for the other.
    seed({ accounts: { 2: ALICE }, sequence: [2, 5] });
    const { fetchClaudeAccounts } = await freshAccounts();
    const roster = await fetchClaudeAccounts({ force: true });
    expect(roster.ok).toBe(true);
    expect(roster.accounts.map(a => a.num)).toEqual([2]);
  });
});

describe("activeAccountUsage, which the Usage panel's bars are made from", () => {
  it("refuses a row written for another address", async () => {
    seed({ accounts: { 2: ALICE }, usage: { 2: collected(BOB) } });
    expect(await (await freshAccounts()).activeAccountUsage()).toBeNull();
  });

  it("refuses a row for the same address under another organization", async () => {
    seed({ accounts: { 2: ALICE }, usage: { 2: collected({ ...ALICE, organizationUuid: "org-b" }) } });
    expect(await (await freshAccounts()).activeAccountUsage()).toBeNull();
  });

  it("refuses a usage file of another schema version", async () => {
    seed({ accounts: { 2: ALICE }, usage: { 2: collected(ALICE) }, schemaVersion: 3 });
    expect(await (await freshAccounts()).activeAccountUsage()).toBeNull();
  });

  it("refuses a row that has never had a good reading", async () => {
    // What a freshly added account's row looks like until its first poll.
    seed({ accounts: { 2: ALICE }, usage: { 2: collected(ALICE, { lastGood: undefined }) } });
    expect(await (await freshAccounts()).activeAccountUsage()).toBeNull();
  });

  it("refuses a collection time that is not a number", async () => {
    // quotaFromStore prints this as the reading's age and ranks it against
    // readings the deck took itself; a string would compare as nonsense.
    seed({ accounts: { 2: ALICE }, usage: { 2: collected(ALICE, { fetchedAt: "1700000000" }) } });
    expect(await (await freshAccounts()).activeAccountUsage()).toBeNull();
  });

  it("answers for the active slot's own row, with claude-swap's seconds as whole milliseconds", async () => {
    // claude-swap writes fractional seconds; the panel compares and prints
    // milliseconds, and a fraction of one is not something it can print.
    seed({ accounts: { 2: ALICE }, usage: { 2: collected(ALICE, { fetchedAt: 1700000000.4 }) } });
    expect(await (await freshAccounts()).activeAccountUsage())
      .toMatchObject({ num: 2, email: "alice@x", fetchedAt: 1700000000400, lastGood: { five_hour: { pct: 80 } } });
    seed({ accounts: { 2: ALICE }, usage: { 2: collected(ALICE, { fetchedAt: 1700000000.4567 }) } });
    expect((await (await freshAccounts()).activeAccountUsage())?.fetchedAt).toBe(1700000000457);
  });
});

describe("the Usage panel, end to end", () => {
  type Quota = { ok: boolean; source?: string; session5hPct?: number };

  /** Real quota.mjs over the real claude-accounts.mjs, and a forced read. */
  async function usagePanel(): Promise<Quota> {
    vi.resetModules();
    // @ts-expect-error — plain .mjs server module, no types
    const quota = await import("../../server/quota.mjs");
    return quota.fetchClaudeQuota({ force: true });
  }

  it("does not show a previous occupant's numbers as claude-swap's reading of this account", async () => {
    seed({ accounts: { 2: ALICE }, usage: { 2: collected(BOB) } });
    const read = await usagePanel();
    expect(read.source).not.toBe("claude-swap");
    // It asked the CLI instead, which answers about whoever is signed in.
    expect(read).toMatchObject({ ok: true, source: "cli", session5hPct: 12 });
  });

  it("does serve the store when the row is the account's own, which is what the case above is refused", async () => {
    seed({ accounts: { 2: ALICE }, usage: { 2: collected(ALICE) } });
    expect(await usagePanel()).toMatchObject({ ok: true, source: "claude-swap", session5hPct: 80 });
    expect(proc.calls.filter(a => a[0] === "--print")).toEqual([]);
  });
});
