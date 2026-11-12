// V4 critique 3: the Inspector's Agents tab says each fact once. For one
// session with no subagents it used to say the task three times (the agent
// card, Now, Prompts), the cost three times (beside "Agents", on the card, in
// the spend line), the time and the model twice, and the call count twice
// (Activity and Tool calls).
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Inspector from "../components/Inspector";
import Detail, { promptsNotSaid } from "../components/Detail";
import { elapsed } from "../duration";
import { modelChipText } from "../model-label";
import { fmtCost } from "../pricing";
import { agentCost } from "../usage-models";
import type { AgentNodeData, PromptEntry } from "../types";

const USAGE = { inputTokens: 1200, outputTokens: 800, cacheReadTokens: 0, cacheCreateTokens: 0 };
const TASK = "Write the release notes for 3.83";
const NOW = 27_000;
const A = (id: string, over: Partial<AgentNodeData> = {}) => ({
  id, sessionId: "s", label: id, kind: id === "s" ? "root" : "subagent", state: "active", childCount: 0, tools: [], toolCount: 0,
  usage: USAGE, model: "claude-sonnet-4-5", prompts: [{ text: TASK, at: 2000 }], startedAt: 1000, ...over,
}) as unknown as AgentNodeData;
const mapOf = (...agents: AgentNodeData[]) => new Map(agents.map(a => [a.id, a]));

/** The Agents tab as DetailAside draws it: the tab around the detail panel. */
const panel = (selected: AgentNodeData, agents: ReadonlyMap<string, AgentNodeData>) =>
  renderToStaticMarkup(createElement(Inspector, {
    selected, agents, onSelectAgent: () => {}, onClose: () => {},
    detail: createElement(Detail, { agent: selected, now: NOW, onOpenTool: () => {}, onExportSession: () => {}, onRemove: () => {} }),
  }));
/** How many text nodes read exactly `text`. */
const said = (html: string, text: string) => html.split(`>${text}<`).length - 1;
const detail = (agent: AgentNodeData) => renderToStaticMarkup(createElement(Detail, { agent, now: NOW, onOpenTool: () => {} }));
const headings = (html: string) => [...html.matchAll(/<h3>(.*?)<\/h3>/g)].map(m => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

describe("a session with no subagents", () => {
  const root = A("s");
  const out = panel(root, mapOf(root));

  it("draws no agent card, and keeps 'no subagents' as the head's quiet line", () => {
    expect(out).not.toContain('class="insp-tree"');
    expect(out).not.toContain("agent-node");
    expect(out).toContain('<span class="insp-title">Agents</span>');
    expect(out).toContain('<span class="insp-qual">no subagents</span>');
  });

  it("says the cost once, in the spend line with its bar", () => {
    const cost = fmtCost(agentCost(root).total);
    expect(said(out, cost)).toBe(1);
    expect(out).toMatch(new RegExp(`<span class="hero-cost-value">${cost.replace(/[$.]/g, "\\$&")}</span>`));
    expect(out).toContain('class="cost-bar');
    expect(out).not.toContain("insp-fig");
  });

  it("says the name, the state, the time and the model once, in one header", () => {
    expect(said(out, elapsed(root.startedAt, root.endedAt, NOW))).toBe(1);
    expect(said(out, modelChipText(root.model!))).toBe(1);
    expect(said(out, "working")).toBe(1);
    expect(out).not.toContain(">Working<");
    // "session" said nothing about a session's own root; the state takes its place.
    const meta = /<div class="hero-meta">(.*?)<\/div>/.exec(out)![1];
    expect(meta).not.toMatch(/>session</);
    expect(meta.indexOf(">working<")).toBeLessThan(meta.indexOf('class="model-chip"'));
  });

  it("says the task once, under Now", () => {
    expect(out.split(TASK).length - 1).toBe(1);
    expect(headings(out)[0]).toMatch(/^Now\b/);
  });

  it("has one calls section, no Activity, and keeps Export JSON and Remove from board", () => {
    expect(headings(out).filter(h => /^(Activity|Tool calls)\b/.test(h))).toEqual(["Tool calls 0"]);
    expect(out).toContain("Export JSON");
    expect(out).toContain("Remove from board");
  });
});

describe("a session with subagents", () => {
  it("keeps the agent list as it was: one card per agent", () => {
    const root = A("s", { childCount: 1 });
    const out = panel(root, mapOf(root, A("c1", { parentId: "s", startedAt: 3000 })));
    expect(out).toContain('class="insp-tree"');
    expect(out.match(/<div class="agent-node /g)).toHaveLength(2);
    expect(out).toContain('<span class="insp-qual">1 subagent</span>');
    expect(out).not.toContain("insp-fig");
  });

  it("names a subagent's kind beside its state", () => {
    const sub = A("c1", { parentId: "s", startedAt: 3000 });
    const meta = /<div class="hero-meta">(.*?)<\/div>/.exec(detail(sub))![1];
    expect(meta).toMatch(/>subagent<.*>working</);
  });
});

describe("the Prompts section", () => {
  const P = (text: string, at: number): PromptEntry => ({ text, at });

  it("is not there with one prompt, which Now already says", () => {
    const out = detail(A("s"));
    expect(headings(out).some(h => /prompts/i.test(h))).toBe(false);
    expect(out.split(TASK).length - 1).toBe(1);
  });

  it("lists the earlier prompts when there are more, and not the one Now says", () => {
    const out = detail(A("s", { prompts: [P("Look at the CI", 1500), P(TASK, 2000)] }));
    expect(headings(out)).toContain("Earlier prompts 1");
    expect(out).toContain("Look at the CI");
    expect(out.split(TASK).length - 1).toBe(1);
  });

  it("lists the prompt when Now says the model's own line instead", () => {
    const out = detail(A("s", { activity: { text: "Reading the changelog", source: "said", at: 5000 } }));
    expect(headings(out)).toContain("Prompts 1");
    expect(out.split(TASK).length - 1).toBe(1);
    expect(out).toContain("Reading the changelog");
  });

  it("leaves out only the newest prompt, and only when the note says it", () => {
    const typed = [P("first", 1), P("second", 2)];
    expect(promptsNotSaid(typed, null)).toEqual(typed);
    expect(promptsNotSaid(typed, { text: "something else" })).toEqual(typed);
    expect(promptsNotSaid(typed, { text: "second" })).toEqual([typed[0]]);
    expect(promptsNotSaid(typed, { text: "first" })).toEqual(typed);
    // A long prompt is said by its first line, cut, as the note says it.
    const long = P(`Ship it\nwith the notes`, 3);
    expect(promptsNotSaid([long], { text: "Ship it" })).toEqual([]);
  });
});
