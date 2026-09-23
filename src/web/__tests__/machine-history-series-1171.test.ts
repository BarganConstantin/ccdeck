// The three history charts nothing ever asked the server for (#1171).
//
// The machine strip draws four groups — cores, memory, load and thermal — out
// of one call, `historySnapshot(group)`. Only `thermal` and `network` were ever
// asked for in a test, so three of the four charts could have come back empty,
// mislabelled or mis-scaled and nothing would have failed.
//
// The load chart carries the most risk of the three because it is the one with
// arithmetic in it. Every other series here is drawn against a fixed 0-100
// track; load is genuinely unbounded — 114 was measured on a twelve-core
// machine — so its top is FITTED, and a fitted top that comes out under the
// peak it is fitted to draws a line out of the top of its own box. `loadTop`
// had zero hits.
//
// HOW THIS RUNS WITHOUT WAITING FOR A MACHINE. `os` is faked so the cores, the
// tick counters and the load average are this file's to choose — a suite's own
// runner is never reliably busy or reliably idle, and a case that needed it to
// be would pass for the wrong reason. The children the sampler spawns and
// `/proc/meminfo` are faked for the same reason, so the same claims are made on
// all three platforms rather than on whichever one happened to answer.
import { describe, it, expect, vi, afterEach } from "vitest";

/** What the faked machine says about itself, changed per case. `tick` is what
 *  makes the CPU counters move: the sampler works in deltas, so two readings
 *  with the same counters are no reading at all. */
const { state } = vi.hoisted(() => ({
  state: { cores: 12, load: [20, 10, 5] as number[], tick: 0, memOk: true },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const faked = {
    ...actual,
    // Idle grows by a fixed 400 per tick and busy time grows by 100 per core
    // index, so core 0 reads 20% busy and the twelfth reads 75% — a machine
    // with one hot core, which is the shape "all cores" alone cannot show and
    // the reason the group has two series.
    cpus: () => Array.from({ length: state.cores }, (_, i) => ({
      model: "fake", speed: 2_400,
      times: { user: 1_000 + state.tick * 100 * (i + 1), nice: 0, sys: 0, irq: 0, idle: 5_000 + state.tick * 400 },
    })),
    loadavg: () => state.load,
    // ONE MACHINE, THREE READS OF IT. `readAvailable` divides by `totalmem()`
    // and takes the numerator from `/proc/meminfo` on Linux, `vm_stat` on
    // macOS and `freemem()` on Windows — three different sources that have to
    // describe the SAME machine, or the percentage this file asserts is a
    // different number per leg.
    //
    // A QUARTER AVAILABLE RATHER THAN A HALF, deliberately. Half would make
    // "used" and "available" the same number, so a read that returned the wrong
    // one of the two would land on the right answer; and the swap fixture below
    // is a quarter USED for the mirror of the same reason, so the two series
    // cannot be swapped without saying so.
    totalmem: () => 16_384_000 * 1024,
    freemem: () => 4_096_000 * 1024,
  };
  return { ...faked, default: faked };
});

/** A `/proc/meminfo` with a quarter of the memory available and a quarter of
 *  the swap in use. Everything else this module reads through `readFile` is
 *  left alone. */
const MEMINFO = [
  "MemTotal:       16384000 kB",
  "MemAvailable:    4096000 kB",
  "SwapTotal:       4096000 kB",
  "SwapFree:        3072000 kB",
].join("\n");
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: unknown, enc: unknown) => {
      if (String(path) === "/proc/meminfo") {
        if (!state.memOk) throw new Error("EACCES");
        return MEMINFO;
      }
      return (actual.readFile as (p: unknown, e: unknown) => Promise<string>)(path, enc);
    },
  };
});

/** The two children the memory reading costs on macOS and on Windows, in the
 *  shapes their parsers were written against. Everything else the sampler
 *  spawns — the thermal probes, the network counters — exits non-zero, which is
 *  what those readings already do on a machine that cannot answer them. */
const VM_STAT = [
  // 1,024,000 reclaimable pages of 4 KiB is the same 4,096,000 KiB the meminfo
  // above reports. `Pages active` is deliberately NOT reclaimable and is here
  // to be ignored — counting it would be the `os.freemem()` mistake #789 is
  // about, in reverse.
  "Mach Virtual Memory Statistics: (page size of 4096 bytes)",
  "Pages free:                          1024000.",
  "Pages active:                        1000000.",
].join("\n");
const SYSCTL_SWAP = "total = 4096.00M  used = 1024.00M  free = 3072.00M  (encrypted)";
const COMMIT_JSON = '{"TotalVirtualMemorySize":4000000,"FreeVirtualMemory":3000000}';
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: (file: string, args: string[]) => {
      const all = `${file} ${(args ?? []).join(" ")}`;
      let out = "";
      if (file === "vm_stat") out = state.memOk ? VM_STAT : "";
      else if (file === "sysctl" && all.includes("vm.swapusage")) out = SYSCTL_SWAP;
      else if (all.includes("Win32_OperatingSystem")) out = COMMIT_JSON;
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        if (out) child.stdout.emit("data", out);
        child.emit("close", out ? 0 : 1);
      });
      return child;
    },
  };
});

import {
  historySnapshot, startSystemMetrics, stopSystemMetrics, systemSnapshot,
  // @ts-expect-error — plain .mjs server module, no types
} from "../../server/system-metrics.mjs";

interface Series { key: string; label: string; unit: string; top: number; warnAt: number | null; points: { t: number; v: number }[] }

/** The three-second tick, taken from the module rather than re-typed, so a
 *  change to the cadence cannot leave these cases sampling nothing. */
const TICK_MS = systemSnapshot().intervalMs as number;

/** A machine sampled three times, from a clean start. Fake timers because the
 *  alternative is nine seconds of waiting per case, and because a bucket is a
 *  minute of wall clock that this then owns. */
async function sampled({ cores = 12, load = [20, 10, 5], memOk = true } = {}) {
  stopSystemMetrics();
  vi.useFakeTimers();
  Object.assign(state, { cores, load, memOk, tick: 0 });
  startSystemMetrics();
  for (let i = 0; i < 3; i++) {
    state.tick += 1;
    await vi.advanceTimersByTimeAsync(TICK_MS);
  }
}

const group = (name: string) => historySnapshot(name).series as Series[];

afterEach(() => { stopSystemMetrics(); vi.useRealTimers(); });

describe("the cores chart", () => {
  it("draws the average and the busiest core against one fixed scale", async () => {
    await sampled();
    const series = group("cores");
    // Two lines, not twelve: twelve in a 620px dialog is a picture nobody can
    // read, and these two answer what the columns cannot answer over time —
    // "all cores" at 20 with "busiest" at 100 is ONE core pinned, which is a
    // different machine from twelve at 20.
    expect(series.map(s => s.key)).toEqual(["cpu:all", "cpu:busiest"]);
    expect(series.map(s => s.label)).toEqual(["All cores", "Busiest core"]);

    for (const s of series) {
      expect(s.unit).toBe("%");
      // FIXED at 100, never fitted: the panel draws the same reading against a
      // 0-100 track, and two pictures of one number that disagree about how
      // alarming it is would be worse than either alone.
      expect(s.top).toBe(100);
      // No bands, deliberately. A CPU at 90% is the machine doing the work you
      // asked for, and an indicator that alarms during the normal case teaches
      // you to stop reading it.
      expect(s.warnAt).toBeNull();
      expect(s.points.length).toBeGreaterThan(0);
    }

    // The faked machine has one core four times busier than the quietest, so
    // the two lines have to differ — otherwise both could be reading the same
    // number under two labels.
    const all = series[0].points.at(-1)!.v;
    const busiest = series[1].points.at(-1)!.v;
    expect(busiest).toBeGreaterThan(all);
    expect(busiest).toBeCloseTo(75, 0);
  });
});

describe("the load chart, whose scale is the only one that is computed", () => {
  it("fits its top to the queue and warns where the queue exceeds the cores", async () => {
    // NOTHING IS SKIPPED ON ANY LEG, the same arrangement loadavg-zero-1028
    // reaches for. Node documents `os.loadavg()` as always [0, 0, 0] on
    // Windows, which is not a reading and is not recorded as one — so there is
    // no load chart there at all. That is the rule rather than a gap, so the
    // Windows leg asserts it instead of standing the case down: a gate here
    // would be a case that only ever runs on two of the three legs, and the
    // register that tracks such gates says why that is worth avoiding.
    if (process.platform === "win32") {
      await sampled();
      expect(group("load"), "Windows drew a chart out of [0, 0, 0]").toEqual([]);
      expect(systemSnapshot().loadavg).toBeNull();
      return;
    }

    for (const [what, cores, load, top, warnAt] of [
      // Twenty queued on twelve cores: rounded up to something a person would
      // choose, and clear of the peak, so the line is inside its own box.
      ["an ordinary busy machine", 12, 20, 30, 12],
      // 114 was measured on a twelve-core machine. A top that stayed on the
      // twenty-scale would draw this line out through the top of the chart.
      ["a machine that is genuinely buried", 12, 114, 150, 12],
      // The other direction, and the reason for the floor: half a job queued on
      // four cores is nothing at all, and a top fitted to the peak alone would
      // draw a quiet machine as a chart full of load.
      ["a quiet machine", 4, 0.5, 10, 4],
    ] as Array<[string, number, number, number, number]>) {
      await sampled({ cores, load: [load, load / 2, load / 4] });
      const [s, ...rest] = group("load");
      // ONE series, not three. 1m, 5m and 15m are three views of one number —
      // the longer two are the short one smoothed — so charting the 1m says
      // everything the others would, at the resolution they hide.
      expect(rest, what).toEqual([]);
      expect(s, what).toMatchObject({ key: "load:1m", label: "Queued work", unit: "" });
      expect(s.points.at(-1)!.v, what).toBe(load);
      expect(s.top, what).toBe(top);
      expect(s.top, `${what}: the peak is outside its own box`).toBeGreaterThan(load);
      // Where the queue exceeds the cores there are to run it, which is the
      // line the section's own note already draws.
      expect(s.warnAt, what).toBe(warnAt);
    }
  });
});

describe("the memory chart", () => {
  /** The same machine, read the way each platform reads it, from any machine.
   *  `process.platform` is restored before the assertions run so a failure
   *  reports under the real one. */
  async function on(platform: string, opts: Parameters<typeof sampled>[0] = {}) {
    const was = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      await sampled(opts);
      // Read inside the stub too: `seriesFor` asks the platform for the swap
      // series' label.
      return { series: group("memory"), snapshot: systemSnapshot() };
    } finally {
      Object.defineProperty(process, "platform", was);
    }
  }

  it("draws what is in use and what has been paged out, with one band, on every platform", async () => {
    // ONE MACHINE, THREE READS OF IT, AND ALL THREE DRIVEN FROM HERE. The three
    // branches of `readAvailable` and `readSwap` take their numbers from
    // `/proc/meminfo`, `vm_stat` plus `sysctl`, and `freemem()` plus a WMI
    // query — so a leg is the only thing that decides which arithmetic runs,
    // and a fixture that describes a different machine per leg is a percentage
    // that means something different per leg. Stubbing the platform runs all
    // three from one runner, which is how the Linux mismatch in the first
    // version of this file was found.
    for (const [platform, swapLabel] of [
      ["linux", "Swap"], ["darwin", "Swap"],
      // `Swap` is `Commit` on Windows: commit charge is a different mechanism,
      // and borrowing the Unix word for it would be a claim about how the
      // machine works. The KEY stays `mem:swap` on all three, so nothing joins
      // on what the eye sees.
      ["win32", "Commit"],
    ] as Array<[string, string]>) {
      const { series } = await on(platform);
      expect(series.map(s => s.key), platform).toEqual(["mem:physical", "mem:swap"]);
      expect(series.map(s => s.label), platform).toEqual(["Physical", swapLabel]);
      for (const s of series) {
        expect(s.unit, platform).toBe("%");
        expect(s.top, platform).toBe(100);
        // ONE band, not two. A `critAt` of 100 draws a rule along the top of a
        // chart whose scale ends at 100 — the ceiling, drawn again in red,
        // saying nothing the edge did not.
        expect(s.warnAt, platform).toBe(90);
        expect(s.points.length, platform).toBeGreaterThan(0);
      }
      // Three quarters used and a quarter paged out, exactly, on all three —
      // not "about": the fixtures describe one machine, so a platform that
      // landed elsewhere read a different field or divided the other way up.
      expect(series[0].points.at(-1)!.v, `${platform} physical`).toBe(75);
      expect(series[1].points.at(-1)!.v, `${platform} swap`).toBe(25);
    }
  });

  // #789, driven rather than pinned by a regex. `record` folds a minute by
  // MAXIMUM, so one failed poll that recorded a guess painted a red 99% peak on
  // the chart that survived every good sample for the next twenty-four hours.
  // The failure is ordinary — a spawn that hit EAGAIN under fork pressure, a
  // non-zero exit, the 2s deadline — and there are 2,880 chances a day.
  it("records nothing at all for a poll that could not measure", async () => {
    for (const platform of ["linux", "darwin"]) {
      const { series, snapshot } = await on(platform, { memOk: false });
      expect(series.find(s => s.key === "mem:physical"), platform)
        .toBeUndefined();
      // And the meter keeps its last reading rather than going red: there was
      // never one here, so it stays empty.
      expect(snapshot.memory, platform).toBeNull();
    }

    // Windows has nothing to fail. That branch answers `os.freemem()`, which is
    // the measurement rather than a substitute for one — so the same "failing"
    // poll still produces a reading there, and that is the rule rather than a
    // gap in this case.
    const win = await on("win32", { memOk: false });
    expect(win.series.find(s => s.key === "mem:physical")).toBeDefined();
    expect(win.snapshot.memory).not.toBeNull();
  });
});
