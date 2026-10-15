import { describe, expect, it } from "vitest";
import { radarMonitorState } from "../radar-monitor-state";
import type { CaptureSnapshot } from "../use-telemetry-capture";

const idle: CaptureSnapshot = { ok: true, managed: true, enabled: false, sessionId: null, state: "idle", destination: null, interface: null, startedAt: null, expiresAt: null, lastInputAt: null, bytes: 0, issues: {}, events: [] };
const listening: CaptureSnapshot = { ...idle, enabled: true, state: "receiving", sources: [{ destination: "192.0.2.16:4317", interface: "en0", active: true, bytes: 0 }] };
describe("Radar monitoring evidence", () => {
  it("separates reading, disabled monitoring and enabled but unready listeners", () => {
    expect(radarMonitorState(null).title).toBe("Reading monitor…");
    expect(radarMonitorState(idle)).toMatchObject({ enabled: false, active: 0, tone: "neutral", title: "Monitoring stopped" });
    expect(radarMonitorState({ ...idle, enabled: true, state: "awaiting" })).toMatchObject({ title: "Starting monitoring…", tone: "neutral" });
  });
  it("does not confuse an active listener or observed bytes with decoded messages", () => {
    expect(radarMonitorState(listening)).toMatchObject({ tone: "ok", traffic: false, decoded: 0 });
    expect(radarMonitorState({ ...listening, bytes: 20, observations: [{ id: 1, at: 0, destination: "192.0.2.16:4317", source: "192.0.2.10", reason: "joined_midstream" }] })).toMatchObject({ title: "Listening for telemetry", tone: "ok", traffic: true, decoded: 0, observed: 1 });
  });
  it("separates actionable permission issues and retrying from real read errors", () => {
    expect(radarMonitorState({ ...listening, state: "interrupted" })).toMatchObject({ title: "Reconnecting capture…", tone: "attention" });
    expect(radarMonitorState({ ...listening, sources: [{ ...listening.sources![0], active: false, error: "Capture permission is required" }] })).toMatchObject({ title: "Capture permission needed", tone: "attention" });
    expect(radarMonitorState({ ...listening, state: "error" })).toMatchObject({ title: "Capture error", tone: "error" });
    expect(radarMonitorState(listening, true)).toMatchObject({ title: "Monitor connection lost", tone: "error", enabled: true });
  });
  it("keeps stopped history independent of capture readiness", () => {
    expect(radarMonitorState({ ...idle, bytes: 100 })).toMatchObject({ title: "Monitoring stopped", tone: "neutral", traffic: true });
  });
  it("marks partial readiness and names each listener in the source evidence", () => {
    const partial = { ...listening, sources: [...listening.sources!, { destination: "192.0.2.17:4317", interface: "en0", active: false, bytes: 0, error: "Synthetic listener unavailable" }] };
    expect(radarMonitorState(partial)).toMatchObject({ title: "Listening to some destinations", active: 1, tone: "attention", enabled: true });
    expect(radarMonitorState({ ...partial, sources: partial.sources.map(source => ({ ...source, active: true })) })).toMatchObject({ title: "Listening for telemetry", active: 2, tone: "ok" });
  });
});
