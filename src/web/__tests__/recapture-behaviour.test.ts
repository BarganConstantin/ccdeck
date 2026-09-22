// The one place the deck writes a credential into claude-swap's store without
// anybody pressing anything (#1169).
//
// A roster read that finds a `stale-copy` row — claude-swap's stored copy of
// the active account's login is dead while the live login works — calls
// `autoRecapture`, which starts `recaptureActive({ expect: email })`. That runs
// `cswap add`, and `cswap add` captures WHOEVER IS SIGNED IN RIGHT NOW. The
// identity guard in front of it is the whole difference between refreshing the
// paused row and quietly adding a stranger's credentials in its place: someone
// who signed in as another account in a terminal is exactly who this runs
// against, and nothing tells them.
//
// Until this file those two functions had source-regex tests only
// (stale-login-badge.test.ts slices recaptureActive and matches
// `who !== activeEmail`), which survive every regression that keeps the
// spelling: case folding dropped from one side, the org check inverted,
// `expect` read and ignored, the check moved below the add. And the attempt
// bookkeeping — one per account, one per ten minutes, the cache dropped when
// it settles — had nothing behind it at all. A slip there is `cswap add` on
// every panel poll, or a row that says "resuming…" forever.
//
// So everything below is driven. exec.mjs's `run` is replaced by a script that
// answers `claude auth status --json` with the identity each case chooses and
// records every argument vector in order; the store is a real sequence.json in
// a temp CLAUDE_SWAP_BACKUP; AGENTS_DECK_CSWAP and AGENTS_DECK_CLAUDE name
// paths that do not exist, so no real binary can be resolved, let alone run.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-recapture-"));
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

type Reply = { ok: boolean; code?: number | string; stdout?: string; stderr?: string };

// The script `run` follows, and the record of what it was asked. `identity` is
// what `claude auth status --json` prints; `add` and `list` are what the two
// cswap commands answer — a function, so a case can hold one open or make it
// reject the way a runner that is not `run` might.
const { proc } = vi.hoisted(() => ({
  proc: {
    calls: [] as string[][],
    identity: null as null | Record<string, unknown>,
    add: null as null | (() => Promise<Reply> | Reply),
    list: null as null | (() => Promise<Reply> | Reply),
  },
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
  return {
    ...real,
    run: async (_cmd: string, args: string[] = []) => {
      proc.calls.push(args);
      if (args[0] === "auth" && args[1] === "status") {
        return { ...okay, stdout: JSON.stringify(proc.identity ?? { loggedIn: false }) };
      }
      if (args[0] === "add") return { ...okay, ...(await (proc.add?.() ?? okay)) };
      if (args[0] === "list") return { ...okay, ...(await (proc.list?.() ?? okay)) };
      return okay;
    },
    runDetached: (_cmd: string, args: string[] = []) => { proc.calls.push(args); },
  };
});

type Recapture = { ok: boolean; reason?: string; email?: string; collected?: boolean; error?: string };
type Repair = { state: string; reason?: string | null; retryAt?: number } | null;
type Row = { num: number; staleCopy: boolean; repair: Repair };
type Admin = {
  recaptureActive: (o?: { expect?: string | null }) => Promise<Recapture>;
  autoRecapture: (o: { email?: string; now?: number }) => Repair;
  withStoreLock: <T>(fn: () => Promise<T>) => Promise<T>;
  addFailureText: (r: Reply) => string;
};
type Accounts = {
  fetchClaudeAccounts: (o?: { force?: boolean }) => Promise<{ ok: boolean; accounts: Row[] }>;
  repairStaleCopyWith: (fn: unknown) => void;
};

/**
 * Both modules with no memory of the previous case. The attempt bookkeeping in
 * cswap-admin.mjs and the roster's cache and registered repair are all module
 * state, so a case that inherited them would be asserting another case's
 * history. They come out of one reset so the lock, the cache and the repair
 * hook they share are the same instances.
 */
async function fresh(): Promise<{ admin: Admin; accounts: Accounts }> {
  vi.resetModules();
  const admin = await import("../../server/cswap-admin.mjs") as unknown as Admin;
  const accounts = await import("../../server/claude-accounts.mjs") as unknown as Accounts;
  return { admin, accounts };
}

/**
 * The store the issue describes: slot 2 is active and is a@x.com in org o1.
 * `usage` adds claude-swap's row for it, quarantined — `consecutiveFailures: 1`,
 * which is what makes the roster ask the CLI who is signed in — and collected a
 * minute ago with its next poll an hour out, so nothing is due and the read
 * spawns no collector of its own.
 */
function seedStore({ usage = false } = {}) {
  mkdirSync(join(STORE, "cache"), { recursive: true });
  writeFileSync(join(STORE, "sequence.json"), JSON.stringify({
    activeAccountNumber: 2,
    accounts: { 2: { email: "a@x.com", organizationUuid: "o1" } },
  }));
  const sec = Math.floor(Date.now() / 1000);
  writeFileSync(join(STORE, "cache", "usage.json"), JSON.stringify({
    schemaVersion: 2,
    accounts: usage ? {
      2: {
        email: "a@x.com", organizationUuid: "o1",
        fetchedAt: sec - 60, nextPollAt: sec + 3600,
        consecutiveFailures: 1, lastError: "invalid_grant",
        lastGood: { five_hour: { pct: 30 }, seven_day: { pct: 12 } },
      },
    } : {},
  }));
}

const signedInAs = (email: string, orgId = "o1") => { proc.identity = { loggedIn: true, email, orgId }; };
const ran = (first: string) => proc.calls.filter(a => a[0] === first);
const rest = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Hold the store mutex until the returned function is called — the shape a
 *  sign-in's `cswap add` holds it in. Resolves once the hold is really in
 *  place, since a queued `withStoreLock` has not run its callback yet. */
async function holdTheStore(withStoreLock: Admin["withStoreLock"]) {
  let release!: () => void;
  let acquired!: () => void;
  const reached = new Promise<void>(r => { acquired = r; });
  const held = withStoreLock(() => { acquired(); return new Promise<void>(r => { release = r; }); });
  await reached;
  return async () => { release(); await held; };
}

beforeEach(() => {
  proc.calls.length = 0;
  proc.identity = null;
  proc.add = null;
  proc.list = null;
  rmTempDir(STORE);
  seedStore();
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k]!;
  }
  rmTempDir(DIR);
});

describe("recaptureActive: who `cswap add` would capture, asked first", () => {
  it("re-captures the active slot when the CLI is signed in as it, whatever the case of the address", async () => {
    // The CLI prints the address the way the user typed it at sign-in, and
    // claude-swap stores it the way it was captured. Both sides are folded,
    // and a guard that folded only one of them would refuse every such user —
    // or, the other way round, admit a different account spelled alike.
    const { admin } = await fresh();
    signedInAs("A@X.com");
    expect(await admin.recaptureActive()).toEqual({ ok: true, email: "A@X.com", collected: true });
    // The question, then the capture, then the collection that makes the
    // press show something — and in that order, since the identity read is
    // worthless once the add has run.
    expect(proc.calls).toEqual([["auth", "status", "--json"], ["add"], ["list"]]);
  });

  it("refuses when nobody is signed in, and captures nothing", async () => {
    const { admin } = await fresh();
    proc.identity = { loggedIn: false };
    expect(await admin.recaptureActive()).toEqual({ ok: false, reason: "not_signed_in" });
    expect(ran("add")).toEqual([]);
  });

  it("refuses when the CLI is signed in as a different account", async () => {
    // The case the guard exists for: a terminal sign-in as somebody else. A
    // `cswap add` here would record b@x.com's credentials in a@x.com's stead.
    const { admin } = await fresh();
    signedInAs("b@x.com");
    expect(await admin.recaptureActive()).toEqual({ ok: false, reason: "not_active_account", email: "b@x.com" });
    expect(ran("add")).toEqual([]);
  });

  it("refuses the same address under another organization, which is another account", async () => {
    // claude-swap keys an account by (email, organizationUuid); the same
    // address in two orgs is two slots on purpose.
    const { admin } = await fresh();
    signedInAs("a@x.com", "o2");
    expect(await admin.recaptureActive()).toMatchObject({ ok: false, reason: "not_active_account" });
    expect(ran("add")).toEqual([]);
  });

  it("refuses when the account it was asked to repair is not the one signed in", async () => {
    // autoRecapture always names the row it drew. The active slot and the CLI
    // can agree with each other and still not be that row — an auto-switch
    // moved the machine on while the attempt waited for the lock.
    const { admin } = await fresh();
    signedInAs("a@x.com");
    expect(await admin.recaptureActive({ expect: "c@x.com" }))
      .toMatchObject({ ok: false, reason: "not_active_account" });
    expect(ran("add")).toEqual([]);
  });

  it("says why the capture failed in the words addFailureText chooses", async () => {
    const { admin } = await fresh();
    signedInAs("a@x.com");
    const failed = { ok: false, code: 1, stdout: "", stderr: "Error: credentials in the macOS Keychain are unreadable right now" };
    proc.add = () => failed;
    expect(await admin.recaptureActive()).toEqual({
      ok: false, reason: "add_failed", error: admin.addFailureText({ ...failed }),
    });
    // Nothing was captured, so there is nothing to collect.
    expect(ran("list")).toEqual([]);
  });

  it("still reports the capture when the collection after it does not come back", async () => {
    // The credentials are in the store either way and claude-swap's own
    // schedule will collect them; failing the repair over the collection would
    // report a repair that happened as one that did not.
    const { admin } = await fresh();
    signedInAs("a@x.com");
    proc.list = () => Promise.reject(new Error("test: list never answered"));
    expect(await admin.recaptureActive()).toEqual({ ok: true, email: "a@x.com", collected: false });
  });

  it("asks nothing and captures nothing while another mutation holds the store", async () => {
    // The identity read and the add are one decision, and the lock is what
    // keeps a sign-in's own `cswap add` from landing between them.
    const { admin } = await fresh();
    signedInAs("a@x.com");
    const release = await holdTheStore(admin.withStoreLock);
    let done!: Promise<Recapture>;
    try {
      done = admin.recaptureActive();
      await rest(60);
      expect(proc.calls, "recaptureActive ran beside an in-flight store mutation").toEqual([]);
    } finally {
      await release();
    }
    expect(await done).toMatchObject({ ok: true });
    expect(ran("add")).toEqual([["add"]]);
  });
});

describe("autoRecapture: the same repair, with nobody pressing anything", () => {
  const MIN = 60_000;
  const T = 1_800_000_000_000;

  /** Poll until the attempt for `email` has settled, without starting one:
   *  while it runs, autoRecapture answers `running` and does nothing else. */
  async function settled(admin: Admin, email: string, now: number): Promise<Repair> {
    let state: Repair = null;
    for (let i = 0; i < 400; i++) {
      state = admin.autoRecapture({ email, now });
      if (state?.state !== "running") return state;
      await rest(5);
    }
    return state;
  }

  it("has nothing to do for a row with no address", async () => {
    const { admin } = await fresh();
    expect(admin.autoRecapture({ email: "" })).toBeNull();
    expect(admin.autoRecapture({})).toBeNull();
    expect(proc.calls).toEqual([]);
  });

  it("starts one attempt per account, and answers `running` to every read while it is out", async () => {
    // The panel polls every fifteen seconds and a forced read can come on top.
    // Each of those reads calls this, and each must not become a `cswap add`.
    const { admin } = await fresh();
    signedInAs("a@x.com");
    let letGo!: () => void;
    proc.add = () => new Promise<Reply>(r => { letGo = () => r({ ok: true }); });

    expect(admin.autoRecapture({ email: "a@x.com", now: T })).toEqual({ state: "running" });
    // A second read before the first attempt settles, and one spelling the
    // address differently: the attempt is per account, not per string.
    expect(admin.autoRecapture({ email: "a@x.com", now: T })).toEqual({ state: "running" });
    expect(admin.autoRecapture({ email: "A@X.COM", now: T })).toEqual({ state: "running" });
    for (let i = 0; i < 200 && !letGo; i++) await rest(5);
    letGo();

    // The capture held, so there is no reason to show — and still no second
    // attempt inside the window, because a row that is still paused after a
    // capture that "worked" is exactly what the ten minutes are for.
    expect(await settled(admin, "a@x.com", T)).toEqual({ state: "failed", reason: null, retryAt: T + 10 * MIN });
    expect(ran("add")).toEqual([["add"]]);
  });

  it("remembers why an attempt failed, and tries again ten minutes after it started", async () => {
    const { admin } = await fresh();
    signedInAs("b@x.com");          // somebody else is signed in: the guard refuses

    expect(admin.autoRecapture({ email: "a@x.com", now: T })).toEqual({ state: "running" });
    await settled(admin, "a@x.com", T);
    expect(ran("add")).toEqual([]);

    // A minute later the row is still paused and the panel says why, and when
    // it will try again — measured from the attempt, not from this read.
    expect(admin.autoRecapture({ email: "a@x.com", now: T + MIN }))
      .toEqual({ state: "failed", reason: "not_active_account", retryAt: T + 10 * MIN });
    expect(ran("auth"), "the refusal was asked about once, not once per read").toHaveLength(1);

    // At the retry instant a new attempt starts, and this one can succeed.
    signedInAs("a@x.com");
    expect(admin.autoRecapture({ email: "a@x.com", now: T + 10 * MIN })).toEqual({ state: "running" });
    await settled(admin, "a@x.com", T + 10 * MIN);
    expect(ran("add")).toEqual([["add"]]);
  });

  it("repairs only the row it was started for, even when the active slot and the CLI agree", async () => {
    // The row that paused was c@x.com; by the time its attempt holds the lock
    // an auto-switch has made a@x.com active, and the CLI is signed in as
    // a@x.com. The slot and the CLI match each other, so only the address the
    // attempt carries stops a@x.com being captured under c@x.com's repair.
    const { admin } = await fresh();
    signedInAs("a@x.com");
    admin.autoRecapture({ email: "c@x.com", now: T });
    expect(await settled(admin, "c@x.com", T))
      .toEqual({ state: "failed", reason: "not_active_account", retryAt: T + 10 * MIN });
    expect(ran("add")).toEqual([]);
  });
});

describe("the roster's repair hook", () => {
  it("draws a stale copy with the state the registered repair hands back", async () => {
    const { accounts } = await fresh();
    seedStore({ usage: true });
    signedInAs("a@x.com");
    const asked: unknown[] = [];
    accounts.repairStaleCopyWith((o: unknown) => { asked.push(o); return { state: "running" }; });

    const roster = await accounts.fetchClaudeAccounts({ force: true });
    expect(roster.ok).toBe(true);
    expect(roster.accounts[0]).toMatchObject({ num: 2, staleCopy: true, repair: { state: "running" } });
    // Asked about the row it drew, by slot and by address.
    expect(asked).toEqual([{ num: 2, email: "a@x.com", now: expect.any(Number) }]);
  });

  it("costs the row its repair state and never the read when the repair throws", async () => {
    const { accounts } = await fresh();
    seedStore({ usage: true });
    signedInAs("a@x.com");
    accounts.repairStaleCopyWith(() => { throw new Error("test: the repair blew up"); });

    const roster = await accounts.fetchClaudeAccounts({ force: true });
    expect(roster.ok).toBe(true);
    expect(roster.accounts[0]).toMatchObject({ num: 2, staleCopy: true, repair: null });
  });

  it("lets the very next forced read say how the deck's own attempt went", async () => {
    // Found by running the real server against a `cswap add` that fails: the
    // roster had cached the row as `running`, a forced read is floored at a
    // minute, and the panel said "resuming…" over a repair that had already
    // failed. The attempt drops the roster's cache as it settles, success or
    // not, which is what gets the next read past that floor.
    const { admin, accounts } = await fresh();
    seedStore({ usage: true });
    signedInAs("a@x.com");
    proc.add = () => ({ ok: false, code: 1, stderr: "Error: nothing to capture" });
    accounts.repairStaleCopyWith(admin.autoRecapture);

    const first = await accounts.fetchClaudeAccounts({ force: true });
    expect(first.accounts[0].repair).toEqual({ state: "running" });
    for (let i = 0; i < 200 && ran("add").length === 0; i++) await rest(5);
    await rest(20);

    const next = await accounts.fetchClaudeAccounts({ force: true });
    expect(next.accounts[0].repair).toMatchObject({ state: "failed", reason: "add_failed" });
    expect(ran("add"), "the failed attempt was not repeated by the read that reported it").toHaveLength(1);
  });
});
