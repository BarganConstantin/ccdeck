// What the card's cost slot holds, run rather than read.
//
// The slot's decision was an IIFE in AgentNode's JSX, so the suite could only
// pin its text: the gate that stopped removing the element (#400), the marker
// that waits for tokens, the `+` that says a figure is a floor (#686), and the
// burn left out for a session the deck joined late (#822). It is costChip in
// card-cost.ts now, and each of those rules is asked of it here.
import { afterEach, describe, expect, it, vi } from "vitest";

import { agentCostTooltip, costChip } from "../card-cost";
import { fmtCostRate } from "../pricing";
import { agentCost } from "../usage-models";
import type { AgentNodeData, TokenUsage } from "../types";

const usage = (u: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, ...u,
});
const SPENT = usage({ inputTokens: 12_000, outputTokens: 34_000, cacheReadTokens: 500_000, cacheCreateTokens: 80_000 });
const UNLISTED = "gpt-9-unlisted";

const card = (over: Partial<AgentNodeData> = {}): AgentNodeData => ({
  id: "s1", sessionId: "s1", label: "agents-deck", kind: "root", state: "done",
  startedAt: 1_000_000, endedAt: 1_600_000, tools: [], toolCount: 0, childCount: 0,
  model: "claude-sonnet-5", usage: SPENT,
  ...over,
} as unknown as AgentNodeData);

afterEach(() => { vi.useRealTimers(); });

describe("the card's cost slot", () => {
  it("draws nothing for a card whose chip names no model", () => {
    expect(costChip(card({ model: undefined }))).toBeNull();
  });

  it("draws nothing for a priced model that has spent nothing yet", () => {
    expect(costChip(card({ usage: usage() }))).toBeNull();
  });

  it("says a model is unpriced in the slot the money would have used, once there are tokens", () => {
    // #400: the lookup failing used to take the element away, so a card on an
    // unpriced model read exactly like one that had spent nothing.
    expect(costChip(card({ model: UNLISTED, usage: usage() }))).toBeNull();
    const chip = costChip(card({ model: UNLISTED, usage: usage({ inputTokens: 900, outputTokens: 1_500 }) }));
    expect(chip?.kind).toBe("unpriced");
    expect(chip?.tt).toContain(`model: ${UNLISTED}`);
    expect(chip?.tt).toMatch(/no published rate/);
  });

  it("prints the agent's priced spend with the tooltip that multiplies it out", () => {
    const data = card();
    const chip = costChip(data);
    expect(chip).toEqual({ kind: "spent", total: agentCost(data).total, floor: false, tt: agentCostTooltip(data) });
    expect(chip && chip.kind === "spent" && chip.total).toBeGreaterThan(0);
  });

  it("gives the figure its + when some of the spend reached no rate card (#686)", () => {
    const data = card({ usageByModel: { "claude-sonnet-5": SPENT, [UNLISTED]: usage({ inputTokens: 5_000, outputTokens: 5_000 }) } });
    const chip = costChip(data);
    expect(chip?.kind).toBe("spent");
    expect(chip && chip.kind === "spent" && chip.floor).toBe(true);
  });

  it("prices spend on an earlier model even when the one the card is on has no rate", () => {
    // `rates` is about the model the chip names; the money is about the tokens
    // already spent, and a card that switched to an unlisted model keeps them.
    const data = card({ model: UNLISTED, usageByModel: { "claude-sonnet-5": SPENT } });
    expect(costChip(data)?.kind).toBe("spent");
  });

  it("adds the burn rate to the tooltip of a live card, as of the render", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000 + 600_000);
    const data = card({ state: "active", endedAt: undefined });
    const rate = fmtCostRate(agentCost(data).total, 600);
    expect(rate).not.toBeNull();
    expect(costChip(data)?.tt).toBe(`${agentCostTooltip(data)}\nburn: ${rate}`);
  });

  it("leaves the burn out for a card that is not live", () => {
    expect(costChip(card({ state: "done" }))?.tt).not.toMatch(/burn:/);
    expect(costChip(card({ state: "err" }))?.tt).not.toMatch(/burn:/);
  });

  it("leaves the burn out for a session the deck joined late (#822)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000 + 600_000);
    const data = card({ state: "active", endedAt: undefined, synthetic: true } as Partial<AgentNodeData>);
    expect(costChip(data)?.tt).toBe(agentCostTooltip(data));
  });
});
