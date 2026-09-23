// #853: a screen reader heard each agent card as one run-on string, was told
// "Press delete to remove it", and heard a different name at the far zoom tier.
//
// With no `ariaLabel`, React Flow names a node from its content: every word on
// the card with no separators, 67-125 characters, median 89. Its stock
// description promised arrow-key moves and Delete, and neither lands on a
// controlled graph with no onNodesChange. And at the far tier the card's details
// are `visibility: hidden`, which takes them out of the accessibility tree, so
// the announced name changed with zoom.
//
// agentAriaLabel composes the name from the data — so zoom cannot change it —
// and App.tsx turns React Flow's keyboard layer and delete key off.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentAriaLabel } from "../components/AgentNode";
import type { AgentNodeData } from "../types";

const card = (over: Partial<AgentNodeData> = {}): AgentNodeData => ({
  id: "s1", sessionId: "s1", label: "agents-deck", kind: "root", state: "active",
  startedAt: 0, tools: [], prompts: [], toolCount: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ...over,
} as unknown as AgentNodeData);

describe("a card's spoken name (#853)", () => {
  it("says name, kind and state first, separated so they can be heard apart", () => {
    expect(agentAriaLabel(card())).toBe("agents-deck, session, live, 0 tools");
    expect(agentAriaLabel(card({ kind: "subagent", state: "done" }))).toBe("agents-deck, subagent, done, 0 tools");
  });

  it("carries the waiting sentence when the session is blocked on the reader", () => {
    const blocked = card({ waiting: { since: 1, kind: "permission", message: "Claude needs your permission to use Bash" } } as Partial<AgentNodeData>);
    expect(agentAriaLabel(blocked)).toContain("Claude needs your permission to use Bash");
  });

  it("counts tools and failures the way the card does", () => {
    const tools = [{ ok: true }, { ok: false }, { ok: false }] as AgentNodeData["tools"];
    expect(agentAriaLabel(card({ tools, toolCount: 3 }))).toBe("agents-deck, session, live, 3 tools, 2 failed");
    expect(agentAriaLabel(card({ toolCount: 1 }))).toContain("1 tool");
  });

  it("stays short — a name, not the card read out", () => {
    const busy = card({ toolCount: 250, tools: Array.from({ length: 21 }, () => ({ ok: false })) as AgentNodeData["tools"] });
    expect(agentAriaLabel(busy).length).toBeLessThan(90);
  });
});

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const stripped = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
const appCode = stripped(app);
/** The node-building half of the canvas, out of App.tsx since #1175. */
const flowCode = stripped(readFileSync(fileURLToPath(new URL("../canvas-flow.ts", import.meta.url)), "utf8"));

describe("the canvas wiring (#853)", () => {
  it("gives every agent node its composed name", () => {
    // The node is built in canvas-flow.ts since #1175; App registers the
    // renderer and this is what it is handed.
    expect(flowCode).toMatch(/type: "agent",[\s\S]{0,200}?ariaLabel: agentAriaLabel\(a, now\),/);
  });

  it("drops React Flow's false keyboard instructions and its delete key", () => {
    expect(appCode).toMatch(/\n\s*disableKeyboardA11y\n/);
    expect(appCode).toMatch(/deleteKeyCode=\{null\}/);
  });

  it("takes the unreferenced instruction text out of the page as well", () => {
    // disableKeyboardA11y stops nodes pointing at React Flow's description,
    // but the text itself is still rendered, and a screen reader browsing the
    // page would read "Press delete to remove it" out of nowhere.
    const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\[id\^="react-flow__node-desc"\],\s*\[id\^="react-flow__edge-desc"\]\s*\{\s*display:\s*none;\s*\}/);
  });
});
