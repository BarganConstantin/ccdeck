// Two starts inside one boot window used to become two decks.
//
// A start asks the registry whether one of its decks is up, and a deck answers
// only once its record is written — up to eight seconds into its boot. So the
// login item and a terminal opened at login both read an empty registry, both
// started, and one machine showed up twice on a colleague's Local network list
// with two fingerprints at one address. boot-lock.mjs makes the asking and the
// starting one step; these pin the ways a lock goes wrong: two holders, a
// holder nobody can get past, and a lock that takes a deck down with it.
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

type Lock = { held: boolean; waited: boolean; reason?: string; release: () => boolean };
type Holder = { pid: number; at: number; nonce?: string } | null;

// @ts-expect-error — .mjs server module, no types
const mod = await import("../../server/boot-lock.mjs");
const { takeBootLock, holderIsGone, BOOT_LOCK_FILE, BOOT_LOCK_STALE_MS } = mod as {
  takeBootLock: (o: { dir: string; pid?: number; alive?: (pid: number) => boolean; pollMs?: number; now?: () => number }) => Promise<Lock>;
  holderIsGone: (h: Holder, o: { now: number; alive: (pid: number) => boolean; staleMs?: number; mtime?: number | null; self?: number }) => boolean;
  BOOT_LOCK_FILE: string;
  BOOT_LOCK_STALE_MS: number;
};

const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-boot-lock-"));
afterAll(() => rmTempDir(ROOT));
let n = 0;
const fresh = () => join(ROOT, `r${n++}`);

const DECK = readFileSync(fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");

describe("one start at a time", () => {
  it("makes the second start wait until the first gives the lock back", async () => {
    const dir = fresh();
    const first = await takeBootLock({ dir });
    expect(first.held).toBe(true);
    expect(existsSync(join(dir, BOOT_LOCK_FILE))).toBe(true);

    // Another process: a lock carrying the reader's own pid is a dead process's
    // by definition, so the second start has to be somebody else.
    let second: Lock | null = null;
    const pending = takeBootLock({ dir, pid: 999_999, pollMs: 10 }).then(l => { second = l; return l; });
    await new Promise(r => setTimeout(r, 80));
    // Still waiting: the first holder is alive and well inside its window.
    expect(second).toBeNull();

    expect(first.release()).toBe(true);
    const got = await pending;
    expect(got.held).toBe(true);
    expect(got.waited).toBe(true);
    got.release();
  });

  it("gives back only its own lock, once", async () => {
    const dir = fresh();
    const lock = await takeBootLock({ dir });
    // Judged stale and taken by somebody else: the file carries their nonce now,
    // and removing it would hand the window straight to a third start.
    writeFileSync(join(dir, BOOT_LOCK_FILE), JSON.stringify({ pid: 1, at: Date.now(), nonce: "theirs" }));
    expect(lock.release()).toBe(false);
    expect(existsSync(join(dir, BOOT_LOCK_FILE))).toBe(true);

    const dir2 = fresh();
    const mine = await takeBootLock({ dir: dir2 });
    expect(mine.release()).toBe(true);
    // The exit handler calls it again after the boot already did.
    expect(mine.release()).toBe(false);
  });

  it("is never read as a deck by anything that lists the registry", () => {
    // The stale sweep in index.mjs keeps `*.json` only; the hook is narrower
    // still and keeps `${pid}.json`, which is the only shape writeDiscovery has
    // ever produced (installer.mjs:781). Either rule excludes the lock, and the
    // narrow one excludes it twice over.
    expect(BOOT_LOCK_FILE.endsWith(".json")).toBe(false);
    const hook = readFileSync(fileURLToPath(new URL("../../../hook/hook.js", import.meta.url)), "utf8");
    // The listing is fs.readdir now, not fs.readdirSync — a synchronous call
    // there could not be preempted by the hook's own exit timer, which is #1018
    // and not this file's business. The filter is, so the directory read and
    // the filter are asserted separately and the pair survives that change.
    expect(hook).toMatch(/fs\.readdir\(DIR,/);
    expect(hook).toMatch(/\.filter\(f => \/\^\\d\+\\\.json\$\/\.test\(f\)\)/);
    // And the rule itself, rather than only its spelling: whatever the filter
    // is, it must refuse this name.
    expect(/^\d+\.json$/.test(BOOT_LOCK_FILE)).toBe(false);
  });
});

describe("a holder that cannot let go is not waited on", () => {
  it("steps past a lock whose pid is gone", async () => {
    const dir = fresh();
    const lock = await takeBootLock({ dir, alive: () => true });
    lock.release();
    writeFileSync(join(dir, BOOT_LOCK_FILE), JSON.stringify({ pid: 424242, at: Date.now(), nonce: "x" }));
    const got = await takeBootLock({ dir, alive: (pid) => pid !== 424242 });
    expect(got).toMatchObject({ held: true, waited: false });
    got.release();
  });

  it("steps past a lock older than any boot, even when its pid answers", async () => {
    // #695 pointed at a lock: the pid was recycled into something else, which
    // answers signal 0 forever.
    const dir = fresh();
    (await takeBootLock({ dir })).release();
    writeFileSync(join(dir, BOOT_LOCK_FILE), JSON.stringify({ pid: 5, at: Date.now() - BOOT_LOCK_STALE_MS - 1, nonce: "x" }));
    const got = await takeBootLock({ dir, alive: () => true });
    expect(got.held).toBe(true);
    got.release();
  });

  it("reads a lock carrying its own pid as a dead process's", () => {
    // The recycled pid the other way round: it answers signal 0 because it is us.
    expect(holderIsGone({ pid: 7, at: Date.now() }, { now: Date.now(), alive: () => true, self: 7 })).toBe(true);
    expect(holderIsGone({ pid: 8, at: Date.now() }, { now: Date.now(), alive: () => true, self: 7 })).toBe(false);
  });

  it("waits on a half-written lock for as long as a write can take, and no longer", () => {
    const now = Date.now();
    const alive = () => true;
    expect(holderIsGone(null, { now, alive, mtime: now - 100 })).toBe(false);
    expect(holderIsGone(null, { now, alive, mtime: now - 5_000 })).toBe(true);
    // Gone between the failed open and the read: nothing left to wait for.
    expect(holderIsGone(null, { now, alive, mtime: null })).toBe(true);
  });
});

describe("a lock never keeps a deck from starting", () => {
  it("starts unguarded where the directory cannot be written", async () => {
    // A path through a regular file: mkdir and open both refuse, on every
    // platform, with something other than EEXIST.
    const file = join(ROOT, "not-a-dir");
    writeFileSync(file, "");
    const got = await takeBootLock({ dir: join(file, "agent-dag") });
    expect(got.held).toBe(false);
    expect(got.reason).toBeTruthy();
    expect(got.release()).toBe(false);
  });
});

describe("where bin/deck.js holds it", () => {
  const at = (s: string) => DECK.indexOf(s);

  it("takes it before asking, and asks before anything is bound", () => {
    const take = at("bootLock = await takeBootLock({ dir: deckRegistryDir() })");
    const ask = at("const plan = secondStart({");
    const bind = at("const starting = startServer({");
    expect(take).toBeGreaterThan(0);
    expect(ask).toBeGreaterThan(take);
    expect(bind).toBeGreaterThan(ask);
  });

  it("gives it back once this deck's record is on disk, not at exit", () => {
    const check = at("await discovery.check();");
    const release = DECK.indexOf("bootLock?.release();", check);
    expect(check).toBeGreaterThan(0);
    expect(release).toBeGreaterThan(check);
    // Nothing else is awaited between the two: the lock is for the window
    // before the record, and every line held after it is a second start kept
    // waiting for nothing.
    expect(DECK.slice(check + "await discovery.check();".length, release)).not.toMatch(/await /);
  });

  it("gives it back on every way out, from a handler that exists before the gate", () => {
    // Observed on a sandbox deck: `ccdeck` typed beside a running one takes the
    // attach exit, and `<config>/agent-dag/boot.lock` was still on disk
    // afterwards carrying the attaching process's now-dead pid. bin/deck.js is
    // an ES module with top-level `await`, so its statements run in source
    // order: the handler was registered 440 lines BELOW the three
    // `process.exit()` calls it was written to cover — the yield, the attach,
    // and the boot whose server could not bind — and the explicit release is on
    // the one path none of them take. #980.
    //
    // This case used to assert
    //
    //   expect(DECK).toMatch(/process\.on\("exit", …bootLock\?\.release\(\)…/);
    //   expect(at("let bootLock = null;")).toBeGreaterThan(0);
    //   expect(at("let bootLock = null;")).toBeLessThan(at("dieWithParent(…)"));
    //
    // — which proves the handler exists SOMEWHERE and then compares the
    // position of the DECLARATION, never of the registration. Both halves were
    // true of the leaking file, so the case passed while the property in its own
    // title was false. The declaration's position is a different rule (#448),
    // and it is now checked under its own name below.
    const arm = 'process.on("exit", () => { bootLock?.release(); });';
    expect(at(arm)).toBeGreaterThan(0);
    expect(at(arm)).toBeLessThan(at("bootLock = await takeBootLock("));
    // And before each of the three exits it has to survive, named one by one so
    // a fourth added above the handler fails here rather than quietly joining
    // them: the yield, the attach, and the boot that could not bind.
    for (const exit of [
      'if (plan.act === "yield") {',
      'if (plan.act === "attach") {',
      'server failed: ${bound.err.message}',
    ]) {
      expect(at(exit)).toBeGreaterThan(0);
      expect(at(arm)).toBeLessThan(at(exit));
    }
  });

  it("declares it above the first line shutdown can be reached from", () => {
    // #448's rule, which the case above used to be a check of by accident. A
    // `const` at the gate would be in its temporal dead zone for every exit
    // before it, and `shutdown` is reachable from the moment dieWithParent is
    // armed — so the declaration has to come first or an early exit dies of a
    // ReferenceError instead of tidying up.
    expect(at("let bootLock = null;")).toBeGreaterThan(0);
    expect(at("let bootLock = null;")).toBeLessThan(at("dieWithParent(() => shutdown(0));"));
  });
});
