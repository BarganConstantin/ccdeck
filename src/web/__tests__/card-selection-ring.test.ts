// A selected card drew no ring, by mouse or by keyboard.
//
// AgentNode put `.selected` on the card from React Flow's own `selected` prop,
// and React Flow never sets it here: the canvas hands it a controlled `nodes`
// array with no onNodesChange, so its click and keyboard selection write to a
// store that a controlled board skips. The sheet's ring — `.agent-node.selected`
// up close, its `.lod-face` twin at a distance — therefore matched nothing, and
// on a one-session board, where nothing dims, only the topbar ribbon said what
// was selected. Shift+clicking a second card of the same session changed
// nothing on the canvas at all.
//
// The frame knows the selection — it is one of snapshotToFlow's inputs — so it
// marks the selected nodes' wrappers itself, beside rf-exiting and
// rf-spotlit-out, and the ring is drawn from that mark. Not `node.selected`:
// React Flow would then drag every selected node together, against
// use-node-drag's patch.
import { describe, expect, it } from "vitest";
import { snapshotToFlow } from "../canvas-flow";
import { initialState, type GraphState } from "../reducer";
import type { AgentNodeData } from "../types";
import { sheetText } from "./sheet-source";

const agent = (id: string): AgentNodeData => ({
  id,
  sessionId: id.split("::")[0],
  label: id,
  kind: id.includes("::") ? "subagent" : "root",
  parentId: id.includes("::") ? id.split("::")[0] : undefined,
  state: "active",
  startedAt: 1_000,
  tools: [],
  prompts: [],
  toolCount: 0,
  childCount: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
} as AgentNodeData);

function board(...ids: string[]): GraphState {
  const state = initialState();
  for (const id of ids) state.agents.set(id, agent(id));
  state.revision = 1;
  return state;
}

const onOpenContext = () => {};

/** Each card's wrapper classes in one frame with `selected` selected. */
function classes(state: GraphState, selected: string[]): Record<string, string[]> {
  const { nodes } = snapshotToFlow(
    state, 3_000, 4_000, 2_000, new Map(), new Map(), new Map(), () => {},
    true, false, new Map(), new Set(), "sig", { current: "" },
    new Set(selected), null, new Set(state.agents.keys()), onOpenContext, true, new Set(),
  );
  return Object.fromEntries(nodes.map(n => [n.id, (n.className ?? "").split(/\s+/).filter(Boolean)]));
}

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

function decl(selector: string, prop: string): string | null {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  const body = re.exec(css)?.[1];
  if (body == null) return null;
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "m").exec(body);
  return m ? m[1].trim() : null;
}

describe("a selected card says so on the canvas", () => {
  it("marks the selected card's wrapper, and no other", () => {
    const c = classes(board("s1"), ["s1"]);
    expect(c.s1).toContain("rf-selected");
    expect(classes(board("s1"), []).s1).not.toContain("rf-selected");
  });

  it("marks every card of a multi-selection inside one session", () => {
    // The case that changed nothing at all: one session, so no spotlight dims
    // anything, and Shift+click only moved the ribbon's +N.
    const c = classes(board("s1", "s1::a", "s1::b"), ["s1::a", "s1::b"]);
    expect(c["s1::a"]).toContain("rf-selected");
    expect(c["s1::b"]).toContain("rf-selected");
    expect(c.s1).not.toContain("rf-selected");
  });

  it("draws the deck's ring and lift from that mark, up close and on the far face", () => {
    expect(decl(".react-flow__node.rf-selected .agent-node", "outline")).toBe("2px solid var(--accent)");
    expect(decl(".react-flow__node.rf-selected .agent-node", "outline-offset")).toBe("2px");
    expect(decl(".react-flow__node.rf-selected .agent-node", "box-shadow")).toBe("var(--shadow-2)");
    expect(decl(".react-flow__node.rf-selected .agent-node > .lod-face", "outline")).toBe("2px solid var(--accent)");
  });

  it("keeps the ring in a forced-colours theme, in the highlight the session list's selected row wears", () => {
    const forced = /@media \(forced-colors: active\) \{([\s\S]*)$/.exec(css)?.[1] ?? "";
    expect(forced).toMatch(/\.react-flow__node\.rf-selected \.agent-node,\s*\.react-flow__node\.rf-selected \.agent-node > \.lod-face \{ outline-color: Highlight; \}/);
  });
});
