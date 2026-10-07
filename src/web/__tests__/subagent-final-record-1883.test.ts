// #1883: a subagent's request is billed from its final record, not from the
// streaming snapshot Claude Code writes first.
//
// In a subagent's `subagents/agent-*.jsonl`, Claude Code writes an assistant
// record while the response is still streaming: `apiBlockIndex` 0,
// `stop_reason: null`, the output counted so far, and no `usage.speed`. The
// final record of the same request follows, often after the tool results the
// streamed call already produced, with the whole output, a `stop_reason` and
// the speed it was billed at. #1641 billed every request from block 0, which in
// the main transcript restates the final usage and here is the snapshot.
// Measured on one machine: 19,659 subagent requests billed at 102K output
// tokens against 22.9M in their final records, and every fast-mode subagent
// turn priced at the standard rate, because the snapshot names no speed.
//
// The cases below are a request as a subagent writes it, the same request read
// in two passes (the deck folds a live file as it grows, so the snapshot is
// usually billed before its final record exists), a fast-mode one, one whose
// final record never came, and the Projects report, which folds the same lines
// on its own persisted cursor and has to reach the same numbers across passes
// and a restart.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs server module, no types
const enrichment = await import("../../server/session-enrichment.mjs");
const { sessionUsageTotals, sessionUsageByModel, readUsageFromTranscript, readContextFromTranscript } = enrichment as {
  sessionUsageTotals(p: string): Promise<Record<string, number> | null>;
  readUsageFromTranscript(p: string): Promise<Record<string, number> | null>;
  sessionUsageByModel(p: string): Promise<Record<string, Record<string, unknown>> | null>;
  readContextFromTranscript(p: string): Promise<Record<string, number> | null>;
};
// @ts-expect-error — plain .mjs server module, no types
const { createProjectRollup } = await import("../../server/account-projects.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { appendSwap } = await import("../../server/swap-log.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { accountKey } = await import("../../server/lan-sync.mjs");

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-subagent-final-record-"));
afterAll(() => rmTempDir(DIR));

const ROOT_MODEL = "claude-opus-5-5";
const AGENT_MODEL = "claude-sonnet-5";
const INPUT = { input_tokens: 2, cache_read_input_tokens: 51_940, cache_creation_input_tokens: 11_991 };
const SPLIT = { ephemeral_1h_input_tokens: 11_991, ephemeral_5m_input_tokens: 0 };

/** A snapshot's usage block, in the order Claude Code writes its keys: the
 *  cache split comes before the output counted so far, and there is no speed. */
function streamingUsage(output: number) {
  return { ...INPUT, cache_creation: SPLIT, output_tokens: output, service_tier: "standard", inference_geo: "not_available" };
}

/** A final record's usage block, in the order Claude Code writes its keys:
 *  the whole output first, then the cache split, the iterations restating it,
 *  and the speed the request was billed at. */
function finalUsage(output: number, speed: string) {
  return {
    ...INPUT, output_tokens: output, output_tokens_details: { thinking_tokens: 150 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: "standard",
    cache_creation: SPLIT, inference_geo: "not_available",
    iterations: [{ ...INPUT, output_tokens: output, cache_creation: SPLIT, type: "message" }],
    speed, fallback_credit: null,
  };
}

/** The totals one request adds, in the shape the scan reports, at `output`. */
function billed(output: number) {
  return { ...INPUT, ...SPLIT, output_tokens: output };
}

/** One record of a subagent's request. `stop` null is the streaming snapshot,
 *  as Claude Code writes it; anything else is the final record. */
function record(id: string, block: number, output: number, { stop = null as string | null, speed = "standard", at = "2026-10-03T12:00:00.000Z" } = {}) {
  return JSON.stringify({
    parentUuid: null, isSidechain: true, agentId: "a1b2c3", apiBlockIndex: block, requestId: `req_${id}`,
    type: "assistant", timestamp: at, cwd: "/Users/c/agents-deck",
    message: {
      model: AGENT_MODEL, id: `msg_${id}`, type: "message", role: "assistant",
      content: [{ type: block === 0 ? "thinking" : "tool_use" }], stop_reason: stop,
      usage: stop === null ? streamingUsage(output) : finalUsage(output, speed),
    },
  }) + "\n";
}

/** The tool result Claude Code writes between a streamed call and the
 *  request's final record. */
function toolResult(at = "2026-10-03T12:00:01.000Z"): string {
  return JSON.stringify({
    type: "user", isSidechain: true, timestamp: at, cwd: "/Users/c/agents-deck",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
  }) + "\n";
}

const SNAPSHOT = (id: string) => record(id, 0, 6);
const FINAL = (id: string, speed = "standard") => record(id, 1, 374, { stop: "tool_use", speed, at: "2026-10-03T12:00:02.000Z" });

let n = 0;
/** A session with no spend of its own and one subagent file holding `body`;
 *  returns the main transcript's path and the subagent's. */
function session(body: string): { main: string; agent: string } {
  const main = join(DIR, `session-${++n}.jsonl`);
  writeFileSync(main, "");
  const dir = join(DIR, `session-${n}`, "subagents");
  mkdirSync(dir, { recursive: true });
  const agent = join(dir, "agent-a1b2c3.jsonl");
  writeFileSync(agent, body);
  return { main, agent };
}

describe("a subagent's request", () => {
  it("bills a subagent request from its final record, not the streaming snapshot at block 0", async () => {
    const { main } = session(SNAPSHOT("1") + toolResult() + FINAL("1"));
    expect(await sessionUsageTotals(main)).toEqual(billed(374));
  });

  it("charges the same request once to its model, in the split the cost is priced from", async () => {
    const { main } = session(SNAPSHOT("1") + toolResult() + FINAL("1"));
    expect(await sessionUsageByModel(main)).toEqual({ [AGENT_MODEL]: billed(374) });
  });

  it("prices a fast-mode subagent request at the speed its final record carries", async () => {
    const { main } = session(SNAPSHOT("1") + toolResult() + FINAL("1", "fast"));
    expect(await sessionUsageByModel(main)).toEqual({ [AGENT_MODEL]: { ...billed(374), speeds: { fast: billed(374) } } });
  });

  it("reaches the same totals when the snapshot and the final record are folded in different passes", async () => {
    // The subagent's own file, read on its cursor: the session's walk of the
    // directory is shared for a couple of seconds, and this is the pass it runs.
    const { agent } = session(SNAPSHOT("1") + toolResult());
    // Billed while it streams, so the card does not wait for the reply...
    expect(await readUsageFromTranscript(agent)).toMatchObject(INPUT);
    // ...and the final record takes the snapshot's place rather than adding to it.
    appendFileSync(agent, FINAL("1"));
    expect(await readUsageFromTranscript(agent)).toEqual(billed(374));
    expect(await readUsageFromTranscript(agent)).toEqual(billed(374));
  });

  it("still bills a request whose final record never came, from the snapshots written for it", async () => {
    const { main } = session(record("1", 0, 4) + record("1", 1, 9) + SNAPSHOT("2") + toolResult() + FINAL("2"));
    const twice = Object.fromEntries(Object.entries(billed(0)).map(([k, v]) => [k, v * 2]));
    // Request 1 keeps the 9 output tokens its last snapshot had streamed.
    expect(await sessionUsageTotals(main)).toEqual({ ...twice, output_tokens: 9 + 374 });
  });

  it("counts the output a snapshot has streamed so far, while its final record has not come", async () => {
    const { agent } = session(SNAPSHOT("1") + toolResult());
    expect((await readUsageFromTranscript(agent))?.output_tokens).toBe(6);
  });

  it("is still one reply in the context breakdown", async () => {
    const { agent } = session(SNAPSHOT("1") + toolResult() + FINAL("1"));
    expect((await readContextFromTranscript(agent))?.msgsAssistant).toBe(1);
  });
});

const ISO = (s: string) => Date.parse(s);
const KEY = accountKey("a@x.com", "O1");
const tmps: string[] = [];
afterEach(async () => { for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true }); });
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "ccdeck-1883-proj-"));
  tmps.push(d);
  return d;
}

/** A projects tree with one session and one subagent file, a swap log that
 *  has account A active, and a rollup factory over a state file that outlives
 *  each rollup, the way the deck's does a restart. */
async function projectsTree() {
  const root = await tmp();
  const projects = join(root, "projects");
  const slug = join(projects, "-Users-c-agents-deck");
  const agentDir = join(slug, "s1", "subagents");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(slug, "s1.jsonl"), "", "utf8");
  const agent = join(agentDir, "agent-a1b2c3.jsonl");
  const swapLog = join(root, "swap.jsonl");
  await appendSwap({ at: ISO("2026-10-01T00:00:00Z"), slot: 1, email: "a@x.com", orgUuid: "O1", source: "start" }, swapLog);
  const stateFile = join(root, "state.json");
  const rollup = () => createProjectRollup({
    now: () => ISO("2026-10-03T18:00:00Z"),
    roots: [projects], state: stateFile, swapLog, storeRoot: join(root, "no-store"),
  });
  return { agent, rollup, stateFile };
}

const COUNTERS = (o: number) => ({ i: INPUT.input_tokens, o, cr: INPUT.cache_read_input_tokens, cc: INPUT.cache_creation_input_tokens, c1h: SPLIT.ephemeral_1h_input_tokens, c5m: 0 });

describe("the Projects report", () => {
  it("bills a subagent request from its final record, across two passes", async () => {
    const { agent, rollup } = await projectsTree();
    await writeFile(agent, SNAPSHOT("1") + toolResult(), "utf8");
    const deck = rollup();
    await deck.tick();
    await appendFile(agent, FINAL("1", "fast"), "utf8");
    await deck.tick();
    const rep = await deck.report(KEY, 0);
    expect(rep.projects[0].models[AGENT_MODEL]).toEqual({ ...COUNTERS(374), s: { fast: COUNTERS(374) } });
  });

  it("and across a restart between the snapshot and the final record", async () => {
    const { agent, rollup } = await projectsTree();
    await writeFile(agent, SNAPSHOT("1") + toolResult(), "utf8");
    await rollup().tick();
    // Request 2 is dated after request 1, as Claude Code writes it: a record
    // older than one the file has already read is a resumed subagent restating
    // its history, and is not billed again (subagent-resume-replay.test.ts).
    const second = record("2", 0, 6, { at: "2026-10-03T12:00:03.000Z" }) + record("2", 1, 374, { stop: "tool_use", at: "2026-10-03T12:00:05.000Z" });
    await appendFile(agent, FINAL("1") + second, "utf8");
    const restarted = rollup();
    await restarted.tick();
    const rep = await restarted.report(KEY, 0);
    expect(rep.projects[0].models[AGENT_MODEL]).toEqual({ ...COUNTERS(374 * 2), i: 4, cr: INPUT.cache_read_input_tokens * 2, cc: INPUT.cache_creation_input_tokens * 2, c1h: SPLIT.ephemeral_1h_input_tokens * 2 });
  });
});

describe("a Projects tally from before #1883", () => {
  it("is rebuilt once from the transcripts, so the subagent output it left off comes back", async () => {
    const { agent, rollup, stateFile } = await projectsTree();
    await writeFile(agent, SNAPSHOT("1") + toolResult() + FINAL("1"), "utf8");
    // What version 4 kept for that file: its cursor at the end, and the
    // request billed from its snapshot.
    await writeFile(stateFile, JSON.stringify({
      version: 4,
      cursors: { [agent]: Buffer.byteLength(SNAPSHOT("1") + toolResult() + FINAL("1")) },
      tally: { [KEY]: { "/Users/c/agents-deck": { "2026-10-03": { [AGENT_MODEL]: COUNTERS(6) } } } },
      folders: {},
    }), "utf8");
    const deck = rollup();
    await deck.tick();
    expect((await deck.report(KEY, 0)).projects[0].models[AGENT_MODEL]).toEqual(COUNTERS(374));
  });
});
