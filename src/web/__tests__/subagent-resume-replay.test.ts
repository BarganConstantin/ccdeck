// A resumed subagent's file restates its history, and every request in it is
// still billed once.
//
// When Claude Code resumes a subagent, it writes the agent's history into the
// agent's `subagents/agent-*.jsonl` again before the new turn: the same records,
// with the same `uuid`, `requestId`, `message.id` and `timestamp`, usually byte
// for byte, after records written later. #2023 billed a request from block 0
// whenever no other request was streaming, so each restated block 0 started a
// new bill and its restated final record replaced it: a request was charged
// once more for every replay. Measured on one machine: two such files, 98
// requests charged 821 extra times, 102M cache-read tokens over.
//
// A restated record is older than the newest request record the file has
// already read; nothing Claude Code writes fresh is (none of 162,790 request
// records on that machine). So that is how one is told apart, which costs the
// scan one timestamp per file rather than a list of every request it billed.
//
// Also here: the request a forked subagent's file opens with, which is its
// parent's and billed in the parent's transcript, and must stay unbilled in the
// fork.
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs server module, no types
const enrichment = await import("../../server/session-enrichment.mjs");
const { sessionUsageTotals, sessionUsageByModel, readUsageFromTranscript } = enrichment as {
  sessionUsageTotals(p: string): Promise<Record<string, number> | null>;
  sessionUsageByModel(p: string): Promise<Record<string, Record<string, unknown>> | null>;
  readUsageFromTranscript(p: string): Promise<Record<string, number> | null>;
};
// @ts-expect-error — plain .mjs server module, no types
const { createProjectRollup } = await import("../../server/account-projects.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { appendSwap } = await import("../../server/swap-log.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { accountKey } = await import("../../server/lan-sync.mjs");

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-subagent-replay-"));
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

/** A final record's usage block, in the order Claude Code writes its keys. */
function finalUsage(output: number) {
  return {
    ...INPUT, output_tokens: output, output_tokens_details: { thinking_tokens: 150 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: "standard",
    cache_creation: SPLIT, inference_geo: "not_available",
    iterations: [{ ...INPUT, output_tokens: output, cache_creation: SPLIT, type: "message" }],
    speed: "standard",
  };
}

/** The totals `requests` requests add, in the shape the scan reports, with
 *  `output` output tokens between them. */
function billed(requests: number, output: number) {
  const scaled = Object.fromEntries(Object.entries({ ...INPUT, ...SPLIT }).map(([k, v]) => [k, v * requests]));
  return { ...scaled, output_tokens: output };
}

/** One record of a subagent's request at second `sec` past noon. `stop` null
 *  is the streaming snapshot; anything else is the final record. */
function record(id: string, block: number, output: number, sec: number, { stop = null as string | null, model = AGENT_MODEL, parent = true } = {}) {
  return JSON.stringify({
    parentUuid: parent ? `u-${id}-${block}-parent` : null, isSidechain: true, agentId: "a1b2c3",
    apiBlockIndex: block, requestId: `req_${id}`, type: "assistant", uuid: `u-${id}-${block}`,
    timestamp: at(sec), cwd: "/Users/c/agents-deck",
    message: {
      model, id: `msg_${id}`, type: "message", role: "assistant",
      content: [{ type: block === 0 ? "thinking" : "tool_use" }], stop_reason: stop,
      usage: stop === null ? streamingUsage(output) : finalUsage(output),
    },
  }) + "\n";
}

function at(sec: number): string {
  return new Date(Date.UTC(2026, 9, 3, 12, 0, sec)).toISOString();
}

/** The tool result Claude Code writes between a streamed call and the
 *  request's final record. */
function toolResult(sec: number): string {
  return JSON.stringify({
    type: "user", isSidechain: true, uuid: `u-result-${sec}`, timestamp: at(sec), cwd: "/Users/c/agents-deck",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
  }) + "\n";
}

/** The prompt that opens an agent's history, and opens it again on a resume. */
const PROMPT = JSON.stringify({
  parentUuid: null, isSidechain: true, agentId: "a1b2c3", type: "user", uuid: "u-prompt",
  timestamp: at(0), cwd: "/Users/c/agents-deck", message: { role: "user", content: "look into it" },
}) + "\n";

/** A request as a subagent writes it: the snapshot, the tool result, then the
 *  final record, starting at second `sec`. */
function request(id: string, output: number, sec: number): string {
  return record(id, 0, 6, sec) + toolResult(sec + 1) + record(id, 1, output, sec + 2, { stop: "tool_use" });
}

/** Two requests, the history every resume below restates. */
const HISTORY = PROMPT + request("1", 374, 1) + request("2", 500, 4);
/** The turn the resume was for, written after the restated history. */
const RESUMED_TURN = request("3", 222, 60);
/** What all three requests bill, each once. */
const THREE_REQUESTS = billed(3, 374 + 500 + 222);

let n = 0;
/** A session with no spend of its own and one subagent file holding `body`;
 *  returns the main transcript's path and the subagent's. */
function session(body: string, mainBody = ""): { main: string; agent: string } {
  const main = join(DIR, `session-${++n}.jsonl`);
  writeFileSync(main, mainBody);
  const dir = join(DIR, `session-${n}`, "subagents");
  mkdirSync(dir, { recursive: true });
  const agent = join(dir, "agent-a1b2c3.jsonl");
  writeFileSync(agent, body);
  return { main, agent };
}

describe("a resumed subagent's file", () => {
  it("bills each request once, however many times the file restates its history", async () => {
    const { main } = session(HISTORY + HISTORY + RESUMED_TURN + HISTORY + RESUMED_TURN);
    expect(await sessionUsageTotals(main)).toEqual(THREE_REQUESTS);
  });

  it("charges them once to their model, in the split the cost is priced from", async () => {
    const { main } = session(HISTORY + HISTORY + RESUMED_TURN);
    expect(await sessionUsageByModel(main)).toEqual({ [AGENT_MODEL]: THREE_REQUESTS });
  });

  it("reaches the same totals when the replay is folded in a later pass than the history it restates", async () => {
    const { agent } = session(HISTORY);
    expect(await readUsageFromTranscript(agent)).toEqual(billed(2, 874));
    appendFileSync(agent, HISTORY + RESUMED_TURN);
    expect(await readUsageFromTranscript(agent)).toEqual(THREE_REQUESTS);
  });

  it("keeps billing a request still streaming when the replay restates its snapshot", async () => {
    // The agent is resumed while its second request streams: the restated
    // history holds that request's snapshot, and its final record comes after.
    const streaming = PROMPT + request("1", 374, 1) + record("2", 0, 6, 4);
    const { main } = session(streaming + streaming + toolResult(61) + record("2", 1, 500, 62, { stop: "tool_use" }));
    expect(await sessionUsageTotals(main)).toEqual(billed(2, 874));
  });
});

describe("a forked subagent's file", () => {
  it("does not bill again the parent's request it opens with", async () => {
    // A fork's file opens with the parent's turn that spawned it, a later block
    // of a request the parent's own transcript has already billed.
    const parent = record("p", 0, 1_000, 1, { stop: "tool_use", model: ROOT_MODEL }) + record("p", 1, 1_000, 1, { stop: "tool_use", model: ROOT_MODEL });
    const forkRef = JSON.stringify({ type: "fork-context-ref", parentUuid: null }) + "\n";
    const inherited = record("p", 1, 1_000, 1, { stop: "tool_use", model: ROOT_MODEL, parent: false });
    const { main } = session(forkRef + inherited + request("1", 374, 5), parent);
    expect(await sessionUsageTotals(main)).toEqual(billed(2, 1_374));
  });
});

const ISO = (s: string) => Date.parse(s);
const KEY = accountKey("a@x.com", "O1");
const tmps: string[] = [];
afterEach(async () => { for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true }); });
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "ccdeck-replay-proj-"));
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

/** The Projects report's counters for `requests` requests and `output` output tokens. */
function counters(requests: number, output: number) {
  return {
    i: INPUT.input_tokens * requests, o: output, cr: INPUT.cache_read_input_tokens * requests,
    cc: INPUT.cache_creation_input_tokens * requests, c1h: SPLIT.ephemeral_1h_input_tokens * requests, c5m: 0,
  };
}

describe("the Projects report", () => {
  it("bills each request of a resumed subagent once, across two passes", async () => {
    const { agent, rollup } = await projectsTree();
    await writeFile(agent, HISTORY, "utf8");
    const deck = rollup();
    await deck.tick();
    await appendFile(agent, HISTORY + RESUMED_TURN, "utf8");
    await deck.tick();
    expect((await deck.report(KEY, 0)).projects[0].models[AGENT_MODEL]).toEqual(counters(3, 374 + 500 + 222));
  });

  it("and across a restart between the history and its replay", async () => {
    const { agent, rollup } = await projectsTree();
    await writeFile(agent, HISTORY, "utf8");
    await rollup().tick();
    await appendFile(agent, HISTORY + RESUMED_TURN, "utf8");
    const restarted = rollup();
    await restarted.tick();
    expect((await restarted.report(KEY, 0)).projects[0].models[AGENT_MODEL]).toEqual(counters(3, 374 + 500 + 222));
  });
});

describe("a Projects tally from before replays were told apart", () => {
  it("is rebuilt once from the transcripts, so a replayed request stops counting twice", async () => {
    const { agent, rollup, stateFile } = await projectsTree();
    const body = HISTORY + HISTORY + RESUMED_TURN;
    await writeFile(agent, body, "utf8");
    // What version 5 kept for that file: its cursor at the end, and the two
    // requests of the history billed twice.
    await writeFile(stateFile, JSON.stringify({
      version: 5,
      cursors: { [agent]: Buffer.byteLength(body) },
      tally: { [KEY]: { "/Users/c/agents-deck": { "2026-10-03": { [AGENT_MODEL]: counters(5, 2 * (374 + 500) + 222) } } } },
      folders: {}, requests: {},
    }), "utf8");
    const deck = rollup();
    await deck.tick();
    expect((await deck.report(KEY, 0)).projects[0].models[AGENT_MODEL]).toEqual(counters(3, 374 + 500 + 222));
  });
});
