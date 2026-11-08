import { afterEach, describe, expect, it } from "vitest";
import { readWindowsThermal, throttleFromWindows } from "../../server/thermal-metrics.mjs";
import { sampleThermal, stopThermal, thermalSnapshot } from "../../server/thermal-sampler.mjs";
import { attentionFlag, throttleRow } from "../machine-readings";

const output = (...v: unknown[]) => JSON.stringify({ cpuLimit: v.map(v => ({ v })) });
const deps = (printed: string) => ({ powershell: async () => printed, hwMonitor: async () => ({}) });
afterEach(() => stopThermal());

describe("Windows CPU performance limits without thermal sensors", () => {
  it("shows a real counter even when neither temperature source answers", async () => {
    const r = await readWindowsThermal(null, deps(output(100)));
    expect(r).toEqual({ celsius: [], throttle: { speedLimit: 100, source: "windows-performance" } });
    await sampleThermal({ read: async () => r });
    expect(thermalSnapshot()?.throttle).toEqual(r.throttle);
  });

  it("preserves the most limited core, including a fully held processor", () => {
    expect(throttleFromWindows(output(100, 62, 90))?.speedLimit).toBe(62);
    expect(throttleFromWindows(output(0, 100))?.speedLimit).toBe(0);
    expect(throttleFromWindows(output(150))?.speedLimit).toBe(100);
  });

  it("does not turn missing, malformed or inaccessible counters into zero", async () => {
    for (const text of ["", "bad json", "null", "{}", output(), output(null, "62", -1)]) {
      expect(throttleFromWindows(text)).toBeNull();
      expect(await readWindowsThermal(null, deps(text))).toBeNull();
    }
  });

  it("keeps temperatures alongside the independent performance limit", async () => {
    const r = await readWindowsThermal(null, { ...deps(output(70)), hwMonitor: async () => ({ cpu: 80 }) });
    expect(r.celsius[0]).toMatchObject({ label: "CPU", celsius: 80 });
    expect(r.throttle.speedLimit).toBe(70);
  });

  it("does not describe a power-policy limit as overheating or claim to measure turbo speed", () => {
    const throttle = { speedLimit: 62, source: "windows-performance" as const };
    expect(throttleRow(throttle)).toMatchObject({ pct: 38, value: "38%", note: "Windows CPU limit: 62% of nominal performance" });
    expect(attentionFlag({ thermal: { celsius: [], throttle }, memory: null, network: null }))
      .toBe("Windows CPU limit: 62% of nominal performance");
    expect(throttleRow({ ...throttle, speedLimit: 100 }).note).toBe("Windows reports no CPU cap below nominal performance");
    expect(throttleRow({ ...throttle, speedLimit: 100 }, { peak: 38, lastMs: 0 }, 60_000).note)
      .toContain("Windows CPU limit was 62%");
  });
});
