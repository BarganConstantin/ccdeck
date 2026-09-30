// A fast-mode turn is billed at the fast-mode rate (#754).
//
// Claude Code's `/fast` runs Opus with `speed: "fast"`, and Anthropic bills
// those requests at a premium: $10 / $50 on Opus 5 and Opus 4.8, $8 / $40 on
// Opus 5.5, with the prompt-caching multipliers applied on top. The model id
// does not change, so a rate table keyed on the model alone priced every fast
// turn at the standard rate, which is half the bill.
//
// The speed is on the usage object itself. The API documents
// `usage.speed` as "fast" or "standard", and Claude Code writes that object
// into the transcript verbatim: on this machine 140,634 assistant lines carry
// `speed`, every final one among them. So the question #754 kept open, whether
// a fast session says so anywhere the deck reads, has the answer yes, per
// request, on the same line as the model and the tokens.
//
// What these hold: the fast rate card and the models it covers; the scanner
// keeping a fast turn's tokens as a share of its model's bucket, in both halves
// a session is read from; the board pricing that share at the premium and the
// rest at the standard rate; a speed this build has no rate for, and a fast
// turn on a model with no published fast rate, reaching no rate instead of the
// standard one; and the card's tooltip showing the multiplication it adds up.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { costForUsage, fmtCost, ratesForModel } from "../pricing";
import { boardModelTable } from "../board-usage";
import { agentCostTooltip, costChip } from "../card-cost";
import { applyEvent, initialState } from "../reducer";
import { agentCost, agentUnpricedTokens } from "../usage-models";
import type { HookEnvelope, HookPayload, TokenUsage } from "../types";

// Nothing in this file may touch the real ~/.claude, ~/.codex or the
// claude-swap store: every home the server module resolves at import time is
// pointed at a throwaway directory before that import happens.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-fast-mode-"));
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
const PREV = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
for (const k of ENV_KEYS) process.env[k] = k === "HOME" || k === "USERPROFILE" ? DIR : join(DIR, k);

/** Hard stop if a path we are about to hand the scanner escapes the sandbox —
 *  a transcript read is a read of whatever path it is given. */
function sandboxed(name: string): string {
  const p = resolve(DIR, name);
  if (!p.startsWith(resolve(DIR) + "/") && !p.startsWith(resolve(DIR) + "\\")) {
    throw new Error(`refusing to touch ${p}: outside ${DIR}`);
  }
  return p;
}

// @ts-expect-error — .mjs server module, no types
const { readUsageByModelFromTranscript, sessionUsageByModel, sessionUsageTotals } =
  await import("../../server/index.mjs");

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (PREV[k] === undefined) delete process.env[k]; else process.env[k] = PREV[k];
  }
  rmTempDir(DIR);
});

const NOW = Date.UTC(2026, 8, 30);
const OPUS = "claude-opus-5";
const SONNET = "claude-sonnet-5";

interface Turn {
  input: number;
  output: number;
  cacheRead?: number;
  cache1h?: number;
  cache5m?: number;
  /** `usage.speed` as Claude Code writes it; `null` leaves the key out, the
   *  shape older Claude Code versions wrote. */
  speed: string | null;
}

/** One assistant line in the field order of a live Claude Code transcript,
 *  `iterations` and the trailing `speed` included. */
function line(model: string, t: Turn): string {
  const cache1h = t.cache1h ?? 0;
  const cache5m = t.cache5m ?? 0;
  const cacheCreation = { ephemeral_1h_input_tokens: cache1h, ephemeral_5m_input_tokens: cache5m };
  const usage: Record<string, unknown> = {
    input_tokens: t.input,
    cache_creation_input_tokens: cache1h + cache5m,
    cache_read_input_tokens: t.cacheRead ?? 0,
    output_tokens: t.output,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: cacheCreation,
    inference_geo: "not_available",
    iterations: [{
      input_tokens: t.input,
      output_tokens: t.output,
      cache_read_input_tokens: t.cacheRead ?? 0,
      cache_creation_input_tokens: cache1h + cache5m,
      cache_creation: cacheCreation,
      type: "message",
    }],
  };
  if (t.speed !== null) usage.speed = t.speed;
  return JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: { model, role: "assistant", content: [{ type: "text", text: "x" }], usage },
  });
}

function writeTranscript(name: string, lines: string[]): string {
  const path = sandboxed(name);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

const STANDARD_TURN: Turn = { input: 2_000, output: 10_000, cacheRead: 100_000, speed: "standard" };
const FAST_TURN: Turn = { input: 1_000, output: 20_000, cacheRead: 500_000, cache1h: 30_000, cache5m: 10_000, speed: "fast" };

const usage = (t: Turn): TokenUsage => ({
  inputTokens: t.input,
  outputTokens: t.output,
  cacheReadTokens: t.cacheRead ?? 0,
  cacheCreateTokens: (t.cache1h ?? 0) + (t.cache5m ?? 0),
  cacheCreate1hTokens: t.cache1h ?? 0,
  cacheCreate5mTokens: t.cache5m ?? 0,
});

const env = (payload: HookPayload, seq: number): HookEnvelope =>
  ({ seq, receivedAt: 1_700_000_000_000 + seq, source: "hook", payload });

/** The session as the deck holds it after a scan, through the two session
 *  readers `maybeResolveUsage` ships. */
async function deckState(path: string, model: string) {
  const usageTotals = await sessionUsageTotals(path);
  const usageByModel = await sessionUsageByModel(path);
  let state = applyEvent(initialState(), env({
    hook_event_name: "SessionStart", session_id: "s", model,
  }, 1));
  state = applyEvent(state, env({
    hook_event_name: "UsageObserved", session_id: "s", usage: usageTotals, usageByModel,
  }, 2));
  return state.agents.get("s")!;
}

describe("the fast-mode rate card", () => {
  it("prices Opus 5 and Opus 4.8 at $10 / $50 and Opus 5.5 at $8 / $40, caching multipliers on top", () => {
    // platform.claude.com/docs/en/about-claude/pricing, "Fast mode pricing":
    // "Claude Opus 5.5 | $8 / MTok | $40 / MTok" and "Claude Opus 5 / Claude
    // Opus 4.8 | $10 / MTok | $50 / MTok", and "Prompt caching multipliers
    // apply on top of fast mode pricing": 1.25x for a 5-minute write, 2x for a
    // 1-hour one, 0.1x for a hit, 0.05x on Opus 5.5.
    const opusFast = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 };
    expect(ratesForModel("claude-opus-5", NOW, "fast")).toEqual(opusFast);
    expect(ratesForModel("claude-opus-4-8", NOW, "fast")).toEqual(opusFast);
    expect(ratesForModel("claude-opus-5-5", NOW, "fast"))
      .toEqual({ input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10, cacheWrite1h: 16 });
    // The same ids the standard table accepts: a dated snapshot and CC's [1m].
    expect(ratesForModel("claude-opus-4-8-20260101", NOW, "fast")).toEqual(opusFast);
    expect(ratesForModel("claude-opus-5[1m]", NOW, "fast")).toEqual(opusFast);
  });

  it("reads `standard` as the standard table, exactly", () => {
    for (const id of [OPUS, "claude-opus-5-5", SONNET, "claude-haiku-4-5", "gpt-5.6"]) {
      expect(ratesForModel(id, NOW, "standard"), id).toEqual(ratesForModel(id, NOW));
    }
  });

  it("has no fast rate for a model Anthropic does not run fast, or one nobody has read", () => {
    // Fast mode is Opus 5.5, Opus 5 and Opus 4.8 only. Opus 4.7 rejects it and
    // Opus 4.6 runs at standard speed and says so. And #688's rule: a version
    // this build has never read a price for reaches no row.
    for (const id of [
      SONNET, "claude-sonnet-5-5", "claude-haiku-4-5", "claude-fable-5", "claude-opus-4-7",
      "claude-opus-4-6", "claude-opus-5-6", "claude-opus-4-9", "gpt-6-astra",
    ]) {
      expect(ratesForModel(id, NOW, "fast"), id).toBeNull();
    }
  });

  it("has no rate at all for a speed it has never read a price for", () => {
    expect(ratesForModel(OPUS, NOW, "turbo")).toBeNull();
    expect(ratesForModel(OPUS, NOW, "priority")).toBeNull();
  });
});

describe("the scanner keeps a fast turn's tokens as a share of its model", () => {
  it("records the share beside the model's bucket and leaves the totals alone", async () => {
    const path = writeTranscript("share.jsonl", [line(OPUS, STANDARD_TURN), line(OPUS, FAST_TURN)]);
    const byModel = await readUsageByModelFromTranscript(path);

    expect(Object.keys(byModel)).toEqual([OPUS]);
    expect(byModel[OPUS].input_tokens).toBe(3_000);
    expect(byModel[OPUS].output_tokens).toBe(30_000);
    expect(byModel[OPUS].speeds).toEqual({
      fast: {
        input_tokens: 1_000,
        output_tokens: 20_000,
        cache_read_input_tokens: 500_000,
        cache_creation_input_tokens: 40_000,
        ephemeral_1h_input_tokens: 30_000,
        ephemeral_5m_input_tokens: 10_000,
      },
    });

    const totals = await sessionUsageTotals(path);
    expect(totals.input_tokens).toBe(3_000);
    expect(totals.output_tokens).toBe(30_000);
    expect(totals.cache_read_input_tokens).toBe(600_000);
  });

  it("writes no share for a session that never ran fast", async () => {
    // Standard, and the key left out the way older Claude Code wrote it.
    const path = writeTranscript("standard.jsonl", [
      line(OPUS, STANDARD_TURN),
      line(OPUS, { ...STANDARD_TURN, speed: null }),
    ]);
    const byModel = await readUsageByModelFromTranscript(path);
    expect(byModel[OPUS]).not.toHaveProperty("speeds");
  });

  it("carries the share through the subagents/ merge", async () => {
    const sid = "fast-subagent";
    const path = writeTranscript(`${sid}.jsonl`, [line(OPUS, STANDARD_TURN)]);
    writeTranscript(join(sid, "subagents", "agent-abc123.jsonl"), [line(OPUS, FAST_TURN)]);

    const byModel = await sessionUsageByModel(path);
    expect(byModel[OPUS].input_tokens).toBe(3_000);
    expect(byModel[OPUS].speeds.fast.input_tokens).toBe(1_000);
    expect(byModel[OPUS].speeds.fast.output_tokens).toBe(20_000);
  });
});

describe("the board bills a fast turn at the premium and the rest at the standard rate", () => {
  it("costs $2.545 for a session whose second Opus 5 turn ran fast, not $1.4275", async () => {
    const path = writeTranscript("fast-session.jsonl", [line(OPUS, STANDARD_TURN), line(OPUS, FAST_TURN)]);
    const root = await deckState(path, OPUS);

    // By hand, $/MTok. The standard turn at $5 / $25 / $0.50:
    //   2,000 x 5 + 10,000 x 25 + 100,000 x 0.5            = $0.31
    // The fast turn at $10 / $50 / $1, writes at $20 (1h) and $12.50 (5m):
    //   1,000 x 10 + 20,000 x 50 + 500,000 x 1
    //   + 30,000 x 20 + 10,000 x 12.5                       = $2.235
    expect(agentCost(root, NOW).total).toBeCloseTo(0.31 + 2.235, 9);
    // Priced as one standard session, it read $1.4275 — the fast turn at half
    // its bill.
    const allStandard = costForUsage(usage(STANDARD_TURN), OPUS, NOW).total
                      + costForUsage(usage(FAST_TURN), OPUS, NOW).total;
    expect(allStandard).toBeCloseTo(1.4275, 9);
    expect(agentUnpricedTokens(root, NOW)).toBe(0);

    // One model, so one row, and the row carries the premium too.
    const rows = boardModelTable([root], NOW);
    expect(rows.map(r => r.model)).toEqual([OPUS]);
    expect(rows[0].agentCount).toBe(1);
    expect(rows[0].inputTokens).toBe(3_000);
    expect(rows[0].cost.total).toBeCloseTo(2.545, 9);
  });

  it("keeps the fast share when tokens the split cannot explain join the model's row", () => {
    // A finished Task folds its subagent's tokens into the owner's flat total
    // and nothing else, and usage-models.ts merges that remainder into the row
    // of the agent's own model at the standard rate. The fast share already on
    // that row has to survive the merge, or the premium disappears the moment
    // a Task finishes.
    const fast = usage(FAST_TURN);
    const root = {
      model: OPUS,
      usage: { ...fast, inputTokens: fast.inputTokens + 4_000, outputTokens: fast.outputTokens + 8_000 },
      usageByModel: { [OPUS]: { ...fast, bySpeed: { fast } } },
    };
    const remainder = costForUsage({ inputTokens: 4_000, outputTokens: 8_000, cacheReadTokens: 0, cacheCreateTokens: 0 }, OPUS, NOW).total;
    expect(agentCost(root, NOW).total).toBeCloseTo(2.235 + remainder, 9);
  });

  it("costs a session that never ran fast exactly what it did", async () => {
    const path = writeTranscript("never-fast.jsonl", [
      line(OPUS, STANDARD_TURN),
      line(OPUS, { ...STANDARD_TURN, speed: null }),
    ]);
    const root = await deckState(path, OPUS);
    expect(agentCost(root, NOW)).toEqual(costForUsage(root.usage, OPUS, NOW));
  });

  it("does not price a speed it has no rate for at the standard rate", async () => {
    const odd: Turn = { input: 4_000, output: 6_000, speed: "turbo" };
    const path = writeTranscript("odd-speed.jsonl", [line(OPUS, STANDARD_TURN), line(OPUS, odd)]);
    const root = await deckState(path, OPUS);

    // The standard turn is priced; the other is counted and left unpriced, and
    // the card says its figure is a floor.
    expect(agentCost(root, NOW).total).toBeCloseTo(0.31, 9);
    expect(agentUnpricedTokens(root, NOW)).toBe(10_000);
    const chip = costChip(root);
    expect(chip?.kind).toBe("spent");
    expect(chip?.kind === "spent" && chip.floor).toBe(true);
  });

  it("does not price a fast turn on a model with no published fast rate", async () => {
    const path = writeTranscript("fast-sonnet.jsonl", [line(SONNET, { input: 1_000, output: 1_000, speed: "fast" })]);
    const root = await deckState(path, SONNET);
    expect(agentCost(root, NOW).total).toBe(0);
    expect(agentUnpricedTokens(root, NOW)).toBe(2_000);
  });
});

describe("the card's tooltip shows the fast-mode multiplication", () => {
  it("prints the fast rate card beside the standard one and adds up to the chip", async () => {
    const path = writeTranscript("tooltip.jsonl", [line(OPUS, STANDARD_TURN), line(OPUS, FAST_TURN)]);
    const root = await deckState(path, OPUS);
    const tt = agentCostTooltip(root);

    expect(tt).toContain(`model: ${OPUS}\n`);
    expect(tt).toContain(`model: ${OPUS} · fast`);
    expect(tt).toMatch(/output\s+20,000\s+× \$50\/MTok\s+= \$1\.00/);
    expect(tt).toMatch(/output\s+10,000\s+× \$25\/MTok\s+= 25¢/);
    expect(tt.trimEnd().split("\n").pop()).toMatch(new RegExp(`= \\${fmtCost(agentCost(root, NOW).total)}$`));
  });
});
