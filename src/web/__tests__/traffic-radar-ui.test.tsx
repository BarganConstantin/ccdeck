import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { RadarSnapshot } from "../traffic-radar";
import { Configuration, TrafficRadarView } from "../components/TrafficRadar";
const snapshot: RadarSnapshot = { ok: true, sampledAt: 1700000000000, platform: "darwin", pollMs: 5000, status: "observing", processCount: 2, connections: [], alerts: [], config: { sources: [{ name: "User settings", status: "read" }], variables: [] } };
describe("Telemetry Radar evidence and navigation", () => {
  it("does not mistake missing configuration for disabled telemetry", () => {
    const markup = renderToStaticMarkup(<TrafficRadarView snapshot={snapshot} />);
    expect(markup).toContain("Configuration unknown");
    expect(markup).toContain("This does not mean telemetry is off");
    expect(markup).not.toMatch(/safe|protected|Disabled in settings/);
  });
  it("distinguishes configured enablement from effective session settings and shows the raw flag", () => {
    const config = { ...snapshot, config: { ...snapshot.config!, variables: [{ key: "CLAUDE_CODE_ENABLE_TELEMETRY", value: "Enabled", rawValue: "1", source: "User settings" }] } };
    const markup = renderToStaticMarkup(<TrafficRadarView snapshot={config} />);
    expect(markup).toContain("Enabled in settings");
    expect(markup).toContain("tr-tone-enabled");
    expect(markup).toContain("The effective environment of a running session is not verified");
    expect(markup).toContain('class="tr-raw-flag">1');
  });
  it("marks failed reads unavailable rather than retaining a current enabled claim", () => {
    const markup = renderToStaticMarkup(<TrafficRadarView snapshot={snapshot} failed />);
    expect(markup).toContain("Configuration unavailable");
  });
  it("keeps connection evidence visible when organization settings disappear", () => {
    const live = { ...snapshot, connections: [{ pid: 123, destination: "192.0.2.16:4317", workspace: "Test project", firstSeenAt: 0, lastSeenAt: 0, active: true }] };
    const markup = renderToStaticMarkup(<TrafficRadarView snapshot={live} />);
    expect(markup).toContain("Configuration unknown");
    expect(markup).toContain("Claude connections observed");
    expect(markup).toContain("192.0.2.16:4317");
    expect(markup).toContain("not confirmed telemetry messages");
    expect(renderToStaticMarkup(<TrafficRadarView snapshot={live} failed />)).not.toContain("Claude connections observed");
    expect(renderToStaticMarkup(<TrafficRadarView snapshot={{ ...live, status: "unavailable" }} />)).not.toContain("Claude connections observed");
  });
  it("provides three focused views and defaults to all sessions", () => {
    const markup = renderToStaticMarkup(<TrafficRadarView snapshot={snapshot} sessions={[{ id: "test-session", label: "Test project" }]} />);
    expect(markup).toContain('aria-selected="true" aria-controls="tr-panel-monitor"');
    expect(markup).toContain("Configuration"); expect(markup).toContain("File");
    expect(markup).toContain("All sessions"); expect(markup).toContain("Test project");
    expect(markup).not.toContain("Observation history"); expect(markup).not.toContain("Live connections");
  });
  it("escapes configuration and session labels", () => {
    const markup = renderToStaticMarkup(<Configuration snapshot={snapshot} sessionLabel="<script>alert(1)</script>" />);
    expect(markup).not.toContain("<script>"); expect(markup).toContain("&lt;script&gt;");
  });
  it("renders loading and retry states without fabricating data", () => {
    expect(renderToStaticMarkup(<TrafficRadarView snapshot={null} />)).toContain("Reading settings");
    expect(renderToStaticMarkup(<TrafficRadarView snapshot={null} failed />)).toContain("Sampling will retry");
  });
  it("keeps reads on demand and pauses hidden tabs", () => {
    const hook = readFileSync(new URL("../use-traffic-radar.ts", import.meta.url), "utf8");
    expect(hook).toContain('document.visibilityState !== "hidden"');
    expect(hook).toContain("controller?.abort()"); expect(hook).not.toContain("setInterval");
    const dialogs = readFileSync(new URL("../components/DeckDialogs.tsx", import.meta.url), "utf8");
    expect(dialogs).toContain("{trafficRadarOpen && <Suspense");
  });
});
