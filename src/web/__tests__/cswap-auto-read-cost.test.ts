// #616. What one GET /api/cswap-auto is allowed to COST.
//
// The route is a read, and reads on this server are deliberately open:
// `isTrustedRead` does not apply the `Sec-Fetch-Site` test that
// `isTrustedMutation` does, so a local caller sending neither Origin nor
// Sec-Fetch-Site — curl, a shell script, a sandboxed agent — reaches it. That
// decision is fine. What was missing beside it is a ceiling, and this is the
// route #544's sweep did not reach.
//
// `autoStatus()` starts TWO children per request and had no cache, no in-flight
// join and no rate floor on either of them: `cswap config` (a Python process)
// and a full process-table listing — `ps -Ao args=` on POSIX, `Get-CimInstance
// Win32_Process` through PowerShell on Windows, where it carries an 8s deadline
// of its own. Measured on macOS through a PATH shim that logged every real
// child: one call was 2 children and about 190ms warm, twenty-five concurrent
// readers were 50 children and 1.3–1.9s, and afterwards the same twenty-five are
// 2 children and 190ms. Nobody hostile is needed to get there either —
// AccountsPanel polls this route every 15 seconds per open tab, and on Windows
// one CIM query outlasts that poll, so two tabs overlap rather than alternate.
//
// The assertions are behavioural rather than structural: nothing below reads a
// constant or a timestamp out of the module. What a ceiling means is how many
// children start and which callers share one, so that is what is counted — and
// the two windows are pinned the only way they are visible from outside, by
// moving the clock across each of them and seeing which half spawns again.
//
// PLAIN NODE, no DOM. `run` is answered from here, so nothing in this file runs
// cswap, ps or PowerShell, and no test can read the process table of the machine
// running the suite.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { spawnedArgv } from "./spawned-argv";

/** Every `run` the module asked for, and the knobs its answer is built from. */
const exec = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[] }[],
  /** How long one child takes. Zero settles on the next microtask, which keeps
   *  the sequential blocks fast; the concurrency blocks want a real overlap
   *  window and set it. */
  ms: 0,
  /** Live children right now, and the most that were ever live at once. */
  live: 0,
  peak: 0,
  /** What `cswap config` prints, and whether it succeeds at all. */
  configOut: "",
  configOk: true,
  /** What the process-table query prints. */
  tableOut: "",
  /** When set, a `cswap config` READ blocks until the test releases it, so a
   *  case can stand inside one and do something to the module while it is
   *  there. Writes are never held — a test that gates a read wants the write
   *  beside it to land. */
  holdConfig: false,
  holds: [] as (() => void)[],
}));

vi.mock("../../server/exec.mjs", () => ({
  // Indexing `args` positionally is safe HERE and only here: this stands in for
  // `run` itself, which is the layer ABOVE the platform spelling — viaCmd's
  // `cmd.exe /d /s /c "…"` wrapping happens inside the real run, below this
  // mock. Everything downstream that reads a recorded call goes through
  // spawnedArgv, which is where that distinction is handled.
  run: async (cmd: string, args: string[] = []) => {
    exec.calls.push({ cmd, args });
    exec.live += 1;
    exec.peak = Math.max(exec.peak, exec.live);
    const configRead = cmd === "cswap" && args[0] === "config" && args.length === 1;
    // What this child would print, decided when it STARTS. A real one prints
    // what was true when it ran, and the blocks below change these knobs while
    // a child is in flight precisely to tell the two moments apart.
    const ok = configRead ? exec.configOk : true;
    const stdout = configRead ? exec.configOut : cmd === "cswap" ? "" : exec.tableOut;
    if (configRead && exec.holdConfig) await new Promise<void>(r => exec.holds.push(r));
    else if (exec.ms) await new Promise(r => setTimeout(r, exec.ms));
    exec.live -= 1;
    if (!ok) return { ok: false, code: 1, killed: false, timedOut: false, stdout: "", stderr: "boom" };
    return { ok: true, code: 0, killed: false, timedOut: false, stdout, stderr: "" };
  },
  runDetached: () => {},
}));

// cswapBin() probes the real filesystem for an installed claude-swap; the name
// it resolves to is irrelevant here and the probe is not.
vi.mock("../../server/cswap-install.mjs", () => ({ cswapBin: async () => "cswap" }));

type Setting = { value: string | null; isDefault: boolean };
// @ts-expect-error — .mjs server module, no types
const auto = await import("../../server/cswap-auto.mjs") as {
  autoStatus: () => Promise<{ ok: boolean; external: boolean; settings: Record<string, Setting> }>;
  externalAutoRunning: () => Promise<boolean>;
  readCswapConfig: () => Promise<Record<string, Setting> | null>;
  setCswapConfig: (key: string, value: unknown) => Promise<{ ok: boolean }>;
  invalidateCswapAutoCache: () => void;
};

// `[program, ...arguments]` as the child really received them, on every
// platform. The Windows blocks below run on a Mac, and a recorded call is read
// the same way in both.
const argv = () => exec.calls.map(spawnedArgv);
const configReads  = () => argv().filter(a => a[1] === "config" && a.length === 2).length;
const configWrites = () => argv().filter(a => a[1] === "config" && a[2] === "set").length;
const psReads      = () => argv().filter(a => a[0] === "ps").length;
const cimReads     = () => argv().filter(a => /powershell/i.test(a[0])).length;
/** Whichever spelling of the process table this platform uses. */
const tableReads   = () => psReads() + cimReads();

// The clock is moved rather than waited on. Both windows are measured in
// seconds, and a suite that slept through them would take longer than the rest
// of it put together.
const realNow = Date.now;
let skew = 0;
const advance = (ms: number) => { skew += ms; };

// externalAutoRunning reads process.platform at call time, so both halves are
// reachable from either host — which is the only way the Windows one stays
// right, since it is the expensive one and runs on machines this suite is rarely
// run on.
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const asPlatform = (value: string) =>
  Object.defineProperty(process, "platform", { value, configurable: true });

beforeAll(() => { vi.spyOn(Date, "now").mockImplementation(() => realNow.call(Date) + skew); });
afterAll(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", realPlatform);
});

/** Real `cswap config` output, with one value this file can watch change. */
const CONFIG = (threshold: string) => [
  "autoswitch.enabled             true       (default)",
  "autoswitch.intervalSeconds     120",
  `autoswitch.threshold           ${threshold}`,
].join("\n");

/** A process table with nobody's `cswap auto` loop in it. */
const TABLE = [
  "/sbin/launchd",
  "node /usr/local/lib/node_modules/agents-deck/bin/agent-dag.js",
].join("\n");

beforeEach(() => {
  exec.calls.length = 0;
  exec.ms = 0;
  exec.peak = 0;
  exec.live = 0;
  exec.configOk = true;
  exec.configOut = CONFIG("85");
  exec.tableOut = TABLE;
  exec.holdConfig = false;
  exec.holds.length = 0;
  skew = 0;
  asPlatform("linux");
  auto.invalidateCswapAutoCache();
});

/** Let every held `cswap config` finish, oldest first. */
const releaseAll = () => { while (exec.holds.length) exec.holds.shift()!(); };
/** Let the oldest held `cswap config` finish, and leave the rest waiting. */
const releaseOldest = () => { exec.holds.shift()!(); };

describe("a burst of readers on GET /api/cswap-auto", () => {
  it("starts one child per question rather than one pair per request", async () => {
    // The issue's own reproduction. Twenty-five concurrent readers used to be
    // twenty-five Python interpreters and twenty-five `ps`, with nothing shared
    // between them; measured through a PATH shim they also took 1.3–1.9s
    // together against 190ms for one, so the cost per reader grew.
    exec.ms = 20;
    const all = await Promise.all(Array.from({ length: 25 }, () => auto.autoStatus()));

    expect(exec.calls).toHaveLength(2);
    expect(configReads()).toBe(1);
    expect(psReads()).toBe(1);
    // One of each, at the same time, and never a second of either. autoStatus
    // runs the two halves in parallel on purpose, so two live children is the
    // floor here rather than a queue forming.
    expect(exec.peak).toBe(2);

    // One reading, handed to everyone who asked for it — the same object, not
    // merely an equal one.
    for (const status of all) {
      expect(status.settings).toBe(all[0].settings);
      expect(status.ok).toBe(true);
      expect(status.external).toBe(false);
    }
  });

  it("is the same one child on Windows, where the query is the expensive one", async () => {
    // `Get-CimInstance Win32_Process` through PowerShell carries an 8s deadline
    // of its own and is the same order of cost as the Get-Process #544 measured
    // at about six seconds — long enough that AccountsPanel's 15s poll from two
    // tabs overlapped rather than alternated.
    asPlatform("win32");
    auto.invalidateCswapAutoCache();
    exec.ms = 20;
    await Promise.all(Array.from({ length: 25 }, () => auto.autoStatus()));

    expect(cimReads()).toBe(1);
    expect(psReads()).toBe(0);
    expect(configReads()).toBe(1);
    expect(argv().find(a => /powershell/i.test(a[0]))!.join(" ")).toContain("Win32_Process");
  });

  it("serves a reader arriving just after a reading rather than spawning again", async () => {
    // The sequential shape of the same flood: a `curl` in a loop that waits for
    // each answer, and the second tab whose poll lands a moment after the
    // first's. Before #616 every one of these was another pair of children.
    await auto.autoStatus();
    expect(exec.calls).toHaveLength(2);

    await auto.autoStatus();
    await auto.autoStatus();
    expect(exec.calls).toHaveLength(2);
  });

  it("shares the process-table reading with the deck's own tick", async () => {
    // runTick asks externalAutoRunning() again before every tick, so on a deck
    // with the loop switched on and a panel open there were two callers of the
    // expensive half on two different timers. They join the same child.
    await auto.autoStatus();
    expect(tableReads()).toBe(1);

    expect(await auto.externalAutoRunning()).toBe(false);
    expect(tableReads()).toBe(1);
  });
});

describe("the two windows, which are not the same window", () => {
  it("re-reads the settings well before it re-reads the process table", async () => {
    // The settings map is what the panel DISPLAYS, and `cswap config set` typed
    // in a terminal changes it behind the deck's back — so its floor is short.
    // The process table answers a boolean nobody changes between two polls, and
    // it is the expensive half, so its floor is measured in seconds.
    await auto.autoStatus();
    expect(configReads()).toBe(1);
    expect(psReads()).toBe(1);

    advance(5_000);            // past the config floor, well inside the other
    await auto.autoStatus();
    expect(configReads()).toBe(2);
    expect(psReads()).toBe(1);

    advance(6_000);            // and now past both
    await auto.autoStatus();
    expect(configReads()).toBe(3);
    expect(psReads()).toBe(2);
  });

  it("never hands AccountsPanel's own poll a cached reading", async () => {
    // POLL_MS is 15s. Both floors are chosen under it — and under MIN_INTERVAL_S,
    // claude-swap's own tick floor, which is also 15 — so neither scheduled
    // caller is ever shown something older than its own period. A window that
    // crept past either of those would make the panel's every-15s reload stop
    // meaning a reload.
    await auto.autoStatus();
    expect(configReads()).toBe(1);
    expect(psReads()).toBe(1);

    advance(15_000);
    await auto.autoStatus();
    expect(configReads()).toBe(2);
    expect(psReads()).toBe(2);
  });
});

describe("a reading that failed", () => {
  it("is not remembered as if it were a reading", async () => {
    // readCswapConfig spells its failure `null` and autoStatus reports
    // `ok: config != null`, so holding one would turn a single hiccup into a
    // panel that renders itself as broken for longer than the hiccup lasted.
    exec.configOk = false;
    const broken = await auto.autoStatus();
    expect(broken.ok).toBe(false);
    expect(configReads()).toBe(1);

    // The next caller tries again immediately rather than being handed the
    // failure for another three seconds.
    exec.configOk = true;
    const fixed = await auto.autoStatus();
    expect(fixed.ok).toBe(true);
    expect(configReads()).toBe(2);
    // And only that half retried. The process table answered, so its reading
    // still stands.
    expect(psReads()).toBe(1);
  });

  it("still shares one failing child between callers who overlap it", async () => {
    // Not remembering a failure is not the same as abandoning the dedupe: a
    // burst arriving while a read is failing is one failing child, not a burst
    // of them.
    exec.configOk = false;
    exec.ms = 20;
    const all = await Promise.all(Array.from({ length: 5 }, () => auto.autoStatus()));
    expect(configReads()).toBe(1);
    expect(psReads()).toBe(1);
    for (const status of all) expect(status.ok).toBe(false);
  });
});

describe("a settings write, which is this route's explicit refresh", () => {
  it("shows the panel what was written rather than the map read a moment before", async () => {
    // There is no ?refresh=1 here. Every auto-switch control is a POST followed
    // by load(true), which re-fetches this route — so the reload lands inside
    // the floor by construction, and a cache the write did not clear would show
    // the OLD value straight back to the user who had just changed it. That
    // disagreement between an optimistic value and the next read is #584.
    expect((await auto.autoStatus()).settings["autoswitch.threshold"].value).toBe("85");

    exec.configOut = CONFIG("90");
    expect((await auto.setCswapConfig("autoswitch.threshold", 90)).ok).toBe(true);
    expect(configWrites()).toBe(1);

    const after = await auto.autoStatus();
    expect(after.settings["autoswitch.threshold"].value).toBe("90");
  });

  it("forgets the reading even when the CLI reported the write as failed", async () => {
    // `r.ok` is not proof either way — that is the whole of #584, where argparse
    // read a leading dash as an option, printed help and exited 0 for a setting
    // it never stored. A write that reported a failure may equally have landed,
    // so the only safe thing to hold afterwards is nothing.
    await auto.autoStatus();
    expect(configReads()).toBe(1);

    exec.configOk = false;
    await auto.setCswapConfig("autoswitch.threshold", 90);
    exec.configOk = true;

    await auto.autoStatus();
    expect(configReads()).toBe(2);
  });

  it("does not let a read that started before the write answer callers after it", async () => {
    // #582's shape, in the module #582 did not touch. invalidateCswapAutoCache
    // clears variables, which does nothing to a read that is already running and
    // still holds the pre-write map in a local — so without a guard on the way
    // out, the OLD settings were written straight back over the cleared cache
    // milliseconds later, and the panel went on showing the value the user had
    // just changed away from for the rest of the window.
    exec.holdConfig = true;
    const straddling = auto.autoStatus();
    await Promise.resolve();
    expect(configReads()).toBe(1);

    exec.configOut = CONFIG("90");
    await auto.setCswapConfig("autoswitch.threshold", 90);

    releaseOldest();
    // The read itself is not wrong — it ran before the write and reports what it
    // saw. What matters is that it is not left holding it.
    expect((await straddling).settings["autoswitch.threshold"].value).toBe("85");

    exec.holdConfig = false;
    const next = await auto.autoStatus();
    expect(configReads()).toBe(2);
    expect(next.settings["autoswitch.threshold"].value).toBe("90");
  });

  it("does not let that read clear the in-flight slot the next one installed", async () => {
    // The other half of the same guard. A read from before the write finishing
    // afterwards must not take the CURRENT read's promise down with it: the
    // caller arriving next would then start a third child beside a second that
    // is already running, which is the fan-out this whole file is about,
    // reintroduced through the invalidation path.
    exec.holdConfig = true;
    const before = auto.autoStatus();
    await Promise.resolve();
    expect(configReads()).toBe(1);

    await auto.setCswapConfig("autoswitch.threshold", 90);

    const after = auto.autoStatus();          // starts the second read
    await Promise.resolve();
    expect(configReads()).toBe(2);

    releaseOldest();                          // the pre-write read settles
    await before;

    const third = auto.autoStatus();          // must join the second, not start a third
    await Promise.resolve();
    expect(configReads()).toBe(2);

    releaseAll();
    await Promise.all([after, third]);
    expect(configReads()).toBe(2);
  });

  it("refuses a value the grammar rejects without spending a child on it", async () => {
    // The floor is admission control, not a reason to relax validation: a
    // rejected setting never reaches an argument vector and never clears a
    // reading either.
    await auto.autoStatus();
    expect(configReads()).toBe(1);

    expect((await auto.setCswapConfig("autoswitch.threshold", 1_000)).ok).toBe(false);
    expect(configWrites()).toBe(0);

    await auto.autoStatus();
    expect(configReads()).toBe(1);
  });
});
