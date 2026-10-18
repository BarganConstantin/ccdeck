import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Node } from "reactflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../reducer";
import { useNodeDrag } from "../use-node-drag";
import { saveLayout } from "../layout-storage";

vi.mock("../layout-storage", () => ({ saveLayout: vi.fn() }));
vi.mock("../components/SessionPeek", () => ({ hidePeek: vi.fn() }));

const event = { clientX: 120, clientY: 80 };
const node = (id = "agent", type = "agent", x = 10, y = 20): Node => ({
  id, type, position: { x, y }, data: { sessionId: "session" },
});

function mount(nodes: Node[] = [node()]) {
  const input = {
    nodes, stateRef: { current: initialState() },
    pinnedRef: { current: new Map<string, { x: number; y: number }>() },
    positionsRef: { current: new Map(nodes.map(n => [n.id, { ...n.position }])) },
    draggingRef: { current: false },
    dragPatchRef: { current: null as Map<string, { x: number; y: number }> | null },
    setDragging: vi.fn(), setDragMoveTick: vi.fn(), setDragTick: vi.fn(),
    endBubble: vi.fn(), markInteract: vi.fn(), disableAutoFit: vi.fn(),
    beginTrashDrag: vi.fn(), trackTrashDrag: vi.fn(), endTrashDrag: vi.fn(() => false), removeNode: vi.fn(),
  };
  let drag!: ReturnType<typeof useNodeDrag>;
  function Harness() { drag = useNodeDrag(input); return null; }
  renderToStaticMarkup(createElement(Harness));
  // React Flow's type promises Node, but its find-by-id can return undefined
  // when the controlled node disappears during a gesture. Exercise that call.
  const call = (phase: keyof typeof drag, value?: Node) => Reflect.apply(drag[phase], undefined, [event, value, []]);
  return { input, call };
}

beforeEach(() => vi.clearAllMocks());

describe("drag callbacks whose node has disappeared", () => {
  it("ignores an unresolvable drag start", () => {
    const { input, call } = mount();
    expect(() => call("onNodeDragStart")).not.toThrow();
    expect(input.draggingRef.current).toBe(false);
    expect(input.beginTrashDrag).not.toHaveBeenCalled();
  });

  it("ignores a missing node during movement without corrupting the last good position", () => {
    const { input, call } = mount();
    call("onNodeDragStart", node());
    call("onNodeDrag", node("agent", "agent", 40, 60));
    expect(() => call("onNodeDrag")).not.toThrow();
    expect(input.positionsRef.current.get("agent")).toEqual({ x: 40, y: 60 });
    expect(input.trackTrashDrag).toHaveBeenCalledTimes(1);
    expect(input.removeNode).not.toHaveBeenCalled();
  });

  it("a missing drag-stop node still clears drag and trash state and saves valid positions", () => {
    const { input, call } = mount();
    call("onNodeDragStart", node());
    call("onNodeDrag", node("agent", "agent", 40, 60));
    expect(() => call("onNodeDragStop")).not.toThrow();
    expect(input.endTrashDrag).toHaveBeenCalledWith(event, false);
    expect(input.draggingRef.current).toBe(false);
    expect(input.dragPatchRef.current).toBeNull();
    expect(input.setDragging).toHaveBeenLastCalledWith(false);
    expect(saveLayout).toHaveBeenCalledWith(input.positionsRef.current, input.pinnedRef.current);
    expect([...input.pinnedRef.current.keys()]).toEqual(["agent"]);
    expect(input.removeNode).not.toHaveBeenCalled();
  });

  it("clears the previous group snapshot after an interrupted session drag", () => {
    const group = node("group", "sessionGroup", 0, 0);
    const { input, call } = mount([group, node()]);
    call("onNodeDragStart", group);
    call("onNodeDrag", node("group", "sessionGroup", 30, 40));
    expect(() => call("onNodeDragStop")).not.toThrow();
    const last = { ...input.positionsRef.current.get("agent")! };
    call("onNodeDrag", node("group", "sessionGroup", 80, 90));
    expect(input.positionsRef.current.get("agent")).toEqual(last);
  });

  it("keeps normal drag movement, final pinning and persistence", () => {
    const { input, call } = mount();
    call("onNodeDragStart", node());
    call("onNodeDrag", node("agent", "agent", 40, 60));
    call("onNodeDragStop", node("agent", "agent", 45, 65));
    expect(input.pinnedRef.current.get("agent")).toEqual({ x: 45, y: 65 });
    expect(saveLayout).toHaveBeenCalledTimes(1);
    expect(input.draggingRef.current).toBe(false);
  });

  it("keeps intentional drop-to-trash removal", () => {
    const { input, call } = mount();
    input.endTrashDrag.mockReturnValue(true);
    call("onNodeDragStart", node());
    call("onNodeDragStop", node());
    expect(input.removeNode).toHaveBeenCalledWith("agent");
    expect(saveLayout).not.toHaveBeenCalled();
  });

  it("keeps normal session-group movement and persistence", () => {
    const group = node("group", "sessionGroup", 0, 0);
    const { input, call } = mount([group, node()]);
    call("onNodeDragStart", group);
    call("onNodeDrag", node("group", "sessionGroup", 30, 40));
    call("onNodeDragStop", node("group", "sessionGroup", 35, 45));
    expect(input.positionsRef.current.get("agent")).toEqual({ x: 45, y: 65 });
    expect(input.endTrashDrag).toHaveBeenCalledWith(event, true);
    expect(input.draggingRef.current).toBe(false);
    expect(saveLayout).toHaveBeenCalledTimes(1);
    expect(input.removeNode).not.toHaveBeenCalled();
  });
});

describe("dragging a session's box to the trash", () => {
  const withRoot = (input: ReturnType<typeof mount>["input"]) => {
    input.stateRef.current.agents.set("session", { id: "session", label: "web-api" } as never);
  };

  it("raises the trash under the session's name and follows the pointer", () => {
    const group = node("group", "sessionGroup", 0, 0);
    const { input, call } = mount([group, node()]);
    withRoot(input);
    call("onNodeDragStart", group);
    call("onNodeDrag", node("group", "sessionGroup", 30, 40));
    expect(input.beginTrashDrag).toHaveBeenCalledWith("web-api");
    expect(input.trackTrashDrag).toHaveBeenCalledWith(event);
  });

  it("removes the whole session and puts its cards back where the drag found them", () => {
    const group = node("group", "sessionGroup", 0, 0);
    const pinned = node("pinned", "agent", 100, 200);
    const { input, call } = mount([group, node(), pinned]);
    withRoot(input);
    input.pinnedRef.current.set("pinned", { x: 100, y: 200 });
    input.endTrashDrag.mockReturnValue(true);
    call("onNodeDragStart", group);
    call("onNodeDrag", node("group", "sessionGroup", 300, 400));
    call("onNodeDragStop", node("group", "sessionGroup", 300, 400));
    expect(input.removeNode).toHaveBeenCalledWith("session");
    expect(input.positionsRef.current.get("agent")).toEqual({ x: 10, y: 20 });
    expect(input.pinnedRef.current.has("agent")).toBe(false);
    expect(input.pinnedRef.current.get("pinned")).toEqual({ x: 100, y: 200 });
    expect(saveLayout).not.toHaveBeenCalled();
    expect(input.draggingRef.current).toBe(false);
  });

  it("leaves the trash down for a box whose session has no card to remove by", () => {
    const group = node("group", "sessionGroup", 0, 0);
    const { input, call } = mount([group, node()]);
    call("onNodeDragStart", group);
    expect(input.beginTrashDrag).toHaveBeenCalledWith(null);
  });
});
