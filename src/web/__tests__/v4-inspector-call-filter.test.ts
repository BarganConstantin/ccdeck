// V4 critique 3: Activity and Tool calls are one section, and the kind chips
// under its heading filter the list under them. One kind at a time; the chip
// pressed again shows every call.
import { describe, it, expect, vi } from "vitest";
import { all, mount, one, type Drawn } from "./fake-react";
vi.mock("react", async () => (await import("./fake-react")).react);
const { ToolCalls } = await import("../components/Detail");
import type { AgentNodeData, ToolCall } from "../types";

const call = (id: string, name: string, at: number): ToolCall => ({ id, name, inputPreview: "", startedAt: at, endedAt: at + 10, ok: true });
const agent = (over: Partial<AgentNodeData> = {}) => ({
  id: "s", sessionId: "s", label: "s", kind: "root", state: "active", childCount: 0, startedAt: 0, prompts: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  tools: [call("t1", "Read", 100), call("t2", "Bash", 200), call("t3", "Edit", 300)],
  toolCount: 3, toolCountByName: new Map([["Read", 1], ["Bash", 1], ["Edit", 1]]),
  ...over,
}) as unknown as AgentNodeData;

const chips = (tree: unknown) => all(tree, el => el.type === "button" && el.props.className === "call-kind");
const chipFor = (tree: unknown, kind: string) =>
  chips(tree).find(b => (b.props.children as Drawn).props.c === kind)!;
const press = (tree: unknown, kind: string) => (chipFor(tree, kind).props.onClick as () => void)();
const rows = (tree: unknown) =>
  all(tree, el => typeof el.type === "function" && (el.type as { name: string }).name === "ToolRow").map(el => (el.props.call as ToolCall).id);
const pressed = (tree: unknown) => chips(tree).filter(b => b.props["aria-pressed"] === true).map(b => (b.props.children as Drawn).props.c);

describe("the kind chips filter the calls", () => {
  it("are buttons in a named group, under the one heading, none pressed at first", () => {
    const view = mount(ToolCalls, { agent: agent(), onOpenTool: () => {} });
    const group = one(view.tree, el => el.props.role === "group")!;
    expect(group.props.className).toBe("cat-strip");
    expect(group.props["aria-label"]).toBe("Filter calls by kind");
    expect(chips(view.tree).map(b => b.props.type)).toEqual(["button", "button"]);
    expect(chips(view.tree).map(b => b.props["aria-pressed"])).toEqual([false, false]);
    expect(rows(view.tree)).toEqual(["t3", "t2", "t1"]);
  });

  it("keeps the list to one kind, one at a time, and shows every call when pressed again", () => {
    const view = mount(ToolCalls, { agent: agent(), onOpenTool: () => {} });
    press(view.tree, "file");
    expect(pressed(view.tree)).toEqual(["file"]);
    expect(rows(view.tree)).toEqual(["t3", "t1"]);
    press(view.tree, "shell");
    expect(pressed(view.tree)).toEqual(["shell"]);
    expect(rows(view.tree)).toEqual(["t2"]);
    press(view.tree, "shell");
    expect(pressed(view.tree)).toEqual([]);
    expect(rows(view.tree)).toEqual(["t3", "t2", "t1"]);
  });

  it("counts every call in the heading, and says so when the list holds fewer", () => {
    // 250 calls over the agent's life; the deck keeps the last three.
    const long = agent({ toolCount: 250, toolCountByName: new Map([["Read", 200], ["Bash", 49], ["Edit", 1]]) });
    const view = mount(ToolCalls, { agent: long, onOpenTool: () => {} });
    const count = one(view.tree, el => el.props.className === "section-count")!;
    expect(count.props.children).toBe(250);
    const note = () => all(view.tree, el => el.props.className === "empty").map(el => el.props.children);
    expect(note()).toEqual(["Older calls are not listed."]);
    press(view.tree, "shell");
    expect(rows(view.tree)).toEqual(["t2"]);
    expect(note()).toEqual(["Older calls are not listed."]);
  });

  it("says nothing more when the list holds every call of the kind", () => {
    const view = mount(ToolCalls, { agent: agent(), onOpenTool: () => {} });
    expect(all(view.tree, el => el.props.className === "empty")).toEqual([]);
    press(view.tree, "file");
    expect(all(view.tree, el => el.props.className === "empty")).toEqual([]);
  });
});
