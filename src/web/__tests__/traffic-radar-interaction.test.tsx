import { describe, expect, it, vi } from "vitest";
import { mount, one, textOf } from "./fake-react";
import type { RadarSnapshot } from "../traffic-radar";
vi.mock("react", async () => (await import("./fake-react")).react);
const { TrafficRadarView, Configuration } = await import("../components/TrafficRadar");
const { useModalGate } = await import("../use-modal-gate");
const snapshot: RadarSnapshot = {
  ok: true, sampledAt: 1700000000000, platform: "darwin", pollMs: 5000, status: "observing",
  processCount: 2, config: { sources: [], variables: [] }, alerts: [],
  connections: [
    { pid: 42, destination: "192.0.2.16:4317", workspace: "~/project-one", active: true, firstSeenAt: 1, lastSeenAt: 2 },
    { pid: 43, destination: "192.0.2.17:443", workspace: "~/project-two", active: false, firstSeenAt: 1, lastSeenAt: 2 },
  ],
};

describe("Telemetry Radar modal interactions", () => {
  it("separates live connections from history and inspects the clicked row", () => {
    const view = mount(TrafficRadarView, { snapshot });
    const feed = () => one(view.tree, e => e.props.className === "tr-feed")!;
    const inspector = () => one(view.tree, e => e.props.className === "tr-inspector")!;
    expect(textOf(feed())).not.toContain("192.0.2.17");
    const history = one(view.tree, e => e.type === "button" && textOf(e) === "Observation history")!;
    (history.props.onClick as () => void)();
    expect(textOf(feed())).toContain("192.0.2.17");
    const row = one(view.tree, e => e.type === "button" && textOf(e).includes("192.0.2.17"))!;
    (row.props.onClick as () => void)();
    expect(textOf(inspector())).toContain("~/project-two");
    expect(textOf(inspector())).not.toContain("~/project-one");
    expect(textOf(inspector())).toContain("Payload not captured");
    view.unmount();
  });

  it("opens configuration without losing the modal", () => {
    const view = mount(TrafficRadarView, { snapshot });
    const button = one(view.tree, e => e.type === "button" && textOf(e) === "Configuration")!;
    (button.props.onClick as () => void)();
    expect(one(view.tree, e => e.type === Configuration)).not.toBeNull();
    expect(one(view.tree, e => e.props.className === "tr-feed")).toBeNull();
    view.unmount();
  });

  it("keeps the selected inspector stable when a connection stops being live", () => {
    const view = mount(TrafficRadarView, { snapshot });
    const row = one(view.tree, e => e.type === "button" && textOf(e).includes("192.0.2.16"))!;
    (row.props.onClick as () => void)();
    view.rerender({ snapshot: { ...snapshot, connections: snapshot.connections.map(c => ({ ...c, active: c.pid !== 42 })) } });
    const inspector = one(view.tree, e => e.props.className === "tr-inspector")!;
    expect(textOf(inspector)).toContain("~/project-one");
    expect(textOf(inspector)).toContain("Seen earlier");
    expect(textOf(inspector)).not.toContain("~/project-two");
    view.rerender({ snapshot: { ...snapshot, connections: [snapshot.connections[1]] } });
    expect(textOf(one(view.tree, e => e.props.className === "tr-inspector")!)).toContain("no longer retained");
    view.unmount();
  });

  it("blocks canvas shortcuts while the radar is open", () => {
    const view = mount(useModalGate, { openedTool: null, usageHistoryOpen: false, contextFor: null,
      tourOpen: false, summaryFor: null, browserWatchOpen: false, keyHelpOpen: false,
      releaseNotes: null, feedbackOpen: false, trafficRadarOpen: true });
    expect(view.tree.modalOpenRef.current).toBe(true);
    view.unmount();
  });
});
