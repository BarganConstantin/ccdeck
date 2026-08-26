// #685. A session that delegates spends money in two files, and the deck was
// reading one of them. Claude Code writes the root's turns to
// `<slug>/<sessionId>.jsonl` and every delegated turn to
// `<slug>/<sessionId>/subagents/agent-<id>.jsonl`, with no overlap between the
// two — established by reading real transcripts on the reporter's machine: a
// session holding 397 subagent files has zero `isSidechain` lines in its main
// JSONL, and one measured session carries 40.4M cache-read tokens in the main
// file against 217.7M across its twenty subagent files. The deck read the main
// file alone, so it billed that session at about a sixth of what it cost.
//
// Two smaller wrongs sat on top of that, both of them the same tokens counted
// twice:
//
//   * The parent's line for a finished `Task` carries a `toolUseResult` with a
//     `usage` block of its own, and that block restates the subagent's LAST API
//     turn — 181,387 cache-read tokens on the parent's line, and 181,387 in the
//     last usage block of that subagent's own file. Byte for byte the same
//     tokens, in both files.
//   * The reducer ADDED that same block to the parent agent on `PostToolUse`,
//     which is where the reported symptom came from: the card jumped to $0.4675
//     and fell back to $0.0175 when the next transcript pass assigned over it.
//
// So the accounting these pin is one sentence: a session's tokens are its own
// turns plus every subagent file beside them, each token counted once, written
// by one writer that ASSIGNS — so nothing moves when a transcript pass happens
// to land.
//
// No DOM. The server half drives the scanners over a sandboxed temp tree, the
// reducer half drives `applyEvent` directly.
import { describe, it, expect, afterAll, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEvent, initialState, type GraphState } from "../reducer";
import { costForUsage } from "../pricing";
import type { HookEnvelope, HookPayload } from "../types";

// Every path below lives inside this temp directory, and the server module
// resolves the Claude and Codex config directories from the home directory at
// import time — so all four point at the sandbox BEFORE any import of it, and
// nothing here can reach the developer's real ~/.claude or ~/.codex on any
// platform.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-subagent-usage-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — .mjs server module, no types
const { readUsageFromTranscript, sessionUsageTotals } = await import("../../server/index.mjs");

afterAll(() => {
  vi.useRealTimers();
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(DIR, { recursive: true, force: true });
});

// ─── Fixtures ────────────────────────────────────────────────────────────

type Totals = {
  input_tokens: number; output_tokens: number;
  cache_read_input_tokens: number; cache_creation_input_tokens: number;
  ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number;
};

function totals(
  input: number, output: number, cacheRead: number, cacheCreate: number,
  h1 = 0, m5 = 0,
): Totals {
  return {
    input_tokens: input, output_tokens: output,
    cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate,
    ephemeral_1h_input_tokens: h1, ephemeral_5m_input_tokens: m5,
  };
}

function sum(...parts: Totals[]): Totals {
  const out = totals(0, 0, 0, 0);
  for (const p of parts) for (const k of Object.keys(out) as Array<keyof Totals>) out[k] += p[k];
  return out;
}

/** One assistant turn as CC writes it. The four flat counters come first and
 *  the TTL split last, which is the order a real transcript uses and the order
 *  the scanner's `[^}]+` blob depends on. */
function turn(t: Totals, model = "claude-opus-4-7"): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      model,
      usage: {
        input_tokens: t.input_tokens,
        output_tokens: t.output_tokens,
        cache_read_input_tokens: t.cache_read_input_tokens,
        cache_creation_input_tokens: t.cache_creation_input_tokens,
        cache_creation: {
          ephemeral_1h_input_tokens: t.ephemeral_1h_input_tokens,
          ephemeral_5m_input_tokens: t.ephemeral_5m_input_tokens,
        },
      },
    },
  }) + "\n";
}

/** The line CC writes into the PARENT's transcript when a delegated call comes
 *  back: a user-role tool_result, with the agent's closing figures hung off the
 *  record as `toolUseResult`. Those figures are the subagent's last turn and
 *  are already in the subagent's own file — this line is the double count. */
function taskResultLine(agentId: string, restated: Totals): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }] },
    toolUseResult: {
      agentId,
      totalTokens: 184307,
      usage: {
        input_tokens: restated.input_tokens,
        output_tokens: restated.output_tokens,
        cache_read_input_tokens: restated.cache_read_input_tokens,
        cache_creation_input_tokens: restated.cache_creation_input_tokens,
        cache_creation: {
          ephemeral_1h_input_tokens: restated.ephemeral_1h_input_tokens,
          ephemeral_5m_input_tokens: restated.ephemeral_5m_input_tokens,
        },
      },
    },
  }) + "\n";
}

// The root's own two turns.
const ROOT_A = totals(1000, 500, 20000, 300, 200, 100);
const ROOT_B = totals(7, 3, 11, 13, 5, 8);
// The subagent's turns. The LAST one is the turn the parent's `toolUseResult`
// restates, so it is the token-for-token overlap between the two files.
const SUB_A = totals(5000, 2000, 500000, 20000, 15000, 5000);
const SUB_LAST = totals(2, 1, 181387, 229, 129, 100);

const ROOT_OWN = sum(ROOT_A, ROOT_B);
const SUB_OWN = sum(SUB_A, SUB_LAST);
const SESSION = sum(ROOT_OWN, SUB_OWN);

let nextSession = 0;

/** A session on disk in CC's current layout, and the main transcript path the
 *  hook payload would carry. `subagent: false` builds a session that never
 *  delegated — no `subagents/` directory at all, which is what a Codex session
 *  and a legacy-schema Claude session both look like from here. */
function sessionOnDisk(opts: { subagent?: boolean; restated?: boolean } = {}): string {
  const { subagent = true, restated = true } = opts;
  const sid = `session-${nextSession++}`;
  const slug = join(DIR, "projects", "-Users-someone-Desktop-repo");
  mkdirSync(slug, { recursive: true });
  const main = join(slug, `${sid}.jsonl`);
  let text = turn(ROOT_A);
  if (restated) text += taskResultLine("00ff", SUB_LAST);
  text += turn(ROOT_B);
  writeFileSync(main, text);
  if (subagent) {
    const subDir = join(slug, sid, "subagents");
    if (!subDir.startsWith(DIR)) throw new Error("refusing to run: fixture path escaped the sandbox");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "agent-00ff.jsonl"), turn(SUB_A) + turn(SUB_LAST));
  }
  return main;
}

/** The subagent directory walk is memoised for a couple of seconds so the model
 *  pass and the usage pass share one listing of what can be a few hundred
 *  files. A test that appends between passes has to step past that window, and
 *  faking `Date` alone leaves vitest's own timers real. */
function stepPastTheMemo(): void {
  vi.setSystemTime(Date.now() + 5_000);
}

// ─── The server half: what a session's totals are made of ────────────────

describe("#685 — a session's totals are its own turns plus its subagents'", () => {
  it("counts every token exactly once across both files", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const main = sessionOnDisk();

    // The two halves, read apart.
    expect(await readUsageFromTranscript(main)).toEqual(ROOT_OWN);
    // …and together. Not ROOT_OWN — that is the number the deck used to show,
    // and it is missing everything the session delegated.
    expect(await sessionUsageTotals(main)).toEqual(SESSION);
    expect(SESSION.cache_read_input_tokens).toBeGreaterThan(ROOT_OWN.cache_read_input_tokens * 30);
  });

  it("does not count the turn the parent's Task result restates", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // The same session written twice: once with the `toolUseResult` line CC
    // really writes, once without it. The subagent's last turn is in the
    // subagent's file either way, so the session cost the same either way.
    const withRestatement = sessionOnDisk({ restated: true });
    const without = sessionOnDisk({ restated: false });
    stepPastTheMemo();

    expect(await sessionUsageTotals(withRestatement)).toEqual(await sessionUsageTotals(without));
    expect(await sessionUsageTotals(withRestatement)).toEqual(SESSION);
  });

  it("leaves a session that never delegated exactly where it was", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const main = sessionOnDisk({ subagent: false, restated: false });
    stepPastTheMemo();
    expect(await sessionUsageTotals(main)).toEqual(ROOT_OWN);
  });

  it("restates the same total on a pass that has nothing new to fold", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const main = sessionOnDisk();

    const first = await sessionUsageTotals(main);
    stepPastTheMemo();
    const second = await sessionUsageTotals(main);
    stepPastTheMemo();
    const third = await sessionUsageTotals(main);

    // The oscillation #685 reported is exactly this equality failing: the
    // number a user reads must not depend on when a scan happened to run.
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first).toEqual(SESSION);
  });

  it("adds an appended subagent turn once, and only the appended one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const main = sessionOnDisk();
    const subFile = join(main.replace(/\.jsonl$/, ""), "subagents", "agent-00ff.jsonl");

    expect(await sessionUsageTotals(main)).toEqual(SESSION);

    const MORE = totals(11, 13, 17, 19, 7, 3);
    appendFileSync(subFile, turn(MORE));
    stepPastTheMemo();

    expect(await sessionUsageTotals(main)).toEqual(sum(SESSION, MORE));
  });

  it("still folds only the appended bytes — #611's cursor survives the new reader", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const main = sessionOnDisk({ restated: false });
    const subFile = join(main.replace(/\.jsonl$/, ""), "subagents", "agent-00ff.jsonl");

    const before = await sessionUsageTotals(main);
    expect(before).toEqual(SESSION);

    // Rewrite the bytes the cursor has already folded, keeping the byte length
    // identical, and append one turn. A kept cursor folds the appended turn and
    // nothing else; a reader that went back to byte 0 would fold the rewritten
    // prefix again and land on a number nearly twice as large. This is the read
    // #611 removed, and the subagent files are exactly where it hurt.
    const MORE = totals(11, 13, 17, 19, 7, 3);
    const rewritten = (turn(SUB_A) + turn(SUB_LAST))
      .replace(`"input_tokens":${SUB_A.input_tokens}`, `"input_tokens":${String(SUB_A.input_tokens).replace(/./g, "9")}`);
    writeFileSync(subFile, rewritten + turn(MORE));
    stepPastTheMemo();

    expect(await sessionUsageTotals(main)).toEqual(sum(SESSION, MORE));
  });
});

// ─── The reducer half: one writer, and it assigns ────────────────────────

const MODEL = "claude-opus-4-1-20250805";
const T0 = 1_700_000_000_000;
const SEC = 1_000;
let seq = 0;

function send(state: GraphState, at: number, payload: HookPayload): GraphState {
  seq++;
  return applyEvent(state, { seq, receivedAt: at, source: "hook", payload } as HookEnvelope);
}

/** What the sidebar, the session summary and the usage panel all print: the
 *  root plus every subagent under it, each priced with its own model. Spelled
 *  out here rather than imported so this file needs no DOM — SessionList.tsx,
 *  SessionSummary.tsx and UsagePanel.tsx each compute exactly this. */
function sessionCost(state: GraphState, sessionId: string): number {
  let cost = 0;
  for (const a of state.agents.values()) {
    if (a.sessionId !== sessionId) continue;
    cost += costForUsage(a.usage, a.model, T0).total;
  }
  return cost;
}

function sessionTokens(state: GraphState, sessionId: string): number {
  let n = 0;
  for (const a of state.agents.values()) {
    if (a.sessionId !== sessionId) continue;
    n += a.usage.inputTokens + a.usage.outputTokens
       + a.usage.cacheReadTokens + a.usage.cacheCreateTokens;
  }
  return n;
}

/** A `UsageObserved` as the server now sends it: the session's whole bill,
 *  subagents included, cumulative. */
function usageObserved(sessionId: string, t: Totals): HookPayload {
  return { hook_event_name: "UsageObserved", session_id: sessionId, usage: t } as unknown as HookPayload;
}

/** The `tool_response` of a finished Task — the sliver. Chosen to look like the
 *  real thing: a large cache-read figure that is a small fraction of what the
 *  subagent actually spent. */
const TASK_RESPONSE = {
  content: "done",
  usage: {
    input_tokens: SUB_LAST.input_tokens,
    output_tokens: 2689,
    cache_read_input_tokens: SUB_LAST.cache_read_input_tokens,
    cache_creation_input_tokens: SUB_LAST.cache_creation_input_tokens,
  },
};

describe("#685 — the session's number does not move when a Task returns", () => {
  function sessionWithSubagent(): GraphState {
    seq = 0;
    let state = initialState();
    state = send(state, T0, {
      hook_event_name: "SessionStart", session_id: "sess-1", cwd: "/repo", model: MODEL,
    });
    state = send(state, T0 + SEC, {
      hook_event_name: "SubagentStart", session_id: "sess-1", agent_id: "00ff",
      agent_type: "general-purpose", model: MODEL,
    });
    state = send(state, T0 + 2 * SEC, {
      hook_event_name: "PreToolUse", session_id: "sess-1", model: MODEL,
      tool_name: "Task", tool_use_id: "tt", tool_input: { prompt: "go" },
    });
    return state;
  }

  it("reads the same three times running: pass, Task result, pass", () => {
    let state = sessionWithSubagent();

    state = send(state, T0 + 3 * SEC, usageObserved("sess-1", SESSION));
    const afterFirstPass = sessionCost(state, "sess-1");
    const tokensFirst = sessionTokens(state, "sess-1");
    expect(afterFirstPass).toBeGreaterThan(0);

    // The Task comes back. This is the instant the card used to jump.
    state = send(state, T0 + 4 * SEC, {
      hook_event_name: "PostToolUse", session_id: "sess-1", model: MODEL,
      tool_name: "Task", tool_use_id: "tt", tool_response: TASK_RESPONSE,
    });
    expect(sessionCost(state, "sess-1")).toBe(afterFirstPass);
    expect(sessionTokens(state, "sess-1")).toBe(tokensFirst);

    // …and the next pass, two and a half seconds later, is where it used to
    // fall back. Same totals, so the same number.
    state = send(state, T0 + 7 * SEC, usageObserved("sess-1", SESSION));
    expect(sessionCost(state, "sess-1")).toBe(afterFirstPass);
    expect(sessionTokens(state, "sess-1")).toBe(tokensFirst);
  });

  it("bills the session's whole transcript, delegated turns included", () => {
    let state = sessionWithSubagent();
    state = send(state, T0 + 3 * SEC, usageObserved("sess-1", SESSION));

    // The tokens on the board are the tokens in the files — not the root's own
    // share of them, which is what the deck used to bill.
    expect(sessionTokens(state, "sess-1")).toBe(
      SESSION.input_tokens + SESSION.output_tokens
      + SESSION.cache_read_input_tokens + SESSION.cache_creation_input_tokens,
    );
    const rootOnly = ROOT_OWN.input_tokens + ROOT_OWN.output_tokens
      + ROOT_OWN.cache_read_input_tokens + ROOT_OWN.cache_creation_input_tokens;
    expect(sessionTokens(state, "sess-1")).toBeGreaterThan(rootOnly * 10);
  });

  it("counts a delivered-twice Task result no times, not twice", () => {
    let state = sessionWithSubagent();
    state = send(state, T0 + 3 * SEC, usageObserved("sess-1", SESSION));
    const settled = sessionTokens(state, "sess-1");

    const post: HookPayload = {
      hook_event_name: "PostToolUse", session_id: "sess-1", model: MODEL,
      tool_name: "Task", tool_use_id: "tt", tool_response: TASK_RESPONSE,
    };
    state = send(state, T0 + 4 * SEC, post);
    state = send(state, T0 + 4 * SEC + 7, post);
    state = send(state, T0 + 4 * SEC + 41, post);

    expect(sessionTokens(state, "sess-1")).toBe(settled);
    // The figure is still recorded where it is true — on the call — so the tool
    // modal can show what that call reported. Found by sweeping the session
    // rather than read off the root: with a subagent live, `resolveOwner` draws
    // an unattributed call under it, which is a question about the canvas and
    // not about the bill.
    const calls = [...state.agents.values()]
      .filter(a => a.sessionId === "sess-1")
      .flatMap(a => a.tools)
      .filter(t => t.id === "tt");
    expect(calls).toHaveLength(1);
    expect(calls[0].usage!.cacheReadTokens).toBe(SUB_LAST.cache_read_input_tokens);
  });

  it("keeps the subagent node at zero, because the roll-ups add it to the root", () => {
    let state = sessionWithSubagent();
    state = send(state, T0 + 3 * SEC, usageObserved("sess-1", SESSION));
    state = send(state, T0 + 4 * SEC, {
      hook_event_name: "PostToolUse", session_id: "sess-1", model: MODEL,
      tool_name: "Task", tool_use_id: "tt", tool_response: TASK_RESPONSE,
    });

    // Every consumer of these numbers sums the root and its subagents. A share
    // written onto the subagent as well as into the session totals would be the
    // same tokens on the board twice.
    const sub = state.agents.get("sess-1::00ff")!;
    expect(sub.kind).toBe("subagent");
    expect(sub.usage).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    });
  });
});
