// V4 top-10, the Inspector's next step, pressed: Answer and Open call the
// deck's opener with this session's id, once, and Show recap beside them still
// opens the recap and nothing else. Detail runs on fake-react, so a press is a
// call of the handler it drew (what the row looks like, per state, is
// v4-inspector-next-step.test.ts).
import { describe, expect, it, vi } from "vitest";
import { mount, all, textOf, type Drawn } from "./fake-react";
vi.mock("react", async () => (await import("./fake-react")).react);
const { default: Detail } = await import("../components/Detail");
import type { AgentNodeData } from "../types";

const USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
const A = (over: Partial<AgentNodeData> = {}) => ({
  id: "sess-1", sessionId: "sess-1", label: "api", kind: "root", state: "active", childCount: 0, toolCount: 3,
  tools: [], usage: USAGE, prompts: [{ text: "Ship it", at: 1200 }], startedAt: 1000, ...over,
}) as unknown as AgentNodeData;
const WAITING = A({ waiting: { kind: "permission", message: "Claude needs your permission to use Bash", since: 1500 } });

const drawn = (agent: AgentNodeData) => {
  const p = { onOpenSession: vi.fn(), onShowSummary: vi.fn() };
  const view = mount(Detail, { agent, now: 30_000, onOpenTool: () => {}, onExportSession: () => {}, onRemove: () => {}, ...p });
  const button = (text: string) => {
    const hits = all(view.tree, e => e.type === "button" && textOf(e) === text);
    expect(hits, text).toHaveLength(1);
    return hits[0];
  };
  return { p, view, button };
};
const press = (b: Drawn) => (b.props.onClick as () => void)();

describe("the next step, pressed", () => {
  it("Answer opens this session through the opener, once, with its id", () => {
    const { p, view, button } = drawn(WAITING);
    press(button("Answer"));
    expect(p.onOpenSession).toHaveBeenCalledTimes(1);
    expect(p.onOpenSession).toHaveBeenCalledWith("sess-1");
    expect(p.onShowSummary).not.toHaveBeenCalled();
    view.unmount();
  });

  it("Open does the same for a session that is not waiting", () => {
    const { p, view, button } = drawn(A());
    press(button("Open"));
    expect(p.onOpenSession).toHaveBeenCalledTimes(1);
    expect(p.onOpenSession).toHaveBeenCalledWith("sess-1");
    view.unmount();
  });

  it("Show recap beside Open still opens the recap, and opens no session", () => {
    const { p, view, button } = drawn(A({ state: "done", endedAt: 5000 }));
    press(button("Show recap"));
    expect(p.onShowSummary).toHaveBeenCalledWith("sess-1");
    expect(p.onOpenSession).not.toHaveBeenCalled();
    view.unmount();
  });

  it("is a native button nothing takes out of the Tab order, so Enter and Space are its click", () => {
    const { view, button } = drawn(WAITING);
    const b = button("Answer");
    expect(b.props.type).toBe("button");
    expect(b.props.tabIndex).toBeUndefined();
    expect(b.props.disabled).toBeUndefined();
    expect(b.props["aria-disabled"]).toBeUndefined();
    expect(b.props.onKeyDown).toBeUndefined();
    view.unmount();
  });
});
