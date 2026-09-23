import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectBursts } from "../components/ToolBursts";
import type { AgentNodeData } from "../types";
import { readRemovedNodes, removalHiddenIds, saveRemovedNodes, visibleBoard } from "../remove-node";

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

// ── the tool bubbles beside a removed card (#1237) ──────────────────────────
//
// The cards were filtered and the bubbles were not: `collectBursts` gates on
// the canvas's one visibility set, and removal never reached it, so a removed
// session's `Bash → cd` pairs stayed on the board with no card to hang from.

const NOW = 1_000_000;

function agent(id: string, sessionId: string, parentId?: string): AgentNodeData {
  return {
    id, sessionId, parentId, label: id, kind: parentId ? "subagent" : "root", state: "done",
    startedAt: NOW - 60_000, endedAt: NOW - 1_000,
    tools: [{ id: `${id}:t1`, name: "Bash", inputPreview: "", input: { command: "cd /repo" }, startedAt: NOW - 30_000, endedAt: NOW - 29_000, ok: true }],
    prompts: [], toolCount: 1, childCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  } as AgentNodeData;
}

const agents = new Map([
  ["s1", agent("s1", "s1")],
  ["s1::sub", agent("s1::sub", "s1", "s1")],
  ["s2", agent("s2", "s2")],
]);

/** The bubbles `<ToolBursts>` would draw for this visibility set. */
function bubbleOwners(visible: Set<string>): Set<string> {
  const at = new Map([...agents.keys()].map((id, i) => [id, { x: 0, y: i * 300 }]));
  const measured = new Map([...agents.keys()].map(id => [id, { width: 260, height: 130 }]));
  return new Set(collectBursts(agents, visible, at, new Map(), measured, NOW).map(b => b.agentId));
}

describe("what a removal takes off the canvas's visibility set (#1237)", () => {
  it("hides the removed agent, what descends from it, and every agent of a removed session", () => {
    expect([...removalHiddenIds(agents.values(), new Set(["s1::sub"]))]).toEqual(["s1::sub"]);
    expect([...removalHiddenIds(agents.values(), new Set(["s1"]))].sort()).toEqual(["s1", "s1::sub"]);
    expect(removalHiddenIds(agents.values(), new Set()).size).toBe(0);
  });

  it("leaves no tool bubbles for a removed session", () => {
    const all = new Set(agents.keys());
    // The premise: before the removal every agent's bubbles are drawn, so the
    // assertion after it cannot pass by drawing nothing at all.
    expect([...bubbleOwners(all)].sort()).toEqual(["s1", "s1::sub", "s2"]);

    const visible = new Set(all);
    for (const id of removalHiddenIds(agents.values(), new Set(["s1"]))) visible.delete(id);
    expect([...bubbleOwners(visible)]).toEqual(["s2"]);
  });
});

describe("the canvas wiring (#1237)", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

  it("works the removal out once, from the removed-node store", () => {
    expect(app).toMatch(/const removedAgentIds = useMemo\(\s*\(\) => removalHiddenIds\(stateRef\.current\.agents\.values\(\), removedNodes\),/);
  });

  it("subtracts it from the visibility set the cards AND the tool bubbles both gate on", () => {
    const memo = /const visibleAgentIds = useMemo<Set<string>>\([\s\S]*?\n  \);/.exec(app)?.[0] ?? "";
    expect(memo).toMatch(/for \(const id of removedAgentIds\) ids\.delete\(id\);/);
    expect(memo).toMatch(/removedAgentIds\],/);
    // The two readers of that set: the cards and the bubble overlay.
    expect(app).toMatch(/selectedIds, spotlightSet, visibleAgentIds, openContext,/);
    expect(app).toMatch(/<ToolBursts[\s\S]*?visibleAgentIds=\{visibleAgentIds\}/);
  });

  it("keeps the layout signature in step with it, so the board reflows around a removal", () => {
    const sig = /const layoutSig = useMemo\([\s\S]*?\n  \}, \[[^\]]*\]\);/.exec(app)?.[0] ?? "";
    expect(sig).toMatch(/if \(!isAgentVisible\(a, now\) \|\| removedAgentIds\.has\(a\.id\)\) continue;/);
    expect(sig).toMatch(/removedAgentIds\]\);$/);
  });
});
