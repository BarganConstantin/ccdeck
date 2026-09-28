// The layout's structural signature, run rather than read: layout reruns only
// when it moves, so what it counts is what can reflow the board and what it
// leaves out can never reflow it.
import { describe, it, expect } from "vitest";
import { layoutSignature } from "../layout-signature";
import type { AgentNodeData } from "../types";
import { EXIT_ANIM_MS } from "../visibility";

const agent = (id: string, extra: Partial<AgentNodeData> = {}): AgentNodeData =>
  ({ id, kind: "sub", state: "active", tools: [], startedAt: 0, ...extra }) as AgentNodeData;
const NOW = 100_000;
const none = new Set<string>();

describe("layoutSignature", () => {
  it("names each visible agent under its parent, sorted, with both size versions", () => {
    const sig = layoutSignature([agent("b", { parentId: "a" }), agent("a", { kind: "root" })], NOW, none, 3, 7);
    expect(sig).toBe("a|b>a#sv3.7");
  });

  it("does not depend on the order the board holds the agents in", () => {
    const one = [agent("a"), agent("c"), agent("b", { parentId: "a" })];
    expect(layoutSignature(one, NOW, none, 0, 0)).toBe(layoutSignature([...one].reverse(), NOW, none, 0, 0));
  });

  it("moves when a card changes size, through either counter", () => {
    const board = [agent("a")];
    const at = layoutSignature(board, NOW, none, 1, 1);
    expect(layoutSignature(board, NOW, none, 2, 1)).not.toBe(at);
    expect(layoutSignature(board, NOW, none, 1, 2)).not.toBe(at);
  });

  it("leaves out an agent Remove node has taken off the board", () => {
    expect(layoutSignature([agent("a"), agent("b")], NOW, new Set(["b"]), 0, 0)).toBe("a#sv0.0");
  });

  it("agrees with isAgentVisible: an exit past its animation is gone, one still animating is not", () => {
    const leaving = agent("x", { exitAt: NOW - EXIT_ANIM_MS + 1 });
    const gone = agent("y", { exitAt: NOW - EXIT_ANIM_MS - 1 });
    expect(layoutSignature([leaving, gone], NOW, none, 0, 0)).toBe("x#sv0.0");
  });

  it("is only the size versions for an empty board", () => {
    expect(layoutSignature([], NOW, none, 4, 5)).toBe("#sv4.5");
  });
});
