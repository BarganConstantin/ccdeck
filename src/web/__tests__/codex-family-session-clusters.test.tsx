import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentNodeData } from "../types";

const store = vi.hoisted(() => ({ nodes: new Map<string, unknown>() }));
vi.mock("react", async importOriginal => {
  const React = await importOriginal<typeof import("react")>();
  return { ...React, useLayoutEffect: React.useEffect };
});
vi.mock("reactflow", () => ({
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  useStore: (selector: (state: unknown) => unknown) => selector({
    width: 1200,
    height: 800,
    domNode: { querySelector: () => ({}) },
    nodeInternals: store.nodes,
  }),
}));
vi.mock("react-dom", async importOriginal => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (children: unknown) => children,
}));

const { default: SessionClusters } = await import("../components/SessionClusters");

function card(id: string, sessionId: string, provider: "claude" | "codex", kind: "root" | "subagent", parentId?: string, x = 0) {
  const data = {
    id, sessionId, provider, kind, parentId,
    label: kind === "root" ? `${provider}-workspace` : "Explore",
    state: "active", startedAt: 1, tools: [], prompts: [], toolCount: 0, childCount: 0,
  } as AgentNodeData;
  return [id, { id, type: "agent", position: { x, y: 80 }, width: 240, height: 130, data }];
}

function html(...nodes: ReturnType<typeof card>[]) {
  store.nodes = new Map(nodes);
  return renderToStaticMarkup(createElement(SessionClusters, { onFocusSession: () => {} }));
}

describe("SessionClusters renders a lone multi-agent Codex family", () => {
  it("renders one enclosure and the root workspace title around the family", () => {
    const output = html(
      card("codex-root", "root-session", "codex", "root", undefined, 0),
      card("codex-child", "child-session", "codex", "subagent", "codex-root", 320),
    );
    expect(output.match(/class="cluster-card"/g)).toHaveLength(1);
    expect(output.match(/class="cluster-label"/g)).toHaveLength(1);
    expect(output).toContain("codex-workspace");
  });

  it("keeps a lone ordinary Codex root and a lone Claude session hidden", () => {
    expect(html(card("codex-root", "root-session", "codex", "root"))).toBe("");
    expect(html(card("claude-root", "claude-session", "claude", "root"))).toBe("");
  });

  it("continues to show separate Claude session frames when there are multiple sessions", () => {
    const output = html(
      card("claude-a", "claude-a", "claude", "root"),
      card("claude-b", "claude-b", "claude", "root", undefined, 500),
    );
    expect(output.match(/class="cluster-card"/g)).toHaveLength(2);
    expect(output.match(/class="cluster-label"/g)).toHaveLength(2);
  });
});
