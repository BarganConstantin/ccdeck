// A ToolCall used to be pushed onto its owner's `tools` array and never taken
// off again: pruneOldAgents / pruneDoneSessions only evict whole finished
// agents and sessions, so a root session left open all day kept every call it
// ever made — each one holding the complete tool_input and tool_response the
// server forwarded verbatim (payloads are accepted up to 5MB). Hundreds of MB
// piled up in the tab and the detail panel grew one DOM row per call. The
// reducer now keeps a bounded window of recent calls and releases the heavy
// blobs of everything older, while `toolCount` still counts every call.
import { describe, it, expect } from "vitest";
import {
  applyEvent,
  initialState,
  MAX_TOOLS_PER_AGENT,
  TOOL_BLOB_WINDOW,
} from "../reducer";
import type { GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const SESSION = "sess-tools";

/** The clock these envelopes carry. Every `receivedAt` is this plus the seq, so
 *  the reducer's `now` is always a number this file can name — which is the
 *  point of `STAMPS` below. */
const CLOCK_BASE = 1_000;

let seq = 0;
/** The `receivedAt` the last envelope went out with. */
let lastStamp = 0;

function send(state: GraphState, payload: HookPayload): GraphState {
  const env: HookEnvelope = {
    seq: ++seq,
    receivedAt: (lastStamp = CLOCK_BASE + seq),
    source: "hook",
    payload: { session_id: SESSION, ...payload },
  };
  return applyEvent(state, env);
}

/** What the envelopes for each tool id actually stamped, captured as they are
 *  sent. Recorded rather than recomputed: a formula written out here would be a
 *  second copy of the feed, and would go on agreeing with itself if the feed
 *  changed underneath it. */
const STAMPS = new Map<string, { startedAt: number; endedAt: number }>();

/** One complete Read: PreToolUse with a fat input, PostToolUse with a fat
 *  response — the shape that actually eats the heap. */
function readCall(state: GraphState, n: number): GraphState {
  const id = `t${n}`;
  let s = send(state, {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_use_id: id,
    tool_input: { file_path: `/repo/file-${n}.ts`, blob: "i".repeat(4096) },
  });
  const startedAt = lastStamp;
  s = send(s, {
    hook_event_name: "PostToolUse",
    tool_use_id: id,
    tool_response: { content: "r".repeat(4096) },
  });
  STAMPS.set(id, { startedAt, endedAt: lastStamp });
  return s;
}

function feed(count: number): GraphState {
  seq = 0;
  STAMPS.clear();
  let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
  for (let n = 0; n < count; n++) state = readCall(state, n);
  return state;
}

describe("per-agent tool history", () => {
  it("caps the retained calls instead of growing for the life of the session", () => {
    const calls = MAX_TOOLS_PER_AGENT + 120;
    const root = feed(calls).agents.get(SESSION)!;

    expect(root.tools.length).toBe(MAX_TOOLS_PER_AGENT);
    // The counter still reflects every call ever made, so the cards and the
    // session list don't start under-reporting once trimming kicks in.
    expect(root.toolCount).toBe(calls);
    // The oldest calls are the ones that go.
    expect(root.tools[0].id).toBe(`t${calls - MAX_TOOLS_PER_AGENT}`);
    expect(root.tools[root.tools.length - 1].id).toBe(`t${calls - 1}`);
  });

  it("releases input/response blobs outside the recent window", () => {
    const calls = MAX_TOOLS_PER_AGENT + 50;
    const root = feed(calls).agents.get(SESSION)!;
    const withBlobs = root.tools.filter(t => t.input != null || t.response != null);

    expect(withBlobs.length).toBe(TOOL_BLOB_WINDOW);
    // …and they are the newest ones, which is what the modal is opened on.
    expect(withBlobs[withBlobs.length - 1].id).toBe(`t${calls - 1}`);

    const old = root.tools[0];
    expect(old.input).toBeUndefined();
    expect(old.response).toBeUndefined();
    expect(old.trimmed).toBe(true);
    // Everything the canvas reads off an entry survives the trim.
    expect(old.name).toBe("Read");
    expect(old.inputPreview.length).toBeGreaterThan(0);
    // The timings are the ones this entry's own two envelopes carried. That is
    // the claim — the timing SURVIVES the trim — and `toBeGreaterThan(0)` was
    // not it (#654): every stamp in this feed is `1_000 + seq`, so ≥ 1002 by
    // construction, and a zero was never among the answers the assertion could
    // have received. `Date.now()`, a neighbour's stamp and a literal 1 all
    // satisfied it, and overwriting both fields with `Date.now()` inside
    // trimTools left this whole file green — an elapsed time of minus an hour
    // on the card, reported as a pass.
    const stamp = STAMPS.get(old.id);
    expect(stamp, `no envelope recorded for ${old.id} — the feed and the trim disagree about which call this is`).toBeDefined();
    expect([old.startedAt, old.endedAt]).toEqual([stamp!.startedAt, stamp!.endedAt]);
    expect(old.ok).toBe(true);
    expect(old.agentId).toBe(SESSION);
  });

  it("keeps every blob while the agent is under the window", () => {
    const root = feed(TOOL_BLOB_WINDOW).agents.get(SESSION)!;
    expect(root.tools.length).toBe(TOOL_BLOB_WINDOW);
    expect(root.tools.every(t => t.input != null && t.response != null)).toBe(true);
    expect(root.tools.some(t => t.trimmed)).toBe(false);
  });

  it("does not re-attach a blob when a late response settles a trimmed call", () => {
    seq = 0;
    let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
    // One slow call, then enough traffic to push it out of the blob window.
    state = send(state, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "slow",
      tool_input: { command: "sleep 300" },
    });
    for (let n = 0; n < TOOL_BLOB_WINDOW + 5; n++) state = readCall(state, n);

    const root = state.agents.get(SESSION)!;
    const slow = root.tools.find(t => t.id === "slow")!;
    expect(slow.trimmed).toBe(true);
    expect(slow.input).toBeUndefined();

    state = send(state, {
      hook_event_name: "PostToolUse",
      tool_use_id: "slow",
      tool_response: { stdout: "x".repeat(4096) },
    });
    expect(slow.endedAt).toBeGreaterThan(0);
    expect(slow.ok).toBe(true);
    expect(slow.response).toBeUndefined();
  });

  it("drops evicted in-flight calls from the live index so it can't strand entries", () => {
    seq = 0;
    let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
    // A call whose PostToolUse never arrives, buried under a full cap of newer
    // ones. Its index entry has to go with it or nothing can ever clear it.
    state = send(state, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "lost",
      tool_input: { command: "hang" },
    });
    for (let n = 0; n < MAX_TOOLS_PER_AGENT; n++) state = readCall(state, n);

    const root = state.agents.get(SESSION)!;
    expect(root.tools.some(t => t.id === "lost")).toBe(false);
    expect(state.toolIndex.has("lost")).toBe(false);
    expect(state.toolOwner.has("lost")).toBe(false);
    // The settled calls left the index on their own PostToolUse.
    expect(state.toolIndex.size).toBe(0);
    expect(root.tools.filter(t => t.endedAt == null)).toEqual([]);
  });

  it("caps each agent separately — a busy subagent can't evict the root's history", () => {
    seq = 0;
    let state = send(initialState(), { hook_event_name: "SessionStart", cwd: "/repo" });
    state = send(state, { hook_event_name: "PreToolUse", tool_name: "Glob", tool_use_id: "root-1" });
    state = send(state, { hook_event_name: "PostToolUse", tool_use_id: "root-1" });
    state = send(state, { hook_event_name: "SubagentStart", agent_id: "sub-1", agent_type: "explorer" });
    for (let n = 0; n < MAX_TOOLS_PER_AGENT + 10; n++) state = readCall(state, n);

    const root = state.agents.get(SESSION)!;
    const sub = state.agents.get(`${SESSION}::sub-1`)!;
    expect(sub.tools.length).toBe(MAX_TOOLS_PER_AGENT);
    expect(root.tools.length).toBe(1);
    expect(root.tools[0].id).toBe("root-1");
  });
});
