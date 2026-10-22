import { afterEach, describe, expect, it, vi } from "vitest";
import { createRadarService, radarTargets } from "../../server/traffic-radar-service.mjs";
import { CaptureSetupError } from "../../server/traffic-radar-platform.mjs";
const collector = { config: { variables: [] }, connections: [{ active: true, destination: "192.0.2.16:4317" }] };
const clean: (() => void)[] = [];
afterEach(() => { clean.splice(0).forEach(f => f()); vi.useRealTimers(); });
function setup(saved: any = null) {
  vi.useFakeTimers();
  let active = false, sources: any[] = [], stored = saved;
  const capture = {
    read: () => ({ enabled: active, state: active ? "capturing" : "idle", sources, events: [] }),
    prepare: vi.fn(async (targets: string[]) => { active = true; sources = targets.map(destination => ({ destination })); }),
    stop: vi.fn(async () => { active = false; }), dispose: vi.fn(() => { active = false; }),
    // The monitor's own opt-in, which the service hands back to while automatic monitoring is off.
    resume: vi.fn(async () => {}),
  };
  const preferences = { read: vi.fn(async () => stored), write: vi.fn(async (_: number, value: unknown) => { stored = value; }) };
  const discover = vi.fn(async () => collector);
  const service = createRadarService({ capture, preferences, discover }); clean.push(() => service.dispose());
  return { service, capture, preferences, discover, stored: () => stored };
}
const ON = { automatic: true, destinations: [] };
describe("automatic Radar service", () => {
  it("once switched on, starts capture without an open modal or Start action", async () => {
    const t = setup(); await t.service.resume(4329);
    await t.service.setEnabled(true); await vi.advanceTimersByTimeAsync(0);
    expect(t.capture.prepare).toHaveBeenCalledWith(["192.0.2.16:4317"], 4329);
    expect(t.service.read()).toMatchObject({ automatic: true, featureEnabled: true, enabled: true });
    expect(t.stored()).toEqual({ automatic: true, destinations: ["192.0.2.16:4317"] });
  });
  it("waits for a collector and automatically captures it when it appears", async () => {
    const t = setup(ON); t.discover.mockResolvedValueOnce({ config: { variables: [] }, connections: [] });
    await t.service.resume(4329); expect(t.capture.prepare).not.toHaveBeenCalled();
    expect((await t.service.settings()).enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); expect(t.capture.prepare).toHaveBeenCalledTimes(1);
  });
  it("stops discovery and capture when disabled and respects the saved opt-out after restart", async () => {
    const t = setup(ON); await t.service.resume(4329); await t.service.setEnabled(false);
    const calls = t.discover.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(t.discover).toHaveBeenCalledTimes(calls);
    expect(t.service.read()).toMatchObject({ automatic: false, enabled: false });
    expect(t.service.read().featureEnabled).toBeUndefined();
    expect(t.stored()).toMatchObject({ automatic: false });
    const next = setup(t.stored()); await next.service.resume(4329);
    expect(next.discover).not.toHaveBeenCalled(); expect(next.capture.prepare).not.toHaveBeenCalled();
    await next.service.setEnabled(true); await vi.advanceTimersByTimeAsync(0);
    expect(next.capture.prepare).toHaveBeenCalledTimes(1);
  });
  it("retries setup failures while preserving the enabled preference", async () => {
    const t = setup(ON); t.capture.prepare.mockRejectedValueOnce(new CaptureSetupError("Packet capture permission is required."));
    await t.service.resume(4329);
    expect(t.service.read()).toMatchObject({ featureEnabled: true, state: "error", setupError: "Packet capture permission is required." });
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.service.read()).toMatchObject({ enabled: true, setupError: null });
  });
  it("does not resurrect capture when disabled during discovery", async () => {
    const t = setup(ON); let release!: (value: unknown) => void;
    t.discover.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const boot = t.service.resume(4329); await vi.advanceTimersByTimeAsync(0);
    await t.service.setEnabled(false); release(collector); await boot;
    expect(t.capture.prepare).not.toHaveBeenCalled(); expect(t.service.read().enabled).toBe(false);
    expect(t.stored().automatic).toBe(false);
  });
  it("cancels a slow setup that completes after Radar was disabled", async () => {
    const t = setup(ON); let release!: () => void;
    t.capture.prepare.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    const boot = t.service.resume(4329); await vi.advanceTimersByTimeAsync(0);
    await t.service.setEnabled(false); release(); await boot;
    expect(t.capture.stop).toHaveBeenCalledTimes(2); expect(t.service.read().automatic).toBe(false);
    expect(t.stored().automatic).toBe(false);
    // Stopped with the monitor's own opt-in saved off, so nothing resumes after a restart.
    expect(t.capture.stop.mock.calls.at(-1)).toEqual(["stopped", true]);
  });
  it("rolls back the feature switch if its preference cannot be saved", async () => {
    const t = setup(ON); await t.service.resume(4329);
    t.preferences.write.mockRejectedValueOnce(new Error("Read-only file"));
    await expect(t.service.setEnabled(false)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect((await t.service.settings()).enabled).toBe(true);
    expect(t.service.read().enabled).toBe(true);
  });
  it("never treats arbitrary API HTTPS or IPv6 sockets as an IPv4 OTLP collector", () => {
    expect(radarTargets({ connections: [{ active: true, destination: "160.79.104.10:443" }, { active: true, destination: "[::1]:4317" }] }).observed).toEqual([]);
    expect(radarTargets({ config: { variables: [{ key: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://192.0.2.99:4317" }] } }).configured).toEqual(["192.0.2.99:4317"]);
  });
});

// The owner's rule for v3.44.0: automatic monitoring is OFF until someone turns
// it on. A fresh deck and one upgraded from 3.43.4 (which never wrote this
// switch) look for no collector, start nothing and retry nothing; the monitor
// keeps the opt-in it always had, handed back to it untouched.
describe("automatic monitoring stays off until someone turns it on", () => {
  const offAndQuiet = async (t: ReturnType<typeof setup>) => {
    await t.service.resume(4329);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.discover).not.toHaveBeenCalled();
    expect(t.capture.prepare).not.toHaveBeenCalled();
    expect(t.preferences.write).not.toHaveBeenCalled();
    expect(t.capture.resume).toHaveBeenCalledTimes(1);
    expect(t.capture.resume).toHaveBeenCalledWith(4329);
    expect(await t.service.settings()).toEqual({ ok: true, enabled: false, setupError: null });
    expect(t.service.read()).toMatchObject({ automatic: false, enabled: false, state: "idle" });
    expect(t.service.read().featureEnabled).toBeUndefined();
  };
  it("on a fresh deck, with nothing saved", async () => { await offAndQuiet(setup(null)); });
  it("on a deck upgraded from 3.43.4, whatever else its saved files say", async () => {
    // 3.43.4 wrote no automatic switch. Neither a monitor-shaped record nor a
    // development build's `enabled` turns automatic monitoring on.
    for (const saved of [{}, { enabled: true, destinations: ["192.0.2.16:4317"] }, { automatic: "true" }, { automatic: 1 }]) {
      await offAndQuiet(setup(saved));
      clean.splice(0).forEach(f => f());
    }
  });
  it("and a manual Start in the Monitor view stays the monitor's own, with no discovery or retry", async () => {
    const t = setup(null); await t.service.resume(4329);
    await t.service.prepare(["192.0.2.20:4317"], 4329);
    expect(t.capture.prepare).toHaveBeenCalledWith(["192.0.2.20:4317"], 4329);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.discover).not.toHaveBeenCalled();
    expect(t.capture.prepare).toHaveBeenCalledTimes(1);
    expect(t.preferences.write).not.toHaveBeenCalled();
    await t.service.stop();
    expect(t.capture.stop).toHaveBeenCalledTimes(1);
    expect((await t.service.settings()).enabled).toBe(false);
  });
  it("turns on and off on request, and each choice survives a restart", async () => {
    const t = setup(null); await t.service.resume(4329);
    expect(await t.service.setEnabled(true)).toEqual({ ok: true, enabled: true, setupError: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.stored()).toEqual({ automatic: true, destinations: ["192.0.2.16:4317"] });
    expect(t.capture.prepare).toHaveBeenCalledTimes(1);
    const on = setup(t.stored()); await on.service.resume(4329);
    expect(on.capture.resume).not.toHaveBeenCalled();
    expect(on.capture.prepare).toHaveBeenCalledWith(["192.0.2.16:4317"], 4329);
    expect(await on.service.setEnabled(false)).toEqual({ ok: true, enabled: false, setupError: null });
    expect(on.stored()).toEqual({ automatic: false, destinations: ["192.0.2.16:4317"] });
    const calls = on.discover.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(on.discover).toHaveBeenCalledTimes(calls);
    const off = setup(on.stored()); await off.service.resume(4329);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(off.discover).not.toHaveBeenCalled(); expect(off.capture.prepare).not.toHaveBeenCalled();
    expect((await off.service.settings()).enabled).toBe(false);
  });
  it("looks first at a monitor started by hand when it is turned on", async () => {
    const t = setup(null); t.discover.mockResolvedValue({ config: { variables: [] }, connections: [] });
    await t.service.resume(4329);
    await t.service.prepare(["192.0.2.30:4317"], 4329);
    await t.service.setEnabled(true); await vi.advanceTimersByTimeAsync(0);
    expect(t.stored()).toEqual({ automatic: true, destinations: ["192.0.2.30:4317"] });
    expect(t.capture.prepare).toHaveBeenCalledTimes(1);
  });
});
