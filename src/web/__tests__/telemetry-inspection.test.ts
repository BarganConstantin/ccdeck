import { describe, expect, it } from "vitest";
import { captureAddress, configuredState, parseTelemetryFile } from "../telemetry-inspection";
import { exportSummary } from "../../server/traffic-radar-capture.mjs";
import { LOGS } from "./traffic-capture-fixture.mjs";
describe("telemetry session attribution and file inspection", () => {
  it("uses captured session IDs rather than guessing from a destination", () => {
    expect(exportSummary(LOGS, "logs").sessionIds).toEqual(["fixture-session"]);
    expect(exportSummary({ resourceLogs: [] }, "logs").sessionIds).toEqual([]);
  });
  it("collects metric datapoint and resource session IDs and keeps mixed exports explicit", () => {
    const attribute = (id: string) => ({ key: "session.id", value: { stringValue: id } });
    const payload = { resourceMetrics: [{ resource: { attributes: [attribute("one")] }, scopeMetrics: [{ metrics: [{ name: "usage", sum: { dataPoints: [{ attributes: [attribute("two"), attribute("one")] }] } }] }] }] };
    expect(exportSummary(payload, "metrics").sessionIds).toEqual(["one", "two"]);
  });
  it("preserves original JSONL numbers, line numbers and malformed rows", () => {
    const rows = parseTelemetryFile('\n{"session_id":"one","count":9223372036854775806}\ninvalid\n');
    expect(rows.map(r => r.line)).toEqual([2, 3]); expect(rows[0].raw).toContain("9223372036854775806");
    expect(rows[0].sessionIds).toEqual(["one"]); expect(rows[1].valid).toBe(false);
  });
  it("reads a complete OTLP JSON document and its nested session IDs", () => {
    const rows = parseTelemetryFile(JSON.stringify(LOGS, null, 2));
    expect(rows).toHaveLength(1); expect(rows[0].sessionIds).toEqual(["fixture-session"]);
  });
  it("handles empty and bounded inputs", () => {
    expect(parseTelemetryFile("  ")).toEqual([]);
    expect(() => parseTelemetryFile('{}\n'.repeat(10001))).toThrow("10,000");
  });
  it("marks conflicting settings instead of selecting an arbitrary source", () => {
    expect(configuredState([{ key: "CLAUDE_CODE_ENABLE_TELEMETRY", value: "Enabled", source: "User settings" }, { key: "CLAUDE_CODE_ENABLE_TELEMETRY", value: "Disabled", source: "Managed settings" }])).toBe("Conflicting settings");
    expect(configuredState([])).toBe("Unknown");
  });
  it("extracts IPv4 capture addresses without pretending hostnames are resolved", () => {
    expect(captureAddress("http://192.0.2.16:4317")).toBe("192.0.2.16:4317");
    expect(captureAddress("https://collector.example")).toBeNull();
  });
});
