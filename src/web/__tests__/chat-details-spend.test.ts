// The spend Chat's Session details says (board-usage.ts sessionSpend): the
// session's root and its subagents, the figure the Sessions list and the usage
// panel's by-session table give it, never another session's; and the header's
// ⋯ that carries it, drawn in Chat only.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { boardSessionTable, sessionSpend, type SessionBillable } from "../board-usage";
import { agentCost } from "../usage-models";
import StageHeader, { type StageHeaderProps } from "../components/terminal/StageHeader";
import type { TokenUsage } from "../types";

const NOW = Date.UTC(2026, 0, 15);
const OPUS = "claude-opus-5";

const u = (input: number, output: number): TokenUsage =>
  ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreateTokens: 0 } as TokenUsage);
const agent = (sessionId: string, kind: "root" | "subagent", usage: TokenUsage): SessionBillable =>
  ({ sessionId, kind, usage, state: "done", model: OPUS });

describe("a session's spend", () => {
  it("is its root and its subagents, as the by-session table sums them", () => {
    const root = agent("S", "root", u(100_000, 10_000));
    const all = [root, agent("S", "subagent", u(20_000, 2_000)), agent("S", "subagent", u(30_000, 3_000))];
    const spend = sessionSpend(root, all, NOW);
    expect(spend).toBeGreaterThan(0);
    expect(spend).toBeCloseTo(all.reduce((n, a) => n + agentCost(a, NOW).total, 0), 9);
    expect(spend).toBeCloseTo(boardSessionTable(all, NOW)[0].cost, 9);
  });

  it("leaves out another session, and another root that shares the id, as the Sessions list does", () => {
    const root = agent("S", "root", u(100_000, 10_000));
    const others = [agent("T", "root", u(900_000, 90_000)), agent("T", "subagent", u(900_000, 90_000)), agent("S", "root", u(500_000, 50_000))];
    expect(sessionSpend(root, [root, ...others], NOW)).toBeCloseTo(agentCost(root, NOW).total, 9);
  });

  it("is zero for a session nothing here prices, which Session details leaves out", () => {
    const root: SessionBillable = { ...agent("S", "root", u(1_000, 100)), model: "some-model-nobody-prices" };
    expect(sessionSpend(root, [root], NOW)).toBe(0);
  });
});

describe("the header's ⋯ in Chat", () => {
  const props: StageHeaderProps = {
    identity: "session:a", name: "Pane", provider: "claude", workspace: "pane", split: false,
    status: { state: "idle", phrase: "idle" }, keysOwner: "board", chordLabel: "Ctrl+Shift+X",
    canType: true, expanded: false, takeover: false,
    onKeys() {}, onExpand() {}, onClose() {},
  };

  it("is marked for Chat, so it is drawn at every width, and is the plain narrow-header ⋯ otherwise", () => {
    const chat = renderToStaticMarkup(createElement(StageHeader, { ...props, chat: { term() {}, details: [] } }));
    expect(chat).toMatch(/<button[^>]*class="glyph-btn ts-more ts-compact-more"[^>]*data-chat=""/);
    const term = renderToStaticMarkup(createElement(StageHeader, props));
    expect(term).toContain("ts-compact-more");
    expect(term).not.toContain("data-chat");
  });
});
