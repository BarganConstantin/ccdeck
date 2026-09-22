// #1039: `cswap switch` ran beside an in-flight `cswap add`, from two features,
// and cswap-admin.mjs's own header is the sentence that says it must not.
//
// > And `cswap add` takes no lock while assigning the next slot as max+1. Two
// > concurrent adds pick the same number and the second write silently drops
// > the first account's record. Nothing upstream prevents it, so every mutation
// > here goes through one mutex.
//
// "here" was the load-bearing word. `withStoreLock` lived in cswap-admin.mjs
// and was reached only from cswap-admin.mjs, so the seven mutations spelled out
// in that file were serialized against each other and against nothing else.
// `grep -n withStoreLock src/server/*.mjs` returned hits in exactly one module,
// and three writers of the same sequence.json lived outside it:
//
//   POST /api/claude-accounts/switch   claude-accounts.mjs   `cswap switch N`
//   the auto-switch tick               cswap-auto.mjs        `cswap auto --once`
//   the first-run seed                 claude-accounts.mjs   `cswap add`
//
// WHAT WAS OBSERVED, driven below rather than argued: with the lock held the way
// `submitLoginCode` holds it for the length of a `cswap add` — CSWAP_TIMEOUT_MS
// is 60 s, and registerSignedIn follows the add with a `cswap list` and a
// `cswap switch`, so the real hold is minutes rather than seconds — every one of
// those three spawned its child IMMEDIATELY. The child vector was in the
// recorder before the lock had been released, which is the interleaving
// `cancelLogin` already queues its own `cswap switch` to avoid, in a comment
// that names the consequence:
//
// > running `cswap switch` beside an in-flight `cswap add` is precisely the
// > unlocked read-modify-write of sequence.json the mutex exists to prevent:
// > claude-swap takes no file lock around `add`, so whichever write lands
// > second drops the other's record.
//
// Neither of the two timer-driven ones needs a user to do anything: the tick
// fires on an interval whose floor is 15 s, well inside one `cswap add`, and the
// seed runs unawaited at boot. So the rotation is silently undone and the deck
// reports a switch that did not happen, or the account the user has just signed
// in is registered and immediately lost.
//
// Nothing here runs a real subprocess or reads a real store: exec.mjs's three
// spawners are replaced, AGENTS_DECK_CSWAP points at a path that does not exist
// so no binary is ever resolved, and HOME plus CLAUDE_SWAP_BACKUP are checked to
// be inside a temp directory before the server modules are imported.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-store-mutex-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_SWAP_BACKUP", "AGENTS_DECK_CSWAP"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "cswap");
// An explicit path wins over every probe in cswapBin, and this one is not there.
process.env.AGENTS_DECK_CSWAP = join(DIR, "no-such-cswap");

const inside = (p: string) => resolve(p).startsWith(resolve(DIR));
for (const k of ENV_KEYS) {
  if (!inside(process.env[k]!)) throw new Error(`sandbox escaped: ${k}=${process.env[k]}`);
}
// cswap-auto.mjs keeps its enabled flag under the home directory, and homedir()
// reads HOME on POSIX and USERPROFILE on Windows. Stop before the import if
// either is still pointing at the real one.
if (!inside(homedir())) throw new Error(`sandbox escaped: homedir ${homedir()}`);
mkdirSync(join(DIR, "cswap"), { recursive: true });

// Every argument vector a child WOULD have been started with, in order. This is
// the whole instrument: the question is not what a command returned but at what
// moment it was reached, and a recorder that appends before it does anything
// else answers exactly that.
const { proc } = vi.hoisted(() => ({
  proc: {
    calls: [] as string[][],
    // What claude-swap's own write does to sequence.json while the command
    // runs, for the cases that are about what a read AFTER it sees. Null for
    // every case that only asks when a child was reached.
    writes: null as null | ((args: string[]) => void),
    // How a command ends, for the cases that are about a refusal. Answering
    // per argv rather than globally, since a roster read may spawn a collector
    // of its own beside the mutation under test.
    fails: null as null | ((args: string[]) => Record<string, unknown> | null),
  },
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
  return {
    ...real,
    run: async (_cmd: string, args: string[] = []) => {
      proc.calls.push(args);
      proc.writes?.(args);
      const bad = proc.fails?.(args);
      if (bad) return { ...okay, ...bad };
      // The tick parses this; anything else is happy with silence.
      if (args[0] === "auto") {
        return { ...okay, stdout: JSON.stringify({ event: "no-switch", reason: "cooldown" }) };
      }
      return okay;
    },
    runDetached: (_cmd: string, args: string[] = []) => { proc.calls.push(args); },
    runInteractive: (_cmd: string, args: string[] = []) => {
      proc.calls.push(args);
      return { done: Promise.resolve(okay), write() {}, end() {}, onLine() {}, kill() {} };
    },
  };
});

// @ts-expect-error — plain .mjs server module, no types
const { withStoreLock, moveAccount } = await import("../../server/cswap-admin.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { switchClaudeAccount, seedFirstAccount, fetchClaudeAccounts, invalidateClaudeAccountsCache } =
  await import("../../server/claude-accounts.mjs");
// @ts-expect-error — plain .mjs server module, no types
const auto = await import("../../server/cswap-auto.mjs");

const rest = (ms: number) => new Promise(r => setTimeout(r, ms));
const ran = (first: string, second?: string) =>
  proc.calls.filter(a => a[0] === first && (second === undefined || a[1] === second));

/**
 * Hold the mutex the way a sign-in holds it, run `body` against the held lock,
 * and release afterwards whatever `body` did.
 *
 * `submitLoginCode` → `registerSignedIn` opens `withStoreLock` and runs
 * `cswap add` inside it; this is the same shape with a promise standing in for
 * the subprocess, so the hold lasts exactly as long as the test wants it to
 * rather than as long as a machine takes.
 *
 * Two details that are not decoration. The hold is not established until the
 * chain has actually reached it, so this waits for that rather than assuming
 * the lock was free — a queued `withStoreLock` has not run its callback yet and
 * `release` would still be undefined. And the release is in a `finally`: a
 * failing assertion inside the critical section would otherwise leave the chain
 * blocked for the rest of the file, turning one real failure into a page of
 * twenty-second timeouts that say nothing about the bug.
 */
async function whileTheStoreIsBusy(body: () => Promise<void>) {
  let release!: () => void;
  let acquired!: () => void;
  const reached = new Promise<void>(r => { acquired = r; });
  const held = withStoreLock(() => {
    acquired();
    return new Promise<void>(r => { release = r; });
  });
  await reached;
  try {
    await body();
  } finally {
    release();
    await held;
  }
}

beforeEach(() => {
  proc.calls.length = 0;
  proc.writes = null;
  proc.fails = null;
});

afterAll(async () => {
  await auto.setAutoEnabled(false);
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k]!;
  }
  rmTempDir(DIR);
});

describe("the manual switch route", () => {
  it("waits for the mutation that is already running before it moves the account", async () => {
    let switching!: Promise<{ ok: boolean }>;
    await whileTheStoreIsBusy(async () => {
      switching = switchClaudeAccount(2);
      // Long enough for cswapBin() plus a spawn several times over. The unfixed
      // route had `["switch", "2"]` in the recorder within a microtask.
      await rest(60);
      expect(ran("switch"), "a switch was spawned beside an in-flight store mutation").toEqual([]);
    });
    expect(await switching).toMatchObject({ ok: true });
    expect(ran("switch")).toEqual([["switch", "2"]]);
  });

  it("still refuses a slot number that is not one, without reaching for the lock", async () => {
    // The validation is the reason this function can be trusted with an exec
    // argument at all, and putting the run inside the mutex must not move it
    // behind a lock somebody else may be holding: a bad number is answered now.
    await whileTheStoreIsBusy(async () => {
      expect(await switchClaudeAccount("2; rm -rf /")).toMatchObject({ ok: false, reason: "bad_account" });
      expect(await switchClaudeAccount(0)).toMatchObject({ ok: false, reason: "bad_account" });
      expect(ran("switch")).toEqual([]);
    });
  });
});

describe("the auto-switch tick", () => {
  it("does not evaluate a rotation while another mutation holds the store", async () => {
    // `cswap auto --once` reads sequence.json, decides, and writes it back. The
    // interval floor is 15 s (MIN_INTERVAL_S, claude-swap's own) and one
    // `cswap add` is allowed 60, so a tick landing inside a sign-in needs no
    // coincidence — it is the ordinary case for anyone who has the feature on.
    const before = (await auto.autoStatus()).lastTick;
    try {
      await whileTheStoreIsBusy(async () => {
        // setAutoEnabled(true) installs the interval — 15 s, so exactly one tick
        // runs here — and fires the first tick WITHOUT awaiting it, so the
        // finish line has to be watched for rather than awaited.
        await auto.setAutoEnabled(true);
        await rest(80);
        expect(ran("auto"), "a tick evaluated a rotation beside an in-flight store mutation").toEqual([]);
      });
      for (let i = 0; i < 400 && (await auto.autoStatus()).lastTick === before; i++) await rest(5);
      expect((await auto.autoStatus()).lastTick, "the tick never completed").not.toBe(before);
      expect(ran("auto", "--once")).toEqual([["auto", "--once", "--json"]]);
    } finally {
      await auto.setAutoEnabled(false);
    }
  });
});

describe("the first-run seed", () => {
  it("tests the store for emptiness and adds to it inside one critical section", async () => {
    // The seed's guard is a READ of sequence.json — "only when the store holds
    // no accounts at all, so nothing can be overwritten or reordered" — followed
    // by a write. Outside the lock that pair is the read-modify-write the mutex
    // exists to stop, and #796 is what it costs when the two disagree: `cswap
    // add` against a populated store, re-pointing activeAccountNumber with
    // nothing here to restore it.
    //
    // The marker file is written before the add, so this runs once per temp
    // HOME; that is the seed's own contract and it is why the assertion below
    // is about the one run rather than about repetition.
    let seeding!: Promise<unknown>;
    await whileTheStoreIsBusy(async () => {
      seeding = seedFirstAccount();
      await rest(60);
      expect(ran("add"), "the seed added to the store beside an in-flight mutation").toEqual([]);
    });
    await seeding;
    expect(ran("add")).toEqual([["add"]]);
  });
});

describe("the mutex itself", () => {
  // The structural half of #1039 — that there is ONE lock rather than one per
  // module, and that the module it lives in can never end up inside the
  // claude-accounts/cswap-admin cycle — is pinned in boot-module-graph.test.ts,
  // beside the boot-order defect that made that cycle worth writing down.

  it("serializes a switch behind a seed, since both now queue on it", async () => {
    // Two of the newly-covered writers against each other, with no sign-in
    // anywhere: this is the pair a boot and a click produce.
    writeFileSync(join(DIR, "cswap", "sequence.json"), JSON.stringify({ accounts: { 1: {} } }));
    const order: string[] = [];
    const first = withStoreLock(async () => { await rest(30); order.push("held"); });
    const second = switchClaudeAccount(3).then(() => { order.push("switch"); });
    await Promise.all([first, second]);
    expect(order).toEqual(["held", "switch"]);
  });
});

// Two more writers of the same sequence.json, driven rather than read (#1169).
//
// Their bounds are tested and their lock and invalidation were pinned as SOURCE
// TEXT — remaining-forced-read-guards.test.ts slices setAccountEnabled's body
// and looks for the two names in it, which a lock taken around the wrong call
// passes just as well. What follows is the same claim made by running them: the
// child is not reached while somebody else holds the store, and the roster the
// press just made wrong is gone by the time the panel asks again.
describe("holding an account out of rotation", () => {
  const seq = join(DIR, "cswap", "sequence.json");
  /** Two accounts, 1 active, with 2 in or out of the rotation. */
  const store = (twoIsHeld = false) => writeFileSync(seq, JSON.stringify({
    activeAccountNumber: 1,
    accounts: { 1: { email: "a@b.c" }, 2: { email: "d@e.f", ...(twoIsHeld ? { disabled: true } : {}) } },
  }));
  const held = (rows: { num: number; disabled: boolean }[]) => rows.find(r => r.num === 2)?.disabled;

  it("refuses an account number that is not one, without reaching for the lock", async () => {
    // Same argument as the switch route above: the validation is what lets this
    // hand a number to a subprocess at all, and a bad one is answered now
    // rather than behind a lock somebody else is holding.
    await whileTheStoreIsBusy(async () => {
      expect(await auto.setAccountEnabled("2; rm -rf /", true)).toMatchObject({ ok: false, reason: "bad_account" });
      expect(await auto.setAccountEnabled(0, false)).toMatchObject({ ok: false, reason: "bad_account" });
      expect(await auto.setAccountEnabled(1000, false)).toMatchObject({ ok: false, reason: "bad_account" });
      expect(proc.calls).toEqual([]);
    });
  });

  it("waits for the mutation already running before it writes the flag", async () => {
    // `cswap disable N` is a read-modify-write of sequence.json, which is the
    // pair the mutex exists for — and this was the one mutation that did not
    // take it.
    let holding!: Promise<{ ok: boolean }>;
    await whileTheStoreIsBusy(async () => {
      holding = auto.setAccountEnabled(2, false);
      await rest(60);
      expect(ran("disable"), "a disable was spawned beside an in-flight store mutation").toEqual([]);
    });
    expect(await holding).toMatchObject({ ok: true });
    expect(ran("disable")).toEqual([["disable", "2"]]);
  });

  it("puts an account back in with the other spelling of the same command", async () => {
    expect(await auto.setAccountEnabled(2, true)).toMatchObject({ ok: true });
    expect(ran("enable")).toEqual([["enable", "2"]]);
    expect(ran("disable")).toEqual([]);
  });

  it("repeats what claude-swap refused, rather than reporting a hold that happened", async () => {
    proc.fails = args => (args[0] === "disable" ? { ok: false, code: 1, stderr: "no such account\n" } : null);
    expect(await auto.setAccountEnabled(9, false))
      .toEqual({ ok: false, reason: "command_failed", detail: "no such account" });
  });

  it("drops the roster it has just made wrong, so the press is not a no-op for a minute", async () => {
    // The documented bug, driven: the panel polls every 15 s and each poll
    // stamps the read, so `now - _lastReadAt >= FORCE_POLL_MS` (60 s) is a
    // quantity the reload after the press can never reach. Without the
    // invalidation the forced read is refused and hands back the roster from
    // before the press — the chip does not move and nothing has failed.
    store(false);
    proc.writes = args => { if (args[0] === "disable") store(true); };
    invalidateClaudeAccountsCache();
    const before = await fetchClaudeAccounts();
    expect(held(before.accounts), "the fixture starts with account 2 in the rotation").toBe(false);

    expect(await auto.setAccountEnabled(2, false)).toMatchObject({ ok: true });

    const after = await fetchClaudeAccounts({ force: true });
    expect(held(after.accounts)).toBe(true);
  });
});

describe("moving an account to another slot", () => {
  const seq = join(DIR, "cswap", "sequence.json");
  const store = (accounts: Record<number, string>) => writeFileSync(seq, JSON.stringify({
    activeAccountNumber: 2,
    accounts: Object.fromEntries(Object.entries(accounts).map(([n, email]) => [n, { email }])),
  }));

  it("waits for the mutation already running before it reorders the store", async () => {
    store({ 2: "d@e.f", 3: "g@h.i" });
    let moving!: Promise<{ ok: boolean }>;
    await whileTheStoreIsBusy(async () => {
      moving = moveAccount(2, 3);
      await rest(60);
      expect(ran("move"), "a move was spawned beside an in-flight store mutation").toEqual([]);
    });
    await moving;
    expect(ran("move")).toEqual([["move", "2", "3"]]);
  });

  it("reads the store on both sides of the move and reports the trade that happened", async () => {
    // moveOutcome is pure and tested on hand-built pairs; what it is given is
    // not. The two reads must straddle the command — a `before` taken after it
    // would show the move already done and report every move as a relocation
    // into an empty slot.
    store({ 2: "d@e.f", 3: "g@h.i" });
    proc.writes = args => {
      if (args[0] === "move") store({ 2: "g@h.i", 3: "d@e.f" });
    };
    expect(await moveAccount(2, 3)).toMatchObject({ ok: true, from: 2, to: 3, swapped: true });
  });

  it("says a move into a free slot is not a trade", async () => {
    store({ 2: "d@e.f" });
    proc.writes = args => { if (args[0] === "move") store({ 3: "d@e.f" }); };
    expect(await moveAccount(2, 3)).toMatchObject({ ok: true, from: 2, to: 3, swapped: false });
  });

  it("reports a refused move rather than the store it then reads", async () => {
    // The store is untouched on a refusal, so the two reads agree and
    // moveOutcome would answer `to: null` — which reads as "it went somewhere
    // unexpected" rather than as "claude-swap said no".
    store({ 2: "d@e.f", 3: "g@h.i" });
    proc.fails = args => (args[0] === "move" ? { ok: false, code: 1, stderr: "slot 3 is locked\n" } : null);
    const r = await moveAccount(2, 3);
    expect(r).toMatchObject({ ok: false, reason: "move_failed" });
    expect(r.detail).toContain("slot 3 is locked");
  });
});
