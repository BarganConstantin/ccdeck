// A session started from the Command Panel is not the ghost the board hides.
//
// The board leaves out a session that ended its turn within three seconds of
// starting having called no tool. A Codex launched from the panel and asked
// one word does exactly that — on Windows its turn reached the deck in under a
// second — so its card vanished from under the stage that had just started
// it. What saves it is the launch, not a longer threshold: the stage notes
// the launch (panel-launch.ts) and the rule passes over a session the reader
// started until it ends. These drive the real reducer with the events the
// agents send, then read the board the way it does.
import { describe, expect, it } from "vitest";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { AgentNodeData, HookEnvelope, HookPayload } from "../types";
import { computeVisibleIds, isAgentVisible } from "../visibility";
import { PANEL_LAUNCHES_MAX, adoptPanelLaunch, notePanelLaunch } from "../panel-launch";
import { stageShowFor } from "../components/terminal/stage-board";

const SID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const KEY = "launch-test-1";
const START = 1_800_000_000_000;

/** The board's events for one session, `gap` ms apart from START. */
function events(state: GraphState, sessionId = SID, gap = 1_000) {
  let seq = state.lastSeq;
  let at = START;
  return {
    send(payload: Partial<HookPayload>) {
      applyEvent(state, {
        seq: ++seq, receivedAt: at, source: "hook",
        payload: { session_id: sessionId, provider: "codex", ...payload } as HookPayload,
      } as HookEnvelope);
      at += gap;
    },
  };
}

/** Started, asked one word, answered with no tool: over in two gaps. */
function quickTurn(state: GraphState, sessionId = SID, gap = 1_000) {
  const e = events(state, sessionId, gap);
  e.send({ hook_event_name: "SessionStart", cwd: "C:\\work\\repo" });
  e.send({ hook_event_name: "UserPromptSubmit", prompt: "hi" });
  e.send({ hook_event_name: "Stop" });
  return e;
}

const root = (state: GraphState): AgentNodeData => state.agents.get(SID)!;
const LATER = [3_001, 10_000, 60_000, 30 * 60_000];

describe("the ghost rule and a session the Command Panel started", () => {
  it("still hides a session nobody started from the panel: the rule itself is unchanged", () => {
    const s = initialState();
    quickTurn(s);
    const a = root(s);
    expect([a.state, a.tools.length, a.endedAt! - a.startedAt < 3000, a.panelLaunch]).toEqual(["done", 0, true, undefined]);
    for (const after of LATER) {
      expect(isAgentVisible(a, a.endedAt! + after), `${after} ms after`).toBe(false);
      expect(computeVisibleIds(s, a.endedAt! + after).has(SID)).toBe(false);
    }
  });

  it("keeps one the panel launched before its card existed: the launch waits, and the card takes it", () => {
    const s = initialState();
    notePanelLaunch(s, SID, KEY);
    expect([...s.panelLaunches]).toEqual([[SID, KEY]]);
    quickTurn(s);
    const a = root(s);
    expect(a.panelLaunch).toBe(KEY);
    expect(s.panelLaunches.size, "taken by the card").toBe(0);
    for (const after of LATER) {
      expect(isAgentVisible(a, a.endedAt! + after), `${after} ms after`).toBe(true);
      expect(computeVisibleIds(s, a.endedAt! + after).has(SID)).toBe(true);
    }
  });

  it("brings back one whose card was already there — a Codex the deck recognised after its first turn", () => {
    const s = initialState();
    quickTurn(s);
    const a = root(s);
    const now = a.endedAt! + 5_000;
    expect(isAgentVisible(a, now)).toBe(false);
    const revision = s.revision;
    notePanelLaunch(s, SID, KEY);
    expect([a.panelLaunch, s.revision, s.panelLaunches.size]).toEqual([KEY, revision + 1, 0]);
    expect(isAgentVisible(a, now)).toBe(true);
    notePanelLaunch(s, SID, KEY);
    expect(s.revision, "the same launch again changes nothing").toBe(revision + 1);
  });

  it("hides it again once the session has ended, as the rule does for every other", () => {
    const s = initialState();
    notePanelLaunch(s, SID, KEY);
    // Half a second apart: the session is over, closed included, inside the
    // three seconds the rule measures.
    const e = quickTurn(s, SID, 500);
    const a = root(s);
    expect(isAgentVisible(a, a.endedAt! + 5_000), "running: kept").toBe(true);
    e.send({ hook_event_name: "SessionEnd" });
    expect([a.closedAt != null, a.endedAt! - a.startedAt < 3000, a.panelLaunch]).toEqual([true, true, KEY]);
    expect(isAgentVisible(a, a.endedAt! + 5_000), "ended: the rule holds").toBe(false);
  });

  it("says on the stage that the deck launched it", () => {
    const s = initialState();
    quickTurn(s);
    const show = (state: GraphState) => stageShowFor({ kind: "session", id: SID }, state.agents, START + 10_000);
    const before = show(s);
    expect(before.kind === "session" && before.session.launched).toBeFalsy();
    notePanelLaunch(s, SID, KEY);
    const after = show(s);
    expect(after.kind === "session" && after.session.launched).toBe(true);
  });

  it("keeps the newest launches waiting, a bounded few, notes nothing without an id or a key, and drops them on a clear", () => {
    const s = initialState();
    notePanelLaunch(s, "", KEY);
    notePanelLaunch(s, SID, "");
    expect(s.panelLaunches.size).toBe(0);
    for (let i = 0; i < PANEL_LAUNCHES_MAX + 5; i++) notePanelLaunch(s, `s-${i}`, `k-${i}`);
    expect(s.panelLaunches.size).toBe(PANEL_LAUNCHES_MAX);
    expect(s.panelLaunches.has("s-0")).toBe(false);
    expect(s.panelLaunches.get(`s-${PANEL_LAUNCHES_MAX + 4}`)).toBe(`k-${PANEL_LAUNCHES_MAX + 4}`);
    adoptPanelLaunch(s, `s-${PANEL_LAUNCHES_MAX}`);
    expect(s.panelLaunches.has(`s-${PANEL_LAUNCHES_MAX}`), "no card yet: still waiting").toBe(true);
    const cleared = applyEvent(s, { seq: 99, receivedAt: START, source: "hook", payload: { hook_event_name: "__clear" } } as unknown as HookEnvelope);
    expect(cleared.panelLaunches.size).toBe(0);
  });
});
