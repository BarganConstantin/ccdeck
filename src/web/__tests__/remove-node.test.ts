import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectBursts } from "../components/ToolBursts";
import type { AgentNodeData } from "../types";
import { readRemovedNodes, removalHiddenIds, saveRemovedNodes, sessionsCalledBack, visibleBoard, withoutRemovals } from "../remove-node";
import { AUTO_PAN_EDGE_PX, clientPointOf, distanceToRect, pointInRect, trashProximity, TRASH_HIT_SLOP_PX, TRASH_NEAR_PX } from "../trash-zone";

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

// ── undo, the way back, and the alarm (the audit of #1210) ─────────────────
//
// Remove node shipped as one click in the topbar with no undo, and the only
// way back was Clear. A removed session that started waiting was still counted
// by the alarm and still listed, and clicking either selected a card that was
// not drawn.

describe("bringing removed cards back", () => {
  it("takes the named ids out and leaves the rest removed", () => {
    const removed = new Set(["a", "b::sub", "c"]);
    expect([...withoutRemovals(removed, ["a", "c"])]).toEqual(["b::sub"]);
    // A new set: the old one is React state and is never mutated.
    expect([...removed]).toEqual(["a", "b::sub", "c"]);
  });

  it("answers with the same set when nothing it names was removed, so the caller can skip the write", () => {
    const removed = new Set(["a"]);
    expect(withoutRemovals(removed, ["b", "c"])).toBe(removed);
    expect(withoutRemovals(removed, [])).toBe(removed);
  });

  it("calls a removed session back when it starts waiting, and only that one", () => {
    const hidden = new Set(["s1", "s1::sub", "s3"]);
    expect(sessionsCalledBack([{ id: "s1" }, { id: "s2" }], hidden)).toEqual(["s1"]);
    expect(sessionsCalledBack([{ id: "s2" }], hidden)).toEqual([]);
    expect(sessionsCalledBack([{ id: "s1" }], new Set())).toEqual([]);
  });
});

describe("drag-to-trash hit testing", () => {
  const target = { left: 400, right: 620, top: 700, bottom: 758 };

  it("removes only when the pointer release lands inside the target", () => {
    expect(pointInRect({ clientX: 510, clientY: 729 }, target)).toBe(true);
    expect(pointInRect({ clientX: 399, clientY: 729 }, target)).toBe(false);
    expect(pointInRect({ clientX: 510, clientY: 699 }, target)).toBe(false);
  });

  it("counts the visible edge as part of the generous target", () => {
    expect(pointInRect({ clientX: 400, clientY: 700 }, target)).toBe(true);
    expect(pointInRect({ clientX: 620, clientY: 758 }, target)).toBe(true);
  });

  it("reaches a little past the visible edge, so a release just outside still removes", () => {
    expect(pointInRect({ clientX: 400 - TRASH_HIT_SLOP_PX, clientY: 729 }, target, TRASH_HIT_SLOP_PX)).toBe(true);
    expect(pointInRect({ clientX: 400 - TRASH_HIT_SLOP_PX - 1, clientY: 729 }, target, TRASH_HIT_SLOP_PX)).toBe(false);
  });

  it("says far, near or over from the pointer's distance to the target", () => {
    expect(trashProximity({ clientX: 510, clientY: 729 }, target)).toBe("over");
    expect(trashProximity({ clientX: 510, clientY: 700 - TRASH_HIT_SLOP_PX }, target)).toBe("over");
    expect(trashProximity({ clientX: 510, clientY: 700 - TRASH_NEAR_PX }, target)).toBe("near");
    expect(trashProximity({ clientX: 510, clientY: 700 - TRASH_NEAR_PX - 1 }, target)).toBe("far");
    expect(distanceToRect({ clientX: 397, clientY: 696 }, target)).toBe(5);
  });

  it("keeps the whole target clear of the band where React Flow pans the board", () => {
    const sheet = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
    const rule = /\.drag-trash-zone \{([^}]*)\}/.exec(sheet)?.[1] ?? "";
    const bottom = Number(/\bbottom:\s*(\d+)px/.exec(rule)?.[1]);
    expect(bottom - TRASH_HIT_SLOP_PX).toBeGreaterThan(AUTO_PAN_EDGE_PX);
  });

  it("reads the release point of a touch drag from changedTouches", () => {
    expect(clientPointOf({ clientX: 3, clientY: 4 })).toEqual({ clientX: 3, clientY: 4 });
    expect(clientPointOf({ changedTouches: [{ clientX: 7, clientY: 8 }] })).toEqual({ clientX: 7, clientY: 8 });
    expect(clientPointOf({})).toBeNull();
  });
});

describe("where Remove lives and what follows it", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const list = readFileSync(fileURLToPath(new URL("../components/SessionList.tsx", import.meta.url)), "utf8");
  const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

  it("is gone from the topbar and sits with the card's own verbs in the detail panel", () => {
    expect(app).not.toMatch(/>\s*Remove node\s*</);
    const detail = /function Detail\([\s\S]*?\n}\n/.exec(app)?.[0] ?? "";
    expect(detail).toMatch(/className="btn hero-action-btn"\s+onClick=\{onRemove\}[\s\S]*?>Remove from board<\/button>/);
    expect(app).toMatch(/onRemove=\{removeSelectedNode\}/);
    // Undoable, so not dressed as the one destructive .btn the sheet reserves
    // red for.
    expect(detail).not.toMatch(/btn danger[^"]*"\s+onClick=\{onRemove\}/);
  });

  it("is one key from a selection, since a plain click shuts the panel it lives in", () => {
    expect(app).toMatch(/if \(e\.key === "Delete"\) removeSelectedRef\.current\(\);/);
    expect(app).toMatch(/removeSelectedRef\.current = removeSelectedNode;/);
  });

  it("offers Undo, names it for what it undoes, and moves focus onto it", () => {
    expect(app).toMatch(/className="ver-banner note"/);
    expect(app).toMatch(/aria-label=\{`Undo removing \$\{removalNotice\.label\}`\}\s+onClick=\{undoRemoval\}\s*>Undo<\/button>/);
    expect(app).toMatch(/if \(lastRemoval\) \(undoRef\.current \?\? canvasRef\.current\)\?\.focus\(\);/);
  });

  it("says the removal through a region that is mounted before the words arrive", () => {
    expect(app).toMatch(/<div className="vis-hidden" role="status" aria-atomic="true">\s*\{removalNotice \? `\$\{removalNotice\.label\} removed from the board\.` : ""\}/);
  });

  it("puts a card back where it was on Undo, with its selection", () => {
    const undo = /const undoRemoval = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/.exec(app)?.[0] ?? "";
    expect(undo).toMatch(/if \(pin\) pinnedRef\.current\.set\(id, pin\);/);
    expect(undo).toMatch(/if \(position\) positionsRef\.current\.set\(id, position\);/);
    expect(undo).toMatch(/selectAgent\(id, false\)/);
  });

  it("brings a waiting session back instead of leaving the alarm pointing at nothing", () => {
    expect(app).toMatch(/const back = sessionsCalledBack\(waitingSessions, removedAgentIds\);\s*if \(back\.length > 0\) bringBack\(back\);/);
  });

  it("keeps a removed session in the session list, marked, as the way back", () => {
    expect(app).toMatch(/onSelect=\{openSession\}[\s\S]*?removedIds=\{removedAgentIds\}/);
    expect(app).toMatch(/if \(removedAgentIds\.has\(sessionId\)\) bringBack\(\[sessionId\]\);\s*focusSession\(sessionId\);/);
    expect(list).toMatch(/\{removed && <span className="sl-removed">off the board<\/span>\}/);
    expect(list).toMatch(/Bring back \{count\} removed \{count === 1 \? "card" : "cards"\}/);
    expect(css).toMatch(/\.session-list \.sl-row\.removed \.sl-label \{ color: var\(--muted\); \}/);
  });

  it("forgets the Undo on Clear", () => {
    const clear = /const handleClear = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/.exec(app)?.[0] ?? "";
    expect(clear).toMatch(/setLastRemoval\(null\);/);
  });
});
