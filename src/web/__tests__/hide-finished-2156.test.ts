// Finished sessions leaving the board after a delay the reader picks (#2156).
//
// Driven through the real reducer, as remove-node.test.ts drives #1315: what
// counts as finished is a question about which events write `state` and
// `endedAt`, and a hand-built agent would only be agreeing with itself. The
// hide itself is Remove from board's, so the way back is checked with the same
// call-back the board runs (removalsLiftedByWork, sessionsCalledBack).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { blockedSessions } from "../ambient-counts";
import {
  finishedTurns, HANDLED_TURNS_CAP, HANDLED_TURNS_KEY, HIDE_FINISHED_CHOICES, HIDE_FINISHED_KEY, hideFinishedAfter,
  hideFinishedLabel, markBroughtBack, readHandledTurns, resolveHideFinishedAfter, saveHandledTurns,
  sessionsToHide, setHideFinishedAfter, subscribeHideFinishedAfter,
} from "../hide-finished";
import { applyEvent, initialState, type GraphState } from "../reducer";
import { removalHiddenIds, removalsLiftedByWork, removalTimes, sessionsCalledBack, withoutRemovals } from "../remove-node";
import type { HookEnvelope, HookPayload } from "../types";
import BoardSection, { HIDE_FINISHED_LABEL } from "../components/BoardSection";
import { clientText } from "./client-source";

const T = 1_700_000_000_000;
const MIN = 60_000;

let seq = 0;
function send(state: GraphState, session: string, payload: HookPayload, at: number): GraphState {
  const env: HookEnvelope = { seq: ++seq, receivedAt: at, source: "hook", epoch: "boot-1", payload: { session_id: session, ...payload } };
  return applyEvent(state, env);
}

/** A turn: prompt, one tool call, and — unless it is still going — Stop. */
function turn(state: GraphState, session: string, at: number, { ends = true } = {}): GraphState {
  state = send(state, session, { hook_event_name: "UserPromptSubmit", prompt: `work in ${session}` }, at);
  state = send(state, session, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: `${session}-${at}`, tool_input: { command: "ls" } }, at + 100);
  state = send(state, session, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: `${session}-${at}` }, at + 200);
  return ends ? send(state, session, { hook_event_name: "Stop" }, at + 300) : state;
}

/** s1 finished at T+300, s2 finished at T+1300, s3 still working. */
function board(): GraphState {
  seq = 0;
  let state = initialState();
  for (const [i, session] of ["s1", "s2", "s3"].entries()) {
    state = send(state, session, { hook_event_name: "SessionStart", cwd: `/repo/${session}` }, T - 1_000 + i);
  }
  state = turn(state, "s1", T);
  state = turn(state, "s2", T + 1_000);
  return turn(state, "s3", T + 2_000, { ends: false });
}

const due = (state: GraphState, now: number, over: Partial<Parameters<typeof sessionsToHide>[1]> = {}) =>
  sessionsToHide(state.agents.values(), { afterMs: 5 * MIN, now, removed: new Set(), handled: new Map(), ...over })
    .map(d => d.id);

/** The board's call-back, as remove-node.test.ts runs it. */
function callBack(state: GraphState, removed: Set<string>, since: ReadonlyMap<string, number>, now: number) {
  const seen = removalTimes(since, removed, now);
  const hidden = removalHiddenIds(state.agents.values(), removed);
  const back = [
    ...sessionsCalledBack(blockedSessions(state.agents.values()), hidden),
    ...removalsLiftedByWork(state.agents, hidden, removed, seen),
  ];
  return { removed: withoutRemovals(removed, back), since: seen };
}

describe("which sessions leave the board", () => {
  it("hides a session once the delay has passed since its last turn ended, and not a moment before", () => {
    const state = board();
    expect(due(state, T + 300 + 5 * MIN - 1)).toEqual([]);
    expect(due(state, T + 300 + 5 * MIN)).toEqual(["s1"]);
    expect(due(state, T + 1_300 + 5 * MIN)).toEqual(["s1", "s2"]);
  });

  it("hides nothing at Never, which is where every deck starts", () => {
    expect(due(board(), T + 24 * 60 * MIN, { afterMs: 0 })).toEqual([]);
    expect(resolveHideFinishedAfter(null)).toBe(0);
  });

  it("never hides a session that is working, or one blocked on a person", () => {
    let state = board();
    // s3's turn is still going, hours later — a terminal killed mid-turn is the
    // stale reap's to settle, not this.
    expect(due(state, T + 60 * MIN)).not.toContain("s3");
    // A permission prompt on a finished-looking session is somebody's decision.
    state = send(state, "s1", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, T + 400);
    expect(due(state, T + 60 * MIN)).not.toContain("s1");
  });

  it("hides a session that only waits with an empty input box: that is a turn that ended", () => {
    let state = board();
    state = send(state, "s1", { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }, T + 60_300);
    expect(due(state, T + 60 * MIN)).toContain("s1");
  });

  it("keeps a session whose subagent is still running", () => {
    let state = board();
    state = send(state, "s1", { hook_event_name: "SubagentStart", agent_id: "sub", agent_type: "explorer" }, T + 400);
    expect(finishedTurns(state.agents.values()).has("s1")).toBe(false);
    expect(due(state, T + 60 * MIN)).not.toContain("s1");
  });

  it("leaves the selected session, and what is already off the board", () => {
    const state = board();
    expect(due(state, T + 60 * MIN, { keep: "s1" })).toEqual(["s2"]);
    expect(due(state, T + 60 * MIN, { keep: ["s1", "s2"] }), "the selected card's and the stage's").toEqual([]);
    expect(due(state, T + 60 * MIN, { keep: [null, "s2"] })).toEqual(["s1"]);
    expect(due(state, T + 60 * MIN, { removed: new Set(["s2"]) })).toEqual(["s1"]);
  });
});

describe("the way back", () => {
  it("comes back on its next prompt, and leaves again after that turn ends", () => {
    let state = board();
    const hideAt = T + 300 + 5 * MIN;
    const hidden = due(state, hideAt);
    expect(hidden).toEqual(["s1"]);
    let removed = new Set(hidden);
    let handled: ReadonlyMap<string, number> = new Map([["s1", T + 300]]);
    let since: ReadonlyMap<string, number> = new Map();
    ({ removed, since } = callBack(state, removed, since, hideAt));
    expect([...removed]).toEqual(["s1"]);

    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "one more thing" }, hideAt + 30_000);
    const before = removed;
    ({ removed, since } = callBack(state, removed, since, hideAt + 30_050));
    expect(removed.has("s1")).toBe(false);
    handled = markBroughtBack(handled, before, removed, state.agents.values());
    // Working, so not hidden however long the delay has run.
    expect(due(state, hideAt + 60 * MIN, { removed, handled })).toEqual(["s2"]);

    state = send(state, "s1", { hook_event_name: "Stop" }, hideAt + 60_000);
    expect(due(state, hideAt + 60_000 + 5 * MIN - 1, { removed, handled, keep: "s2" })).toEqual([]);
    expect(due(state, hideAt + 60_000 + 5 * MIN, { removed, handled, keep: "s2" })).toEqual(["s1"]);
  });

  it("comes back when it starts waiting on a person", () => {
    let state = board();
    let removed = new Set(["s1"]);
    let since: ReadonlyMap<string, number> = new Map();
    ({ removed, since } = callBack(state, removed, since, T + 6 * MIN));
    state = send(state, "s1", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, T + 7 * MIN);
    ({ removed } = callBack(state, removed, since, T + 7 * MIN + 50));
    expect(removed.has("s1")).toBe(false);
  });

  it("does not hide a session the reader brought back by hand, until a later turn ends", () => {
    let state = board();
    const hideAt = T + 300 + 5 * MIN;
    let handled: ReadonlyMap<string, number> = new Map([["s1", T + 300]]);
    // Brought back from the session list: the set loses it, nothing else moved.
    handled = markBroughtBack(handled, new Set(["s1"]), new Set(), state.agents.values());
    expect(due(state, hideAt + 60 * MIN, { handled, keep: "s2" })).toEqual([]);

    state = turn(state, "s1", hideAt + 2 * MIN);
    expect(due(state, hideAt + 2 * MIN + 300 + 5 * MIN, { handled, keep: "s2" })).toEqual(["s1"]);
  });

  it("does not hide a session the reader removed and brought back by hand either", () => {
    // Remove from board, then the session list: same rule, though the hide was
    // the reader's own and the turn was never marked.
    const state = board();
    const handled = markBroughtBack(new Map(), new Set(["s1"]), new Set(), state.agents.values());
    expect(handled.get("s1")).toBe(T + 300);
    expect(due(state, T + 60 * MIN, { handled, keep: "s2" })).toEqual([]);
  });

  it("is the same map when nothing came back", () => {
    const handled = new Map([["s1", T + 300]]);
    expect(markBroughtBack(handled, new Set(["s1"]), new Set(["s1"]), board().agents.values())).toBe(handled);
  });
});

describe("what is kept", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function storage() {
    const values = new Map<string, string>();
    const listeners = new Map<string, (event: StorageEvent) => void>();
    vi.stubGlobal("window", {
      localStorage: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) },
      addEventListener: (type: string, fn: (event: StorageEvent) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    return { values, listeners };
  }

  it("keeps the delay, offers only its five choices, and tells every reader", () => {
    const { values, listeners } = storage();
    const heard = vi.fn();
    const stop = subscribeHideFinishedAfter(heard);
    setHideFinishedAfter(15);
    expect(values.get(HIDE_FINISHED_KEY)).toBe("15");
    expect(hideFinishedAfter()).toBe(15);
    expect(heard).toHaveBeenCalledTimes(1);
    // Another tab picked 30.
    listeners.get("storage")?.({ key: HIDE_FINISHED_KEY, newValue: "30" } as StorageEvent);
    expect(hideFinishedAfter()).toBe(30);
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    setHideFinishedAfter(0);
    expect(HIDE_FINISHED_CHOICES).toEqual([0, 5, 15, 30, 60]);
    for (const junk of ["7", "-5", "abc", "", "1e9"]) expect(resolveHideFinishedAfter(junk), junk).toBe(0);
    expect(HIDE_FINISHED_CHOICES.map(hideFinishedLabel)).toEqual(["Never", "5 min", "15 min", "30 min", "60 min"]);
  });

  it("keeps the turns already acted on across a reload, the newest few hundred", () => {
    const { values } = storage();
    const handled = new Map(Array.from({ length: HANDLED_TURNS_CAP + 20 }, (_, i) => [`s${i}`, T + i] as [string, number]));
    saveHandledTurns(window.localStorage, handled);
    const back = readHandledTurns(window.localStorage);
    expect(back.size).toBe(HANDLED_TURNS_CAP);
    expect(back.has(`s${HANDLED_TURNS_CAP + 19}`)).toBe(true);
    expect(back.has("s0")).toBe(false);
    values.set(HANDLED_TURNS_KEY, "not json");
    expect(readHandledTurns(window.localStorage).size).toBe(0);
  });
});

describe("the setting and its wiring", () => {
  it("is a labelled picker with a note, in Settings › General", () => {
    const html = renderToStaticMarkup(createElement(BoardSection));
    expect(html).toContain(HIDE_FINISHED_LABEL);
    expect(html).toContain('aria-labelledby="settings-hide-finished-label"');
    expect(html).toContain('aria-describedby="settings-hide-finished-note"');
    expect(html.match(/<option/g)).toHaveLength(5);
    expect(clientText("components/SettingsModal.tsx")).toMatch(/<BoardSection \/>/);
  });

  it("waits for the history before it hides anything, and spares the selected card and the stage's session", () => {
    const app = clientText("App.tsx");
    expect(app).toMatch(/useHideFinished\(\{[\s\S]*?ready: historyReplayed/);
    expect(app).toMatch(/keepSessionId: primarySelectedId/);
    expect(app).toMatch(/stageSessionId: stage\.enabled && stage\.shell\.phase !== "closed" \? targetSession\(stage\.shell\.target\)/);
    expect(app.indexOf("useHideFinished({"), "after the stage it reads").toBeGreaterThan(app.indexOf("const stage = useStage("));
  });
});
