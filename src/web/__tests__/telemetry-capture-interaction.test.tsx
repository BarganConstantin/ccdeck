import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, one, textOf } from "./fake-react";
import type { CaptureSnapshot, CapturedExport } from "../use-telemetry-capture";
vi.mock("react", async () => (await import("./fake-react")).react);
const { TelemetryCapture } = await import("../components/TelemetryCapture");
const empty: CaptureSnapshot = { ok: true, sessionId: null, state: "idle", destination: null, interface: null, startedAt: null, expiresAt: null, lastInputAt: null, bytes: 0, issues: {}, events: [] };
const event = (id: number, signal: CapturedExport["signal"]): CapturedExport => ({ id, signal, at: 1700000000000, observedAt: 1700000000000, destination: "192.0.2.16:4317", bytes: 100, count: 1, name: `Synthetic ${signal} ${id}`, content: [], outcome: "unconfirmed", response: null });
const props = { capture: { ...empty, events: [event(2, "logs"), event(1, "metrics")] }, radar: null, failed: false, busy: false, error: "", command: "", action: vi.fn(async () => {}) };
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ payload: {} }) }))); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("telemetry capture interactions", () => {
  it("selects an export from the new signal rather than inspecting a hidden row", () => {
    const view = mount(TelemetryCapture, props);
    const select = one(view.tree, e => e.type === "select")!;
    (select.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "metrics" } });
    const inspector = one(view.tree, e => e.props.className === "tr-inspector")!;
    expect(textOf(inspector)).toContain("Synthetic metrics 1");
    expect(textOf(inspector)).not.toContain("Synthetic logs 2");
    expect(fetch).toHaveBeenLastCalledWith("/api/system/traffic-radar/capture/event?id=1", expect.anything());
    view.unmount();
  });
  it("keeps explicit selection stable as new exports arrive, then removes expired contents", () => {
    const view = mount(TelemetryCapture, props);
    const row = one(view.tree, e => e.type === "button" && textOf(e).includes("Synthetic metrics 1"))!;
    (row.props.onClick as () => void)();
    view.rerender({ ...props, capture: { ...empty, events: [event(3, "logs"), ...props.capture.events] } });
    expect(textOf(one(view.tree, e => e.props.className === "tr-inspector"))).toContain("Synthetic metrics 1");
    view.rerender({ ...props, capture: { ...empty, events: [event(3, "logs")] } });
    expect(textOf(one(view.tree, e => e.props.className === "tr-inspector"))).toContain("no longer retained");
    view.unmount();
  });
  it("pauses only the list and does not retain exports beyond server retention", () => {
    const view = mount(TelemetryCapture, props);
    (one(view.tree, e => e.type === "button" && textOf(e) === "Pause list")!.props.onClick as () => void)();
    view.rerender({ ...props, capture: { ...empty, events: [event(3, "traces"), event(1, "metrics")] } });
    const feed = textOf(one(view.tree, e => e.props.className === "tr-feed"));
    expect(feed).toContain("Synthetic metrics 1"); expect(feed).not.toContain("Synthetic logs 2"); expect(feed).not.toContain("Synthetic traces 3");
    view.unmount();
  });
  it("offers a replacement command after reopening before activation", () => {
    const view = mount(TelemetryCapture, { ...props, capture: { ...empty, state: "awaiting", destination: "192.0.2.16:4317" } });
    (one(view.tree, e => e.type === "button" && textOf(e) === "Prepare a new command")!.props.onClick as () => void)();
    expect(props.action).toHaveBeenCalledWith("prepare", "192.0.2.16:4317");
    expect(textOf(view.tree)).toContain("previous token will be invalidated");
    view.unmount();
  });
  it("preserves the pending action's focusable button while disabling sibling actions", () => {
    const view = mount(TelemetryCapture, { ...props, busy: true, pendingAction: "prepare" });
    const prepare = one(view.tree, e => e.type === "button" && textOf(e) === "Preparing…")!;
    expect(prepare.props.disabled).toBe(false); expect(prepare.props["aria-busy"]).toBe(true);
    expect(one(view.tree, e => e.type === "button" && textOf(e) === "Clear captured contents")!.props.disabled).toBe(true);
    view.unmount();
  });
});
