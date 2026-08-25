// A selection used to be able to outlive the agent it named, and when it did,
// the whole canvas went dark. `spotlightLineage` seeded its result with the
// selected id and only THEN looked the id up, so for an id that was no longer
// in `state.agents` the ancestor walk broke on its first iteration, the
// descendant sweep matched nothing, and the function returned a one-element set
// naming a node that does not exist. That set is not empty, so the memo above
// it reported a live spotlight and handed it to the canvas, where the rule is
// `spotlitOut = lineage != null && !lineage.has(a.id)` — and no live agent is
// in a lineage whose only member is dead. Every card took `rf-spotlit-out`
// (16% opacity, desaturated, blurred), every edge was written at 0.12, and
// every tool bubble dimmed on the same set. The topbar ribbon reads the same
// dead id through the same map, so it resolved to null and vanished at the same
// moment, taking its own × with it: a deck that looked like it had faded out
// and stopped, with no selection anywhere on screen to explain it and nothing
// obvious to click to undo it.
//
// Three things can strand a selection, and this file exercises all three
// against the real reducer rather than a hand-built map, because what makes
// them worth testing is that they are the shipped eviction paths and not a
// hypothetical: `pruneDoneSessions` (the common one — the 250ms tick evicts the
// oldest finished session whole once seven are on the board), `pruneOldAgents`
// (the same thing one agent at a time at the 200-node cap), and a `__clear`
// arriving over SSE from a second tab or from `POST /api/clear`, which replaces
// the state with an empty one while the selection survives untouched.
//
// The assertions are written in terms of what the user sees rather than what
// the function returns: `dimmedBy` below is the canvas's own out-of-lineage
// rule applied to every agent in the map, so "dims nothing" is asserted as the
// empty list of dimmed cards. A lineage for an agent that does not exist is not
// a lineage; it is nothing, and nothing dims nothing.
//
// This lives in a module of its own — extracted from App.tsx for #576 — for the
// reason visibility.ts and placement.ts did: the suite renders no React, so a
// rule buried in a component file is a rule no test can ask a question of.
import { describe, it, expect } from "vitest";
import { spotlightLineage, spotlightUnion } from "../spotlight";
import { pruneSelection } from "../prune";
import {
  applyEvent, initialState, pruneDoneSessions, pruneOldAgents, type GraphState,
} from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const NOW = Date.now();
const MIN = 60_000;
const ago = (ms: number): number => NOW - ms;

let seq = 1;
function envelope(payload: HookPayload, at: number): HookEnvelope {
  return { seq: seq++, receivedAt: at, source: "hook", payload };
}

/** Root ids are the session id; subagents hang off it as `<session>::<key>`. */
const subId = (sessionId: string, i: number): string => `${sessionId}::${sessionId}-tu-${i}`;

interface SessionSpec {
  id: string;
  /** How many subagents fan out under the root. */
  subs?: number;
  /** When the root stopped. Omit to leave the whole session running. */
  endedAt?: number;
}

/** Drive a session through the real reducer, so the shapes under test are the
 *  shapes the deck actually holds — parentId links included. */
function feedSession(state: GraphState, spec: SessionSpec): GraphState {
  const { id, subs = 0, endedAt } = spec;
  const startedAt = endedAt != null ? endedAt - 10 * MIN : ago(10 * MIN);
  let s = applyEvent(state, envelope(
    { hook_event_name: "SessionStart", session_id: id, cwd: "/repo" }, startedAt,
  ));
  for (let i = 0; i < subs; i++) {
    s = applyEvent(s, envelope(
      { hook_event_name: "SubagentStart", session_id: id, parent_tool_use_id: `${id}-tu-${i}`, subagent_type: "worker" },
      startedAt + 100 + i,
    ));
    if (endedAt != null) {
      s = applyEvent(s, envelope(
        { hook_event_name: "SubagentStop", session_id: id, parent_tool_use_id: `${id}-tu-${i}` },
        endedAt - 1_000 + i,
      ));
    }
  }
  if (endedAt != null) {
    s = applyEvent(s, envelope({ hook_event_name: "Stop", session_id: id }, endedAt));
  }
  return s;
}

function build(specs: SessionSpec[]): GraphState {
  seq = 1;
  let state = initialState();
  for (const spec of specs) state = feedSession(state, spec);
  return state;
}

/** Exactly the rule snapshotToFlow applies to every card it draws, and the one
 *  ToolBursts applies to every bubble: out of a live lineage means dimmed. */
function dimmedBy(state: GraphState, lineage: Set<string> | null): string[] {
  return [...state.agents.keys()].filter(id => lineage != null && !lineage.has(id)).sort();
}

/** A board with one finished session and one still working, which is the shape
 *  every eviction path below needs: something to evict, something to survive. */
const finishedAndRunning = (): GraphState => build([
  { id: "old", subs: 2, endedAt: ago(30 * MIN) },
  { id: "live", subs: 1 },
]);

describe("spotlightLineage", () => {
  it("spotlights a selected agent, its ancestors and its descendants", () => {
    const state = build([{ id: "s1", subs: 2 }, { id: "s2", subs: 1 }]);
    const lineage = spotlightLineage(state, "s1");
    expect(lineage).not.toBeNull();
    expect([...lineage!].sort()).toEqual(["s1", subId("s1", 0), subId("s1", 1)].sort());
    // The other session is what a spotlight is for: it, and only it, dims.
    expect(dimmedBy(state, lineage)).toEqual(["s2", subId("s2", 0)].sort());
  });

  it("keeps a selected subagent's own chain alive, walking up to its root", () => {
    const state = build([{ id: "s1", subs: 2 }, { id: "s2", subs: 1 }]);
    const lineage = spotlightLineage(state, subId("s1", 0));
    expect(lineage!.has(subId("s1", 0))).toBe(true);
    expect(lineage!.has("s1")).toBe(true);
    expect(dimmedBy(state, lineage)).toEqual(["s2", subId("s2", 0)].sort());
  });

  it("returns no spotlight at all when nothing is selected", () => {
    const state = build([{ id: "s1", subs: 2 }]);
    expect(spotlightLineage(state, null)).toBeNull();
    expect(dimmedBy(state, spotlightLineage(state, null))).toEqual([]);
  });

  it("refuses to invent a lineage for an id the agent map does not hold", () => {
    const state = build([{ id: "s1", subs: 2 }]);
    const lineage = spotlightLineage(state, "s1::never-existed");
    expect(dimmedBy(state, lineage)).toEqual([]);
    expect(lineage).toBeNull();
  });

  it("dims nothing after pruneDoneSessions evicts the selected session whole", () => {
    const state = finishedAndRunning();
    const selected = "old";
    expect(state.agents.has(selected)).toBe(true);

    // Cap of zero: the one finished session on the board is over the cap and
    // out of its grace period, so the tick takes it — root and both subagents.
    expect(pruneDoneSessions(state, NOW, 0, 2 * MIN)).toBe(true);
    expect(state.agents.has(selected)).toBe(false);
    expect(state.agents.size).toBeGreaterThan(0);

    // The blackout, stated as the user saw it: not one surviving card may
    // dim for a selection that no longer names anything.
    expect(dimmedBy(state, spotlightLineage(state, selected))).toEqual([]);
    expect(spotlightLineage(state, selected)).toBeNull();
  });

  it("dims nothing after pruneOldAgents evicts the selected agent at the cap", () => {
    const state = finishedAndRunning();
    const selected = subId("old", 0);
    expect(state.agents.has(selected)).toBe(true);

    expect(pruneOldAgents(state, NOW, 1, MIN)).toBe(true);
    expect(state.agents.has(selected)).toBe(false);
    expect(state.agents.size).toBeGreaterThan(0);

    expect(dimmedBy(state, spotlightLineage(state, selected))).toEqual([]);
    expect(spotlightLineage(state, selected)).toBeNull();
  });

  it("dims nothing after a __clear arrives over SSE and empties the board", () => {
    let state = build([{ id: "s1", subs: 2 }]);
    const selected = "s1";
    // A second tab pressing Clear, or POST /api/clear: applyEvent hands back a
    // fresh empty state and the selection in App.tsx is not consulted at all.
    state = applyEvent(state, envelope({ hook_event_name: "__clear" }, NOW));
    expect(state.agents.size).toBe(0);

    expect(spotlightLineage(state, selected)).toBeNull();

    // And the sessions that arrive afterwards must draw at full strength
    // rather than inheriting the blackout.
    state = feedSession(state, { id: "s2", subs: 1 });
    expect(dimmedBy(state, spotlightLineage(state, selected))).toEqual([]);
    expect(spotlightLineage(state, selected)).toBeNull();
  });
});

describe("spotlightUnion", () => {
  it("merges the lineages of every selected agent for a multi-select", () => {
    const state = build([{ id: "s1", subs: 1 }, { id: "s2", subs: 1 }, { id: "s3", subs: 1 }]);
    const union = spotlightUnion(state, new Set(["s1", "s2"]));
    expect([...union!].sort()).toEqual(["s1", "s2", subId("s1", 0), subId("s2", 0)].sort());
    expect(dimmedBy(state, union)).toEqual(["s3", subId("s3", 0)].sort());
  });

  it("spotlights the live half of a mixed selection and dims only the rest", () => {
    const state = finishedAndRunning();
    const stranded = "old";
    expect(pruneDoneSessions(state, NOW, 0, 2 * MIN)).toBe(true);

    // One id still names an agent, the other names an evicted session. The
    // survivor must go on spotlighting exactly what it always did.
    const union = spotlightUnion(state, new Set([stranded, "live"]));
    expect([...union!].sort()).toEqual(["live", subId("live", 0)].sort());
    expect(dimmedBy(state, union)).toEqual([]);
  });

  it("gives an empty selection, and a wholly stranded one, no spotlight", () => {
    const state = finishedAndRunning();
    expect(spotlightUnion(state, new Set())).toBeNull();
    expect(spotlightUnion(state, new Set(["gone", "also-gone"]))).toBeNull();
    expect(dimmedBy(state, spotlightUnion(state, new Set(["gone"])))).toEqual([]);
  });
});

// The second half of #576: the spotlight rule above stops the blackout, but the
// selection itself was still a cache keyed by node id with no eviction rule, so
// the id sat in state naming nothing — invisible in the topbar, and ready to
// re-attach if a session evicted while still open came back under the same id.
describe("pruneSelection", () => {
  it("drops ids whose agent has been evicted and keeps the ones that remain", () => {
    const state = finishedAndRunning();
    const selected = new Set(["old", "live"]);
    pruneDoneSessions(state, NOW, 0, 2 * MIN);
    expect([...pruneSelection(selected, state.agents)]).toEqual(["live"]);
  });

  it("hands back the very same set when every selected agent is still there", () => {
    const state = build([{ id: "s1", subs: 1 }]);
    const selected = new Set(["s1", subId("s1", 0)]);
    // Identity, not equality: App.tsx feeds this to setSelectedIds as an
    // updater, and returning `prev` unchanged is what stops the 250ms tick
    // from re-rendering the canvas four times a second forever.
    expect(pruneSelection(selected, state.agents)).toBe(selected);
    expect(pruneSelection(new Set(), state.agents).size).toBe(0);
  });

  it("clears the whole selection when a __clear empties the map", () => {
    let state = build([{ id: "s1", subs: 1 }]);
    const selected = new Set(["s1"]);
    state = applyEvent(state, envelope({ hook_event_name: "__clear" }, NOW));
    // Unguarded on purpose, unlike the position and pin caches: those are
    // restored from localStorage before the log replays, so an empty map means
    // "nothing has arrived yet" for them. A selection is never restored from
    // anywhere — it takes a click on a card that exists — so an empty map here
    // can only mean every card that could have been selected is gone.
    expect(pruneSelection(selected, state.agents).size).toBe(0);
  });
});
