import { afterEach, describe, expect, it, vi } from "vitest";
import { createRadarService, radarTargets, resolveCollector } from "../../server/traffic-radar-service.mjs";
import { CaptureSetupError } from "../../server/traffic-radar-platform.mjs";
const collector = { config: { variables: [] }, connections: [{ active: true, destination: "192.0.2.16:4317" }] };
const nothing = { config: { variables: [] }, connections: [] };
const clean: (() => void)[] = [];
afterEach(() => { clean.splice(0).forEach(f => f()); vi.useRealTimers(); });
function setup(saved: any = null, { resumed = [] as string[] } = {}) {
  vi.useFakeTimers();
  let active = false, sources: any[] = [], stored = saved;
  const capture = {
    read: () => ({ enabled: active, state: active ? "capturing" : "idle", sources, events: [] }),
    prepare: vi.fn(async (targets: string[]) => { active = true; sources = targets.map(destination => ({ destination })); }),
    stop: vi.fn(async () => { active = false; }), dispose: vi.fn(() => { active = false; }),
    // The monitor's own record (radar-monitor-<port>.json): a monitor started by
    // hand in an earlier release comes back running.
    resume: vi.fn(async () => { if (resumed.length) { active = true; sources = resumed.map(destination => ({ destination })); } }),
  };
  const preferences = { read: vi.fn(async () => stored), write: vi.fn(async (_: number, value: unknown) => { stored = value; }) };
  const discover = vi.fn(async () => collector);
  const resolve = vi.fn(async (_: string) => null as string | null);
  const service = createRadarService({ capture, preferences, discover, resolve }); clean.push(() => service.dispose());
  return { service, capture, preferences, discover, resolve, stored: () => stored, down: () => { active = false; } };
}

// The owner, 2026-10-23: Radar monitors by itself, always. There is no switch
// and no Start, so nothing a deck saved — not v3.44.0's `automatic: false`, not
// an older record — keeps it off.
describe("Radar monitors by itself, with no switch", () => {
  it("starts discovery and capture on resume, with nothing open and nothing saved", async () => {
    const t = setup(); await t.service.resume(4329);
    expect(t.discover).toHaveBeenCalledTimes(1);
    expect(t.capture.prepare).toHaveBeenCalledWith(["192.0.2.16:4317"], 4329);
    expect(t.service.read()).toMatchObject({ automatic: true, featureEnabled: true, enabled: true, setupError: null });
    expect(t.stored()).toEqual({ destinations: ["192.0.2.16:4317"] });
  });
  it("ignores whatever an earlier release saved about being off", async () => {
    for (const saved of [{ automatic: false, destinations: [] }, {}, { automatic: "true" }, { enabled: false }]) {
      const t = setup(saved); await t.service.resume(4329);
      expect(t.capture.prepare, JSON.stringify(saved)).toHaveBeenCalledWith(["192.0.2.16:4317"], 4329);
      expect(t.stored()).toEqual({ destinations: ["192.0.2.16:4317"] });
      clean.splice(0).forEach(f => f());
    }
  });
  it("goes back to the collectors it remembered, beside the ones it sees", async () => {
    const t = setup({ automatic: false, destinations: ["192.0.2.20:4317", "not an address"] }); await t.service.resume(4329);
    expect(t.capture.prepare).toHaveBeenCalledWith(["192.0.2.16:4317", "192.0.2.20:4317"], 4329);
  });
  it("waits for a collector and captures it when it appears", async () => {
    const t = setup(); t.discover.mockResolvedValueOnce(nothing);
    await t.service.resume(4329); expect(t.capture.prepare).not.toHaveBeenCalled();
    expect(t.service.read()).toMatchObject({ automatic: true, enabled: false, state: "idle" });
    await vi.advanceTimersByTimeAsync(5000); expect(t.capture.prepare).toHaveBeenCalledTimes(1);
  });
  it("takes a monitor started by hand as the place to look when no setting names a collector", async () => {
    const t = setup(null, { resumed: ["192.0.2.30:4317"] }); t.discover.mockResolvedValue(nothing);
    await t.service.resume(4329);
    expect(t.capture.resume).toHaveBeenCalledWith(4329);
    // Already running on it: nothing to set up again.
    expect(t.capture.prepare).not.toHaveBeenCalled();
    t.down(); await vi.advanceTimersByTimeAsync(60_000);
    expect(t.capture.prepare).toHaveBeenCalledWith(["192.0.2.30:4317"], 4329);
  });
});

describe("what discovery costs a deck nobody is looking at", () => {
  it("looks every minute while Radar is closed, and every five seconds while it is open", async () => {
    const t = setup(); await t.service.resume(4329);
    expect(t.discover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(55_000); expect(t.discover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000); expect(t.discover).toHaveBeenCalledTimes(2);
    // Radar opens: the page reads the capture, and discovery keeps pace with it.
    t.service.read();
    await vi.advanceTimersByTimeAsync(5_000); expect(t.discover).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5_000); expect(t.discover).toHaveBeenCalledTimes(4);
    // Fifteen seconds without a read: closed again, back to once a minute.
    await vi.advanceTimersByTimeAsync(5_000); expect(t.discover).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(40_000); expect(t.discover).toHaveBeenCalledTimes(4);
  });
  it("looks at once when Radar opens after a quiet stretch, rather than waiting out the minute", async () => {
    const t = setup(); await t.service.resume(4329);
    await vi.advanceTimersByTimeAsync(20_000); expect(t.discover).toHaveBeenCalledTimes(1);
    t.service.read(); await vi.advanceTimersByTimeAsync(0);
    expect(t.discover).toHaveBeenCalledTimes(2);
  });
});

describe("finding the collector", () => {
  it("looks up a collector named by host and captures the address it has", async () => {
    const t = setup(); t.resolve.mockResolvedValue("192.0.2.40:4317");
    t.discover.mockResolvedValue({ config: { variables: [{ key: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://otel.example.com:4317" }] }, connections: [] });
    await t.service.resume(4329);
    expect(t.resolve).toHaveBeenCalledWith("otel.example.com:4317");
    expect(t.capture.prepare).toHaveBeenCalledWith(["192.0.2.40:4317"], 4329);
  });
  it("ignores a name that does not resolve, and waits", async () => {
    const t = setup();
    t.discover.mockResolvedValue({ config: { variables: [{ key: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://nowhere.invalid:4317" }] }, connections: [] });
    await t.service.resume(4329);
    expect(t.resolve).toHaveBeenCalledTimes(1);
    expect(t.capture.prepare).not.toHaveBeenCalled();
  });
  it("never treats arbitrary API HTTPS or IPv6 sockets as an IPv4 OTLP collector", () => {
    expect(radarTargets({ connections: [{ active: true, destination: "160.79.104.10:443" }, { active: true, destination: "[::1]:4317" }] }).observed).toEqual([]);
    expect(radarTargets({ connections: [{ active: true, connecting: true, destination: "192.0.2.16:4317" }, { active: false, destination: "192.0.2.17:4317" }] }).observed).toEqual([]);
    expect(radarTargets({ config: { variables: [{ key: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://192.0.2.99:4317" }] } }).configured).toEqual(["192.0.2.99:4317"]);
  });
  it("sorts endpoints into addresses, names to look up and neither", () => {
    const variables = [
      { key: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://192.0.2.99:4317" },
      { key: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", value: "https://otel.example.com" },
      { key: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", value: "http://[2001:db8::1]:4317" },
      { key: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", value: "grpc://otel.example.com:4317" },
      { key: "OTEL_EXPORTER_OTLP_HEADERS", value: "http://headers.example.com" },
      { key: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "not a url" },
    ];
    expect(radarTargets({ config: { variables } })).toEqual({ configured: ["192.0.2.99:4317"], named: ["otel.example.com:443"], observed: [] });
    // A running Claude's launch environment counts as settings do.
    expect(radarTargets({ environment: [{ key: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://collector.local:4318" }] }).named).toEqual(["collector.local:4318"]);
  });
});

describe("resolveCollector", () => {
  it("answers the IPv4 address a name has, with its port", async () => {
    const find = vi.fn(async () => ({ address: "192.0.2.50", family: 4 }));
    expect(await resolveCollector("otel.example.com:4317", find)).toBe("192.0.2.50:4317");
    expect(find).toHaveBeenCalledWith("otel.example.com", { family: 4 });
  });
  it("answers nothing for a failed lookup, a hung one or an address that is not IPv4", async () => {
    expect(await resolveCollector("otel.example.com:4317", async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); })).toBeNull();
    expect(await resolveCollector("otel.example.com:4317", () => new Promise(() => {}), 10)).toBeNull();
    expect(await resolveCollector("otel.example.com:4317", async () => ({ address: "::1", family: 6 }))).toBeNull();
  });
});

describe("setup that fails, finishes late or is asked again", () => {
  it("shows a setup failure and retries it", async () => {
    const t = setup(); t.capture.prepare.mockRejectedValueOnce(new CaptureSetupError("Packet capture permission is required."));
    await t.service.resume(4329);
    expect(t.service.read()).toMatchObject({ featureEnabled: true, state: "error", setupError: "Packet capture permission is required." });
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.service.read()).toMatchObject({ enabled: true, setupError: null });
  });
  it("names an unexpected failure without its details", async () => {
    const t = setup(); t.capture.prepare.mockRejectedValueOnce(new Error("spawn EINVAL /secret/path"));
    await t.service.resume(4329);
    expect(t.service.read().setupError).toBe("Monitoring setup failed. Retrying automatically.");
  });
  it("stops a setup that lands after the deck shut the service down, with nothing saved to resume", async () => {
    const t = setup(); let release!: () => void;
    t.capture.prepare.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    const boot = t.service.resume(4329); await vi.advanceTimersByTimeAsync(0);
    t.service.dispose(); release(); await boot;
    expect(t.capture.dispose).toHaveBeenCalledTimes(1);
    expect(t.capture.stop.mock.calls.at(-1)).toEqual(["stopped", false]);
    expect(t.preferences.write).not.toHaveBeenCalled();
    const calls = t.discover.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.discover).toHaveBeenCalledTimes(calls);
  });
  it("starts capture again on the same collectors when permission was just granted", async () => {
    const t = setup(); await t.service.resume(4329);
    expect(t.capture.prepare).toHaveBeenCalledTimes(1);
    await t.service.retry();
    expect(t.capture.prepare).toHaveBeenCalledTimes(2);
    expect(t.capture.prepare.mock.calls[1]).toEqual([["192.0.2.16:4317"], 4329]);
  });
  it("looks for a collector when permission is granted before capture had one", async () => {
    const t = setup(); t.discover.mockResolvedValueOnce(nothing);
    await t.service.resume(4329); expect(t.capture.prepare).not.toHaveBeenCalled();
    await t.service.retry();
    expect(t.discover).toHaveBeenCalledTimes(2);
    expect(t.capture.prepare).toHaveBeenCalledWith(["192.0.2.16:4317"], 4329);
  });
  it("shows a retry that still cannot set up", async () => {
    const t = setup(); await t.service.resume(4329);
    t.capture.prepare.mockRejectedValueOnce(new CaptureSetupError("Install tcpdump to capture traffic. Configuration and file inspection work without it."));
    await t.service.retry();
    expect(t.service.read().setupError).toMatch(/^Install tcpdump/);
  });
});
