import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error server module
import { codexCostState, codexCostGap, foldCodexCost, codexCostBuckets } from "../../server/codex-cost-usage.mjs";
// @ts-expect-error server module
import { readCodexRollout } from "../../server/codex-enrichment.mjs";
import { usageByModelFromWire } from "../usage-wire";
import { agentCost, agentUnpricedTokens } from "../usage-models";
import { costBreakdownTooltip } from "../card-cost";
import { applyEvent, initialState } from "../reducer";
import type { HookPayload } from "../types";

const model = "gpt-6.1-sol";
const meta = { type: "session_meta", payload: { id: "test", model } };
const tier = (service_tier: unknown) => ({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier } } });
const usage = (input_tokens: number, output_tokens = 0) => ({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens, output_tokens } } } });
function read(lines: unknown[]) {
  const s = codexCostState();
  for (const line of lines) foldCodexCost(s, line);
  return { state: s, usageByModel: usageByModelFromWire(codexCostBuckets(s)) };
}
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-tier-"));
afterAll(() => rmTempDir(DIR));

describe("recorded Codex tier estimates", () => {
  it("prices only each tier's own increase, including the first request", () => {
    const result = read([meta, tier("priority"), usage(1000), usage(1000), tier("flex"), usage(2000), tier("default"), usage(3000)]);
    const a = { model, usage: { inputTokens: 3000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }, usageByModel: result.usageByModel };
    expect(agentCost(a).total).toBeCloseTo(0.004 + 0.001 + 0.002);
    expect(agentUnpricedTokens(a)).toBe(0);
    expect(costBreakdownTooltip(a.usageByModel![model], model)).toContain("do not confirm the served tier");
  });
  it("does not attribute pre-attachment usage to a new tier", () => {
    const result = read([tier("fast"), { type: "turn_context", payload: { model } }, usage(2000), usage(3000)]);
    expect(result.usageByModel?.[model].inputTokens).toBe(1000);
    expect(result.usageByModel?.[model].bySpeed?.fast.inputTokens).toBe(1000);
  });
  it("clears stale tier evidence at a skipped byte range", () => {
    const { state } = read([meta, tier("fast"), usage(1000)]);
    codexCostGap(state);
    foldCodexCost(state, usage(10000));
    foldCodexCost(state, { type: "turn_context", payload: { model } });
    foldCodexCost(state, usage(11000));
    const buckets = usageByModelFromWire(codexCostBuckets(state))!;
    expect(buckets[model].inputTokens).toBe(2000);
    expect(buckets[model].bySpeed?.fast.inputTokens).toBe(1000);
  });
  it("does not keep higher costs after cumulative counters reset", () => {
    const result = read([meta, tier("fast"), usage(3000), usage(100)]);
    expect(result.usageByModel).toBeUndefined();
  });
  it("uses unknown pricing for an unknown recorded tier", () => {
    const result = read([meta, tier("ultra-unknown"), usage(1000)]);
    const a = { model, usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }, usageByModel: result.usageByModel };
    expect(agentUnpricedTokens(a)).toBe(1000);
    expect(agentCost(a).total).toBe(0);
  });
  it("drops charges from before a reset hidden in the skipped range", () => {
    const { state } = read([meta, tier("fast"), usage(1000)]);
    codexCostGap(state);
    foldCodexCost(state, usage(100));
    expect(codexCostBuckets(state)).toBeUndefined();
  });
  it("keeps model attribution when both models ran at standard rates", () => {
    const result = read([meta, usage(1000), { type: "turn_context", payload: { model: "gpt-6-astra" } }, usage(2000)]);
    expect(Object.keys(result.usageByModel!)).toEqual([model, "gpt-6-astra"]);
  });
  it("passes tier shares through the bounded rollout reader and reducer", async () => {
    const path = join(DIR, "rollout.jsonl");
    writeFileSync(path, [meta, tier("fast"), usage(1000), tier("flex"), usage(2000)].map(v => JSON.stringify(v)).join("\n"));
    const snapshot = await readCodexRollout(path);
    const state = initialState();
    let seq = 0;
    const emit = (payload: HookPayload) => applyEvent(state, { seq: ++seq, receivedAt: seq, payload: { session_id: "test", provider: "codex", ...payload } });
    emit({ hook_event_name: "SessionStart", model });
    emit({ hook_event_name: "UsageObserved", usage: snapshot.usage, usageByModel: snapshot.usageByModel });
    const root = state.agents.get("test")!;
    expect(agentCost(root).total).toBeCloseTo(0.005);
    emit({ hook_event_name: "UsageObserved", usage: { input_tokens: 3000, output_tokens: 0 } });
    expect(root.usageByModel?.[model].bySpeed?.fast.inputTokens).toBe(1000);
    emit({ hook_event_name: "UsageObserved", usage: { input_tokens: 3000, output_tokens: 0 }, usageByModel: null });
    expect(root.usageByModel).toBeUndefined();
    emit({ hook_event_name: "UsageObserved", usage: { input_tokens: 3000, cached_input_tokens: 800 }, usageByModel: snapshot.usageByModel });
    emit({ hook_event_name: "UsageObserved", usage: { input_tokens: 3000, cached_input_tokens: 0 } });
    expect(root.usageByModel).toBeUndefined();
  });
});
