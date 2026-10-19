import { describe, expect, it, vi } from "vitest";
import { mount, one } from "./fake-react";
import type { RadarSnapshot } from "../traffic-radar";
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), ...(await import("./fake-react")).react }));
const { TrafficRadarView, Configuration } = await import("../components/TrafficRadar");
const { useModalGate } = await import("../use-modal-gate");
const snapshot: RadarSnapshot = { ok: true, sampledAt: 1700000000000, platform: "darwin", pollMs: 5000, status: "observing", processCount: 2, config: { sources: [], variables: [] }, alerts: [], connections: [] };
describe("Telemetry Radar modal interactions", () => {
  it("changes views without unmounting the monitor and has no file import", () => {
    const view = mount(TrafficRadarView, { snapshot });
    (one(view.tree, e => e.props.id === "tr-tab-configuration")!.props.onClick as () => void)();
    expect(one(view.tree, e => e.props.id === "tr-panel-monitor")!.props.hidden).toBe(true);
    expect(one(view.tree, e => e.props.id === "tr-panel-configuration")!.props.hidden).toBe(false);
    expect(one(view.tree, e => e.props.id === "tr-panel-file")).toBeNull();
    expect(one(view.tree, e => e.props.id === "tr-tab-file")).toBeNull();
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

describe('Telemetry flag controls', () => {
  const configured = { ...snapshot, config: { sources: [], variables: [{ key: 'OTEL_LOG_USER_PROMPTS', source: 'User settings', value: 'Enabled', rawValue: '1', editable: true }] } };
  it('saves only the selected flag, blocks repeated clicks, and confirms after success', async () => {
    let resolve!: (value: unknown) => void;
    const fetchMock = vi.fn(() => new Promise(r => { resolve = r; }));
    vi.stubGlobal('fetch', fetchMock);
    const view = mount(Configuration, { snapshot: configured });
    const click = one(view.tree, e => e.props.role === 'switch')!.props.onClick as () => void;
    click(); click();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ key: 'OTEL_LOG_USER_PROMPTS', enabled: false });
    expect(one(view.tree, e => e.props.role === 'switch')!.props.disabled).toBe(false);
    expect(one(view.tree, e => e.props.role === 'switch')!.props['aria-busy']).toBe(true);
    resolve({ ok: true, json: async () => ({ ok: true, config: { sources: [], variables: [{ ...configured.config.variables[0], value: 'Disabled', rawValue: '0' }] } }) });
    await vi.waitFor(() => expect(one(view.tree, e => e.props.role === 'switch')!.props['aria-checked']).toBe(false));
    expect(one(view.tree, e => e.props.role === 'status')).not.toBeNull();
    view.unmount(); vi.unstubAllGlobals();
  });
  it('keeps the previous value and exposes a failed save', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: 'No write permission.' }) })));
    const view = mount(Configuration, { snapshot: configured });
    (one(view.tree, e => e.props.role === 'switch')!.props.onClick as () => void)();
    await vi.waitFor(() => expect(one(view.tree, e => e.props.role === 'alert')).not.toBeNull());
    expect(one(view.tree, e => e.props.role === 'switch')!.props['aria-checked']).toBe(true);
    view.unmount(); vi.unstubAllGlobals();
  });
});

describe('Telemetry toggle keyboard focus', () => {
  it('keeps the working switch enabled while blocking other flags', async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(r => { resolve = r; })));
    const configured = { ...snapshot, config: { sources: [], variables: [
      { key: 'OTEL_LOG_USER_PROMPTS', source: 'User settings', value: 'Enabled', editable: true },
      { key: 'OTEL_LOG_TOOL_DETAILS', source: 'User settings', value: 'Enabled', editable: true },
    ] } };
    const view = mount(Configuration, { snapshot: configured });
    const prompt = () => one(view.tree, e => e.props.role === 'switch' && String(e.props['aria-label']).startsWith('Your prompts'))!;
    const tool = () => one(view.tree, e => e.props.role === 'switch' && String(e.props['aria-label']).startsWith('Tool details'))!;
    (prompt().props.onClick as () => void)();
    expect(prompt().props.disabled).toBe(false);
    expect(prompt().props['aria-busy']).toBe(true);
    expect(tool().props.disabled).toBe(true);
    resolve({ ok: true, json: async () => ({ ok: true, config: configured.config }) });
    await vi.waitFor(() => expect(prompt().props['aria-busy']).toBe(false));
    expect(tool().props.disabled).toBe(false);
    view.unmount(); vi.unstubAllGlobals();
  });
});
