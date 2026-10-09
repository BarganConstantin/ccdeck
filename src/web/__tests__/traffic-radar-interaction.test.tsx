import { describe, expect, it, vi } from "vitest";
import { mount, one } from "./fake-react";
import type { RadarSnapshot } from "../traffic-radar";
vi.mock("react", async () => (await import("./fake-react")).react);
const { TrafficRadarView, Configuration } = await import("../components/TrafficRadar");
const { useModalGate } = await import("../use-modal-gate");
const snapshot: RadarSnapshot = { ok: true, sampledAt: 1700000000000, platform: "darwin", pollMs: 5000, status: "observing", processCount: 2, config: { sources: [], variables: [] }, alerts: [], connections: [] };
describe("Telemetry Radar modal interactions", () => {
  it("changes views without unmounting the monitor or imported file", () => {
    const view = mount(TrafficRadarView, { snapshot });
    (one(view.tree, e => e.props.id === "tr-tab-configuration")!.props.onClick as () => void)();
    expect(one(view.tree, e => e.props.id === "tr-panel-monitor")!.props.hidden).toBe(true);
    expect(one(view.tree, e => e.props.id === "tr-panel-configuration")!.props.hidden).toBe(false);
    expect(one(view.tree, e => e.props.id === "tr-panel-file")).not.toBeNull();
    view.unmount();
  });
  it("preserves the session filter between views without pretending settings are process-verified", () => {
    const view = mount(TrafficRadarView, { snapshot, sessions: [{ id: "session-one", label: "Project one" }] });
    (one(view.tree, e => e.props["aria-label"] === "Session")!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "session-one" } });
    (one(view.tree, e => e.props.id === "tr-tab-configuration")!.props.onClick as () => void)();
    expect(one(view.tree, e => e.type === Configuration)!.props.sessionLabel).toBe("Project one");
    expect(one(view.tree, e => e.props["aria-label"] === "Session")!.props.value).toBe("session-one");
    view.unmount();
  });
  it("blocks canvas shortcuts while the radar is open", () => {
    const view = mount(useModalGate, { openedTool: null, usageHistoryOpen: false, contextFor: null, tourOpen: false, summaryFor: null, browserWatchOpen: false, keyHelpOpen: false, releaseNotes: null, feedbackOpen: false, trafficRadarOpen: true });
    expect(view.tree.modalOpenRef.current).toBe(true); view.unmount();
  });
});
