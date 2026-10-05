// Panning a busy board rewrote every tool bubble and connector on every frame.
//
// The burst layer folded the camera into each bubble's left, top and scale and
// into each connector's path, so a pan or zoom frame restyled all of them: on a
// board of 751 bubbles, 40 wheel steps made about 60,000 DOM writes against 244
// with the bubbles hidden, and the frame rate fell from 59 to 34–45. The cards
// do not work that way — React Flow moves them with one transform on its
// viewport — and neither do the session boxes since #353.
//
// Rendered, not read: the bubbles come from collectBursts and the layer is drawn
// by react-dom/server at two cameras. What a bubble or a connector draws must
// not depend on the camera; the camera is one transform per layer.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentNodeData, ToolCall } from "../types";

const camera = vi.hoisted(() => ({ x: 0, y: 0, zoom: 1 }));
vi.mock("reactflow", () => ({ useViewport: () => ({ ...camera }) }));

const { default: ToolBursts } = await import("../components/ToolBursts");
const { collectBursts } = await import("../burst-layout");

const NOW = 1_700_000_000_000;
const call = (id: string, name: string, ok?: boolean): ToolCall => ({
  id, name, inputPreview: "", input: name === "Bash" ? { command: "npm test" } : { file_path: "/repo/a.ts" },
  startedAt: NOW - 30_000, endedAt: ok === undefined ? undefined : NOW - 29_000, ok, agentId: "",
});
const agent = (id: string, sessionId: string, parentId?: string): AgentNodeData => ({
  id, sessionId, parentId, label: id, kind: parentId ? "subagent" : "root", state: "active",
  startedAt: NOW - 60_000,
  tools: [call(`${id}:1`, "Read", true), call(`${id}:2`, "Bash", false), call(`${id}:3`, "Edit", true), call(`${id}:4`, "Bash")],
  prompts: [], toolCount: 4, childCount: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
} as unknown as AgentNodeData);

const agents = new Map([
  ["s1", agent("s1", "s1")],
  ["s1::a", agent("s1::a", "s1", "s1")],
  ["s2", agent("s2", "s2")],
]);
const visible = new Set(agents.keys());
const positions = new Map([...agents.keys()].map((id, i) => [id, { x: 40 + i * 520, y: 60 + i * 210 }]));
const measured = new Map([...agents.keys()].map(id => [id, { width: 260, height: 130 }]));
const props = { agents, visibleAgentIds: visible, positions, pinned: new Map(), measured, now: NOW, onOpenTool: () => {} };

function drawAt(x: number, y: number, zoom: number) {
  Object.assign(camera, { x, y, zoom });
  const html = renderToStaticMarkup(createElement(ToolBursts, props));
  return {
    html,
    wraps: [...html.matchAll(/<div class="tool-burst-wrap" style="([^"]*)"/g)].map(m => m[1]),
    paths: [...html.matchAll(/<path [^>]*class="tool-conn[^"]*"[^>]*>/g)].map(m => m[0]),
  };
}

describe("the tool-bubble layer and the camera", () => {
  const home = drawAt(0, 0, 1);
  const panned = drawAt(-340, 120, 0.5);

  it("draws every bubble and connector the same wherever the camera is", () => {
    // The premise: there is a board's worth of each to compare.
    expect(home.wraps.length).toBeGreaterThanOrEqual(9);
    expect(home.paths).toHaveLength(home.wraps.length);
    expect(panned.wraps).toEqual(home.wraps);
    expect(panned.paths).toEqual(home.paths);
  });

  it("carries the camera once per layer, as React Flow carries the cards", () => {
    expect(panned.html.split("translate(-340px, 120px) scale(0.5)")).toHaveLength(2);
    expect(panned.html.split('transform="translate(-340 120) scale(0.5)"')).toHaveLength(2);
  });

  it("puts each bubble at its world position, which the camera then maps to the screen", () => {
    const bursts = collectBursts(agents, visible, positions, new Map(), measured, NOW);
    expect(panned.wraps).toHaveLength(bursts.length);
    bursts.forEach((b, n) => {
      expect(panned.wraps[n]).toContain(`left:${b.worldX}px`);
      expect(panned.wraps[n]).toContain(`top:${b.worldY}px`);
    });
  });

  it("keeps a connector's stroke in screen pixels at any zoom", () => {
    for (const p of panned.paths) expect(p).toContain('vector-effect="non-scaling-stroke"');
  });
});
