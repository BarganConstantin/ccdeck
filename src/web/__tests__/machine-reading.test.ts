// machineReading(): CPU and memory for the account's status frame, and
// nothing else — in particular not notePanelPoll.
//
// systemSnapshot() calls notePanelPoll(), which tells the network section a
// Machine panel is open and so starts the probe that times the API and reads
// the route: the one part of system-metrics that leaves the machine. A frame
// every fifteen seconds that read systemSnapshot would keep that probe running
// on every connected deck with no panel open. So the frame reads
// machineReading, and this holds it to never touching the probe — with
// systemSnapshot beside it as the proof the spy is wired.
import { afterEach, describe, expect, it, vi } from "vitest";

const polls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../server/network-sampler.mjs", async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, notePanelPoll: () => { polls.count += 1; } };
});

// @ts-expect-error — plain .mjs server module, no types
const metrics = await import("../../server/system-metrics.mjs");

afterEach(() => { metrics.stopSystemMetrics(); polls.count = 0; });

describe("machineReading", () => {
  it("never calls notePanelPoll, which starts the network probe", () => {
    metrics.startSystemMetrics({ probe: false });
    for (let i = 0; i < 5; i++) metrics.machineReading();
    expect(polls.count).toBe(0);
    metrics.systemSnapshot();
    expect(polls.count, "the spy is wired: the panel's own read does poll").toBe(1);
  });

  it("is unavailable before sampling starts, and warming up before two CPU samples", () => {
    expect(metrics.machineReading()).toEqual({ cpu: { unknown: "unavailable" }, memory: { unknown: "unavailable" } });
    metrics.startSystemMetrics({ probe: false });
    expect(metrics.machineReading().cpu).toEqual({ unknown: "warming-up" });
  });

  it("reads the panel's own CPU number, with the core count and when it was taken", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      metrics.startSystemMetrics({ probe: false });
      // Real time for the tick counters to move (they count in 10 ms
      // jiffies), then the sampler's 3-second timer.
      const until = performance.now() + 60;
      while (performance.now() < until) { /* spin */ }
      vi.advanceTimersByTime(3_000);
      const r = metrics.machineReading();
      const snap = metrics.systemSnapshot();
      expect(r.cpu).toEqual({ pct: snap.cpu, cores: snap.cores, sampledAt: Date.now() });
      expect(r.cpu.pct).toBeGreaterThanOrEqual(0);
      expect(r.cpu.pct).toBeLessThanOrEqual(100);
      // No load average, by the owner's decision: CPU and memory only.
      expect(Object.keys(r).sort()).toEqual(["cpu", "memory"]);
      expect(JSON.stringify(r)).not.toMatch(/load/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads memory once the first poll has measured it", async () => {
    metrics.startSystemMetrics({ probe: false });
    // The first memory poll runs at start; on Linux it reads /proc/meminfo.
    for (let i = 0; i < 50 && "unknown" in metrics.machineReading().memory; i++) await new Promise(r => setTimeout(r, 20));
    const m = metrics.machineReading().memory;
    if ("unknown" in m) {
      expect(["warming-up", "unavailable"]).toContain(m.unknown);
    } else {
      expect(m.usedPct).toBeGreaterThanOrEqual(0);
      expect(m.usedPct).toBeLessThanOrEqual(100);
      expect(Number.isInteger(m.totalMb) && m.totalMb > 0).toBe(true);
      expect(m.sampledAt).toBeLessThanOrEqual(Date.now());
    }
  });
});
