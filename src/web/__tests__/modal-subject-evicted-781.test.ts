// A modal whose subject has been evicted took every keyboard shortcut with it.
//
// #781. `modalOpenRef` is computed from the ID a modal was opened for, not from
// what actually rendered:
//
//     modalOpenRef.current = openedTool != null || usageHistoryOpen
//       || contextFor != null || summaryFor != null || …
//
// while both of those modals render nothing once their subject is gone — the
// context modal on `if (!root) return null`, and SessionSummary on the same
// `state.agents.get(sessionId)` inside `buildSummary`. `contextFor` is only ever
// cleared by the dialog's own `onClose`, which lives on the dialog that no
// longer exists.
//
// So: open the context donut on a card, leave it open, let the session finish.
// `pruneDoneSessions` evicts it about two minutes later — or another deck
// presses Clear and a `__clear` empties the map — the dialog silently vanishes,
// and from then on Space, C, R, F, L, H, U, A, J, K, T and M all do nothing,
// and so does the trash button. Only a reload recovers it.
//
// THE FIX IS TO CLOSE, NOT TO RECOUNT. Making the flag agree with the render
// would leave an invisible modal "open" forever; a modal whose subject has been
// evicted has nothing left to show and should go. It is cleared in the same
// 250ms tick that already prunes the selection for the same reason (#576), and
// for the same stated reason it runs unconditionally: a `__clear` arriving over
// SSE empties the map through `applyEvent`, which that tick never hears about.
//
// These cases drive the two rules the fix rests on — the predicate, and the
// blocking it prevents — plus the source shape, because the bug was in WHERE
// the state was cleared and no behavioural test in a DOM-less suite can see a
// React state setter fire.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyEvent, initialState, pruneDoneSessions, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

let seq = 0;
function send(state: GraphState, session: string, payload: HookPayload, at?: number): GraphState {
  seq++;
  return applyEvent(state, {
    seq, receivedAt: at ?? 1_000 + seq, source: "hook",
    payload: { session_id: session, cwd: "/w/paycore", ...payload },
  } as HookEnvelope);
}

/** A session that ran a tool and then stopped, so the pruner can take it. */
function finishedSession(id: string, at: number): GraphState {
  let st: GraphState = initialState();
  st = send(st, id, { hook_event_name: "SessionStart" } as HookPayload, at);
  st = send(st, id, { hook_event_name: "Stop" } as HookPayload, at + 1);
  return st;
}

describe("the state a modal is opened for", () => {
  it("stops resolving the moment the pruner takes the session", () => {
    // The premise. Both modals resolve their subject through `agents.get`, so
    // this one call is what decides whether either can render.
    const st = finishedSession("s1", 1_000);
    expect(st.agents.has("s1")).toBe(true);
    // Well past DONE_SESSION_GRACE_MS, with the cap exceeded by nothing else —
    // the pruner's own arguments are the caller's, so this drives it the way
    // App.tsx's tick does.
    pruneDoneSessions(st, 1_000 + 10 * 60_000, 0, 0);
    expect(st.agents.has("s1"), "the pruner left the session on the board").toBe(false);
  });

  it("stops resolving when a clear empties the map, which no tick hears about", () => {
    const st = finishedSession("s2", 1_000);
    const cleared = send(st, "s2", { hook_event_name: "__clear" } as HookPayload);
    expect(cleared.agents.has("s2")).toBe(false);
  });
});

describe("what App.tsx does about it", () => {
  it("clears both modal ids in the tick that prunes, not only the selection", () => {
    // The selection already had this treatment (#576) and the two modals did
    // not; that asymmetry IS the bug. Pinned by shape because a DOM-less suite
    // cannot watch a setter run.
    expect(app).toContain("setContextFor(prev => (prev != null && !stateRef.current.agents.has(prev) ? null : prev));");
    expect(app).toContain("setSummaryFor(prev => (prev != null && !stateRef.current.agents.has(prev) ? null : prev));");
  });

  it("puts them beside the selection prune, so one tick owns all four", () => {
    // Not merely present — present in the right place. Somewhere else they
    // would be a second mechanism to keep in step with the pruner, and the
    // reason this tick runs its clears unconditionally (a `__clear` over SSE)
    // applies to the modals exactly as it does to the selection.
    const sel = app.indexOf("setPrimarySelectedId(prev => (prev != null");
    const ctx = app.indexOf("setContextFor(prev => (prev != null");
    const sum = app.indexOf("setSummaryFor(prev => (prev != null");
    const tickEnd = app.indexOf("if (changed) rerender();", sel);
    expect(sel).toBeGreaterThan(-1);
    expect(ctx, "setContextFor is not in the prune tick").toBeGreaterThan(sel);
    expect(sum, "setSummaryFor is not in the prune tick").toBeGreaterThan(sel);
    expect(ctx).toBeLessThan(tickEnd);
    expect(sum).toBeLessThan(tickEnd);
  });

  it("still counts them as open while they can render, which is what the flag is for", () => {
    // The other direction. The flag must keep blocking shortcuts for a modal
    // that IS on screen — "fixing" this by dropping the two ids from the
    // expression would make Escape-less dialogs swallow every key press.
    expect(app).toContain("modalOpenRef.current = openedTool != null || usageHistoryOpen || contextFor != null");
    expect(app).toContain("|| summaryFor != null || browserWatchOpen || keyHelpOpen || releaseNotes != null;");
  });
});
