import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { scanTranscript, copyUsageBucket, mergeUsageByModel, newRequestLedger, isLongContextRequest } from "../../server/transcript-scan.mjs";
import { foldLine, reportFrom } from "../../server/account-projects.mjs";
import { usageByModelFromWire } from "../usage-wire";
import { ratesForModel, costForUsage } from "../pricing";
import { shortModel } from "../model-label";
import { contextWindowForModel } from "../context-window";
import { costBreakdownTooltip } from "../card-cost";
import { reconcile } from "../account-projects-reconcile";
import type { TokenUsage } from "../types";

const MODEL = "claude-haiku-5-5";
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-model-pricing-"));
afterAll(() => rmTempDir(DIR));
const now = Date.parse("2026-10-12T12:00:00Z");
const timeline = [{ at: now - 86400000, slot: 1, email: "qa@example.test", orgUuid: "qa", source: "start" }];
const raw = (i: number, r = 0, w = 0) => ({
  input_tokens: i, output_tokens: 1000, cache_read_input_tokens: r, cache_creation_input_tokens: w,
  cache_creation: { ephemeral_1h_input_tokens: w, ephemeral_5m_input_tokens: 0 },
});
function line(id: string, u: ReturnType<typeof raw>, extra = {}) {
  return JSON.stringify({ type: "assistant", timestamp: "2026-10-12T10:00:00Z", cwd: DIR,
    message: { id, model: MODEL, usage: u, content: [{ type: "text", text: "test" }] }, ...extra });
}
const usage = (u: ReturnType<typeof raw>): TokenUsage => ({ inputTokens: u.input_tokens,
  outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens,
  cacheCreateTokens: u.cache_creation_input_tokens, cacheCreate1hTokens: u.cache_creation_input_tokens,
  cacheCreate5mTokens: 0 });
const expected = (u: ReturnType<typeof raw>, factor = 1) =>
  factor * (u.input_tokens * 0.1 + u.output_tokens * 0.5 + u.cache_read_input_tokens * 0.01 + u.cache_creation_input_tokens * 0.2) / 1e6;

describe("published model coverage checked 2026-10-12", () => {
  it("recognizes Haiku 5.5 across Claude providers, with its real window", () => {
    for (const id of [MODEL, "claude-haiku-5.5", "claude_haiku_5_5", `us.anthropic.${MODEL}`, `anthropic.${MODEL}`, `${MODEL}@default`]) {
      expect(ratesForModel(id)).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2 });
      expect(contextWindowForModel(id)).toBe(1000000);
      expect(shortModel(id)).toContain("Haiku 5.5");
    }
    for (const id of ["claude-haiku-5-6", "claude-haiku-5-5-1", "claude-haiku-5-55", "gpt-5.6-sol-pro", "gpt-5.6-luna-pro", "gpt-5.6-terra-pro", "gpt-5.6-cyber-pro"]) expect(ratesForModel(id)).toBeNull();
    expect(ratesForModel(MODEL, now, "fast")).toBeNull();
  });
  it("keeps retired GPT-5.3 Chat usage priced, at the published 128K window", () => {
    expect(ratesForModel("gpt-5.3-chat-latest")).toEqual({ input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 });
    expect(contextWindowForModel("gpt-5.3-chat-latest")).toBe(128000);
    expect(ratesForModel("gpt-5.3-chat-latest-pro")).toBeNull();
  });
  it("corrects Sonnet 5.5 cache hits without changing Sonnet 5", () => {
    expect(ratesForModel("claude-sonnet-5-5")?.cacheRead).toBe(0.1);
    expect(ratesForModel("claude-sonnet-5")?.cacheRead).toBe(0.2);
  });
});

describe("Haiku request tiers through both transcript readers", () => {
  it("counts cache reads and writes toward the strict 100K boundary", () => {
    expect(isLongContextRequest(MODEL, raw(100000))).toBe(false);
    expect(isLongContextRequest(MODEL, raw(100001))).toBe(true);
    expect(isLongContextRequest(MODEL, raw(1, 90000, 10000))).toBe(true);
    expect(isLongContextRequest("claude-haiku-4-5", raw(200000))).toBe(false);
  });
  it("prices a mix of short and long requests, preserving cache TTL and copies", async () => {
    const short = raw(1000, 80000, 19000), long = raw(1001, 80000, 19000);
    const path = join(DIR, "mixed.jsonl");
    writeFileSync(path, [line("short", short), line("long", long)].join("\n") + "\n");
    const state = await scanTranscript(path);
    const buckets = usageByModelFromWire(state.usageByModel)!;
    expect(costForUsage(buckets[MODEL], MODEL).total).toBeCloseTo(expected(short) + expected(long, 5), 10);
    const copied = copyUsageBucket(state.usageByModel[MODEL]);
    copied.longContext.input_tokens++;
    expect(state.usageByModel[MODEL].longContext.input_tokens).toBe(1001);
    const merged = mergeUsageByModel({}, state.usageByModel);
    mergeUsageByModel(merged, state.usageByModel);
    expect(costForUsage(usageByModelFromWire(merged)![MODEL], MODEL).total).toBeCloseTo(2 * (expected(short) + expected(long, 5)), 10);
    const tt = costBreakdownTooltip(buckets[MODEL], MODEL);
    expect(tt).toContain("prompt >100K");
    expect(tt).toContain("$0.5/MTok");
    expect(tt).toContain("$2.5/MTok");
    const tally: Record<string, unknown> = {};
    foldLine(tally, line("short", short), timeline);
    foldLine(tally, line("long", long), timeline);
    const [key] = Object.keys(tally);
    const rec = reconcile(reportFrom(tally, timeline, key, 0, now).daily, null, new Map(), now);
    expect(rec.totalCost).toBeCloseTo(expected(short) + expected(long, 5), 10);
  });
  it("does not surcharge many short requests after the session total passes 100K", async () => {
    const turn = raw(40000);
    const path = join(DIR, "shorts.jsonl");
    writeFileSync(path, [line("1", turn), line("2", turn), line("3", turn)].join("\n") + "\n");
    const state = await scanTranscript(path);
    expect(costForUsage(usageByModelFromWire(state.usageByModel)![MODEL], MODEL).total).toBeCloseTo(3 * expected(turn), 10);
  });
  it("refunds a streaming tier before charging the final request across incremental scans", async () => {
    const path = join(DIR, "streaming.jsonl"), short = raw(99000), long = raw(100001);
    const snapshot = line("request", short, { isSidechain: true, apiBlockIndex: 0, requestId: "r1" });
    // A streaming record has no stop_reason; the final record does.
    const final = JSON.parse(line("request", long, { isSidechain: true, apiBlockIndex: 1, requestId: "r1" }));
    final.message.stop_reason = "end_turn";
    writeFileSync(path, snapshot + "\n");
    await scanTranscript(path);
    appendFileSync(path, JSON.stringify(final) + "\n");
    const state = await scanTranscript(path);
    expect(costForUsage(usageByModelFromWire(state.usageByModel)![MODEL], MODEL).total).toBeCloseTo(expected(long, 5), 10);
    const tally: Record<string, unknown> = {}, from = { path, requests: { [path]: newRequestLedger() } };
    foldLine(tally, snapshot, timeline, from);
    foldLine(tally, JSON.stringify(final), timeline, from);
    const [key] = Object.keys(tally);
    expect(reconcile(reportFrom(tally, timeline, key, 0, now).daily, null, new Map(), now).totalCost).toBeCloseTo(expected(long, 5), 10);
  });
  it("keeps calibrated project costs proportional to each project's request tier", () => {
    const short = raw(40000), long = raw(100001);
    const tally: Record<string, unknown> = {};
    const l = (id: string, u: ReturnType<typeof raw>, cwd: string) => {
      const obj = JSON.parse(line(id, u)); obj.cwd = cwd; return JSON.stringify(obj);
    };
    foldLine(tally, l("short", short, DIR + "/short"), timeline);
    foldLine(tally, l("long", long, DIR + "/long"), timeline);
    const [key] = Object.keys(tally);
    const daily = reportFrom(tally, timeline, key, 0, now).daily;
    const cells = new Map([[`${daily[0].day}|${MODEL}`, {
      cost: expected(short) + expected(long, 5),
      usage: usage(raw(140001)),
    }]]);
    cells.values().next().value!.usage.outputTokens = 2000;
    const rec = reconcile(daily, null, cells, now);
    expect(rec.projects.find(p => p.path.endsWith("/short"))?.cost).toBeCloseTo(expected(short), 10);
    expect(rec.projects.find(p => p.path.endsWith("/long"))?.cost).toBeCloseTo(expected(long, 5), 10);
  });
  it("refunds a long snapshot when the final request falls below the threshold", async () => {
    const path = join(DIR, "long-to-short.jsonl"), short = raw(99000), long = raw(100001);
    const snapshot = line("req", long, { apiBlockIndex: 0, requestId: "r2" });
    const final = JSON.parse(line("req", short, { apiBlockIndex: 1, requestId: "r2" }));
    final.message.stop_reason = "end_turn";
    writeFileSync(path, snapshot + "\n");
    await scanTranscript(path);
    appendFileSync(path, JSON.stringify(final) + "\n");
    const state = await scanTranscript(path);
    expect(costForUsage(usageByModelFromWire(state.usageByModel)![MODEL], MODEL).total).toBeCloseTo(expected(short), 10);
  });
  it("does not infer a long request from legacy aggregate usage with no tier evidence", () => {
    const aggregate = usage(raw(200000));
    expect(costForUsage(aggregate, MODEL).total).toBeCloseTo(expected(raw(200000)), 10);
  });
});
