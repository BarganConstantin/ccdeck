import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { captureSummary, radarStatus, type RadarSnapshot } from "../traffic-radar";
import { Configuration, TrafficRadarView } from "../components/TrafficRadar";

const snapshot: RadarSnapshot = {
  ok: true, sampledAt: 1_700_000_000_000, platform: "darwin", pollMs: 5_000,
  status: "observing", processCount: 2, connections: [], alerts: [],
  config: { sources: [{ name: "User settings", status: "read" }], variables: [] },
};

describe("Traffic Radar status language", () => {
  it("never labels an empty connection sample as disabled or safe", () => {
    expect(radarStatus(snapshot)).toBe("No connections observed in this sample");
    const markup = renderToStaticMarkup(<TrafficRadarView snapshot={snapshot} />);
    const config = renderToStaticMarkup(<Configuration snapshot={snapshot} />);
    expect(config).toContain("This does not mean telemetry is off");
    expect(markup).toContain("Brief transfers between samples may not appear");
    expect(config).toContain("Content capture settings unknown");
    expect(markup).not.toMatch(/safe|protected|not sending/i);
  });

  it("shows configured capture without claiming it proves effective runtime capture", () => {
    const variables = [{ source: "Managed settings", key: "OTEL_LOG_USER_PROMPTS", value: "Enabled" }];
    expect(captureSummary(variables)).toBe("Content capture enabled in a configuration source");
    expect(captureSummary([{ ...variables[0], value: "Disabled" }])).toContain("unverified");
    const markup = renderToStaticMarkup(<Configuration snapshot={{ ...snapshot, config: { ...snapshot.config!, variables } }} />);
    expect(markup).toContain("not the effective settings of a running session");
  });

  it("makes stale observations unknown after a failed poll", () => {
    const read = { ...snapshot, connections: [{ pid: 42, destination: "192.0.2.16:4317", workspace: "~/vcrm-core", firstSeenAt: snapshot.sampledAt, lastSeenAt: snapshot.sampledAt, active: true }] };
    const markup = renderToStaticMarkup(<TrafficRadarView snapshot={read} failed />);
    expect(markup).toContain("Visibility interrupted");
    expect(markup).not.toContain("Observed now");
    expect(markup).toContain("Unknown");
    expect(markup).toContain("last seen");
    expect(markup).not.toContain("last sent");
  });

  it("does not turn unsupported platforms into empty successful samples", () => {
    const markup = renderToStaticMarkup(<TrafficRadarView snapshot={{ ...snapshot, status: "unsupported", platform: "win32", config: null }} />);
    expect(markup).toContain("cannot inspect Claude connections");
    expect(markup).toContain("No privacy conclusion can be drawn");
  });

  it.each([false, true])("does not present failed observations as successful empty samples (poll failed: %s)", failed => {
    const markup = renderToStaticMarkup(<TrafficRadarView snapshot={{ ...snapshot, status: failed ? "observing" : "unavailable" }} failed={failed} />);
    expect(markup).toContain("Connections could not be determined");
    expect(markup).not.toContain("No established TCP connections captured");
  });

  it("describes lazy history reset without promising timed deletion", () => {
    const markup = renderToStaticMarkup(<TrafficRadarView snapshot={snapshot} />);
    expect(markup).toContain("On the next sample, history resets");
    expect(markup).not.toContain("resets after 30 seconds without a reader");
  });

  it("renders loading and retry states without inventing data", () => {
    expect(renderToStaticMarkup(<TrafficRadarView snapshot={null} />)).toContain("Reading configuration");
    expect(renderToStaticMarkup(<TrafficRadarView snapshot={null} failed />)).toContain("sampling will retry");
  });

  it("escapes workspace labels and does not expose endpoint payloads", () => {
    const read = { ...snapshot, connections: [{ pid: 42, destination: "192.0.2.16:4317", workspace: "<script>alert(1)</script>", firstSeenAt: snapshot.sampledAt, lastSeenAt: snapshot.sampledAt, active: true }] };
    const markup = renderToStaticMarkup(<TrafficRadarView snapshot={read} />);
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });

  it("keeps sampling on demand and pauses hidden tabs", () => {
    const hook = readFileSync(new URL("../use-traffic-radar.ts", import.meta.url), "utf8");
    const component = readFileSync(new URL("../components/TrafficRadar.tsx", import.meta.url), "utf8");
    expect(hook).toContain('document.visibilityState !== "hidden"');
    expect(hook).toContain("controller?.abort()");
    expect(hook).toContain("setTimeout(load, 5_000)");
    expect(hook).not.toContain("setInterval");
    expect(component).toContain("useModalDismiss(onClose)");
    const dialogs = readFileSync(new URL("../components/DeckDialogs.tsx", import.meta.url), "utf8");
    const machine = readFileSync(new URL("../components/MachinePanel.tsx", import.meta.url), "utf8");
    expect(dialogs).toContain("{trafficRadarOpen && <Suspense");
    expect(machine).not.toContain("TrafficRadar");
  });

  it("offers separate live, history and configuration views with honest payload limits", () => {
    const markup = renderToStaticMarkup(<TrafficRadarView snapshot={snapshot} />);
    expect(markup).toContain("Live connections");
    expect(markup).toContain("Observation history");
    expect(markup).toContain("Configuration");
    expect(markup).toContain("Payload not captured");
    expect(markup).toContain("Earlier payloads cannot be recovered");
  });
});
