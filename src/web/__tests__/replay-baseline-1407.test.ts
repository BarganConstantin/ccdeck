// #1407: a ccusage reading that landed while the page was still replaying its
// log took its baseline over a half-replayed board, and the rest of the replay
// was added to the reading as new spend.
//
// Between two readings the panel adds what each session has gained since the
// baseline (live-delta.ts), and a session missing from the baseline adds
// nothing, because its history is not the delta's to claim. A session caught
// part-way through its replay is not missing: it is in the baseline at the
// usage of the last event replayed so far, and every later replayed event
// raises it. That is history the reading already holds, counted a second time.
// Measured on a deck: ccusage said $10.00 for today and the panel printed
// $11.46 until the next reading a minute later.
//
// The server's cached answer comes back in milliseconds, so on a reload the
// first reading routinely lands inside the replay. The panel now takes no
// baseline until the replay has landed — the `liveSince` the header's $/min
// already counts from — and a reading that lands before then stands alone
// until the next one.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyEvent, initialState, type GraphState } from "../reducer";
import { boardBySession, liveDelta, NO_DELTA } from "../live-delta";
import { panelFigures, type Board, type UsageRange } from "../usage-from-ccusage";
import type { HookEnvelope, HookPayload } from "../types";

const T0 = Date.UTC(2026, 8, 1, 9);
const OPUS = "claude-opus-5";   // $5 in / $25 out per Mtok

/** One session's log as the server replays it: its start, its model, and
 *  three restatements of its cumulative usage — $5.00, then $10.00, then
 *  $12.50. */
const LOG: HookPayload[] = [
  { hook_event_name: "SessionStart", session_id: "s", cwd: "/repo" },
  { hook_event_name: "ModelObserved", session_id: "s", model: OPUS } as HookPayload,
  usage(1_000_000, 0),
  usage(2_000_000, 0),
  usage(2_000_000, 100_000),
];

function usage(input: number, output: number): HookPayload {
  const totals = { input_tokens: input, output_tokens: output };
  return { hook_event_name: "UsageObserved", session_id: "s", usage: totals, usageByModel: { [OPUS]: totals } } as unknown as HookPayload;
}

/** The board after the first `n` events of the replay. */
function replayed(n: number, state: GraphState = initialState(), from = 0): GraphState {
  let s = state;
  LOG.slice(from, n).forEach((payload, i) => {
    const env: HookEnvelope = { seq: from + i + 1, receivedAt: T0 + (from + i) * 1000, source: "hook", payload, replay: true };
    s = applyEvent(s, env);
  });
  return s;
}

/** The reading: ccusage already counts the whole session, $12.50. */
const READING = {
  ok: true,
  totals: { totalCost: 12.5, inputTokens: 2_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 2_100_000 },
} as unknown as UsageRange;
const BOARD: Board = { cost: { total: 0 }, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, sum: 0 };

describe("a baseline taken during the replay (#1407)", () => {
  it("counts the rest of the replay as spend on top of a reading that already holds it", () => {
    // What the panel did: the reading lands after the first restatement.
    const mid = replayed(3);
    const baseline = boardBySession(mid.agents.values(), T0);
    expect(baseline.get("s")?.cost).toBeCloseTo(5, 6);
    const done = replayed(LOG.length, mid, 3);
    const delta = liveDelta(baseline, boardBySession(done.agents.values(), T0));
    expect(delta.cost, "the replayed $7.50 is the failure this issue is about").toBeCloseTo(7.5, 6);
    expect(panelFigures(READING, BOARD, delta).cost).toBeCloseTo(20, 6);
  });

  it("adds nothing when there is no baseline, so the reading stands alone", () => {
    // What the panel does now while `liveSince` is null.
    const done = replayed(LOG.length);
    const delta = liveDelta(null, boardBySession(done.agents.values(), T0));
    expect(delta).toEqual(NO_DELTA);
    expect(panelFigures(READING, BOARD, delta).cost).toBeCloseTo(12.5, 6);
  });

  it("still counts work watched after the replay, from the next reading's baseline", () => {
    const done = replayed(LOG.length);
    const baseline = boardBySession(done.agents.values(), T0);
    // One live Opus turn after the replay: 100,000 more input tokens, $0.50.
    const live = applyEvent(done, { seq: 99, receivedAt: T0 + 60_000, source: "hook", payload: usage(2_100_000, 100_000) });
    const delta = liveDelta(baseline, boardBySession(live.agents.values(), T0));
    expect(delta.cost).toBeCloseTo(0.5, 6);
  });
});

describe("the panel takes no baseline before the replay has landed (#1407)", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("hands the range hook nothing to measure from while liveSince is null", () => {
    expect(read("../components/UsagePanel.tsx"))
      .toContain("boardNowRef.current = () => (liveSince == null ? null : boardBySession(state.agents.values(), now));");
  });

  it("and the hook stores that null with the reading, where liveDelta reads it as no delta", () => {
    const hook = read("../use-usage-range.ts");
    expect(hook).toContain("takeBaseline: () => ReadonlyMap<string, SessionUsage> | null,");
    expect(hook).toContain("setLanded({ period: want, data: d, baseline: takeBaseline() });");
  });
});
