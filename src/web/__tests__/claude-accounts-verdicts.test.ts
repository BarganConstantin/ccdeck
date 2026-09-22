// claude-swap's own verdict on each slot, from a real roster read (#1169).
//
// usage.json records numbers and a failure COUNTER; `cswap list --json`
// records a per-slot VERDICT — `no_credentials`, `relogin_required`,
// `keychain_unavailable` — and the two disagree in exactly the cases that
// matter: measured on the machine this was written for, one account read
// `consecutiveFailures: 0` in usage.json and `usageStatus: "no_credentials"`
// in `cswap list`. The verdict is what the accounts panel turns into "Sign in"
// and into the block on switching to an account with no credentials.
//
// It arrives by a route no test had driven. A roster read that finds a
// collection due spawns `cswap list --json` without waiting for it, keeps the
// verdicts it prints, and the NEXT read puts them on each row's `collector`.
// Every assertion on `collector` in the suite was made on a hand-built row
// passed to the client's accountIssue, and every roster fixture was seeded
// with nothing due, on purpose — so the field those client tests depend on had
// never once been produced by the server. If the spawn, the parse or the
// replacement slipped, "Sign in" would vanish with every client test green.
//
// exec.mjs's `run` is a script here, AGENTS_DECK_CSWAP names a path that does
// not exist, and the store is a real one in a temp CLAUDE_SWAP_BACKUP. The
// clock is frozen and moved past the collector's throttle by hand, and every
// case gets a fresh module, since the verdicts, the throttle and the in-flight
// flag are all module state.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-verdicts-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_SWAP_BACKUP", "AGENTS_DECK_CSWAP", "AGENTS_DECK_CLAUDE"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap");
process.env.AGENTS_DECK_CSWAP = join(DIR, "no-such-cswap");
process.env.AGENTS_DECK_CLAUDE = join(DIR, "no-such-claude");

const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ENV_KEYS) {
  if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}=${process.env[k]}`);
}
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);

const STORE = join(DIR, "cswap");

// `list` is what `cswap list --json` prints next; `hold`, when set, is a
// promise every list waits on, which is how a slow collection is spelled
// without a clock.
const { proc } = vi.hoisted(() => ({
  proc: {
    calls: [] as string[][],
    list: "",
    hold: null as null | Promise<void>,
  },
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
  return {
    ...real,
    run: async (_cmd: string, args: string[] = []) => {
      proc.calls.push(args);
      if (args[0] === "list" && args[1] === "--json") {
        if (proc.hold) await proc.hold;
        return { ...okay, stdout: proc.list };
      }
      return okay;
    },
    runDetached: (_cmd: string, args: string[] = []) => { proc.calls.push(args); },
  };
});

let skew = 0;
const FROZEN_AT = Date.now();
vi.spyOn(Date, "now").mockImplementation(() => FROZEN_AT + skew);
const advance = (ms: number) => { skew += ms; };
const SEC = 1000;
const MIN = 60 * SEC;

type Row = { num: number; collector: string | null };
type Accounts = {
  fetchClaudeAccounts: (o?: { force?: boolean }) => Promise<{ ok: boolean; accounts: Row[] }>;
  invalidateClaudeAccountsCache: () => void;
  requestCollection: () => Promise<boolean>;
};

async function freshAccounts(): Promise<Accounts> {
  vi.resetModules();
  return await import("../../server/claude-accounts.mjs") as unknown as Accounts;
}

/**
 * Three accounts, slot 2 active. Every row has been collected, so none counts
 * as never-fetched; `due` puts the active row's planned poll in the past,
 * which is claude-swap's own schedule saying a collection is owed.
 */
function seedStore({ due }: { due: boolean }) {
  const sec = Math.floor(Date.now() / 1000);
  const acct = (n: number) => ({ email: `acct${n}@example.invalid`, organizationUuid: `org-${n}` });
  const row = (n: number) => ({
    ...acct(n),
    fetchedAt: sec - 60,
    nextPollAt: due && n === 2 ? sec - 30 : sec + 3600,
    consecutiveFailures: 0,
    lastGood: { five_hour: { pct: 10 * n }, seven_day: { pct: n } },
  });
  rmTempDir(STORE);
  mkdirSync(join(STORE, "cache"), { recursive: true });
  writeFileSync(join(STORE, "sequence.json"), JSON.stringify({
    activeAccountNumber: 2,
    accounts: { 1: acct(1), 2: acct(2), 3: acct(3) },
  }));
  writeFileSync(join(STORE, "cache", "usage.json"), JSON.stringify({
    schemaVersion: 2,
    accounts: { 1: row(1), 2: row(2), 3: row(3) },
  }));
}

const verdicts = (...pairs: [number, string][]) =>
  JSON.stringify({ accounts: pairs.map(([number, usageStatus]) => ({ number, usageStatus })) });
const lists = () => proc.calls.filter(a => a[0] === "list" && a[1] === "--json");
const rest = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Wait until every `cswap list --json` started so far has been answered and
 *  its verdicts kept — the nudge is fire-and-forget, so nothing awaits it. */
async function collected() { await rest(20); }

/** A forced read that is real work: the invalidation is what every mutation
 *  does before the panel reloads, and it clears the one-minute floor. */
async function reread(accounts: Accounts) {
  accounts.invalidateClaudeAccountsCache();
  return (await accounts.fetchClaudeAccounts({ force: true })).accounts;
}
const collectorOf = (rows: Row[]) => Object.fromEntries(rows.map(r => [r.num, r.collector]));

beforeEach(() => {
  proc.calls.length = 0;
  proc.list = "";
  proc.hold = null;
  advance(10 * MIN);
});

afterAll(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k]!;
  }
  rmTempDir(DIR);
});

describe("the verdicts a due collection brings back", () => {
  it("are asked for once by the read that finds a collection due, and drawn by the next", async () => {
    seedStore({ due: true });
    proc.list = verdicts([3, "no_credentials"]);
    const accounts = await freshAccounts();

    const first = await accounts.fetchClaudeAccounts();
    // Nothing has been asked yet when the first read is drawn: the collection
    // runs beside it rather than in front of it.
    expect(collectorOf(first.accounts)).toEqual({ 1: null, 2: null, 3: null });
    expect(lists()).toEqual([["list", "--json"]]);
    await collected();

    expect(collectorOf(await reread(accounts))).toEqual({ 1: null, 2: null, 3: "no_credentials" });
  });

  it("are replaced whole, so a slot the next collection does not mention loses the one it had", async () => {
    // A slot that has gone away — or has since been fixed — must not keep the
    // sentence it had when it was last seen.
    seedStore({ due: true });
    proc.list = verdicts([3, "no_credentials"]);
    const accounts = await freshAccounts();
    await accounts.fetchClaudeAccounts();
    await collected();

    advance(61 * SEC);   // past the collector's own throttle
    proc.list = verdicts([1, "relogin_required"]);
    await reread(accounts);
    expect(lists()).toHaveLength(2);
    await collected();

    expect(collectorOf(await reread(accounts))).toEqual({ 1: "relogin_required", 2: null, 3: null });
  });

  it("start no second collection while the first is still out", async () => {
    // A cold collection over a slow network can outlast several polls, and each
    // poll that finds the collection still due would otherwise start another.
    seedStore({ due: true });
    proc.list = verdicts([3, "no_credentials"]);
    let release!: () => void;
    proc.hold = new Promise<void>(r => { release = r; });
    const accounts = await freshAccounts();

    await accounts.fetchClaudeAccounts();
    expect(lists()).toHaveLength(1);
    advance(61 * SEC);   // the throttle would let a second one through
    await reread(accounts);
    expect(lists(), "a second `cswap list` beside one still running").toHaveLength(1);

    release();
    await collected();
    expect(collectorOf(await reread(accounts))[3]).toBe("no_credentials");
  });

  it("stop being drawn once they are ten minutes old", async () => {
    // "No credentials" under an account somebody has signed into since is a
    // sentence that sends them to fix what is already fixed. A collection that
    // brings back no verdicts at all leaves the old ones to age out.
    seedStore({ due: true });
    proc.list = verdicts([3, "no_credentials"]);
    const accounts = await freshAccounts();
    await accounts.fetchClaudeAccounts();
    await collected();

    advance(9 * MIN);
    proc.list = verdicts();
    expect(collectorOf(await reread(accounts))[3]).toBe("no_credentials");
    await collected();
    advance(2 * MIN);
    expect(collectorOf(await reread(accounts))[3]).toBeNull();
  });
});

describe("requestCollection, the Usage panel's refresh", () => {
  it("says it asked when a collection was due, and asks", async () => {
    seedStore({ due: true });
    const accounts = await freshAccounts();
    expect(await accounts.requestCollection()).toBe(true);
    expect(lists()).toHaveLength(1);
  });

  it("says it did not when nothing was due, and spawns nothing", async () => {
    // What the refresh button leans on to decide whether to wait for a newer
    // row — a `true` here would have it re-read the store for nothing.
    seedStore({ due: false });
    const accounts = await freshAccounts();
    expect(await accounts.requestCollection()).toBe(false);
    expect(proc.calls).toEqual([]);
  });

  it("says it did not when the collector's throttle held the ask back", async () => {
    seedStore({ due: true });
    const accounts = await freshAccounts();
    expect(await accounts.requestCollection()).toBe(true);
    await collected();
    expect(await accounts.requestCollection()).toBe(false);
    expect(lists()).toHaveLength(1);
  });
});
