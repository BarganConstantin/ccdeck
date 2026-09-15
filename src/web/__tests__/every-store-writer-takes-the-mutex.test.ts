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
  proc: { calls: [] as string[][] },
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const okay = { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "" };
  return {
    ...real,
    run: async (_cmd: string, args: string[] = []) => {
      proc.calls.push(args);
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
const { withStoreLock } = await import("../../server/cswap-admin.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { switchClaudeAccount, seedFirstAccount } = await import("../../server/claude-accounts.mjs");
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
