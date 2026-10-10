import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, one, textOf } from "./fake-react";
import type { CaptureSnapshot, CapturedExport } from "../use-telemetry-capture";
vi.mock("react", async () => (await import("./fake-react")).react);
const { TelemetryCapture } = await import("../components/TelemetryCapture");
const empty: CaptureSnapshot = { ok: true, sessionId: null, state: "idle", destination: null, interface: null, startedAt: null, expiresAt: null, lastInputAt: null, bytes: 0, issues: {}, events: [] };
const event = (id: number, signal: CapturedExport["signal"]): CapturedExport => ({ id, signal, at: 1700000000000, observedAt: 1700000000000, destination: "192.0.2.16:4317", bytes: 100, count: 1, name: `Synthetic ${signal} ${id}`, content: [], outcome: "unconfirmed", response: null });
const props = { capture: { ...empty, events: [event(2, "logs"), event(1, "metrics")] }, radar: { ok: true, sampledAt: 0, platform: "darwin", pollMs: 5000, status: "observing" as const, processCount: 0, connections: [], alerts: [], config: { sources: [], variables: [{ key: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://192.0.2.16:4317", source: "User settings" }] } }, failed: false, busy: false, error: "", command: "", action: vi.fn(async () => {}) };
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ payload: {} }) }))); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe("telemetry capture interactions", () => {
  it("keeps consecutive arrow navigation in the feed without activating mobile inspector focus", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    const doc: { activeElement: unknown } = { activeElement: null };
    const buttons = [0, 1].map(() => ({ focus: vi.fn(function(this: unknown) { doc.activeElement = this; }), click: vi.fn() }));
    doc.activeElement = buttons[0];
    vi.stubGlobal("document", doc);
    const view = mount(TelemetryCapture, props);
    const press = (key: string) => {
      const list = one(view.tree, e => e.props.className === "tr-connections")!;
      (list.props.onKeyDown as (e: unknown) => void)({ key, currentTarget: { querySelectorAll: () => buttons }, preventDefault: vi.fn() });
    };
    press("ArrowDown");
    expect(doc.activeElement).toBe(buttons[1]);
    expect(textOf(one(view.tree, e => e.props.className === "tr-inspector"))).toContain("Synthetic metrics 1");
    press("ArrowUp");
    expect(doc.activeElement).toBe(buttons[0]);
    expect(textOf(one(view.tree, e => e.props.className === "tr-inspector"))).toContain("Synthetic logs 2");
    expect(buttons[0].click).not.toHaveBeenCalled();
    expect(buttons[1].click).not.toHaveBeenCalled();
    view.unmount();
  });

  it("requires a deliberate second press to clear history and cancels on blur", () => {
    vi.useFakeTimers();
    const view = mount(TelemetryCapture, props);
    const clear = () => one(view.tree, e => e.type === "button" && /^(Clear history|Confirm clear history)$/.test(textOf(e)))!;
    (clear().props.onClick as () => void)();
    expect(textOf(clear())).toBe("Confirm clear history");
    expect(props.action).not.toHaveBeenCalled();
    (clear().props.onClick as () => void)();
    expect(props.action).not.toHaveBeenCalled();
    (clear().props.onBlur as () => void)();
    expect(textOf(clear())).toBe("Clear history");
    (clear().props.onClick as () => void)();
    vi.advanceTimersByTime(400);
    (clear().props.onClick as () => void)();
    expect(props.action).toHaveBeenCalledTimes(1);
    expect(props.action).toHaveBeenCalledWith("clear");
    view.unmount();
  });
  it("expires clear confirmation without deleting history", () => {
    vi.useFakeTimers();
    const view = mount(TelemetryCapture, props);
    (one(view.tree, e => e.type === "button" && textOf(e) === "Clear history")!.props.onClick as () => void)();
    vi.advanceTimersByTime(5000);
    expect(one(view.tree, e => e.type === "button" && textOf(e) === "Clear history")).not.toBeNull();
    expect(props.action).not.toHaveBeenCalled();
    view.unmount();
  });
  it("resets copy feedback when switching observations and after two seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    const observations = [2, 1].map(id => ({ id, at: 1700000000000 + id, destination: `192.0.2.${id}:4317`, source: "192.0.2.10:50210", reason: "joined_midstream" }));
    const view = mount(TelemetryCapture, { ...props, capture: { ...empty, observations } });
    const copy = () => one(view.tree, e => e.props["aria-label"] === "Copy destination")!;
    await (copy().props.onClick as () => Promise<void>)();
    await Promise.resolve();
    expect(copy().props.title).toBe("Copied destination");
    (one(view.tree, e => e.type === "button" && e.props.className === "tr-message" && textOf(e).includes("192.0.2.1:4317"))!.props.onClick as () => void)();
    expect(copy().props.title).toBe("Copy destination");
    await (copy().props.onClick as () => Promise<void>)();
    await Promise.resolve();
    expect(copy().props.title).toBe("Copied destination");
    vi.advanceTimersByTime(2000);
    expect(copy().props.title).toBe("Copy destination");
    expect(fetch).not.toHaveBeenCalled();
    view.unmount();
  });

  it("pins the initial message without requiring an explicit selection", () => {
    const view = mount(TelemetryCapture, props);
    view.rerender({ ...props, capture: { ...empty, events: [event(3, "logs"), ...props.capture.events] } });
    expect(textOf(one(view.tree, e => e.props.className === "tr-inspector"))).toContain("Synthetic logs 2");
    expect(textOf(one(view.tree, e => e.props.className === "tr-inspector"))).not.toContain("Synthetic logs 3");
    view.unmount();
  });
  it("exposes list freezing separately from monitoring and updates its help on resume", () => {
    const view = mount(TelemetryCapture, props);
    const pause = () => one(view.tree, e => e.type === "button" && /^(Pause|Resume) list$/.test(textOf(e)))!;
    expect(pause().props["aria-pressed"]).toBe(false);
    (pause().props.onClick as () => void)();
    expect(pause().props["aria-pressed"]).toBe(true);
    expect(pause().props.title).toBe("Show new entries received while the list was paused");
    expect(props.action).not.toHaveBeenCalled();
    (pause().props.onClick as () => void)();
    expect(pause().props["aria-pressed"]).toBe(false);
    expect(props.action).not.toHaveBeenCalled();
    view.unmount();
  });
  it("reports arrivals while the list is paused without adding them to its rows", () => {
    const view = mount(TelemetryCapture, props);
    (one(view.tree, e => e.type === "button" && textOf(e) === "Pause list")!.props.onClick as () => void)();
    view.rerender({ ...props, capture: { ...empty, events: [event(3, "logs"), ...props.capture.events] } });
    const feed = textOf(one(view.tree, e => e.props.className === "tr-feed"));
    expect(feed).toContain("Monitoring continues · 1 new entry");
    expect(feed).not.toContain("Synthetic logs 3");
    (one(view.tree, e => e.type === "button" && textOf(e) === "Resume list")!.props.onClick as () => void)();
    expect(textOf(one(view.tree, e => e.props.className === "tr-feed"))).toContain("Synthetic logs 3");
    expect(props.action).not.toHaveBeenCalled();
    view.unmount();
  });
  it("identifies unreadable observations separately and keeps their real metadata", () => {
    const view = mount(TelemetryCapture, { ...props, capture: { ...empty, managed: true, enabled: true, state: "capturing", bytes: 100, sources: [{ destination: "192.0.2.16:4317", interface: "en0", active: true, bytes: 100 }], observations: [{ id: 1, at: 1700000000000, destination: "192.0.2.16:4317", source: "192.0.2.10:50210", reason: "joined_midstream" }] } });
    expect(textOf(view.tree)).toContain("0 decoded messages · 1 observation");
    const inspector = textOf(one(view.tree, e => e.props.className === "tr-inspector"));
    expect(inspector).toContain("192.0.2.10:50210");
    expect(inspector).toContain("Not decoded");
    expect(inspector).toContain("Already captured traffic cannot be reconstructed");
    expect(fetch).not.toHaveBeenCalled();
    view.unmount();
  });
  it("can prepare an explicitly selected observed connection when settings are absent", () => {
    const view = mount(TelemetryCapture, { ...props, capture: empty, radar: { ...props.radar, config: { sources: [], variables: [] }, connections: [{ pid: 123, destination: "192.0.2.16:4317", workspace: null, firstSeenAt: 0, lastSeenAt: 0, active: true }] } });
    expect(one(view.tree, e => e.type === "button" && textOf(e) === "Start monitoring")!.props.disabled).toBe(true);
    expect(textOf(view.tree)).toContain("Claude may still be sending telemetry");
    const select = one(view.tree, e => e.props["aria-label"] === "Capture destination")!;
    (select.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "192.0.2.16:4317" } });
    const start = one(view.tree, e => e.type === "button" && textOf(e) === "Start monitoring")!;
    expect(start.props.disabled).toBe(false);
    (start.props.onClick as () => void)();
    expect(props.action).toHaveBeenCalledWith("prepare", ["192.0.2.16:4317"]);
    view.unmount();
  });
  it("filters messages by session evidence and preserves unidentified exports separately", () => {
    const view = mount(TelemetryCapture, { ...props, sessionFilter: "one", capture: { ...empty, events: [{ ...event(3, "logs"), sessionIds: ["one"] }, { ...event(2, "logs"), sessionIds: ["two"] }, event(1, "metrics")] } });
    expect(textOf(one(view.tree, e => e.props.className === "tr-feed"))).toContain("Synthetic logs 3");
    expect(textOf(one(view.tree, e => e.props.className === "tr-feed"))).not.toContain("Synthetic logs 2");
    view.rerender({ ...props, sessionFilter: "unidentified" });
    expect(textOf(one(view.tree, e => e.props.className === "tr-feed"))).toContain("Synthetic metrics 1");
    view.unmount();
  });

  it("selects an export from the new signal rather than inspecting a hidden row", () => {
    const view = mount(TelemetryCapture, props);
    const select = one(view.tree, e => e.props["aria-label"] === "Message type")!;
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
  it("loads older history in batches and reports capacity evictions", () => {
    const events = Array.from({ length: 150 }, (_, i) => event(150 - i, "logs"));
    const view = mount(TelemetryCapture, { ...props, capture: { ...empty, events, retention: { windowMs: 86400000, maxExports: 2000, payloadBudgetBytes: 33554432, evictedExports: 12 } } });
    expect(textOf(view.tree)).toContain("Last 24 hours");
    expect(textOf(view.tree)).toContain("12 older messages removed");
    expect(one(view.tree, e => e.props.className === "tr-event-name" && textOf(e) === "Synthetic logs 1")).toBeNull();
    (one(view.tree, e => e.type === "button" && textOf(e) === "Show older messages")!.props.onClick as () => void)();
    expect(one(view.tree, e => e.props.className === "tr-event-name" && textOf(e) === "Synthetic logs 1")).not.toBeNull();
    expect(one(view.tree, e => e.type === "button" && textOf(e) === "Show older messages")).toBeNull();
    view.unmount();
  });
  it("offers a replacement command after reopening before activation", () => {
    const view = mount(TelemetryCapture, { ...props, capture: { ...empty, state: "awaiting", destination: "192.0.2.16:4317" } });
    (one(view.tree, e => e.type === "button" && textOf(e) === "Show activation instructions")!.props.onClick as () => void)();
    expect(props.action).toHaveBeenCalledWith("prepare", ["192.0.2.16:4317"]);
    expect(textOf(view.tree)).toContain("previous token will be invalidated");
    view.unmount();
  });
  it("preserves the pending action's focusable button while disabling sibling actions", () => {
    const view = mount(TelemetryCapture, { ...props, busy: true, pendingAction: "prepare" });
    const prepare = one(view.tree, e => e.type === "button" && textOf(e) === "Starting…")!;
    expect(prepare.props.disabled).toBe(false); expect(prepare.props["aria-busy"]).toBe(true);
    expect(one(view.tree, e => e.type === "button" && textOf(e) === "Clear history")!.props.disabled).toBe(true);
    view.unmount();
  });
});
