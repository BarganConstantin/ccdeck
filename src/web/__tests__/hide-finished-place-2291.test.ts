// A session that Hide finished sessions took off the board comes back to where
// it stood (#2291).
//
// "When an agent keeps creating new subagents and auto hide is on, the latest
// agents keep appearing further below." The hide forgot the root's place, so the
// root came back as an arrival and the gap pass gave it the foot of a column:
// three sessions that finished and resumed six times walked from y≈480 to
// y≈8,200. A session whose agent started its next turn on its own brought the
// hidden turn's subagents back with it, and its new ones were put under them,
// a round further down each time.
//
// Driven through snapshotToFlow with the real reducer, the real hide rule and
// the call-back the board runs, in the order App runs them.
import { describe, expect, it } from "vitest";
import type { Node } from "reactflow";
import { snapshotToFlow } from "../canvas-flow";
import { markBroughtBack, retireHiddenTurns, sessionsToHide } from "../hide-finished";
import { footprint, NODE_H, NODE_W } from "../layout-geometry";
import { layoutSignature } from "../layout-signature";
import { applyEvent, initialState, type GraphState } from "../reducer";
import { removalHiddenIds, removalsLiftedByWork, removalTimes } from "../remove-node";
import { sendSessionsHome } from "../return-home";
import { computeVisibleIds, EXIT_ANIM_MS } from "../visibility";
import type { Provisional } from "../placement";
import type { HookEnvelope, HookPayload } from "../types";
import { clientText } from "./client-source";

interface Point { x: number; y: number }
const T0 = 1_700_000_000_000;
const MIN = 60_000;

/** A deck: the reducer's board, the maps App keeps across frames, and the hide
 *  with its way back. */
function deck() {
  let state = initialState();
  let seq = 0;
  let clock = T0;
  const positions = new Map<string, Point>();
  const provisional: Provisional = new Set();
  const pinned = new Map<string, Point>();
  const measured = new Map<string, { width: number; height: number }>();
  const prevSessionSize = new Map<string, { w: number; h: number }>();
  const sigRef = { current: "" };
  let removed = new Set<string>();
  let since: ReadonlyMap<string, number> = new Map();
  let handled: ReadonlyMap<string, number> = new Map();
  const returning = new Set<string>();

  const send = (sid: string, payload: HookPayload, dt = 1_000) => {
    clock += dt;
    state = applyEvent(state, { seq: ++seq, receivedAt: clock, source: "hook", payload: { session_id: sid, ...payload } } as HookEnvelope);
  };
  const visible = (now: number) => {
    const hidden = removalHiddenIds(state.agents.values(), removed);
    const ids = computeVisibleIds(state, now);
    for (const id of hidden) ids.delete(id);
    return { ids, hidden };
  };
  /** One frame, twice: the second after React Flow measured what the first drew. */
  const frame = () => {
    // App's call-backs first, in its order: the hidden turn's subagents retired
    // (use-hide-finished.ts), then whatever works again brought back.
    retireHiddenTurns(state, handled);
    since = removalTimes(since, removed, clock);
    const lifted = removalsLiftedByWork(state.agents, removalHiddenIds(state.agents.values(), removed), removed, since);
    if (lifted.length > 0) bringBack(lifted);
    let nodes: Node[] = [];
    for (let i = 0; i < 2; i++) {
      const now = clock + EXIT_ANIM_MS + 1;
      const { ids, hidden } = visible(now);
      nodes = snapshotToFlow(
        state, now, 1400, 800, pinned, measured, prevSessionSize, () => {}, true, false,
        positions, provisional, layoutSignature(state.agents.values(), now, hidden, measured.size, 0), sigRef,
        new Set(), null, ids, () => {}, true, new Set(), returning,
      ).nodes;
      for (const id of positions.keys()) if (!measured.has(id)) measured.set(id, { width: NODE_W, height: NODE_H });
    }
    return nodes;
  };
  /** use-removals.ts's bringBack: what leaves the set is marked as coming back. */
  const bringBack = (ids: string[]) => {
    const before = removed;
    removed = new Set([...removed].filter(id => !ids.includes(id)));
    for (const id of ids) if (before.has(id)) returning.add(id);
    handled = markBroughtBack(handled, before, removed, state.agents.values());
  };
  /** The hide's look over the board, `minutes` after it went quiet. */
  const hideAfter = (minutes: number) => {
    clock += minutes * MIN;
    const due = sessionsToHide(state.agents.values(), { afterMs: 5 * MIN, now: clock, removed, handled });
    const next = new Map(handled);
    for (const { id, endedAt } of due) { next.set(id, endedAt); removed.add(id); }
    handled = next;
    removed = new Set(removed);
    frame();
    return due.map(d => d.id);
  };
  const spawn = (sid: string, agent: string) => {
    send(sid, { hook_event_name: "PreToolUse", tool_name: "Task", tool_use_id: `task-${agent}`, tool_input: { description: "look", subagent_type: "Explore" } });
    send(sid, { hook_event_name: "SubagentStart", agent_id: agent, agent_type: "Explore" } as HookPayload);
    frame();
    send(sid, { hook_event_name: "PreToolUse", agent_id: agent, tool_name: "Read", tool_use_id: `r-${agent}` } as HookPayload);
    send(sid, { hook_event_name: "PostToolUse", agent_id: agent, tool_name: "Read", tool_use_id: `r-${agent}`, tool_response: {} } as HookPayload);
    send(sid, { hook_event_name: "SubagentStop", agent_id: agent, agent_type: "Explore" } as HookPayload);
    send(sid, { hook_event_name: "PostToolUse", tool_name: "Task", tool_use_id: `task-${agent}`, tool_response: {} });
    frame();
  };
  const subagent = (sid: string, agent: string) =>
    [...state.agents.values()].find(a => a.sessionId === sid && a.kind === "subagent" && a.id.endsWith(agent))!.id;
  return {
    send, frame, hideAfter, spawn, subagent, bringBack, positions, pinned, measured,
    get state() { return state; }, get removed() { return removed; }, get handled() { return handled; },
    shown: () => visible(clock + EXIT_ANIM_MS + 1).ids,
  };
}

const at = (positions: Map<string, Point>, id: string) => ({ ...positions.get(id)! });

describe("a session auto hide took off the board", () => {
  it("comes back on its next prompt to where it stood, and the board does not walk down", () => {
    const d = deck();
    const sessions = ["s1", "s2", "s3"];
    for (const s of sessions) d.send(s, { hook_event_name: "SessionStart", cwd: `/repo/${s}` });
    d.frame();
    const first = new Map<string, Point>();
    for (let round = 0; round < 6; round++) {
      for (const s of sessions) {
        d.send(s, { hook_event_name: "UserPromptSubmit", prompt: `round ${round}` });
        d.frame();
        d.spawn(s, `${s}-${round}-a`);
        d.spawn(s, `${s}-${round}-b`);
        d.send(s, { hook_event_name: "Stop" });
        d.frame();
        // The next session's round starts two minutes on: the one before it is
        // hidden part way through somebody else's turn.
        d.hideAfter(2);
      }
      for (const s of sessions) {
        if (round === 0) first.set(s, at(d.positions, s));
        // Before the fix each round put every root ~1,450 further down.
        else expect(Math.abs(d.positions.get(s)!.y - first.get(s)!.y), `${s} round ${round}`).toBeLessThan(NODE_H);
      }
    }
    expect(d.handled.size).toBeGreaterThan(0);
  });

  it("starting its next turn on its own, leaves the hidden turn's subagents behind and spawns beside its root", () => {
    const d = deck();
    d.send("s1", { hook_event_name: "SessionStart", cwd: "/repo" });
    d.send("s2", { hook_event_name: "SessionStart", cwd: "/other" });
    d.send("s2", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    d.send("s1", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    d.frame();
    let root: Point | null = null;
    let column: number[] = [];
    for (let round = 0; round < 4; round++) {
      if (round > 0) {
        // No prompt: a background task finished, or a scheduled run started.
        d.send("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: `resume-${round}`, tool_input: { command: "ls" } });
        d.frame();
        expect(d.removed.has("s1"), `round ${round}`).toBe(false);
      }
      const ids = ["a", "b", "c"].map(k => { d.spawn("s1", `r${round}-${k}`); return d.subagent("s1", `r${round}-${k}`); });
      const ys = ids.map(id => d.positions.get(id)!.y - d.positions.get("s1")!.y);
      if (round === 0) { root = at(d.positions, "s1"); column = ys; }
      else {
        expect(d.positions.get("s1"), `root, round ${round}`).toEqual(root);
        // Was 600, 1,200 and 1,800 further down than round 0's.
        for (const [k, y] of ys.entries()) expect(Math.abs(y - column[k]), `subagent ${k}, round ${round}`).toBeLessThan(NODE_H);
        // And the earlier rounds' cards are gone from the board, as a prompt
        // would have retired them.
        const shown = d.shown();
        for (let r = 0; r < round; r++) for (const k of ["a", "b", "c"]) expect(shown.has(d.subagent("s1", `r${r}-${k}`))).toBe(false);
      }
      d.send("s1", { hook_event_name: "Stop" });
      d.frame();
      expect(d.hideAfter(6), `round ${round}`).toContain("s1");
    }
  });

  it("arrives whole somewhere clear when another session took its ground while it was away", () => {
    const d = deck();
    d.send("s1", { hook_event_name: "SessionStart", cwd: "/repo" });
    d.send("s2", { hook_event_name: "SessionStart", cwd: "/other" });
    d.send("s2", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    d.send("s1", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    d.frame();
    for (const k of ["a", "b"]) d.spawn("s1", k);
    d.send("s1", { hook_event_name: "Stop" });
    d.frame();
    const home = at(d.positions, "s1");
    expect(d.hideAfter(6)).toContain("s1");
    // A session arrives while s1 is away, and the gap pass gives it s1's ground.
    d.send("s3", { hook_event_name: "SessionStart", cwd: "/third" });
    d.frame();
    d.positions.set("s3", { ...home });
    const s3 = at(d.positions, "s3");

    // Brought back by hand, from the session list: its subagents come with it.
    d.bringBack(["s1"]);
    const nodes = d.frame();
    expect(d.positions.get("s3")).toEqual(s3);
    const cards = nodes.filter(n => n.type !== "recapNote");
    const of = (sid: string) => cards.filter(n => (n.data as { sessionId: string }).sessionId === sid);
    expect(of("s1")).toHaveLength(3);
    const box = (n: Node) => ({ ...n.position, ...footprint(n.id, d.measured) });
    for (const a of of("s1").map(box)) {
      for (const b of of("s3").map(box)) {
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
    }
    // Whole: its subagents still stand to the right of its root, beside it.
    const root = d.positions.get("s1")!;
    for (const k of ["a", "b"]) {
      const p = d.positions.get(d.subagent("s1", k))!;
      expect(p.x).toBeGreaterThan(root.x);
      expect(Math.abs(p.y - root.y)).toBeLessThan(4 * NODE_H);
    }
  });
});

describe("retireHiddenTurns", () => {
  /** s1: a turn with two subagents, ended and hidden at `turn`. */
  function hidden() {
    let state = initialState();
    let seq = 0;
    let clock = T0;
    const send = (payload: HookPayload) => {
      clock += 1_000;
      state = applyEvent(state, { seq: ++seq, receivedAt: clock, source: "hook", payload: { session_id: "s1", ...payload } } as HookEnvelope);
    };
    send({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    for (const k of ["a", "b"]) {
      send({ hook_event_name: "SubagentStart", agent_id: k, agent_type: "Explore" } as HookPayload);
      send({ hook_event_name: "SubagentStop", agent_id: k, agent_type: "Explore" } as HookPayload);
    }
    send({ hook_event_name: "Stop" });
    const turn = clock;
    return { get state() { return state; }, send, turn, later: () => { clock += 10 * MIN; } };
  }
  const exits = (state: GraphState) => [...state.agents.values()].filter(a => a.kind === "subagent").map(a => a.exitAt);

  it("retires the hidden turn's finished subagents once the session works again, at the end of that turn", () => {
    const h = hidden();
    h.later();
    h.send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "ls" } });
    const revision = h.state.revision;
    expect(retireHiddenTurns(h.state, new Map([["s1", h.turn]]))).toBe(true);
    expect(exits(h.state)).toEqual([h.turn, h.turn]);
    expect(h.state.revision).toBe(revision + 1);
    // Gone at once, not fading over the subagent the work is about to spawn.
    expect([...computeVisibleIds(h.state, h.turn + 10 * MIN)].filter(id => id !== "s1")).toEqual([]);
    expect(retireHiddenTurns(h.state, new Map([["s1", h.turn]]))).toBe(false);
  });

  it("leaves them while the session has not worked since — one brought back by hand shows that turn as it was", () => {
    const h = hidden();
    expect(retireHiddenTurns(h.state, new Map([["s1", h.turn]]))).toBe(false);
    expect(exits(h.state)).toEqual([undefined, undefined]);
  });

  it("leaves a session it was never told about, and a subagent of the new turn", () => {
    const h = hidden();
    h.later();
    h.send({ hook_event_name: "SubagentStart", agent_id: "c", agent_type: "Explore" } as HookPayload);
    expect(retireHiddenTurns(h.state, new Map())).toBe(false);
    expect(retireHiddenTurns(h.state, new Map([["other", h.turn]]))).toBe(false);
    expect(retireHiddenTurns(h.state, new Map([["s1", h.turn]]))).toBe(true);
    const c = [...h.state.agents.values()].find(a => a.id.endsWith("c"))!;
    expect(c.state).toBe("active");
    expect(c.exitAt).toBeUndefined();
  });
});

describe("sendSessionsHome", () => {
  const card = (id: string, sessionId: string, x: number, y: number): Node =>
    ({ id, type: "agent", position: { x, y }, data: { sessionId } }) as Node;

  it("keeps a mark until the session's cards are drawn, and spends it then", () => {
    const positions = new Map([["s1", { x: 0, y: 0 }]]);
    const returning = new Set(["s1"]);
    expect(sendSessionsHome([], positions, new Set(), new Map(), new Map(), undefined, returning)).toEqual([]);
    expect(returning.has("s1")).toBe(true);
    expect(sendSessionsHome([card("s1", "s1", 0, 0)], positions, new Set(), new Map(), new Map(), undefined, returning)).toEqual([]);
    expect(returning.size).toBe(0);
    expect(positions.get("s1")).toEqual({ x: 0, y: 0 });
  });

  it("forgets the places of a session whose ground is covered, all but a pinned card's", () => {
    const positions = new Map([["s1", { x: 0, y: 0 }], ["s1::a", { x: 400, y: 0 }], ["s2", { x: 20, y: 30 }]]);
    const pinned = new Map([["s1::a", { x: 400, y: 0 }]]);
    const nodes = [card("s1", "s1", 0, 0), card("s1::a", "s1", 400, 0), card("s2", "s2", 20, 30)];
    expect(sendSessionsHome(nodes, positions, new Set(), pinned, new Map(), undefined, new Set(["s1"]))).toEqual(["s1"]);
    expect(positions.has("s1")).toBe(false);
    expect(pinned.get("s1::a")).toEqual({ x: 400, y: 0 });
    expect(positions.get("s2")).toEqual({ x: 20, y: 30 });
  });
});

describe("the wiring", () => {
  it("keeps a hidden session's place, and marks what comes back", () => {
    const removals = clientText("use-removals.ts");
    const hide = /const hideSessions = useCallback\([\s\S]*?\}, \[\]\);/.exec(removals)?.[0] ?? "";
    expect(hide).not.toBe("");
    expect(hide).not.toMatch(/positionsRef\.current\.delete|pinnedRef\.current\.delete/);
    expect(removals).toMatch(/returningRef\.current\.add\(id\)/);
    expect(clientText("use-board-graph.ts")).toMatch(/restoredLayout\.restored, returningRef\.current,/);
  });

  it("retires the hidden turn ahead of the call-backs that bring a session back", () => {
    const app = clientText("App.tsx");
    const hide = app.indexOf("useHideFinished({");
    const callBacks = app.indexOf("useRemovalCallBacks({");
    expect(hide).toBeGreaterThan(-1);
    expect(callBacks).toBeGreaterThan(hide);
    expect(clientText("use-hide-finished.ts")).toMatch(/if \(ready\) retireHiddenTurns\(stateRef\.current, handledRef\.current\);/);
  });
});
