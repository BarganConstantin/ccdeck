// The usage panel's two tables when ccusage has not answered (#1175).
//
// ccusage is optional — `AGENTS_DECK_NO_INSTALL`, or a machine with no npm at
// all — and on a deck without it every dollar and every token in "by model" and
// "by session" is folded from the board. Those two folds lived inside
// UsagePanel's memos, in a file at 4.56% of lines, where nothing could run
// them. What tested them were REPLICAS: `model-switch-pricing.test.ts` re-typed
// "the exact fold the usage panel's byModel memo runs" and
// `panel-memo-revision.test.ts` re-typed a cut-down bySessions. A re-typed loop
// keeps passing after the real one changes, and both had already drifted —
// neither carried the cache columns, the agent count, `priced`, or the sort.
//
// The folds are `boardModelTable` and `boardSessionTable` in board-usage.ts
// now, beside the headline they have to add up to, and this drives them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  boardModelTable, boardSessionTable, boardTotals, BOARD_SESSION_ROWS, UNKNOWN_MODEL,
  type Billable, type SessionBillable,
} from "../board-usage";
import { costForUsage } from "../pricing";
import { agentCost } from "../usage-models";
import type { TokenUsage } from "../types";

const NOW = Date.UTC(2026, 0, 15);
const OPUS = "claude-opus-5";
const SONNET = "claude-sonnet-5";
/** A model this build holds no rate for, which is every Codex model and every
 *  release that landed after this one. */
const UNPRICED = "some-model-nobody-prices";

const u = (input: number, output: number, cacheRead = 0, cacheCreate = 0): TokenUsage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheCreateTokens: cacheCreate,
} as TokenUsage);

/** The sum of a list of per-model usages, which is what an agent's flat `usage`
 *  holds once the reducer has split it by model. */
const sumUsage = (...parts: TokenUsage[]): TokenUsage => u(
  parts.reduce((n, p) => n + p.inputTokens, 0),
  parts.reduce((n, p) => n + p.outputTokens, 0),
  parts.reduce((n, p) => n + p.cacheReadTokens, 0),
  parts.reduce((n, p) => n + p.cacheCreateTokens, 0),
);

describe("boardModelTable", () => {
  it("gives a session that switched model a row per model, each with that model's tokens", () => {
    // The #686 shape, and the one the replica was written for. A mostly-Opus
    // session that ended on Sonnet is an Opus row AND a Sonnet row, not one
    // Sonnet row holding the whole 1.1M — and the two rows sum to what the
    // headline prices the same agent at.
    const opus = u(1_000_000, 100_000, 20_000, 5_000);
    const sonnet = u(1_000, 100, 40, 10);
    const agent: Billable = {
      model: SONNET,
      usage: sumUsage(opus, sonnet),
      usageByModel: { [OPUS]: opus, [SONNET]: sonnet },
    };

    const rows = boardModelTable([agent], NOW);
    expect(rows.map(r => r.model)).toEqual([OPUS, SONNET]);
    const byModel = new Map(rows.map(r => [r.model, r]));
    expect(byModel.get(OPUS)!.inputTokens).toBe(1_000_000);
    expect(byModel.get(SONNET)!.inputTokens).toBe(1_000);
    // The cache columns the replica did not carry at all.
    expect(byModel.get(OPUS)!.cacheReadTokens).toBe(20_000);
    expect(byModel.get(OPUS)!.cacheCreateTokens).toBe(5_000);
    expect(byModel.get(SONNET)!.cacheReadTokens).toBe(40);
    expect(byModel.get(SONNET)!.cacheCreateTokens).toBe(10);
    // And each row's dollars are that model's tokens at that model's rate.
    expect(byModel.get(OPUS)!.cost.total).toBeCloseTo(costForUsage(opus, OPUS, NOW).total, 9);
    expect(byModel.get(SONNET)!.cost.total).toBeCloseTo(costForUsage(sonnet, SONNET, NOW).total, 9);
    expect(rows.reduce((n, r) => n + r.cost.total, 0)).toBeCloseTo(agentCost(agent, NOW).total, 9);
  });

  it("folds every agent on a model into one row and counts the shares", () => {
    const a: Billable = { model: OPUS, usage: u(1_000, 100, 10, 1) };
    const b: Billable = { model: OPUS, usage: u(2_000, 200, 20, 2) };
    const [row] = boardModelTable([a, b], NOW);
    expect(row.agentCount).toBe(2);
    expect(row.inputTokens).toBe(3_000);
    expect(row.outputTokens).toBe(300);
    expect(row.cacheReadTokens).toBe(30);
    expect(row.cacheCreateTokens).toBe(3);
    // Every column of the breakdown, not only the total — the panel prints the
    // four of them under the row.
    const expected = costForUsage(u(3_000, 300, 30, 3), OPUS, NOW);
    expect(row.cost.input).toBeCloseTo(expected.input, 9);
    expect(row.cost.output).toBeCloseTo(expected.output, 9);
    expect(row.cost.cacheRead).toBeCloseTo(expected.cacheRead, 9);
    expect(row.cost.cacheWrite).toBeCloseTo(expected.cacheWrite, 9);
    expect(row.cost.total).toBeCloseTo(expected.total, 9);
  });

  it("keys an agent that has reported no model under one key, unpriced", () => {
    const rows = boardModelTable([{ usage: u(4_000, 400) }], NOW);
    expect(rows.map(r => r.model)).toEqual([UNKNOWN_MODEL]);
    expect(rows[0].priced).toBe(false);
    // Its tokens are real and its dollars are unknowable, which is not zero
    // dollars — the panel prints the floor marker beside the row for that.
    expect(rows[0].inputTokens + rows[0].outputTokens).toBe(4_400);
    expect(rows[0].cost.total).toBe(0);
  });

  it("marks a model this build has no rate for unpriced, and one it does priced", () => {
    const rows = boardModelTable([
      { model: UNPRICED, usage: u(10, 1) },
      { model: OPUS, usage: u(10, 1) },
    ], NOW);
    expect(new Map(rows.map(r => [r.model, r.priced]))).toEqual(new Map([[UNPRICED, false], [OPUS, true]]));
  });

  it("sorts by dollars, and breaks the tie between unpriced rows on tokens", () => {
    // Every unpriced row costs exactly zero, so without the tiebreak they
    // arrive in the order their agents happened to be observed in — which reads
    // as no order at all.
    const rows = boardModelTable([
      { model: `${UNPRICED}-small`, usage: u(1_000, 100) },
      { model: OPUS, usage: u(1_000, 100) },
      { model: `${UNPRICED}-big`, usage: u(2_000_000, 100) },
    ], NOW);
    expect(rows.map(r => r.model)).toEqual([OPUS, `${UNPRICED}-big`, `${UNPRICED}-small`]);
  });

  it("has nothing to show for an empty board", () => {
    expect(boardModelTable([], NOW)).toEqual([]);
  });
});

/** A root, or one of its subagents, as the session table reads it. */
const agent = (
  sessionId: string, kind: "root" | "subagent", usage: TokenUsage,
  extra: Partial<SessionBillable> = {},
): SessionBillable => ({
  sessionId, kind, usage, state: "done", ...extra,
});

describe("boardSessionTable", () => {
  it("folds a root's same-session subagents into its row", () => {
    const root = agent("S", "root", u(1_000, 100), { model: OPUS, label: "deck" });
    const subs = [
      agent("S", "subagent", u(2_000, 200), { model: OPUS }),
      agent("S", "subagent", u(3_000, 300), { model: OPUS }),
    ];
    const [row] = boardSessionTable([root, ...subs], NOW);
    expect(row.sessionId).toBe("S");
    expect(row.label).toBe("deck");
    expect(row.inputTokens).toBe(6_000);
    expect(row.outputTokens).toBe(600);
    expect(row.cost).toBeCloseTo(
      [root, ...subs].reduce((n, a) => n + agentCost(a, NOW).total, 0), 9);
  });

  it("leaves another session's subagents out of it", () => {
    // One row per session, so a canvas holding two sessions' subagents side by
    // side must not roll one into the other.
    const rows = boardSessionTable([
      agent("S", "root", u(1_000, 100), { model: OPUS }),
      agent("T", "root", u(1_000, 100), { model: OPUS }),
      agent("T", "subagent", u(9_000, 900), { model: OPUS }),
    ], NOW);
    expect(new Map(rows.map(r => [r.sessionId, r.inputTokens]))).toEqual(new Map([["S", 1_000], ["T", 10_000]]));
  });

  it("counts a Codex subagent's tokens as unpriced beside its root's dollars", () => {
    // A session can mix providers: a Claude root that spawned a Codex subagent
    // prices one and not the other, so the row's figure is a floor and the
    // panel has to be able to say so.
    const root = agent("S", "root", u(1_000, 100), { model: OPUS });
    const codex = agent("S", "subagent", u(500_000, 5_000), { model: UNPRICED });
    const [row] = boardSessionTable([root, codex], NOW);
    expect(row.unpricedTokens).toBe(505_000);
    expect(row.cost).toBeCloseTo(agentCost(root, NOW).total, 9);
    expect(row.cost).toBeGreaterThan(0);
  });

  it("names a session by its label, its directory, or the word session", () => {
    const rows = boardSessionTable([
      agent("a", "root", u(1, 1), { label: "named" }),
      agent("b", "root", u(1, 1), { cwdBasename: "proj" }),
      agent("c", "root", u(1, 1)),
    ], NOW);
    expect(new Map(rows.map(r => [r.sessionId, r.label])))
      .toEqual(new Map([["a", "named"], ["b", "proj"], ["c", "session"]]));
  });

  it("carries the state the row's dot is drawn from", () => {
    const [row] = boardSessionTable([agent("S", "root", u(1, 1), { state: "active" })], NOW);
    expect(row.state).toBe("active");
  });

  it("keeps the top twelve by dollars and then by tokens", () => {
    // The tiebreak matters more here than in the model table because this list
    // is CUT: before it, an unpriced session — however large — sat at cost zero
    // among every other zero and could be cut for a row with fewer tokens.
    const priced = Array.from({ length: 11 }, (_, i) =>
      agent(`p${i}`, "root", u(100_000 * (i + 1), 1_000), { model: OPUS }));
    const huge = agent("huge", "root", u(2_000_000, 0), { model: UNPRICED });
    const tiny = agent("tiny", "root", u(1_000, 0), { model: UNPRICED });
    const rows = boardSessionTable([tiny, huge, ...priced], NOW);

    expect(rows).toHaveLength(BOARD_SESSION_ROWS);
    expect(BOARD_SESSION_ROWS).toBe(12);
    // The eleven priced ones sort above both, biggest first.
    expect(rows.slice(0, 11).map(r => r.sessionId)).toEqual(
      Array.from({ length: 11 }, (_, i) => `p${10 - i}`));
    // And the last place goes to the 2M-token session, not to the 1k one.
    expect(rows[11].sessionId).toBe("huge");
    expect(rows.map(r => r.sessionId)).not.toContain("tiny");
  });

  it("has nothing to show for a board of subagents whose roots are gone", () => {
    // Roots only, which is the one place this can fall short of the headline:
    // `pruneOldAgents` can evict a root while a subagent stays, and
    // `boardTotals` still counts that subagent. The behaviour is pinned here
    // rather than changed — the row would have no session to name and no state
    // to draw, and the headline says in its own label that it is the board's.
    const orphan = agent("S", "subagent", u(1_000, 100), { model: OPUS });
    expect(boardSessionTable([orphan], NOW)).toEqual([]);
    expect(boardTotals([orphan], NOW).cost.total).toBeGreaterThan(0);
  });
});

describe("the two tables and the headline price the same board", () => {
  it("has the model rows sum to boardTotals over a mixed board", () => {
    // The property the panel is drawn from: the rows under the strip explain
    // the figure above it, rather than being a second measurement of it.
    const opus = u(1_000_000, 100_000, 20_000, 5_000);
    const sonnet = u(4_000, 400, 100, 10);
    const board: Billable[] = [
      { model: SONNET, usage: sumUsage(opus, sonnet), usageByModel: { [OPUS]: opus, [SONNET]: sonnet } },
      { model: OPUS, usage: u(50_000, 5_000, 1_000, 100) },
      { model: UNPRICED, usage: u(700_000, 70_000) },
      { usage: u(3, 3) },
    ];
    const rows = boardModelTable(board, NOW);
    const total = boardTotals(board, NOW);
    expect(rows.reduce((n, r) => n + r.cost.total, 0)).toBeCloseTo(total.cost.total, 9);
    expect(rows.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0)).toBe(total.sum);
  });

  it("has the session rows sum to boardTotals while every root is still on the board", () => {
    const board: SessionBillable[] = [
      agent("S", "root", u(1_000, 100), { model: OPUS }),
      agent("S", "subagent", u(2_000, 200), { model: OPUS }),
      agent("T", "root", u(400_000, 40_000), { model: SONNET }),
    ];
    const rows = boardSessionTable(board, NOW);
    expect(rows.reduce((n, r) => n + r.cost, 0)).toBeCloseTo(boardTotals(board, NOW).cost.total, 9);
    expect(rows.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0)).toBe(boardTotals(board, NOW).sum);
  });
});

describe("the panel draws its two board tables from these", () => {
  // The half a DOM-less suite cannot drive: that the memos call the folds above
  // rather than holding folds of their own. Two copies of this arithmetic is
  // how the replicas came to be testing code the panel had stopped running.
  const panel = readFileSync(
    fileURLToPath(new URL("../components/UsagePanel.tsx", import.meta.url)), "utf8");

  it("calls boardModelTable and boardSessionTable, and folds nothing itself", () => {
    expect(panel).toMatch(/const byModel = boardModelTable\(state\.agents\.values\(\)\);/);
    expect(panel).toMatch(/\(\): BoardSessionRow\[\] => boardSessionTable\(state\.agents\.values\(\)\)/);
    expect(panel).not.toMatch(/modelMap/);
    expect(panel).not.toMatch(/agentCost\(/);
    expect(panel).not.toMatch(/agentUnpricedTokens\(/);
    // The one `.slice(0, 12)` left in the panel is the ccusage path's own cut,
    // which is a different list from a different source.
    expect([...panel.matchAll(/\.slice\(0, 12\)/g)]).toHaveLength(1);
    expect(panel).toMatch(/ccSessionRows\(range, boardNames\)\.slice\(0, 12\)/);
  });

  it("keeps the rows whose dollars are unknown but whose tokens are not", () => {
    // #400's rule, on the columns these tables now name: a row is selected on
    // tokens, so an unpriced model is listed with the floor marker rather than
    // filtered out of a table that still counts it in the strip above.
    expect(panel).toMatch(
      /const boardModelRows\s+= byModel\.filter\(m => m\.cost\.total > 0 \|\| \(m\.inputTokens \+ m\.outputTokens\) > 0\)/);
    expect(panel).toMatch(
      /const boardSessionRows = bySessions\.filter\(s => s\.cost > 0 \|\| \(s\.inputTokens \+ s\.outputTokens\) > 0\)/);
  });
});
