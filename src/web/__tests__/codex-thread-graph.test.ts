import { describe, expect, it } from "vitest";
import { applyEvent, initialState, pruneDoneSessions, pruneOldAgents } from "../reducer";
import { canvasSessions } from "../canvas-session";
import { nodeDataFor, snapshotToFlow } from "../canvas-flow";
import { clusterBounds } from "../cluster-bounds";
import { sessionGroupNodes } from "../session-group-nodes";
import { groupBySession } from "../layout-geometry";
import { branchSummaries } from "../node-face";
import type { HookPayload } from "../types";
// @ts-expect-error server modules have no declaration files
import { codexThreadLink } from "../../server/codex-lineage.mjs";

const meta = (child: string, parent: string) => ({ type: "session_meta", payload: {
  id: child, cwd: "/project", source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_nickname: "Ada" } } },
} });
function graph() {
  const state = initialState();
  let seq = 0;
  const send = (p: HookPayload, at = ++seq * 1000) => applyEvent(state, { seq: ++seq, receivedAt: at, source: "codex", payload: { provider: "codex", ...p } });
  const start = (id: string) => send({ session_id: id, hook_event_name: "SessionStart", cwd: "/project" });
  const link = (child: string, parent: string) => send(codexThreadLink(meta(child, parent), child, "/project"));
  return { state, send, start, link };
}

describe("Codex thread families", () => {
  it("reads header ancestry and both activity encodings, without guessing from completion", () => {
    expect(codexThreadLink(meta("worker", "lead"), "worker", "/project")).toMatchObject({ session_id: "worker", parent_session_id: "lead", agent_nickname: "Ada" });
    for (const payload of [
      { type: "sub_agent_activity", kind: "started", agent_thread_id: "worker" },
      { type: "item_completed", item: { type: "SubAgentActivity", kind: "started", agent_thread_id: "worker" } },
    ]) expect(codexThreadLink({ type: "event_msg", payload }, "lead", "/project")?.session_id).toBe("worker");
    for (const kind of ["completed", "interacted", "failed"]) {
      expect(codexThreadLink({ type: "event_msg", payload: { type: "sub_agent_activity", kind, agent_thread_id: "ghost" } }, "lead", "/project")).toBeNull();
    }
    const conflict = meta("worker", "lead");
    Object.assign(conflict.payload, { parent_thread_id: "other" });
    expect(codexThreadLink(conflict, "worker", "/project")).toBeNull();
  });

  it("keeps child identity, calls and usage independent when linked after its traffic", () => {
    const { state, send, start, link } = graph();
    start("worker");
    send({ session_id: "worker", hook_event_name: "PreToolUse", tool_use_id: "read", tool_name: "Read", tool_input: {} });
    send({ session_id: "worker", hook_event_name: "UsageObserved", usage: { input_tokens: 90, output_tokens: 12 } });
    link("worker", "lead");
    expect(state.agents.has("lead")).toBe(false);
    start("lead");
    const child = state.agents.get("worker")!;
    expect(child).toMatchObject({ sessionId: "worker", parentId: "lead", label: "Ada", toolCount: 1 });
    expect(child.usage.inputTokens).toBe(90);
    expect(state.agents.get("lead")!.usage.inputTokens).toBe(0);
    expect(state.agents.get("lead")!.toolCount).toBe(0);
    expect(state.agents.get("lead")!.childCount).toBe(1);
    expect(state.agents.size).toBe(2);
  });

  it("does not revive a finished child when relationship metadata repeats", () => {
    const { state, send, start, link } = graph();
    start("lead"); start("worker"); link("worker", "lead");
    send({ session_id: "worker", hook_event_name: "Stop" }, 50_000);
    link("worker", "lead");
    expect(state.agents.get("worker")!.state).toBe("done");
    expect(state.agents.get("lead")!.state).toBe("active");
    expect(state.agents.get("lead")!.childCount).toBe(1);
  });

  it("refuses cycles, conflicting parents and links between providers", () => {
    const { state, start, send, link } = graph();
    start("lead"); link("worker", "lead"); link("lead", "worker");
    link("worker", "different");
    expect(state.agents.get("lead")!.parentId).toBeUndefined();
    expect(state.agents.get("worker")!.parentId).toBe("lead");
    send({ session_id: "claude", hook_event_name: "SessionStart", provider: "claude" });
    link("other", "claude");
    expect(state.agents.has("other")).toBe(false);
  });

  it("groups nested children for layout and dragging, without rewriting their sessions", () => {
    const { state, start, link } = graph();
    start("lead"); link("worker", "lead"); link("reviewer", "worker"); start("separate");
    expect(canvasSessions(state.agents.values()).get("reviewer")).toBe("lead");
    const dataFor = nodeDataFor(state, () => {});
    const nodes = [...state.agents.values()].map((a, i) => ({ id: a.id, type: "agent", data: dataFor(a), position: { x: i * 300, y: 0 }, width: 240, height: 130 }));
    expect(nodes[2].data.sessionId).toBe("reviewer");
    expect(groupBySession(nodes).get("lead")?.length).toBe(3);
    expect(sessionGroupNodes(nodes)).toHaveLength(2);
    const clusters = clusterBounds(nodes);
    expect(clusters).toHaveLength(2);
    expect(clusters.find(c => c.sessionId === "lead")?.label).not.toBe("Ada");
    expect(branchSummaries(state.agents.values()).get("lead")?.total).toBe(2);
    const frame = snapshotToFlow(state, 40_000, 1600, 900, new Map(), new Map(), new Map(), () => {}, true, false, new Map(), new Set(), "test", { current: "" }, new Set(), null, new Set(state.agents.keys()), () => {}, true, new Set());
    expect(frame.edges.map(e => [e.source, e.target])).toEqual(expect.arrayContaining([["lead", "worker"], ["worker", "reviewer"]]));
  });

  it("keeps a finished ancestor while a descendant still runs", () => {
    const { state, start, send, link } = graph();
    start("lead"); link("worker", "lead"); link("reviewer", "worker");
    send({ session_id: "lead", hook_event_name: "Stop" }, 30_000);
    send({ session_id: "worker", hook_event_name: "Stop" }, 31_000);
    pruneDoneSessions(state, 100_000, 0, 1);
    pruneOldAgents(state, 100_000, 1, 1);
    expect([...state.agents.keys()]).toEqual(["lead", "worker", "reviewer"]);
  });
});
