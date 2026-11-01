// v3.44.0 brings back Radar's inspector rework (prompt previews, highlights, a
// resizable list, Settings › Radar) on top of 3.43.4 — without the two things
// that rework took from released Radar: the File view, where a saved telemetry
// file is read in the browser, and Radar in the toolbar whatever Settings ›
// Radar says. These pin both to what 3.43.4 did.
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, mount, one, textOf } from "./fake-react";
import { sourceOf } from "./client-source";
import type { RadarSnapshot } from "../traffic-radar";
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), ...(await import("./fake-react")).react }));
const { TrafficRadarView } = await import("../components/TrafficRadar");
const { TelemetryFile } = await import("../components/TelemetryFile");

const snapshot: RadarSnapshot = { ok: true, sampledAt: 1700000000000, platform: "darwin", pollMs: 5000, status: "observing", processCount: 0, config: { sources: [], variables: [] }, alerts: [], connections: [] };
const file = (text: string, name = "telemetry.jsonl") => ({ name, size: text.length, text: async () => text });
const LINES = ['{"session_id":"session-one","event":"first"}', '{"session_id":"session-two","event":"second"}', "not json"].join("\n");
afterEach(() => { vi.unstubAllGlobals(); });

describe("the File view reads a saved telemetry file as 3.43.4 did", () => {
  it("opens a local file, lists its records, shows each one's original text and copies it", async () => {
    const sessions = vi.fn();
    const view = mount(TelemetryFile, { onSessions: sessions });
    const input = one(view.tree, e => e.props["aria-label"] === "Open telemetry file")!;
    expect(input.props.type).toBe("file");
    expect(input.props.accept).toBe(".json,.jsonl,.ndjson,application/json");
    const target = { files: [file(LINES)], value: "C:\\fakepath\\telemetry.jsonl" };
    (input.props.onChange as (e: unknown) => void)({ target });
    await vi.waitFor(() => expect(sessions).toHaveBeenCalledWith(["session-one", "session-two"]));
    expect(target.value).toBe("");
    const rows = () => all(view.tree, e => e.props.className === "tr-message");
    expect(rows()).toHaveLength(3);
    expect(textOf(rows()[2])).toContain("Invalid JSON");
    const shown = () => textOf(one(view.tree, e => e.type === "pre" && e.props.className === "tr-value"));
    expect(shown()).toBe(LINES.split("\n")[0]);
    (rows()[1].props.onClick as () => void)();
    expect(shown()).toBe(LINES.split("\n")[1]);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    (one(view.tree, e => e.type === "button" && textOf(e) === "Copy JSON")!.props.onClick as () => void)();
    expect(writeText).toHaveBeenCalledWith(LINES.split("\n")[1]);
    await vi.waitFor(() => expect(one(view.tree, e => e.type === "button" && textOf(e) === "Copied")).not.toBeNull());
    (one(view.tree, e => e.props["aria-label"] === "Search file contents")!.props.onChange as (e: unknown) => void)({ target: { value: "second" } });
    expect(rows()).toHaveLength(1);
    view.unmount();
  });

  it("filters by the session chosen in Radar, and refuses a file over 10 MB", async () => {
    const view = mount(TelemetryFile, { sessionFilter: "session-two" });
    const input = () => one(view.tree, e => e.props["aria-label"] === "Open telemetry file")!;
    (input().props.onChange as (e: unknown) => void)({ target: { files: [file(LINES)], value: "" } });
    await vi.waitFor(() => expect(all(view.tree, e => e.props.className === "tr-message")).toHaveLength(1));
    view.rerender({ sessionFilter: "unidentified" });
    expect(textOf(one(view.tree, e => e.props.className === "tr-message"))).toContain("Invalid JSON");
    (input().props.onChange as (e: unknown) => void)({ target: { files: [{ name: "big.json", size: 10 * 1024 * 1024 + 1, text: async () => "" }], value: "" } });
    await vi.waitFor(() => expect(textOf(view.tree)).toContain("Choose a file smaller than 10 MB."));
    view.unmount();
  });

  it("is Radar's third view, and the sessions a file names join Radar's session filter", () => {
    const view = mount(TrafficRadarView, { snapshot });
    (one(view.tree, e => e.props.id === "tr-tab-file")!.props.onClick as () => void)();
    const reader = () => one(view.tree, e => e.type === TelemetryFile)!;
    expect(one(view.tree, e => e.props.id === "tr-panel-file")!.props.hidden).toBe(false);
    (reader().props.onSessions as (ids: string[]) => void)(["file-session-0001"]);
    const select = () => one(view.tree, e => e.props["aria-label"] === "Session")!;
    expect(all(select(), e => e.type === "option").map(o => o.props.value)).toContain("file-session-0001");
    (select().props.onChange as (e: unknown) => void)({ target: { value: "file-session-0001" } });
    expect(reader().props.sessionFilter).toBe("file-session-0001");
    view.unmount();
  });
});

describe("Radar stays in the toolbar whatever Settings › Radar says", () => {
  it("is offered unconditionally, and no page polls the automatic-monitoring switch", () => {
    const app = sourceOf("App.tsx");
    expect(app).toMatch(/setTrafficRadarOpen: dialogs\.setTrafficRadarOpen,/);
    expect(app).not.toContain("use-radar-settings");
    expect(sourceOf("rail-items.tsx")).toMatch(/const radar: RailItem\[\] = setTrafficRadarOpen \? \[\{\s*id: "traffic-radar"/);
    expect(sourceOf("rail-items.tsx")).toMatch(/named\(t\("board\.rail\.group\.watchers"\), \[browserWatch, \.\.\.radar\]\)/);
  });
});
