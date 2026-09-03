// #544. Reads on this server are deliberately open. `isTrustedRead` does not
// apply the `Sec-Fetch-Site` test that `isTrustedMutation` does, and the comment
// above it explains why: a cross-site read of `http://127.0.0.1:4317` is an
// ordinary top-level navigation, not an attack. That decision is fine. What was
// missing beside it is a ceiling on what one of those reads is allowed to COST.
//
// Two endpoints had none.
//
// `/api/ccusage` puts `since` and `until` in the argument vector of a spawned
// CLI. `ccusage-range-validation.test.ts` pins the grammar those two values must
// obey — that neither can become syntax — and nothing pinned how many of them
// could be in flight at once. `fetchCcusageDaily` had no in-flight guard, so any
// page the user had open could run
//
//     for (let d = 20260101; d < 20260131; d++)
//       fetch("http://127.0.0.1:4317/api/ccusage?since=" + d, { mode: "no-cors" })
//
// and get thirty concurrent `node <PKG_DIR>/src/cli.js daily --json` children,
// each with a ninety-second deadline and each walking the whole ~/.claude log
// tree — doubled again whenever runDaily retried without `--by-agent`. Every
// distinct key also left a permanent `_cache` entry, and `isCliDate` admits all
// 10^8 eight-digit strings on purpose, so the map had 10^8 keys available to it
// and no eviction policy at all.
//
// `/api/system/processes` is the sharper per-request version, and its second
// half is a wrong number rather than wasted work. `readProcesses` had no cache,
// no dedupe and no throttle, so each GET spawned a `powershell.exe Get-Process`
// — about six seconds — or a `ps`. On Windows that is also a correctness bug:
// `cpuFromDeltas` needs the PREVIOUS reading's cpuSec per pid, `prevProcCpu` and
// `prevProcAt` are one shared pair, and two readers each stored theirs over the
// other's, so the CPU column came back computed against a baseline belonging to
// somebody else's reading. It needed no attacker to reach — one Get-Process
// takes longer than SystemMeter's four-second poll, so a single tab already
// overlapped itself.
//
// The assertions below are behavioural rather than structural on purpose: none
// of them reads a counter or a Map size out of the module. What a ceiling means
// is how many children start and which callers share one, so that is what is
// counted, and the eviction policy is asserted the only way it is observable
// from outside — a range the cache has forgotten is fetched again, and one it
// still holds is not.
//
// PLAIN NODE, no DOM. `node:child_process` is replaced wholesale, so nothing
// here runs ccusage, powershell or ps, and no test in this file can read the
// process table of the machine running the suite.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Sub = (v?: unknown) => void;

const { spawns, fake } = vi.hoisted(() => ({
  spawns: [] as { file: string; args: string[]; at: number }[],
  fake: {
    /** How long one child takes. Zero means "finish on the next microtask",
     *  which keeps the sequential blocks fast; the concurrency blocks want a
     *  real overlap window and set it. */
    ms: 0,
    /** Live children right now, and the most that were ever live at once. The
     *  second number is the whole point of the ccusage half of this file. */
    live: 0,
    peak: 0,
    /** Bumped once per Get-Process reading, so two readings are distinguishable
     *  and a baseline written from the wrong one produces a different answer. */
    cpuSec: 10,
    /** When set, the next children exit non-zero with nothing on stdout, which
     *  is what `run` in system-metrics.mjs turns into an empty list. */
    fail: false,
  },
}));

/** What each fake child prints. `ps` and `powershell.exe` are the process
 *  table; anything else in this file is ccusage. */
function stdoutFor(file: string): string {
  if (file === "ps") {
    // Already ordered by CPU, because psArgs asks ps to do that sort
    // (`--sort=-pcpu` on Linux, `-r` on BSD) and parsePsProcesses keeps
    // whatever order it was given.
    return "  PID  %CPU %MEM COMMAND\n" +
           "  777  99.0  1.2 node\n" +
           "    1  12.5  0.4 launchd\n";
  }
  if (file.toLowerCase().includes("powershell")) {
    return JSON.stringify([
      { Id: 1, ProcessName: "System", CPU: fake.cpuSec, WorkingSetPrivate: 1024 },
      { Id: 777, ProcessName: "node", CPU: fake.cpuSec, WorkingSetPrivate: 2048 },
    ]);
  }
  return JSON.stringify({ daily: [{ date: "2026-01-01", totalCost: 1 }], totals: { totalCost: 1 } });
}

vi.mock("node:child_process", () => ({
  spawn: (file: string, args: string[] = []) => {
    spawns.push({ file, args, at: Date.now() });
    fake.live += 1;
    fake.peak = Math.max(fake.peak, fake.live);
    if (file.toLowerCase().includes("powershell")) fake.cpuSec += 2;
    const out = stdoutFor(file);
    const outs: Sub[] = [], errs: Sub[] = [], self: Record<string, Sub[]> = {};
    const finish = () => {
      fake.live -= 1;
      outs.forEach(cb => cb(out));
      self.close?.forEach(cb => cb(0));
    };
    const die = () => {
      fake.live -= 1;
      self.close?.forEach(cb => cb(1));
    };
    const settle = fake.fail ? die : finish;
    if (fake.ms > 0) setTimeout(settle, fake.ms);
    else queueMicrotask(settle);
    return {
      pid: 4242,
      stdout: { on: (e: string, cb: Sub) => { if (e === "data") outs.push(cb); } },
      stderr: { on: (e: string, cb: Sub) => { if (e === "data") errs.push(cb); } },
      on: (e: string, cb: Sub) => { (self[e] ||= []).push(cb); },
      kill: () => {},
      unref: () => {},
    };
  },
  spawnSync: () => { throw new Error("test: spawnSync blocked"); },
  // exec.mjs — reached through ccusage.mjs for spawnSpec and killTree — imports
  // it by name, and a name the mock omits is a load error.
  execFile: () => { throw new Error("test: execFile blocked"); },
}));

// ccusage.mjs resolves ~/.agents-deck/ccusage out of os.homedir() at import
// time, so both home variables point into a temp directory BEFORE the module
// loads and nothing here can see the developer's real managed install. PATH goes
// with them: a developer with `npm i -g ccusage` must not take that route
// instead of the override below.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-544-read-cost-"));
const CCUSAGE = join(FAKE_HOME, "ccusage-stand-in");
writeFileSync(CCUSAGE, "");
const prevEnv = { ...process.env };
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.PATH = FAKE_HOME;
process.env.AGENTS_DECK_NO_INSTALL = "1";
// An override that DOES resolve, unlike the one ccusage-range-validation uses:
// that file wants every request refused before a child starts, and this one
// wants a child every time, so it can count them.
process.env.AGENTS_DECK_CCUSAGE = CCUSAGE;

// @ts-expect-error — .mjs server module, no types
const { fetchCcusageDaily } = await import("../../server/ccusage.mjs");
// @ts-expect-error — .mjs server module, no types
const { readProcesses, stopSystemMetrics } = await import("../../server/system-metrics.mjs");

afterAll(() => {
  for (const k of ["HOME", "USERPROFILE", "PATH", "AGENTS_DECK_NO_INSTALL", "AGENTS_DECK_CCUSAGE"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(FAKE_HOME);
});

beforeEach(() => {
  spawns.length = 0;
  fake.peak = 0;
  fake.ms = 0;
  fake.fail = false;
});

/** Only the children that are ccusage, since the process-table blocks share
 *  this mock. */
const ccusageSpawns = () => spawns.filter(s => s.file === CCUSAGE);

/** A `since` nobody else in this file uses, so a block never inherits another
 *  block's cache entries. */
let nextRange = 20200101;
const range = () => String(nextRange++);

describe("a flood of distinct ccusage ranges", () => {
  it("starts a bounded number of children and never two at once", async () => {
    // The issue's own reproduction, at twelve rather than thirty. Every call is
    // a distinct key, so none of them can be answered from the cache and none of
    // them can join another's run — this is the case the in-flight guard alone
    // does not cover, and the one that used to be a child per request.
    fake.ms = 20;
    const results = await Promise.all(
      Array.from({ length: 12 }, () => fetchCcusageDaily({ since: range() })),
    );

    const ok = results.filter(r => r.ok);
    const busy = results.filter(r => !r.ok && r.reason === "busy");
    expect(ok.length + busy.length).toBe(12);
    // Four is MAX_OUTSTANDING, which is more ranges than the usage-history modal
    // can have open at once. The other eight are refused before anything is
    // spawned, which is why the spawn count matches the accepted count exactly.
    expect(ok.length).toBe(4);
    expect(busy.length).toBe(8);
    expect(ccusageSpawns().length).toBe(4);
    // And the four that were accepted ran one at a time. Two ccusage runs are
    // two walks of the same directory tree, so a queue costs a concurrent caller
    // nothing it was going to get.
    expect(fake.peak).toBe(1);

    for (const r of busy) {
      expect(String(r.error)).toContain("already being read");
      expect(r.fetchedAt).toEqual(expect.any(Number));
    }
  });

  it("says so in a shape the modal already knows how to draw", async () => {
    // A refusal is not an exception and not an empty chart: it is the same
    // `{ ok: false, reason, error }` every other ccusage failure returns, so the
    // browser needs nothing new to render it.
    fake.ms = 20;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => fetchCcusageDaily({ since: range() })),
    );
    const busy = results.find(r => !r.ok && r.reason === "busy");
    expect(busy).toBeTruthy();
    expect(Object.keys(busy!).sort()).toEqual(["error", "fetchedAt", "ok", "reason"]);
  });
});

describe("two readers asking for the same range", () => {
  it("wait on one child rather than starting a second", async () => {
    fake.ms = 20;
    const since = range();
    const [a, b, c] = await Promise.all([
      fetchCcusageDaily({ since }),
      fetchCcusageDaily({ since }),
      fetchCcusageDaily({ since }),
    ]);
    expect(ccusageSpawns().length).toBe(1);
    // The same object, not merely an equal one — they were one run.
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.ok).toBe(true);
  });

  it("lets ?refresh=1 join a run in progress instead of racing it", async () => {
    // What refresh asks for is a reading newer than the cache. A run that is
    // still going is one, so forcing a second child beside it would buy nothing
    // and cost another ninety-second deadline.
    fake.ms = 20;
    const since = range();
    const [plain, forced] = await Promise.all([
      fetchCcusageDaily({ since }),
      fetchCcusageDaily({ since, force: true }),
    ]);
    expect(ccusageSpawns().length).toBe(1);
    expect(plain).toBe(forced);
  });

  it("still runs again once the first run has finished and been forced", async () => {
    // The dedupe is about overlap, not about suppressing refreshes: a forced
    // fetch after the run has landed is a new reading and a new child.
    const since = range();
    await fetchCcusageDaily({ since });
    expect(ccusageSpawns().length).toBe(1);
    await fetchCcusageDaily({ since });          // cache hit, no child
    expect(ccusageSpawns().length).toBe(1);
    await fetchCcusageDaily({ since, force: true });
    expect(ccusageSpawns().length).toBe(2);
  });
});

describe("the range cache", () => {
  it("forgets the oldest ranges rather than growing for every key asked of it", async () => {
    // Written sequentially, so the queue is never the thing under test here.
    // CACHE_MAX is 32; forty distinct ranges after `first` means only the last
    // thirty-two of those forty can still be held, whatever the map contained
    // when this block started. That makes the assertion independent of the order
    // vitest runs the blocks in.
    const first = range();
    await fetchCcusageDaily({ since: first });
    expect(ccusageSpawns().length).toBe(1);

    let last = "";
    for (let i = 0; i < 40; i++) {
      last = range();
      await fetchCcusageDaily({ since: last });
    }
    expect(ccusageSpawns().length).toBe(41);

    // The most recent range is still remembered — an eviction policy that threw
    // away what somebody is looking at would be a different bug.
    await fetchCcusageDaily({ since: last });
    expect(ccusageSpawns().length).toBe(41);

    // The oldest is not, so asking for it costs a child again. Before #544 this
    // was a cache hit forever, and the map that produced it had no upper bound.
    await fetchCcusageDaily({ since: first });
    expect(ccusageSpawns().length).toBe(42);
  });
});

describe("the process table", () => {
  it("answers concurrent readers from one child, on the Unix path", async () => {
    fake.ms = 20;
    const lists = await Promise.all([
      readProcesses("linux"), readProcesses("linux"), readProcesses("linux"),
      readProcesses("linux"), readProcesses("linux"),
    ]);
    expect(spawns.filter(s => s.file === "ps").length).toBe(1);
    // One reading, handed to everyone who asked for it. A reading is the pair
    // {procs, total} now — the modal behind the section says how many of the
    // machine's processes the candidates are — so identity is what makes the
    // share visible, not the array.
    for (const list of lists) expect(list).toBe(lists[0]);
    expect(lists[0].procs.map((p: { pid: number }) => p.pid)).toEqual([777, 1]);
    expect(lists[0].total).toBe(2);
  });

  it("answers concurrent readers from one child on Windows, which is one baseline", async () => {
    // This is the correctness half. `cpuFromDeltas` reads prevProcCpu, which is
    // one shared pair of module variables; two Get-Process readings taken a
    // second apart and each stored over the other's left the NEXT reading
    // computing its delta against whichever of the two happened to land last.
    // One in-flight run means one reading, so there is only ever one baseline to
    // be right about.
    stopSystemMetrics();          // clear any reading an earlier block left
    fake.ms = 20;
    fake.cpuSec = 10;
    const lists = await Promise.all([
      readProcesses("win32"), readProcesses("win32"), readProcesses("win32"),
    ]);
    expect(spawns.filter(s => s.file.toLowerCase().includes("powershell")).length).toBe(1);
    for (const list of lists) expect(list).toBe(lists[0]);
    // No previous reading yet, so no rate — reported as null rather than as a
    // number invented from the process's whole lifetime.
    for (const row of lists[0].procs) expect(row.cpu).toBe(null);
  });

  it("serves a caller arriving just after a reading rather than spawning again", async () => {
    stopSystemMetrics();
    await readProcesses("linux");
    expect(spawns.filter(s => s.file === "ps").length).toBe(1);
    // Inside PROC_MIN_GAP_MS: this is the second tab, or the second browser, and
    // it is shown the list the first one is already looking at.
    const again = await readProcesses("linux");
    expect(spawns.filter(s => s.file === "ps").length).toBe(1);
    expect(again.procs.length).toBeGreaterThan(0);

    // Past it, and the panel gets a fresh reading. The gap is 1.5s against
    // SystemMeter's 4s poll, so the panel this exists for never once sees a
    // cached list; the clock is moved rather than waited on.
    const real = Date.now;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => real.call(Date) + 5_000);
    try {
      await readProcesses("linux");
    } finally {
      clock.mockRestore();
    }
    expect(spawns.filter(s => s.file === "ps").length).toBe(2);
  });

  it("does not remember a failed read as if it were a reading", async () => {
    // Every failure inside the reader — a spawn that never started, a non-zero
    // exit, the timeout — resolves to an empty array, and no machine has nothing
    // running on it, so an empty list is a failure by construction. Serving one
    // for the next 1.5s would turn a single hiccup into a blank panel that
    // outlives it.
    stopSystemMetrics();
    fake.fail = true;
    const empty = await readProcesses("linux");
    expect(empty.procs).toEqual([]);
    expect(spawns.filter(s => s.file === "ps").length).toBe(1);

    // The next caller tries again immediately rather than being handed the
    // failure for another second and a half.
    fake.fail = false;
    const real = await readProcesses("linux");
    expect(spawns.filter(s => s.file === "ps").length).toBe(2);
    expect(real.procs.length).toBeGreaterThan(0);
  });

  it("still shares one failing child between callers who overlap it", async () => {
    // Not remembering a failure is not the same as abandoning the dedupe: a
    // burst arriving while a read is failing is one failing child, not a burst
    // of them.
    stopSystemMetrics();
    fake.fail = true;
    fake.ms = 20;
    const lists = await Promise.all([
      readProcesses("linux"), readProcesses("linux"), readProcesses("linux"),
    ]);
    expect(spawns.filter(s => s.file === "ps").length).toBe(1);
    for (const list of lists) expect(list.procs).toEqual([]);
  });
});
