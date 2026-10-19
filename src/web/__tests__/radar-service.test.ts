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
  };
  const preferences = { read: vi.fn(async () => stored), write: vi.fn(async (_: number, value: unknown) => { stored = value; }) };
  const discover = vi.fn(async () => collector);
  const service = createRadarService({ capture, preferences, discover }); clean.push(() => service.dispose());
  return { service, capture, preferences, discover, stored: () => stored };
}
describe("automatic Radar service", () => {
  it("defaults on and starts capture without an open modal or Start action", async () => {
    const t = setup(); await t.service.resume(4329);
    expect(t.capture.prepare).toHaveBeenCalledWith(["192.0.2.16:4317"], 4329);
    expect(t.service.read()).toMatchObject({ automatic: true, featureEnabled: true, enabled: true });
    expect(t.stored()).toEqual({ enabled: true, destinations: ["192.0.2.16:4317"] });
  });
  it("waits for a collector and automatically captures it when it appears", async () => {
    const t = setup(); t.discover.mockResolvedValueOnce({ config: { variables: [] }, connections: [] });
    await t.service.resume(4329); expect(t.capture.prepare).not.toHaveBeenCalled();
    expect((await t.service.settings()).enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); expect(t.capture.prepare).toHaveBeenCalledTimes(1);
  });
  it("stops discovery and capture when disabled and respects the saved opt-out after restart", async () => {
    const t = setup(); await t.service.resume(4329); await t.service.setEnabled(false);
    const calls = t.discover.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(t.discover).toHaveBeenCalledTimes(calls);
    expect(t.service.read()).toMatchObject({ featureEnabled: false, enabled: false });
    const next = setup(t.stored()); await next.service.resume(4329);
    expect(next.discover).not.toHaveBeenCalled(); expect(next.capture.prepare).not.toHaveBeenCalled();
    await next.service.setEnabled(true); await vi.advanceTimersByTimeAsync(0);
    expect(next.capture.prepare).toHaveBeenCalledTimes(1);
  });
  it("retries setup failures while preserving the enabled preference", async () => {
    const t = setup(); t.capture.prepare.mockRejectedValueOnce(new CaptureSetupError("Packet capture permission is required."));
    await t.service.resume(4329);
    expect(t.service.read()).toMatchObject({ featureEnabled: true, state: "error", setupError: "Packet capture permission is required." });
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.service.read()).toMatchObject({ enabled: true, setupError: null });
  });
  it("does not resurrect capture when disabled during discovery", async () => {
    const t = setup(); let release!: (value: unknown) => void;
    t.discover.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const boot = t.service.resume(4329); await vi.advanceTimersByTimeAsync(0);
    await t.service.setEnabled(false); release(collector); await boot;
    expect(t.capture.prepare).not.toHaveBeenCalled(); expect(t.service.read().enabled).toBe(false);
    expect(t.stored().enabled).toBe(false);
  });
  it("cancels a slow setup that completes after Radar was disabled", async () => {
    const t = setup(); let release!: () => void;
    t.capture.prepare.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    const boot = t.service.resume(4329); await vi.advanceTimersByTimeAsync(0);
    await t.service.setEnabled(false); release(); await boot;
    expect(t.capture.stop).toHaveBeenCalledTimes(2); expect(t.service.read().featureEnabled).toBe(false);
    expect(t.stored().enabled).toBe(false);
  });
  it("rolls back the feature switch if its preference cannot be saved", async () => {
    const t = setup(); await t.service.resume(4329);
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
