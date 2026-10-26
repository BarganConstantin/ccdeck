import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, one, textOf } from "./fake-react";
import type { CaptureSnapshot, CapturedExport } from "../use-telemetry-capture";
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), ...(await import("./fake-react")).react }));
const { TelemetryCapture } = await import("../components/TelemetryCapture");
const empty: CaptureSnapshot = { ok: true, automatic: true, featureEnabled: true, managed: true, sessionId: null, state: "idle", destination: null, interface: null, startedAt: null, expiresAt: null, lastInputAt: null, bytes: 0, issues: {}, events: [] };
const event = (id: number, signal: CapturedExport["signal"]): CapturedExport => ({ id, signal, at: 1700000000000, observedAt: 1700000000000, destination: "192.0.2.16:4317", bytes: 100, count: 1, name: `Synthetic ${signal} ${id}`, content: [], outcome: "unconfirmed", response: null });
const props = { capture: { ...empty, events: [event(2, "logs"), event(1, "metrics")] }, radar: { ok: true, sampledAt: 0, platform: "darwin", pollMs: 5000, status: "observing" as const, processCount: 0, connections: [], alerts: [], config: { sources: [], variables: [{ key: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://192.0.2.16:4317", source: "User settings" }] } }, failed: false, busy: false, error: "", action: vi.fn(async () => {}) };
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ payload: {} }) }))); });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe("telemetry capture interactions", () => {
  it("filters activity to prompt exports and restores observations when switched off", () => {
    const capture = { ...props.capture, events: [{ ...event(3, "logs"), content: ["Prompt"] }, ...props.capture.events], observations: [{ id: 4, at: 1700000000001, destination: "192.0.2.16:4317", source: "192.0.2.1:50000", reason: "joined_midstream" }] };
    const view = mount(TelemetryCapture, { ...props, capture });
    const feed = () => one(view.tree, e => e.props.className === "tr-connections")!;
    const toggle = () => one(view.tree, e => e.props.role === "switch" && e.props["aria-label"] === "With prompt")!;
    expect(textOf(feed())).toContain("Connection observed");
    (toggle().props.onClick as () => void)();
    expect(toggle().props["aria-checked"]).toBe(true);
    expect(textOf(feed())).toContain("Synthetic logs 3");
    expect(textOf(feed())).not.toContain("Synthetic logs 2");
    expect(textOf(feed())).not.toContain("Synthetic metrics 1");
    expect(textOf(feed())).not.toContain("Connection observed");
    view.rerender({ ...props, capture: { ...capture, events: props.capture.events } });
    expect(textOf(view.tree)).toContain("Turn off With prompt");
    (toggle().props.onClick as () => void)();
    expect(textOf(feed())).toContain("Connection observed");
    expect(textOf(feed())).toContain("Synthetic metrics 1");
    view.unmount();
  });
  it("starts with one empty workspace and reveals history tools only after activity arrives", () => {
    const view = mount(TelemetryCapture, { ...props, capture: empty });
    expect(one(view.tree, e => e.props.className === "tr-workspace")!.props["data-empty"]).toBe(true);
    expect(one(view.tree, e => e.props.className === "tr-inspector")!.props.hidden).toBe(true);
    expect(one(view.tree, e => e.props["aria-label"] === "Message type")).toBeNull();
    expect(one(view.tree, e => e.type === "button" && textOf(e) === "Clear history")).toBeNull();
    view.rerender(props);
    expect(one(view.tree, e => e.props.className === "tr-workspace")!.props["data-empty"]).toBe(false);
    expect(one(view.tree, e => e.props.className === "tr-inspector")!.props.hidden).toBe(false);
    expect(one(view.tree, e => e.props.className === "tr-details tr-feed-options")!.props.open).toBeUndefined();
    expect(one(view.tree, e => e.props["aria-label"] === "Message type")).not.toBeNull();
    view.unmount();
  });

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
    expect(textOf(view.tree)).toContain("0 decoded · 1 observed");
    const inspector = textOf(one(view.tree, e => e.props.className === "tr-inspector"));
    expect(inspector).toContain("192.0.2.10:50210");
    expect(inspector).toContain("Not decoded");
    expect(inspector).toContain("Already captured traffic cannot be reconstructed");
    expect(fetch).not.toHaveBeenCalled();
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
    expect(textOf(view.tree)).toContain("24h");
    expect(textOf(view.tree)).toContain("12 older messages removed");
    expect(one(view.tree, e => e.props.className === "tr-event-name" && textOf(e) === "Synthetic logs 1")).toBeNull();
    (one(view.tree, e => e.type === "button" && textOf(e) === "Show older messages")!.props.onClick as () => void)();
    expect(one(view.tree, e => e.props.className === "tr-event-name" && textOf(e) === "Synthetic logs 1")).not.toBeNull();
    expect(one(view.tree, e => e.type === "button" && textOf(e) === "Show older messages")).toBeNull();
    view.unmount();
  });
  // Monitoring is always on: an observed connection is monitored by the deck
  // itself, so nothing here asks the person to pick it or press Start.
  it("names an observed collector without a picker or Start when settings are absent", () => {
    const view = mount(TelemetryCapture, { ...props, capture: empty, radar: { ...props.radar, config: { sources: [], variables: [] }, connections: [{ pid: 123, destination: "192.0.2.16:4317", workspace: null, firstSeenAt: 0, lastSeenAt: 0, active: true }] } });
    expect(one(view.tree, e => e.props["aria-label"] === "Capture destination")).toBeNull();
    expect(one(view.tree, e => e.type === "button" && /monitoring/i.test(textOf(e)))).toBeNull();
    expect(textOf(view.tree)).toContain("Radar monitors automatically when a collector is available");
    expect(props.action).not.toHaveBeenCalled();
    view.unmount();
  });
  // The setup card is a child component, which this fake does not render:
  // the test reads the element Monitor drew for it, and draws the card by
  // calling it (it holds no state of its own).
  const deniedOn = (platform: string) => ({ ...props.capture, platform, enabled: true, state: "interrupted" as const, sources: [{ destination: "192.0.2.16:4317", interface: "en0", active: false, bytes: 0, error: "Packet capture permission is required." }] });
  type Card = { platform?: string; install: boolean; asking: boolean; permission: unknown; onAllow: () => void; onCopy: (text: string) => void; copied: boolean };
  const setupOf = (tree: unknown) => one(tree, e => typeof e.props.onAllow === "function");
  const drawCard = (tree: unknown) => { const card = setupOf(tree)!; return (card.type as unknown as (p: Card) => unknown)(card.props as unknown as Card); };
  it("asks for capture permission from the setup card's one button", () => {
    const view = mount(TelemetryCapture, { ...props, capture: deniedOn("darwin") });
    expect(setupOf(view.tree)!.props).toMatchObject({ platform: "darwin", install: false, asking: false, permission: null, copied: false });
    const allow = (tree: unknown) => one(drawCard(tree), e => e.type === "button")!;
    expect(textOf(allow(view.tree))).toBe("Allow capture…");
    (allow(view.tree).props.onClick as () => void)();
    expect(props.action).toHaveBeenCalledTimes(1);
    expect(props.action).toHaveBeenCalledWith("permission");
    // While the prompt is up, a second press asks nothing more of the system.
    view.rerender({ ...props, capture: deniedOn("darwin"), busy: true, pendingAction: "permission" });
    expect(setupOf(view.tree)!.props.asking).toBe(true);
    expect(textOf(allow(view.tree))).toBe("Waiting for your password…");
    expect(allow(view.tree).props["aria-busy"]).toBe(true); expect(allow(view.tree).props.disabled).toBeUndefined();
    (allow(view.tree).props.onClick as () => void)();
    expect(props.action).toHaveBeenCalledTimes(1);
    view.unmount();
  });
  it("draws no setup card while capture is allowed, and one with install named while tcpdump is missing", () => {
    expect(setupOf(mount(TelemetryCapture, props).tree)).toBeNull();
    const missing = mount(TelemetryCapture, { ...props, capture: { ...props.capture, platform: "linux", state: "error" as const, setupError: "Install tcpdump to capture traffic. Configuration and file inspection work without it." } });
    expect(setupOf(missing.tree)!.props).toMatchObject({ platform: "linux", install: true });
    missing.unmount();
  });
  it("copies the terminal command when no password prompt could open", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const permission = { outcome: "unavailable" as const, message: "No password prompt can open in this session.", command: "sudo sh /tmp/radar-capture-setup.sh" };
    const view = mount(TelemetryCapture, { ...props, capture: deniedOn("linux"), permission });
    expect(setupOf(view.tree)!.props.permission).toEqual(permission);
    const copy = () => one(drawCard(view.tree), e => e.type === "button" && /^(Copy command|Copied)$/.test(textOf(e)))!;
    (copy().props.onClick as () => void)();
    await Promise.resolve(); await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("sudo sh /tmp/radar-capture-setup.sh");
    expect(setupOf(view.tree)!.props.copied).toBe(true);
    expect(textOf(copy())).toBe("Copied");
    vi.advanceTimersByTime(2000);
    expect(setupOf(view.tree)!.props.copied).toBe(false);
    expect(textOf(copy())).toBe("Copy command");
    view.unmount();
  });
  it("keeps the pending action's button focusable while disabling sibling actions", () => {
    const asking = mount(TelemetryCapture, { ...props, capture: deniedOn("darwin"), busy: true, pendingAction: "permission" });
    expect(setupOf(asking.tree)!.props.asking).toBe(true);
    expect(one(asking.tree, e => e.type === "button" && textOf(e) === "Clear history")!.props.disabled).toBe(true);
    asking.unmount();
    const clearing = mount(TelemetryCapture, { ...props, busy: true, pendingAction: "clear" });
    const clear = one(clearing.tree, e => e.type === "button" && textOf(e) === "Clear history")!;
    expect(clear.props.disabled).toBe(false); expect(clear.props["aria-busy"]).toBe(true);
    clearing.unmount();
  });
});
