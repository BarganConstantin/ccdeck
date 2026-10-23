import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { connectionLabel, type RadarSnapshot, type RadarVariable } from "../traffic-radar";
import { configuredState } from "../telemetry-inspection";
import { Configuration, TrafficRadarView } from "../components/TrafficRadar";
import { TelemetryCapture } from "../components/TelemetryCapture";
import type { CaptureSnapshot } from "../use-telemetry-capture";

// React separates adjacent text with comments; the assertions read the text a person sees.
const html = (element: React.ReactElement) => renderToStaticMarkup(element).replace(/<!-- -->/g, "");
const snapshot: RadarSnapshot = { ok: true, sampledAt: 1700000000000, platform: "linux", pollMs: 5000, status: "observing", processCount: 1, connections: [], alerts: [], config: { sources: [{ name: "User settings", status: "read" }], variables: [] } };
const connection = { pid: 7, destination: "192.0.2.16:4317", workspace: "~/project", firstSeenAt: 0, lastSeenAt: 0, active: true };
const launch: RadarVariable[] = [
  { key: "CLAUDE_CODE_ENABLE_TELEMETRY", value: "Enabled", rawValue: "1", source: "Process launch environment · PID 7", editable: false, launch: true },
  { key: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://192.0.2.16:4317", source: "Process launch environment · PID 7", launch: true },
];

describe("Linux connection attempts in the inspector", () => {
  it("labels attempts with no reply apart from active and earlier connections", () => {
    expect(connectionLabel({ active: true, connecting: true })).toBe("Connecting · no reply yet");
    expect(connectionLabel({ active: false, connecting: true })).toBe("Attempted · no reply seen");
    expect(connectionLabel({ active: true })).toBe("Active connection");
    expect(connectionLabel({ active: false })).toBe("Previously observed");
    expect(connectionLabel({ active: null })).toBe("Visibility unavailable");
    expect(connectionLabel({ active: true, connecting: true }, true)).toBe("Visibility unavailable");
  });

  it("lists an attempt in Configuration without calling it an observed connection", () => {
    const attempt = { ...snapshot, connections: [{ ...connection, connecting: true as const }] };
    const markup = html(<TrafficRadarView snapshot={attempt} />);
    expect(markup).toContain("Connecting · no reply yet");
    expect(markup).not.toContain("Claude connections observed");
  });

  it("shows a configured collector's pending attempt in Monitor", () => {
    // Before capture names a source: the collector the launch environment
    // names is what the connection is matched against. No picker offers it —
    // the deck monitors it by itself.
    const capture: CaptureSnapshot = { ok: true, automatic: true, featureEnabled: true, managed: true, sessionId: null, state: "idle", destination: null, interface: null, startedAt: null, expiresAt: null, lastInputAt: null, bytes: 0, issues: {}, events: [] };
    const radar = { ...snapshot, environment: launch, connections: [{ ...connection, connecting: true as const }] };
    const markup = html(<TelemetryCapture capture={capture} radar={radar} failed={false} busy={false} error="" action={async () => {}} />);
    expect(markup).toContain("Connections to these collectors (1)");
    expect(markup).toContain('class="tr-attempt">Connecting · no reply yet</span>');
    expect(markup).not.toContain('aria-label="Capture destination"');
  });
});

describe("Launch environment evidence", () => {
  it("counts launch destinations and shows launch flags read-only", () => {
    const markup = html(<TrafficRadarView snapshot={{ ...snapshot, environment: launch }} />);
    expect(markup).toContain("Enabled in launch environment");
    expect(markup).toContain("tr-tone-enabled");
    expect(markup).toContain("1 configured destination");
    expect(markup).toContain("Process launch environment · PID 7 · OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(markup).toContain(">Read-only</span>");
    expect(markup).not.toContain(">Managed</span>");
    expect(markup).not.toContain(">Unavailable</span>");
    expect(markup).toContain("the launch environment of running Claude processes");
  });

  it("keeps settings wording when settings name the flag", () => {
    expect(configuredState([{ key: "CLAUDE_CODE_ENABLE_TELEMETRY", value: "Enabled", source: "User settings" }, launch[0]])).toBe("Enabled in settings");
    expect(configuredState([launch[0]])).toBe("Enabled in launch environment");
    expect(configuredState([{ ...launch[0], value: "Disabled" }])).toBe("Disabled in launch environment");
    expect(configuredState([{ key: "CLAUDE_CODE_ENABLE_TELEMETRY", value: "Disabled", source: "User settings" }, launch[0]])).toBe("Conflicting settings");
  });

  it("says how many Claude processes could not be inspected", () => {
    expect(html(<Configuration snapshot={{ ...snapshot, uninspected: 2 }} />)).toContain("2 Claude processes could not be inspected");
    expect(html(<Configuration snapshot={{ ...snapshot, uninspected: 1 }} />)).toContain("1 Claude process could not be inspected");
    expect(html(<Configuration snapshot={snapshot} />)).not.toContain("could not be inspected");
  });
});
