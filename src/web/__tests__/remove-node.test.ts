import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectBursts } from "../burst-layout";
import type { AgentNodeData, HookEnvelope, HookPayload } from "../types";
import { blockedSessions } from "../ambient-counts";
import { applyEvent, initialState, pruneDoneSessions, STALE_SESSION_MS, sweepStaleSessions, sweepStaleTools, type GraphState } from "../reducer";
import { lastWorkedAt, readRemovedNodes, removalHiddenIds, removalsLiftedByWork, removalTimes, saveRemovedNodes, sessionsCalledBack, visibleBoard, withoutRemovals } from "../remove-node";
import { AUTO_PAN_EDGE_PX, clientPointOf, distanceToRect, pointInRect, trashProximity, TRASH_HIT_SLOP_PX, TRASH_NEAR_PX } from "../trash-zone";
import { clientText } from "./client-source";

const nodes = [
  { id: "a", data: { sessionId: "a" } },
  { id: "a::child", data: { sessionId: "a", parentId: "a" } },
  { id: "a::grandchild", data: { sessionId: "a", parentId: "a::child" } },
  { id: "b", data: { sessionId: "b" } },
];
const edges = [
  { source: "a", target: "a::child" },
  { source: "a::child", target: "a::grandchild" },
];

describe("removing a single board node", () => {
  it("removes only the selected child and its descendants, leaving other sessions alone", () => {
    const result = visibleBoard(nodes, edges, new Set(["a::child"]));
    expect(result.nodes.map(node => node.id)).toEqual(["a", "b"]);
    expect(result.edges).toEqual([]);
  });

  it("removes a whole session when its root is selected", () => {
    expect(visibleBoard(nodes, edges, new Set(["a"])).nodes.map(node => node.id)).toEqual(["b"]);
  });

  it("keeps the rest of the graph unchanged when nothing is removed", () => {
    expect(visibleBoard(nodes, edges, new Set())).toEqual({ nodes, edges });
  });

  it("persists hidden IDs without mixing them with the graph data", () => {
    const values = new Map<string, string>();
    const store = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    saveRemovedNodes(store, new Set(["a::child"]));
    expect([...readRemovedNodes(store)]).toEqual(["a::child"]);
    expect(readRemovedNodes({ getItem: () => "not json" }).size).toBe(0);
  });
});

// ── the tool bubbles beside a removed card (#1237) ──────────────────────────
//
// The cards were filtered and the bubbles were not: `collectBursts` gates on
// the canvas's one visibility set, and removal never reached it, so a removed
// session's `Bash → cd` pairs stayed on the board with no card to hang from.

const NOW = 1_000_000;

function agent(id: string, sessionId: string, parentId?: string): AgentNodeData {
  return {
    id, sessionId, parentId, label: id, kind: parentId ? "subagent" : "root", state: "done",
    startedAt: NOW - 60_000, endedAt: NOW - 1_000,
    tools: [{ id: `${id}:t1`, name: "Bash", inputPreview: "", input: { command: "cd /repo" }, startedAt: NOW - 30_000, endedAt: NOW - 29_000, ok: true }],
    prompts: [], toolCount: 1, childCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  } as AgentNodeData;
}

const agents = new Map([
  ["s1", agent("s1", "s1")],
  ["s1::sub", agent("s1::sub", "s1", "s1")],
  ["s2", agent("s2", "s2")],
]);

/** The bubbles `<ToolBursts>` would draw for this visibility set. */
function bubbleOwners(visible: Set<string>): Set<string> {
  const at = new Map([...agents.keys()].map((id, i) => [id, { x: 0, y: i * 300 }]));
  const measured = new Map([...agents.keys()].map(id => [id, { width: 260, height: 130 }]));
  return new Set(collectBursts(agents, visible, at, new Map(), measured, NOW).map(b => b.agentId));
}

describe("what a removal takes off the canvas's visibility set (#1237)", () => {
  it("hides the removed agent, what descends from it, and every agent of a removed session", () => {
    expect([...removalHiddenIds(agents.values(), new Set(["s1::sub"]))]).toEqual(["s1::sub"]);
    expect([...removalHiddenIds(agents.values(), new Set(["s1"]))].sort()).toEqual(["s1", "s1::sub"]);
    expect(removalHiddenIds(agents.values(), new Set()).size).toBe(0);
  });

  it("leaves no tool bubbles for a removed session", () => {
    const all = new Set(agents.keys());
    // The premise: before the removal every agent's bubbles are drawn, so the
    // assertion after it cannot pass by drawing nothing at all.
    expect([...bubbleOwners(all)].sort()).toEqual(["s1", "s1::sub", "s2"]);

    const visible = new Set(all);
    for (const id of removalHiddenIds(agents.values(), new Set(["s1"]))) visible.delete(id);
    expect([...bubbleOwners(visible)]).toEqual(["s2"]);
  });
});

describe("the canvas wiring (#1237)", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

  it("works the removal out once, from the removed-node store", () => {
    expect(app).toMatch(/const removedAgentIds = useMemo\(\s*\(\) => removalHiddenIds\(stateRef\.current\.agents\.values\(\), removedNodes\),/);
  });

  it("subtracts it from the visibility set the cards AND the tool bubbles both gate on", () => {
    const memo = /const visibleAgentIds = useMemo<Set<string>>\([\s\S]*?\n  \);/.exec(app)?.[0] ?? "";
    expect(memo).toMatch(/for \(const id of removedAgentIds\) ids\.delete\(id\);/);
    expect(memo).toMatch(/removedAgentIds\],/);
    // The two readers of that set: the cards and the bubble overlay.
    expect(app).toMatch(/selectedIds, spotlightSet, visibleAgentIds, openContext,/);
    expect(app).toMatch(/<ToolBursts[\s\S]*?visibleAgentIds=\{visibleAgentIds\}/);
  });

  it("keeps the layout signature in step with it, so the board reflows around a removal", () => {
    // Two links: App.tsx's memo hands the removals to layoutSignature and
    // recomputes when they change, and layoutSignature skips them.
    const sig = /const layoutSig = useMemo\([\s\S]*?\n  \);/.exec(app)?.[0] ?? "";
    expect(sig).toMatch(/layoutSignature\(stateRef\.current\.agents\.values\(\), now, removedAgentIds, /);
    expect(sig).toMatch(/removedAgentIds\],\s*\);$/);
    const fn = readFileSync(fileURLToPath(new URL("../layout-signature.ts", import.meta.url)), "utf8");
    expect(fn).toMatch(/if \(!isAgentVisible\(a, now\) \|\| removedAgentIds\.has\(a\.id\)\) continue;/);
  });
});

// ── undo, the way back, and the alarm (the audit of #1210) ─────────────────
//
// Remove node shipped as one click in the topbar with no undo, and the only
// way back was Clear. A removed session that started waiting was still counted
// by the alarm and still listed, and clicking either selected a card that was
// not drawn.

describe("bringing removed cards back", () => {
  it("takes the named ids out and leaves the rest removed", () => {
    const removed = new Set(["a", "b::sub", "c"]);
    expect([...withoutRemovals(removed, ["a", "c"])]).toEqual(["b::sub"]);
    // A new set: the old one is React state and is never mutated.
    expect([...removed]).toEqual(["a", "b::sub", "c"]);
  });

  it("answers with the same set when nothing it names was removed, so the caller can skip the write", () => {
    const removed = new Set(["a"]);
    expect(withoutRemovals(removed, ["b", "c"])).toBe(removed);
    expect(withoutRemovals(removed, [])).toBe(removed);
  });

  it("calls a removed session back when it starts waiting, and only that one", () => {
    const hidden = new Set(["s1", "s1::sub", "s3"]);
    expect(sessionsCalledBack([{ id: "s1" }, { id: "s2" }], hidden)).toEqual(["s1"]);
    expect(sessionsCalledBack([{ id: "s2" }], hidden)).toEqual([]);
    expect(sessionsCalledBack([{ id: "s1" }], new Set())).toEqual([]);
  });
});

// ── live work wins over a removal (#1315) ──────────────────────────────────
//
// A removed card that went on working stayed hidden for as long as it worked:
// the only ways back were the session list, Clear, and starting to wait. These
// drive the real reducer, because what counts as work is a question about
// which events write which fields, and a hand-built agent would only be
// agreeing with itself.

const T = 1_700_000_000_000;
/** When the cards below are taken off the board: well after all their history. */
const R = T + 60_000;

let seq = 0;
let log: HookEnvelope[] = [];

function send(state: GraphState, session: string, payload: HookPayload, at: number): GraphState {
  const env: HookEnvelope = { seq: ++seq, receivedAt: at, source: "hook", epoch: "boot-1", payload: { session_id: session, ...payload } };
  log.push(env);
  return applyEvent(state, env);
}

/** A finished turn: prompt, one tool call, done. */
function turn(state: GraphState, session: string, at: number): GraphState {
  state = send(state, session, { hook_event_name: "UserPromptSubmit", prompt: `work in ${session}` }, at);
  state = send(state, session, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: `${session}-${at}`, tool_input: { command: "ls" } }, at + 100);
  state = send(state, session, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: `${session}-${at}` }, at + 200);
  return send(state, session, { hook_event_name: "Stop" }, at + 300);
}

/** Three finished sessions, and a finished subagent `s1::sub` under the first. */
function history(): GraphState {
  seq = 0;
  log = [];
  let state = initialState();
  for (const [i, session] of ["s1", "s2", "s3"].entries()) {
    state = send(state, session, { hook_event_name: "SessionStart", cwd: `/repo/${session}` }, T + i * 1_000);
    state = turn(state, session, T + 5_000 + i * 1_000);
  }
  state = send(state, "s1", { hook_event_name: "SubagentStart", agent_id: "sub", agent_type: "explorer" }, T + 10_000);
  state = send(state, "s1", { hook_event_name: "PreToolUse", agent_id: "sub", tool_name: "Read", tool_use_id: "sub-read", tool_input: {} }, T + 10_100);
  state = send(state, "s1", { hook_event_name: "PostToolUse", agent_id: "sub", tool_name: "Read", tool_use_id: "sub-read" }, T + 10_200);
  return send(state, "s1", { hook_event_name: "SubagentStop", agent_id: "sub" }, T + 10_300);
}

/** One run of the call-back effect in App.tsx, the way it runs after a render:
 *  note when each removal was first seen, then take back what the waiting
 *  call-back and live work both ask for. */
function callBack(state: GraphState, removed: Set<string>, since: ReadonlyMap<string, number>, now: number) {
  const seen = removalTimes(since, removed, now);
  const hidden = removalHiddenIds(state.agents.values(), removed);
  const lifted = removalsLiftedByWork(state.agents, hidden, removed, seen);
  const back = [...sessionsCalledBack(blockedSessions(state.agents.values()), hidden), ...lifted];
  return { removed: withoutRemovals(removed, back), since: seen, lifted };
}

describe("live work brings a removed card back (#1315)", () => {
  it("brings a removed idle session back on its next prompt, and leaves an unrelated one removed", () => {
    let state = history();
    const first = callBack(state, new Set(["s1", "s3"]), new Map(), R);
    // Everything these sessions did was done before they were removed.
    expect(first.lifted).toEqual([]);

    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "one more thing" }, R + 5_000);
    const next = callBack(state, first.removed, first.since, R + 5_050);
    expect(next.lifted).toEqual(["s1"]);
    expect([...next.removed]).toEqual(["s3"]);
    expect([...removalHiddenIds(state.agents.values(), next.removed)]).toEqual(["s3"]);
  });

  it("counts a tool call, a block of output and a subagent starting as work, as well as a prompt", () => {
    const work: HookPayload[] = [
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "later", tool_input: { command: "make" } },
      { hook_event_name: "OutputObserved", kind: "text", at: R + 5_000 },
      { hook_event_name: "SubagentStart", agent_id: "sub-2", agent_type: "planner" },
    ];
    for (const payload of work) {
      let state = history();
      const first = callBack(state, new Set(["s1"]), new Map(), R);
      state = send(state, "s1", payload, R + 5_000);
      expect(callBack(state, first.removed, first.since, R + 5_050).lifted, payload.hook_event_name).toEqual(["s1"]);
    }
  });

  it("does not count what the deck is told about a session that is not working", () => {
    let state = history();
    const first = callBack(state, new Set(["s1"]), new Map(), R);
    const quiet: HookPayload[] = [
      // The server's enrichment, which arrives on its own schedule.
      { hook_event_name: "UsageObserved", usage: { input_tokens: 10, output_tokens: 20 } },
      { hook_event_name: "ContextObserved", context: { msgsUser: 3 } },
      { hook_event_name: "ModelObserved", model: "claude-opus-4-7" },
      { hook_event_name: "SessionNamed", sessionName: "tidy-up" },
      { hook_event_name: "SessionRecapped", recap: { text: "Tidied the repo.", at: R + 1_000 } },
      // An idle prompt is a turn that ended, and a second Stop is the same one.
      { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" },
      { hook_event_name: "Stop" },
      // A block written before the removal and read after it.
      { hook_event_name: "OutputObserved", kind: "text", at: R - 1_000 },
    ];
    let since = first.since;
    let removed = first.removed;
    for (const [i, payload] of quiet.entries()) {
      state = send(state, "s1", payload, R + 1_000 + i * 1_000);
      const pass = callBack(state, removed, since, R + 1_050 + i * 1_000);
      expect(pass.lifted, payload.hook_event_name).toEqual([]);
      ({ since, removed } = pass);
    }
    // And the sweeps, which conclude that nothing is happening.
    sweepStaleTools(state, R + STALE_SESSION_MS * 2, STALE_SESSION_MS);
    sweepStaleSessions(state, R + STALE_SESSION_MS * 2, STALE_SESSION_MS);
    expect(callBack(state, removed, since, R + STALE_SESSION_MS * 2).lifted).toEqual([]);
    // The late block is the one stamp any of that moved, and it moved to the
    // block's own time — before the removal, which is why it lifted nothing.
    expect(lastWorkedAt(state.agents.get("s1")!)).toBe(R - 1_000);
    expect([...removed]).toEqual(["s1"]);
  });

  it("takes a card removed mid-turn off the board, and brings it back with the next thing it does", () => {
    let state = history();
    state = send(state, "s2", { hook_event_name: "UserPromptSubmit", prompt: "run the suite" }, R - 2_000);
    state = send(state, "s2", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "suite", tool_input: { command: "npm test" } }, R - 1_000);
    expect(state.agents.get("s2")!.state).toBe("active");

    // Removed while running, it LEAVES — no call-back on the same frame, so
    // Remove is not a flicker — and stays away through a long call.
    const first = callBack(state, new Set(["s2"]), new Map(), R);
    expect(first.lifted).toEqual([]);
    expect(callBack(state, first.removed, first.since, R + 30_000).lifted).toEqual([]);

    // The next thing it does brings it back.
    state = send(state, "s2", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "suite" }, R + 40_000);
    state = send(state, "s2", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "fix", tool_input: { command: "git diff" } }, R + 41_000);
    expect(callBack(state, first.removed, first.since, R + 41_050).lifted).toEqual(["s2"]);
  });

  it("lets a card whose terminal died mid-turn stay removed", () => {
    // `active` to the reducer until the stale sweep, and never going to do
    // anything again: exactly what Remove is for.
    let state = history();
    state = send(state, "s3", { hook_event_name: "UserPromptSubmit", prompt: "deploy" }, R - 2_000);
    state = send(state, "s3", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "deploy", tool_input: {} }, R - 1_000);
    const first = callBack(state, new Set(["s3"]), new Map(), R);
    expect(state.agents.get("s3")!.state).toBe("active");
    expect(first.lifted).toEqual([]);
    expect(callBack(state, first.removed, first.since, R + 60 * 60_000).lifted).toEqual([]);
    sweepStaleSessions(state, R + STALE_SESSION_MS * 2, STALE_SESSION_MS);
    expect(callBack(state, first.removed, first.since, R + STALE_SESSION_MS * 2).lifted).toEqual([]);
  });

  it("does not count a root the deck rebuilt from an ending for a session it had let go", () => {
    // The board evicts finished sessions; a late idle prompt or Stop for one
    // makes its root again, stamped with that event's time — which is a
    // `startedAt` and not work.
    let state = history();
    const first = callBack(state, new Set(["s1"]), new Map(), R);
    pruneDoneSessions(state, R, 0, 0);
    expect(state.agents.has("s1")).toBe(false);
    state = send(state, "s1", { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }, R + 5_000);
    state = send(state, "s1", { hook_event_name: "Stop" }, R + 6_000);
    expect(state.agents.get("s1")!.startedAt).toBe(R + 5_000);
    expect(callBack(state, first.removed, first.since, R + 6_050).lifted).toEqual([]);
  });

  it("brings a resumed subagent back on its own, and not for its session's work", () => {
    let state = history();
    const first = callBack(state, new Set(["s1::sub"]), new Map(), R);

    // The session it belongs to working is not the subagent working.
    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "carry on" }, R + 1_000);
    state = send(state, "s1", { hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "root-grep", tool_input: {} }, R + 1_100);
    state = send(state, "s1", { hook_event_name: "PostToolUse", tool_name: "Grep", tool_use_id: "root-grep" }, R + 1_200);
    expect(callBack(state, first.removed, first.since, R + 1_250).lifted).toEqual([]);

    // Resumed under the same key, the subagent's first call brings it back.
    state = send(state, "s1", { hook_event_name: "SubagentStart", agent_id: "sub", agent_type: "explorer" }, R + 5_000);
    state = send(state, "s1", { hook_event_name: "PreToolUse", agent_id: "sub", tool_name: "Read", tool_use_id: "sub-again", tool_input: {} }, R + 5_100);
    const back = callBack(state, first.removed, first.since, R + 5_150);
    expect(back.lifted).toEqual(["s1::sub"]);
    expect(back.removed.size).toBe(0);
  });

  it("brings a resumed subagent back with the session it hangs from, and nothing else", () => {
    let state = history();
    const first = callBack(state, new Set(["s1::sub", "s1", "s3"]), new Map(), R);
    state = send(state, "s1", { hook_event_name: "SubagentStart", agent_id: "sub", agent_type: "explorer" }, R + 5_000);
    state = send(state, "s1", { hook_event_name: "PreToolUse", agent_id: "sub", tool_name: "Read", tool_use_id: "sub-again", tool_input: {} }, R + 5_100);
    const back = callBack(state, first.removed, first.since, R + 5_150);

    expect(back.lifted.sort()).toEqual(["s1", "s1::sub"]);
    expect([...back.removed]).toEqual(["s3"]);
    // Enough lineage to draw: the subagent AND the card it hangs from.
    const hidden = removalHiddenIds(state.agents.values(), back.removed);
    expect(hidden.has("s1::sub")).toBe(false);
    expect(hidden.has("s1")).toBe(false);
    expect([...hidden]).toEqual(["s3"]);
  });

  it("brings a removed session back when one of its subagents starts, but not a sibling removed on its own", () => {
    let state = history();
    const whole = callBack(state, new Set(["s1"]), new Map(), R);
    state = send(state, "s1", { hook_event_name: "SubagentStart", agent_id: "sub-2", agent_type: "planner" }, R + 5_000);
    const back = callBack(state, whole.removed, whole.since, R + 5_050);
    expect(back.lifted).toEqual(["s1"]);
    expect(removalHiddenIds(state.agents.values(), back.removed).size).toBe(0);

    state = history();
    const sibling = callBack(state, new Set(["s1::sub"]), new Map(), R);
    state = send(state, "s1", { hook_event_name: "SubagentStart", agent_id: "sub-2", agent_type: "planner" }, R + 5_000);
    state = send(state, "s1", { hook_event_name: "PreToolUse", agent_id: "sub-2", tool_name: "Read", tool_use_id: "sub-2-read", tool_input: {} }, R + 5_100);
    expect(callBack(state, sibling.removed, sibling.since, R + 5_150).lifted).toEqual([]);
  });

  it("measures from the newest removal hiding the card, since older work was on the board when it was made", () => {
    const agents = new Map([
      ["s", { id: "s", sessionId: "s", kind: "root" as const, startedAt: 0, tools: [], prompts: [] }],
      ["s::a", { id: "s::a", sessionId: "s", parentId: "s", kind: "subagent" as const, startedAt: 0, tools: [{ startedAt: 150 }], prompts: [] }],
    ]);
    const removed = new Set(["s::a", "s"]);
    // The subagent was removed at 100, worked at 150, and its session was
    // removed at 200 — with that work on screen.
    expect(removalsLiftedByWork(agents, ["s", "s::a"], removed, new Map([["s::a", 100], ["s", 200]]))).toEqual([]);
    expect(removalsLiftedByWork(agents, ["s", "s::a"], removed, new Map([["s::a", 100], ["s", 120]])).sort()).toEqual(["s", "s::a"]);
    // A removal nobody has noted yet lifts nothing rather than everything.
    expect(removalsLiftedByWork(agents, ["s", "s::a"], removed, new Map([["s::a", 100]]))).toEqual([]);
  });

  it("still calls a removed session back when it starts waiting, work or no work", () => {
    let state = history();
    const first = callBack(state, new Set(["s2", "s3"]), new Map(), R);
    state = send(state, "s2", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, R + 5_000);
    const pass = callBack(state, first.removed, first.since, R + 5_050);
    // Not work — a prompt for permission is the session stopped — but the
    // waiting call-back answers for it exactly as it always has.
    expect(pass.lifted).toEqual([]);
    expect([...pass.removed]).toEqual(["s3"]);
  });

  it("saves the restore, so a reload draws the working session and keeps the rest removed", () => {
    const values = new Map<string, string>();
    const store = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    let state = history();
    saveRemovedNodes(store, new Set(["s1", "s3"]));
    const first = callBack(state, readRemovedNodes(store), new Map(), R);
    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "back to it" }, R + 5_000);
    const back = callBack(state, first.removed, first.since, R + 5_050);
    // What bringBack does with a change: write it.
    expect(back.removed).not.toBe(first.removed);
    saveRemovedNodes(store, back.removed);
    expect([...readRemovedNodes(store)]).toEqual(["s3"]);

    // A reload replays the same history into a fresh graph, and the set it
    // reads back counts from the page's first look — after all of it.
    let reloaded = initialState();
    for (const env of log) reloaded = applyEvent(reloaded, env);
    const load = R + 10_000;
    const after = callBack(reloaded, readRemovedNodes(store), new Map(), load);
    expect(after.lifted).toEqual([]);
    expect([...removalHiddenIds(reloaded.agents.values(), after.removed)]).toEqual(["s3"]);
  });

  it("counts each removal from when it was first seen, and forgets one that leaves", () => {
    const one = removalTimes(new Map(), new Set(["a"]), 100);
    expect([...one]).toEqual([["a", 100]]);
    const two = removalTimes(one, new Set(["a", "b"]), 200);
    expect([...two]).toEqual([["a", 100], ["b", 200]]);
    // Nothing came or went: the same map, so the caller keeps it for nothing.
    expect(removalTimes(two, new Set(["a", "b"]), 300)).toBe(two);
    const brought = removalTimes(two, new Set(["b"]), 400);
    expect([...brought]).toEqual([["b", 200]]);
    // Removed again, it starts again.
    expect(removalTimes(brought, new Set(["b", "a"]), 500).get("a")).toBe(500);
    // The map passed in is never written: it is held across renders.
    expect([...two]).toEqual([["a", 100], ["b", 200]]);
  });

  it("is wired into the one call-back effect, through the bringBack that saves", () => {
    const client = clientText();
    const effect = /removedSinceRef\.current = removalTimes\(removedSinceRef\.current, removedNodes, Date\.now\(\)\);[\s\S]*?\}, \[[^\]]*\]\);/.exec(client)?.[0] ?? "";
    expect(effect).toMatch(/\.\.\.sessionsCalledBack\(waitingSessions, removedAgentIds\),/);
    expect(effect).toMatch(/\.\.\.removalsLiftedByWork\(stateRef\.current\.agents, removedAgentIds, removedNodes, removedSinceRef\.current\),/);
    expect(effect).toMatch(/if \(back\.length > 0\) bringBack\(back\);/);
    // Re-run on every revision and every change to the set, or new work and a
    // new removal would both wait for something else to render.
    expect(effect).toMatch(/\}, \[waitingSessions, removedAgentIds, removedNodes, bringBack\]\);$/);
    expect(client).toMatch(/const next = withoutRemovals\(previous, list\);\s*if \(next !== previous\) saveRemovedNodes\(window\.localStorage, next\);/);
  });
});

describe("drag-to-trash hit testing", () => {
  const target = { left: 400, right: 620, top: 700, bottom: 758 };

  it("removes only when the pointer release lands inside the target", () => {
    expect(pointInRect({ clientX: 510, clientY: 729 }, target)).toBe(true);
    expect(pointInRect({ clientX: 399, clientY: 729 }, target)).toBe(false);
    expect(pointInRect({ clientX: 510, clientY: 699 }, target)).toBe(false);
  });

  it("counts the visible edge as part of the generous target", () => {
    expect(pointInRect({ clientX: 400, clientY: 700 }, target)).toBe(true);
    expect(pointInRect({ clientX: 620, clientY: 758 }, target)).toBe(true);
  });

  it("reaches a little past the visible edge, so a release just outside still removes", () => {
    expect(pointInRect({ clientX: 400 - TRASH_HIT_SLOP_PX, clientY: 729 }, target, TRASH_HIT_SLOP_PX)).toBe(true);
    expect(pointInRect({ clientX: 400 - TRASH_HIT_SLOP_PX - 1, clientY: 729 }, target, TRASH_HIT_SLOP_PX)).toBe(false);
  });

  it("says far, near or over from the pointer's distance to the target", () => {
    expect(trashProximity({ clientX: 510, clientY: 729 }, target)).toBe("over");
    expect(trashProximity({ clientX: 510, clientY: 700 - TRASH_HIT_SLOP_PX }, target)).toBe("over");
    expect(trashProximity({ clientX: 510, clientY: 700 - TRASH_NEAR_PX }, target)).toBe("near");
    expect(trashProximity({ clientX: 510, clientY: 700 - TRASH_NEAR_PX - 1 }, target)).toBe("far");
    expect(distanceToRect({ clientX: 397, clientY: 696 }, target)).toBe(5);
  });

  it("keeps the whole target clear of the band where React Flow pans the board", () => {
    const sheet = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
    const rule = /\.drag-trash-zone \{([^}]*)\}/.exec(sheet)?.[1] ?? "";
    const bottom = Number(/\bbottom:\s*(\d+)px/.exec(rule)?.[1]);
    expect(bottom - TRASH_HIT_SLOP_PX).toBeGreaterThan(AUTO_PAN_EDGE_PX);
  });

  it("reads the release point of a touch drag from changedTouches", () => {
    expect(clientPointOf({ clientX: 3, clientY: 4 })).toEqual({ clientX: 3, clientY: 4 });
    expect(clientPointOf({ changedTouches: [{ clientX: 7, clientY: 8 }] })).toEqual({ clientX: 7, clientY: 8 });
    expect(clientPointOf({})).toBeNull();
  });
});

describe("where Remove lives and what follows it", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const list = readFileSync(fileURLToPath(new URL("../components/SessionList.tsx", import.meta.url)), "utf8");
  const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

  it("is gone from the topbar and sits with the card's own verbs in the detail panel", () => {
    expect(app).not.toMatch(/>\s*Remove node\s*</);
    // The panel is components/Detail.tsx now; App.tsx hands it onRemove.
    const panel = readFileSync(fileURLToPath(new URL("../components/Detail.tsx", import.meta.url)), "utf8");
    const detail = /function Detail\([\s\S]*?\n}\n/.exec(panel)?.[0] ?? "";
    expect(detail, "no Detail in components/Detail.tsx").not.toBe("");
    expect(panel).not.toMatch(/>\s*Remove node\s*</);
    expect(detail).toMatch(/className="btn hero-action-btn"\s+onClick=\{onRemove\}[\s\S]*?>Remove from board<\/button>/);
    expect(app).toMatch(/onRemove=\{removeSelectedNode\}/);
    // Reversible from the session list, so not dressed as the one destructive .btn the sheet reserves
    // red for.
    expect(detail).not.toMatch(/btn danger[^"]*"\s+onClick=\{onRemove\}/);
  });

  it("is one key from a selection, since a plain click shuts the panel it lives in", () => {
    // The key is answered in use-deck-shortcuts.ts, through the ref App.tsx hands it.
    const keys = readFileSync(fileURLToPath(new URL("../use-deck-shortcuts.ts", import.meta.url)), "utf8");
    expect(keys).toMatch(/if \(e\.key === "Delete"\) removeSelectedRef\.current\(\);/);
    expect(app).toMatch(/useDeckShortcuts\(\{[\s\S]*?\bremoveSelectedRef\b[\s\S]*?\}\);/);
    // The mirror is `useMirroredRef` now — the keydown handler outlives the
    // render that registered it, so it has to read the current callback.
    expect(app).toMatch(/const removeSelectedRef = useMirroredRef\(removeSelectedNode\);/);
  });

  it("draws nothing after a removal, and keeps focus on the board", () => {
    expect(app).not.toMatch(/is off the board\.<\/strong>/);
    expect(app).not.toMatch(/undoRemoval/);
    expect(app).toMatch(/if \(lastRemoval\) canvasRef\.current\?\.focus\(\);/);
  });

  it("says the removal through a region that is mounted before the words arrive", () => {
    expect(app).toMatch(/<div className="vis-hidden" role="status" aria-atomic="true">\s*\{removalNotice \? `\$\{removalNotice\.label\} removed from the board\.` : ""\}/);
  });

  it("brings a waiting session back instead of leaving the alarm pointing at nothing", () => {
    // One effect, one way back, for both call-backs (#1315): the waiting one
    // is a spread into the same list the live-work one is, and the list goes
    // to bringBack whole.
    expect(clientText()).toMatch(/const back = \[\s*\.\.\.sessionsCalledBack\(waitingSessions, removedAgentIds\),[\s\S]{0,200}?\];\s*if \(back\.length > 0\) bringBack\(back\);/);
  });

  it("keeps a removed session in the session list, marked, as the way back", () => {
    expect(app).toMatch(/onSelect=\{openSession\}[\s\S]*?removedIds=\{removedAgentIds\}/);
    expect(app).toMatch(/if \(removedAgentIds\.has\(sessionId\)\) bringBack\(\[sessionId\]\);\s*focusSession\(sessionId\);/);
    expect(list).toMatch(/\{removed && <span className="sl-removed">off the board<\/span>\}/);
    expect(list).toMatch(/Bring back \{count\} removed \{count === 1 \? "card" : "cards"\}/);
    expect(css).toMatch(/\.session-list \.sl-row\.removed \.sl-label \{ color: var\(--muted\); \}/);
  });

  it("forgets the last removal on Clear", () => {
    const clear = /const handleClear = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/.exec(app)?.[0] ?? "";
    expect(clear).toMatch(/setLastRemoval\(null\);/);
  });
});
