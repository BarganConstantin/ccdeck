import { describe, expect, it } from "vitest";
import { readRemovedNodes, saveRemovedNodes, visibleBoard } from "../remove-node";

const nodes = [
  { id: "a", data: { sessionId: "a" } },
  { id: "a::child", data: { sessionId: "a", parentId: "a" } },
  { id: "a::grandchild", data: { sessionId: "a", parentId: "a::child" } },
  { id: "b", data: { sessionId: "b" } },
];
const edges = [
  { source: "a", target: "a::child" },
  { source: "a::child", target: "a::grandchild" },
];

describe("removing a single board node", () => {
  it("removes only the selected child and its descendants, leaving other sessions alone", () => {
    const result = visibleBoard(nodes, edges, new Set(["a::child"]));
    expect(result.nodes.map(node => node.id)).toEqual(["a", "b"]);
    expect(result.edges).toEqual([]);
  });

  it("removes a whole session when its root is selected", () => {
    expect(visibleBoard(nodes, edges, new Set(["a"])).nodes.map(node => node.id)).toEqual(["b"]);
  });

  it("keeps the rest of the graph unchanged when nothing is removed", () => {
    expect(visibleBoard(nodes, edges, new Set())).toEqual({ nodes, edges });
  });

  it("persists hidden IDs without mixing them with the graph data", () => {
    const values = new Map<string, string>();
    const store = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    saveRemovedNodes(store, new Set(["a::child"]));
    expect([...readRemovedNodes(store)]).toEqual(["a::child"]);
    expect(readRemovedNodes({ getItem: () => "not json" }).size).toBe(0);
  });
});
