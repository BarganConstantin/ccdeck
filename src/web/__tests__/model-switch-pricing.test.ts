// Tokens are priced at the model that produced them (#686).
//
// A session that switched model — `/model`, or Claude Code dropping from Opus
// to Sonnet when the weekly allowance runs low, or a subagent turn on another
// tier — used to have its ENTIRE history re-priced at whichever model wrote the
// final line of its transcript. The root's `usage` is a cumulative total for
// the whole file and the root's `model` is the most recent observation, and
// every cost surface in the deck multiplied one by the other.
//
// The measurement, made through the deck's own scanner over a constructed
// transcript of twenty Opus turns (50,000 in / 5,000 out each) then one Sonnet
// turn (1,000 / 100), at Sonnet 5's introductory rate:
//
//   totals            1,001,000 in / 100,100 out, rootModel claude-sonnet-5
//   truth             $7.503   (Opus 1M/100k at $5/$25, plus $0.003 of Sonnet)
//   last-wins deck    $3.003   (the lot at $2/$10)          — 60.0% under
//
// and with the ordering reversed — twenty Sonnet turns then one Opus turn — the
// same 1.1M tokens run the other way:
//
//   truth             $3.0075
//   last-wins deck    $7.5075                                — 149.6% over
//
// The sign of the error is decided by the last line of the file, which is not a
// property a bill has. Both directions are pinned below, because a fix that
// only corrected one of them would look right on half the machines that hit it.
//
// What these hold, in order: the scanner attributes each usage block to the
// model on its own line; the flat total is unchanged by that; a subagent is
// billed at its own model rather than at its parent's, which is the same bug
// one level in and reachable since #685 folded delegated spend into the session
// total; the reducer carries the split and clears a stale one; `agentCost`
// prices per bucket; the by-model breakdown gains a row per model instead of
// one row for the last one; usage the split cannot explain still costs money; a
// single-model session and a Codex session are byte-identical to the old
// arithmetic; and no surface in the app has gone back to multiplying `a.usage`
// by `a.model`.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { costForUsage } from "../pricing";
import { applyEvent, initialState } from "../reducer";
import {
  agentCost, agentModelIds, agentUnpricedTokens, otherModelIds,
  spansModels, usageByModelEntries,
} from "../usage-models";
import type { HookEnvelope, HookPayload, TokenUsage } from "../types";

// Nothing in this file may touch the real ~/.claude, ~/.codex or the
// claude-swap store: every home the server module resolves at import time is
// pointed at a throwaway directory before that import happens.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-model-switch-"));
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

// Pinned, not `Date.now()`. Sonnet 5's introductory $2/$10 runs to 2026-08-31
// and every dollar figure in this file is quoted at it, so a clock would make
// these cases start failing on their own in September — the exact pinning
// pricing.ts's own comment warns about, one layer up.
const NOW = Date.UTC(2026, 7, 24);          // 2026-08-24
const OPUS = "claude-opus-5";               // $5 / $25
const SONNET = "claude-sonnet-5";           // $2 / $10 until the cutover
const HAIKU = "claude-haiku-4-5";           // $1 / $5

const HERE = dirname(fileURLToPath(import.meta.url));
const srcOf = (rel: string) => readFileSync(resolve(HERE, "..", rel), "utf8");

const u = (i: number, o: number): TokenUsage => ({
  inputTokens: i, outputTokens: o, cacheReadTokens: 0, cacheCreateTokens: 0,
});

/** One assistant line as Claude Code writes it: `message.model` and
 *  `message.usage` in the same object, which is the whole reason attributing
 *  tokens to a model costs no extra read. Field order copied from a live
 *  transcript, `output_tokens_details` included — the usage-block capture stops
 *  at the first `}`, and a fixture without it would not exercise that. */
function turn(model: string, inTok: number, outTok: number): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: {
      model,
      role: "assistant",
      content: [{ type: "text", text: "x" }],
      usage: {
        input_tokens: inTok,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: outTok,
        output_tokens_details: { thinking_tokens: 0 },
      },
    },
  });
}

/** Twenty turns on `bulk`, then one on `tail`. 1,001,000 in / 100,100 out
 *  whichever way round, so the two orderings differ only in which model the
 *  file ends on — which is precisely the variable under test. */
function writeSwitchingTranscript(name: string, bulk: string, tail: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 20; i++) lines.push(turn(bulk, 50_000, 5_000));
  lines.push(turn(tail, 1_000, 100));
  const path = sandboxed(name);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

const env = (payload: HookPayload, seq: number): HookEnvelope =>
  ({ seq, receivedAt: 1_700_000_000_000 + seq, source: "hook", payload });

/** The session as the deck holds it after a scan: a root on `lastModel`, its
 *  cumulative totals, and the per-model split that arrived with them.
 *
 *  Through the two SESSION-level readers, which is exactly what
 *  `maybeResolveUsage` ships — main transcript plus the `subagents/` directory
 *  #685 folds in. Reading the pair the server reads is what keeps the split and
 *  the total it splits describing the same bytes. */
async function deckState(path: string, lastModel: string) {
  const usage = await sessionUsageTotals(path);
  const usageByModel = await sessionUsageByModel(path);
  let state = applyEvent(initialState(), env({
    hook_event_name: "SessionStart", session_id: "s", model: lastModel,
  }, 1));
  state = applyEvent(state, env({
    hook_event_name: "UsageObserved", session_id: "s", usage, usageByModel,
  }, 2));
  return { root: state.agents.get("s")!, usage, usageByModel };
}

describe("a transcript's usage is split by the model that produced it", () => {
  it("attributes each usage block to the model on its own line", async () => {
    const path = writeSwitchingTranscript("split.jsonl", OPUS, SONNET);
    const byModel = await readUsageByModelFromTranscript(path);

    expect(Object.keys(byModel).sort()).toEqual([OPUS, SONNET]);
    expect(byModel[OPUS].input_tokens).toBe(1_000_000);
    expect(byModel[OPUS].output_tokens).toBe(100_000);
    expect(byModel[SONNET].input_tokens).toBe(1_000);
    expect(byModel[SONNET].output_tokens).toBe(100);
  });

  it("leaves the flat total exactly where it was", async () => {
    // The split is about which RATE, never about how many tokens. Every token
    // readout in the deck reads this object, so a split that moved it would be
    // a second bug wearing the first one's fix.
    const path = writeSwitchingTranscript("flat.jsonl", OPUS, SONNET);
    const totals = await sessionUsageTotals(path);
    expect(totals.input_tokens).toBe(1_001_000);
    expect(totals.output_tokens).toBe(100_100);

    const byModel = await sessionUsageByModel(path);
    const summed = Object.values(byModel as Record<string, { input_tokens: number; output_tokens: number }>)
      .reduce((acc, b) => ({ i: acc.i + b.input_tokens, o: acc.o + b.output_tokens }), { i: 0, o: 0 });
    expect(summed.i).toBe(totals.input_tokens);
    expect(summed.o).toBe(totals.output_tokens);
  });

  it("bills a subagent at its OWN model, not at the model its parent is on", async () => {
    // #685 made a session's total include every subagent it ran, read out of
    // `<sessionId>/subagents/agent-*.jsonl`. A Task is given a model, and it is
    // routinely not its parent's — the deck already reads a per-agent model map
    // for exactly that reason — so a session sum that carried only the root's
    // models would price delegated tokens at whatever the root is on now. That
    // is this bug one level in, and the split has to reach the same two places
    // the total does.
    const sid = "with-subagent";
    const path = sandboxed(`${sid}.jsonl`);
    writeFileSync(path, turn(OPUS, 100_000, 10_000) + "\n");
    const subDir = sandboxed(join(sid, "subagents"));
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "agent-abc123.jsonl"), turn(HAIKU, 200_000, 20_000) + "\n");

    const totals = await sessionUsageTotals(path);
    expect(totals.input_tokens).toBe(300_000);
    expect(totals.output_tokens).toBe(30_000);

    const byModel = await sessionUsageByModel(path);
    expect(Object.keys(byModel).sort()).toEqual([HAIKU, OPUS]);
    expect(byModel[HAIKU].input_tokens).toBe(200_000);
    expect(byModel[OPUS].input_tokens).toBe(100_000);

    const { root } = await deckState(path, OPUS);
    const truth = costForUsage(u(100_000, 10_000), OPUS, NOW).total
                + costForUsage(u(200_000, 20_000), HAIKU, NOW).total;
    expect(truth).toBeCloseTo(0.5 + 0.25 + 0.2 + 0.1, 9);       // $1.05
    expect(agentCost(root, NOW).total).toBeCloseTo(truth, 9);
    // All of it at the parent's Opus would be $2.25 — more than twice the bill.
    expect(costForUsage(root.usage, OPUS, NOW).total).toBeCloseTo(2.25, 9);
  });

  it("sums the split back to the flat total across both halves and a Task tail", async () => {
    // THE INVARIANT, over the one composition where the two arithmetics could
    // come apart. A session's spend is read from two places since #685 — the
    // main transcript and every `subagents/agent-*.jsonl` — and each line of
    // either is cut at a top-level `toolUseResult`, because a finished Task
    // restates its subagent's last turn there and those tokens are already in
    // the subagent's own file. The split has to take exactly what the total
    // takes, at all three levels: the same `billed` slice of each line, the
    // same per-file scan state, the same directory walk. A split that read one
    // byte more or less than the total it splits would either re-introduce
    // #685's double count on one side only, or silently drop money into a
    // remainder — and both failures look like a correct number until you add
    // the rows up.
    const sid = "sums-back";
    const path = sandboxed(`${sid}.jsonl`);
    // Parent: one Opus turn, then a Sonnet turn whose line ALSO carries the
    // `toolUseResult` a finished Task leaves behind — a restated 999,999
    // tokens that neither reader may count.
    const restated = JSON.stringify({
      type: "user",
      message: { model: SONNET, usage: { input_tokens: 7_000, output_tokens: 700 } },
      toolUseResult: { usage: { input_tokens: 999_999, output_tokens: 999_999 } },
      });
      writeFileSync(path, [turn(OPUS, 50_000, 5_000), restated].join("\n") + "\n");
      const subDir = sandboxed(join(sid, "subagents"));
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, "agent-aaa111.jsonl"), turn(HAIKU, 30_000, 3_000) + "\n");
      writeFileSync(join(subDir, "agent-bbb222.jsonl"), turn(SONNET, 20_000, 2_000) + "\n");

      const totals = await sessionUsageTotals(path);
      const byModel = await sessionUsageByModel(path);

      // The Task tail is out of both, not just out of one.
      expect(totals.input_tokens).toBe(50_000 + 7_000 + 30_000 + 20_000);
      expect(totals.output_tokens).toBe(5_000 + 700 + 3_000 + 2_000);

      // Three models, each holding the tokens it produced across both halves —
      // Sonnet's row is the parent's second turn PLUS a subagent's, which is
      // the merge doing its job.
      expect(Object.keys(byModel).sort()).toEqual([HAIKU, OPUS, SONNET]);
      expect(byModel[OPUS].input_tokens).toBe(50_000);
      expect(byModel[SONNET].input_tokens).toBe(27_000);
      expect(byModel[HAIKU].input_tokens).toBe(30_000);

      // And the whole point: field for field, the buckets ARE the total.
      const buckets = Object.values(byModel as Record<string, Record<string, number>>);
      for (const k of Object.keys(totals) as Array<keyof typeof totals>) {
        expect(buckets.reduce((n, b) => n + (b[k as string] ?? 0), 0), k as string)
          .toBe(totals[k]);
      }

      // So the deck has no remainder to fall back on, and every dollar is
      // attributed rather than guessed at the session's current model.
      const { root } = await deckState(path, SONNET);
      expect(usageByModelEntries(root)).toHaveLength(3);
      expect(agentCost(root, NOW).total).toBeCloseTo(
        costForUsage(u(50_000, 5_000), OPUS, NOW).total
      + costForUsage(u(27_000, 2_700), SONNET, NOW).total
      + costForUsage(u(30_000, 3_000), HAIKU, NOW).total, 9);
  });
});

describe("a mostly-Opus session that ends on Sonnet costs $7.503, not $3.003", () => {
  it("prices the Opus tokens at Opus and the Sonnet tokens at Sonnet", async () => {
    const path = writeSwitchingTranscript("opus-then-sonnet.jsonl", OPUS, SONNET);
    const { root } = await deckState(path, SONNET);

    // The session IS on Sonnet — that half of the old behaviour was never
    // wrong, and the card still says so.
    expect(root.model).toBe(SONNET);
    expect(root.usage.inputTokens).toBe(1_001_000);
    expect(root.usage.outputTokens).toBe(100_100);

    const truth = costForUsage(u(1_000_000, 100_000), OPUS, NOW).total
                + costForUsage(u(1_000, 100), SONNET, NOW).total;
    expect(truth).toBeCloseTo(7.503, 9);
    expect(agentCost(root, NOW).total).toBeCloseTo(7.503, 9);

    // And is not what the last model alone would say. Named here rather than
    // left implicit: restoring last-wins pricing has to fail this case with
    // both numbers on screen, or the case is not pinning anything.
    const lastWins = costForUsage(root.usage, root.model, NOW).total;
    expect(lastWins).toBeCloseTo(3.003, 9);
    expect(agentCost(root, NOW).total).not.toBeCloseTo(lastWins, 3);
    expect((lastWins - truth) / truth).toBeCloseTo(-0.5997, 3);   // 60.0% under
  });
});

describe("a mostly-Sonnet session that ends on Opus costs $3.0075, not $7.5075", () => {
  it("runs the error the other way, so a one-sided fix cannot pass", async () => {
    const path = writeSwitchingTranscript("sonnet-then-opus.jsonl", SONNET, OPUS);
    const { root } = await deckState(path, OPUS);

    expect(root.model).toBe(OPUS);
    const truth = costForUsage(u(1_000_000, 100_000), SONNET, NOW).total
                + costForUsage(u(1_000, 100), OPUS, NOW).total;
    expect(truth).toBeCloseTo(3.0075, 9);
    expect(agentCost(root, NOW).total).toBeCloseTo(3.0075, 9);

    const lastWins = costForUsage(root.usage, root.model, NOW).total;
    expect(lastWins).toBeCloseTo(7.5075, 9);
    expect((lastWins - truth) / truth).toBeCloseTo(1.4963, 3);    // 149.6% over
  });
});

describe("the by-model breakdown shows both models, not just the last one", () => {
  it("gives the session a row per model, each with the tokens that model produced", async () => {
    // The exact fold the usage panel's `byModel` memo runs — it iterates
    // `usageByModelEntries(a)` rather than agents, and this is that loop with
    // the React removed so a plain-Node suite can reach it.
    const path = writeSwitchingTranscript("by-model.jsonl", OPUS, SONNET);
    const { root } = await deckState(path, SONNET);

    const rows = new Map<string, { tokens: number; cost: number }>();
    for (const e of usageByModelEntries(root)) {
      const key = e.model ?? "__unknown__";
      const row = rows.get(key) ?? { tokens: 0, cost: 0 };
      row.tokens += e.usage.inputTokens + e.usage.outputTokens;
      row.cost += costForUsage(e.usage, e.model, NOW).total;
      rows.set(key, row);
    }

    // Two rows. Before this landed there was one, reading `Sonnet 5 · 1.1M ·
    // $3.00`, with no Opus row anywhere on the panel to say the tokens had ever
    // belonged to another model.
    expect([...rows.keys()].sort()).toEqual([OPUS, SONNET]);
    expect(rows.get(OPUS)!.tokens).toBe(1_100_000);
    expect(rows.get(SONNET)!.tokens).toBe(1_100);
    expect(rows.get(OPUS)!.cost).toBeCloseTo(7.5, 9);
    expect(rows.get(SONNET)!.cost).toBeCloseTo(0.003, 9);

    // The rows sum to the figure the strip above them prints.
    const sum = [...rows.values()].reduce((n, r) => n + r.cost, 0);
    expect(sum).toBeCloseTo(agentCost(root, NOW).total, 9);
    expect([...rows.values()].reduce((n, r) => n + r.tokens, 0))
      .toBe(root.usage.inputTokens + root.usage.outputTokens);
  });

  it("names both models to the card, with the current one still on the chip", async () => {
    const path = writeSwitchingTranscript("chip.jsonl", OPUS, SONNET);
    const { root } = await deckState(path, SONNET);

    expect(spansModels(root)).toBe(true);
    expect(agentModelIds(root)).toEqual([OPUS, SONNET]);
    // The chip keeps naming the model the session is ON — that is the question
    // it answers, and the only one about what happens next. What it gains is a
    // count of the models the dollars beside it also cover.
    expect(otherModelIds(root)).toEqual([OPUS]);
  });
});

describe("a bucket that produced nothing is not a model the card names (#1173)", () => {
  // `agentModelIds` is what the chip's "+N", its tooltip and `spansModels` are
  // built on, and it skips two kinds of entry: one with no model, and one whose
  // four token classes sum to zero. Every bucket in the cases above carries
  // tokens, so neither skip had ever run. Both reach it for real. The server's
  // `subagents/` merge (`mergeUsageByModel`) keeps a zero bucket the main
  // transcript's read would have filtered, and `usageByModelFromWire` passes
  // it through. And the remainder `usageByModelEntries` prices at the agent's
  // own model has no model at all when the agent has none. Either one, counted,
  // is "Opus 5 +1" over a model that cost nothing: #686's misreading, small.
  it("drops an all-zero bucket from the list, from the +N and from the spans test", () => {
    const root = {
      model: SONNET,
      usage: u(1_010, 110),
      usageByModel: { [OPUS]: u(1_000, 100), [HAIKU]: u(0, 0), [SONNET]: u(10, 10) },
    };
    expect(agentModelIds(root)).toEqual([OPUS, SONNET]);
    expect(otherModelIds(root)).toEqual([OPUS]);
    expect(spansModels(root)).toBe(true);
  });

  it("does not read one real model and one empty bucket as two", () => {
    const root = { model: OPUS, usage: u(1_000, 100), usageByModel: { [OPUS]: u(1_000, 100), [HAIKU]: u(0, 0) } };
    expect(spansModels(root)).toBe(false);
    expect(otherModelIds(root)).toEqual([]);
  });

  it("lists no undefined entry for the remainder of an agent with no model", () => {
    // The flat total is larger than the split, and the remainder goes to the
    // agent's own model, which is not known yet — a ModelObserved that has
    // not landed. The entry is priced (as nothing) and must not be named.
    const root = { model: undefined, usage: u(2_000, 200), usageByModel: { [OPUS]: u(1_000, 100) } };
    expect(usageByModelEntries(root).map(e => e.model)).toEqual([OPUS, undefined]);
    expect(agentModelIds(root)).toEqual([OPUS]);
  });

  it("drops the zero bucket a UsageObserved carries, end to end through the reducer", () => {
    let state = applyEvent(initialState(), env({ hook_event_name: "SessionStart", session_id: "s3" }, 1));
    state = applyEvent(state, env({
      hook_event_name: "UsageObserved", session_id: "s3",
      usage: { input_tokens: 5, output_tokens: 0 },
      usageByModel: {
        [HAIKU]: { input_tokens: 0, output_tokens: 0 },
        [OPUS]: { input_tokens: 5 },
      },
    }, 2));
    const root = state.agents.get("s3")!;
    // The reducer keeps the empty bucket: it describes the file as the scan
    // read it. Leaving it out is the reader's job.
    expect(Object.keys(root.usageByModel!)).toEqual([HAIKU, OPUS]);
    expect(agentModelIds(root)).toEqual([OPUS]);
  });
});

describe("what the split does not explain still costs money", () => {
  it("prices the remainder at the agent's current model rather than dropping it", () => {
    // A finished `Task` folds its subagent's tokens into its owner's flat
    // `usage` and into no bucket, so the flat total can exceed the split. A
    // reader that only summed the buckets would make those tokens free — which
    // would be a worse under-report than the one being fixed.
    const root = {
      model: SONNET,
      usage: u(1_100_000, 110_000),
      usageByModel: { [OPUS]: u(1_000_000, 100_000) },
    };
    const expected = costForUsage(u(1_000_000, 100_000), OPUS, NOW).total
                   + costForUsage(u(100_000, 10_000), SONNET, NOW).total;
    expect(agentCost(root, NOW).total).toBeCloseTo(expected, 9);

    // Every token accounted for exactly once, in both directions.
    const entries = usageByModelEntries(root);
    expect(entries.reduce((n, e) => n + e.usage.inputTokens, 0)).toBe(1_100_000);
    expect(entries.reduce((n, e) => n + e.usage.outputTokens, 0)).toBe(110_000);
  });

  it("folds the remainder into the current model's own row instead of a second one", () => {
    // Otherwise one agent contributes two entries for one model, and the
    // by-model table's agent count says the deck is running more sessions
    // than it is.
    const root = {
      model: OPUS,
      usage: u(1_100_000, 0),
      usageByModel: { [OPUS]: u(1_000_000, 0) },
    };
    const entries = usageByModelEntries(root);
    expect(entries).toHaveLength(1);
    expect(entries[0].usage.inputTokens).toBe(1_100_000);
  });

  it("counts unpriced tokens per model, so half a session is not all of it", () => {
    // A model this build has no row for used to make the WHOLE session unpriced
    // or the whole of it priced, depending on which one wrote the last line.
    const root = {
      model: "claude-quasar-9",
      usage: u(1_001_000, 100_100),
      usageByModel: { [OPUS]: u(1_000_000, 100_000), "claude-quasar-9": u(1_000, 100) },
    };
    expect(agentCost(root, NOW).total).toBeCloseTo(7.5, 9);
    expect(agentUnpricedTokens(root, NOW)).toBe(1_100);
  });
});

describe("cache tokens are priced at the model that wrote them, and at the TTL they were written at", () => {
  // THE TWO HALVES WERE EACH TESTED AND THEIR COMPOSITION WAS NOT (#994). Every
  // fixture above carries `cache_creation_input_tokens: 0` and
  // `cache_read_input_tokens: 0`, and the files that drive the 1-hour/5-minute
  // split properly — cache-write-ttl, subagent-usage, transcript-incremental —
  // never mention `usageByModel`. So no test had ever put a cache token through
  // a per-model bucket, which is the one place cache tokens are priced on a
  // session that switched model.
  //
  // On an agentic session cache reads and writes are most of the bill, and the
  // way this breaks is quiet. A bucket that loses its TTL split prices every
  // 1-hour write at the 5-minute rate — 1.25x input instead of 2x — and the
  // remainder cannot rescue it: `remainderUsage` decides whether anything is
  // left over from the four headline counts alone, and those still sum to the
  // flat total. The figure printed is smaller, confident, and wrong. Measured
  // on this fixture with the reducer's `usageFromWire` dropping
  // `cacheCreate1hTokens`: `agentCost` read $1.02006 for a session that cost
  // $1.43256, 28.8% under, and every case in this file stayed green.
  //
  // Written in the field order of a live transcript, the one cache-write-ttl
  // copies: `cache_creation` after `server_tool_use`, past the first `}` where
  // the usage-block capture stops, so the sub-object is read the way the
  // scanner really has to read it.
  function cachedTurn(model: string, t: { input: number; output: number; read: number; h1: number; m5: number }): string {
    return JSON.stringify({
      type: "assistant",
      isSidechain: false,
      message: {
        model,
        role: "assistant",
        content: [{ type: "text", text: "x" }],
        usage: {
          input_tokens: t.input,
          cache_creation_input_tokens: t.h1 + t.m5,
          cache_read_input_tokens: t.read,
          output_tokens: t.output,
          server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
          service_tier: "standard",
          cache_creation: { ephemeral_1h_input_tokens: t.h1, ephemeral_5m_input_tokens: t.m5 },
        },
      },
    });
  }

  /** An Opus turn that wrote mostly 1-hour cache, then a Sonnet turn that wrote
   *  only 1-hour cache — so each bucket's split is different, and neither can
   *  pass by borrowing the other's. */
  function writeCachedSwitch(name: string): string {
    const path = sandboxed(name);
    writeFileSync(path, [
      cachedTurn(OPUS, { input: 10, output: 1_000, read: 400_000, h1: 90_000, m5: 10_000 }),
      cachedTurn(SONNET, { input: 5, output: 500, read: 200_000, h1: 50_000, m5: 0 }),
    ].join("\n") + "\n");
    return path;
  }

  it("carries reads, writes and the 1h/5m split into each model's own bucket", async () => {
    const path = writeCachedSwitch("cached-switch.jsonl");

    // The scanner's half: each bucket holds its own model's cache lines, in the
    // wire spelling the usage event carries them in.
    const byModel = await sessionUsageByModel(path);
    expect(byModel[OPUS]).toMatchObject({
      cache_read_input_tokens: 400_000, cache_creation_input_tokens: 100_000,
      ephemeral_1h_input_tokens: 90_000, ephemeral_5m_input_tokens: 10_000,
    });
    expect(byModel[SONNET]).toMatchObject({
      cache_read_input_tokens: 200_000, cache_creation_input_tokens: 50_000,
      ephemeral_1h_input_tokens: 50_000, ephemeral_5m_input_tokens: 0,
    });

    // The reducer's half: the same lines in the client's spelling, TTL and all.
    const { root } = await deckState(path, SONNET);
    expect(root.usageByModel?.[OPUS]).toMatchObject({
      cacheReadTokens: 400_000, cacheCreateTokens: 100_000,
      cacheCreate1hTokens: 90_000, cacheCreate5mTokens: 10_000,
    });
    expect(root.usageByModel?.[SONNET]).toMatchObject({
      cacheReadTokens: 200_000, cacheCreateTokens: 50_000,
      cacheCreate1hTokens: 50_000, cacheCreate5mTokens: 0,
    });
    // The buckets explain the whole flat total, so there is no remainder for
    // the current model to absorb and hide a missing field in.
    expect(usageByModelEntries(root)).toHaveLength(2);
  });

  it("bills each model's 1-hour writes at that model's 1-hour rate", async () => {
    const { root } = await deckState(writeCachedSwitch("cached-switch-cost.jsonl"), SONNET);

    // Priced by hand from the rate card rather than through costForUsage, so
    // this case does not inherit whatever costForUsage might get wrong. $/MTok:
    //   Opus 5    input 5  output 25  cache read 0.5  write 5m 6.25  write 1h 10
    //   Sonnet 5  input 2  output 10  cache read 0.2  write 5m 2.5   write 1h 4
    // Sonnet at its introductory rate, which is what NOW is pinned for.
    const opusWrites = (10_000 * 6.25 + 90_000 * 10) / 1e6;                     // $0.9625
    const sonnetWrites = (50_000 * 4) / 1e6;                                    // $0.2
    const opus = (10 * 5 + 1_000 * 25 + 400_000 * 0.5) / 1e6 + opusWrites;      // $1.18755
    const sonnet = (5 * 2 + 500 * 10 + 200_000 * 0.2) / 1e6 + sonnetWrites;     // $0.24501

    const cost = agentCost(root, NOW);
    expect(cost.total).toBeCloseTo(opus + sonnet, 9);                          // $1.43256
    expect(cost.cacheWrite).toBeCloseTo(opusWrites + sonnetWrites, 9);
    // What the lost split prints instead, named so a regression to it fails with
    // both numbers on screen: every write at the 5-minute rate.
    const lostSplit = opus + sonnet - (90_000 * (10 - 6.25) + 50_000 * (4 - 2.5)) / 1e6;
    expect(lostSplit).toBeCloseTo(1.02006, 9);
    expect(cost.total).not.toBeCloseTo(lostSplit, 3);
  });
});

describe("a session that never switched is priced exactly as it always was", () => {
  it("matches the single multiplication when one model produced everything", async () => {
    const path = writeSwitchingTranscript("single.jsonl", OPUS, OPUS);
    const { root } = await deckState(path, OPUS);
    expect(agentCost(root, NOW).total)
      .toBeCloseTo(costForUsage(root.usage, OPUS, NOW).total, 9);
    expect(usageByModelEntries(root)).toHaveLength(1);
    expect(otherModelIds(root)).toEqual([]);
  });

  it("falls back to the flat total for a source that reports no split at all", () => {
    // Codex: the rollout carries one running `total_token_usage` and no
    // per-model breakdown, and a subagent node carries no map either. Both have
    // to go on pricing the way they did, because for them the old arithmetic is
    // the right arithmetic.
    const codex = { model: "gpt-5.6", usage: u(400_000, 30_000) };
    expect(agentCost(codex, NOW)).toEqual(costForUsage(codex.usage, "gpt-5.6", NOW));
    expect(usageByModelEntries(codex)).toEqual([{ model: "gpt-5.6", usage: codex.usage }]);
  });
});

describe("the split is cumulative, so a pass that carries none clears it", () => {
  it("does not leave a stale map pricing tokens the transcript no longer has", () => {
    let state = applyEvent(initialState(), env({
      hook_event_name: "SessionStart", session_id: "s2", model: SONNET,
    }, 1));
    state = applyEvent(state, env({
      hook_event_name: "UsageObserved", session_id: "s2",
      usage: { input_tokens: 1_001_000, output_tokens: 100_100 },
      usageByModel: {
        [OPUS]: { input_tokens: 1_000_000, output_tokens: 100_000 },
        [SONNET]: { input_tokens: 1_000, output_tokens: 100 },
      },
    }, 2));
    expect(agentCost(state.agents.get("s2")!, NOW).total).toBeCloseTo(7.503, 9);

    // A `/clear` truncates the file and the scan starts over; a Codex event on
    // the same id carries no split at all. Either way the previous map is a
    // description of bytes that are gone.
    state = applyEvent(state, env({
      hook_event_name: "UsageObserved", session_id: "s2",
      usage: { input_tokens: 1_000, output_tokens: 100 },
    }, 3));
    const root = state.agents.get("s2")!;
    expect(root.usageByModel).toBeUndefined();
    expect(agentCost(root, NOW).total)
      .toBeCloseTo(costForUsage(u(1_000, 100), SONNET, NOW).total, 9);
  });
});

describe("no cost surface multiplies a whole session by its last model", () => {
  it("has no `costForUsage(x.usage, x.model)` left anywhere in the app", () => {
    // The shape of the bug, as one regex. Nine call sites across six files
    // wrote it, every one of them wrong in the same way, and the reason it went
    // unnoticed for so long is that each looked locally correct. A tenth would
    // too.
    //
    // `e.usage, e.model` is exempt and is the only exemption: `e` is one entry
    // out of `usageByModelEntries`, where the usage and the model DO describe
    // the same tokens. That is the corrected call, so excluding it by name is
    // excluding the fix rather than widening a hole — any other receiver, this
    // one included the moment it is renamed to something that is not an entry,
    // trips the check.
    const files = [
      "App.tsx", "components/UsagePanel.tsx", "components/SessionList.tsx",
      "components/SessionSummary.tsx", "components/ContextModal.tsx",
      "components/AgentNode.tsx", "board-usage.ts",
    ];
    const lastWins = /costForUsage\(\s*(?!e\.)(\w+)\.usage\s*,\s*\1\.model\s*\)/;
    for (const f of files) expect(lastWins.test(srcOf(f)), f).toBe(false);
  });

  it("keys the usage panel's model table on the split rather than on one field", () => {
    const panel = srcOf("components/UsagePanel.tsx");
    // The row key comes from an ENTRY now. `const key = a.model ?? UNKNOWN_MODEL`
    // is what produced a single Sonnet row for a session that spent a million
    // tokens on Opus.
    expect(panel).not.toMatch(/const key = a\.model \?\? UNKNOWN_MODEL/);
    expect(panel).toMatch(/for \(const e of usageByModelEntries\(a\)\)/);
    expect(panel).toMatch(/const key = e\.model \?\? UNKNOWN_MODEL/);
  });

  it("carries the split from the scanner to the client on the usage event", () => {
    const server = srcOf("../server/index.mjs");
    expect(server).toMatch(/usageByModel: \{\}/);
    expect(server).toMatch(/readUsageByModelFromTranscript/);
    // And from BOTH places the total is read from — the main transcript and the
    // `subagents/` directory #685 folds in.
    expect(server).toMatch(/export async function sessionUsageByModel/);
    expect(server).toMatch(/usageByModel: spent \? usageByModel : null/);
    expect(server).toMatch(/Promise\.all\(\[sessionUsageTotals\(tp\), sessionUsageByModel\(tp\)\]\)/);
    expect(server).toMatch(/hook_event_name: "UsageObserved", session_id: sid, usage, usageByModel/);
  });
});
