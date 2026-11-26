// The session list follows the pane through a /clear.
//
// Claude Code's /clear goes on in the same terminal under a NEW session id,
// and the pane goes on with it (cleared-session.ts, terminalSessionId): Term
// and Chat draw the new conversation. The pane's tab keeps the id it was
// opened on, on purpose (use-stage.ts splitOutTab), and the list read that id:
// its highlight, the pane's number and the active mark stayed on the row of
// the session that ended, and the new conversation's finished turn could
// read as unseen though it was on screen.
//
// Now the list names the session the tab draws: the pane links are keyed by
// it, the selection follows each /clear once (and never off a session the
// reader picked since), and what is on screen counts as watched.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SessionList, { buildRows } from "../components/SessionList";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookPayload } from "../types";
import { terminalSessionId } from "../canvas-session";
import { selectionAfterClear, type PaneShows } from "../cleared-session";
import { sessionsOf } from "../use-mark-seen";
import { sessionPaneLinks, type SplitState } from "../workspace-split";
import type { StageTarget } from "../stage-shell";

const X = "0f3c2a10-7b6e-4c1d-9a2b-000000000a01";
const Y = "0f3c2a10-7b6e-4c1d-9a2b-000000000b02";
const Z = "0f3c2a10-7b6e-4c1d-9a2b-000000000c03";
const B = "0f3c2a10-7b6e-4c1d-9a2b-000000000e05";
const CWD = "/w/paycore";
const T0 = 1_800_000_000_000;

function board(events: Array<[number, HookPayload]>): GraphState {
  let state = initialState();
  events.forEach(([at, payload], i) => {
    state = applyEvent(state, { seq: i + 1, receivedAt: at, source: "hook", payload: { provider: "claude", cwd: CWD, ...payload } });
  });
  return state;
}

const start = (id: string, source = "startup", cwd = CWD): HookPayload => ({ hook_event_name: "SessionStart", session_id: id, source, cwd });
const prompt = (id: string): HookPayload => ({ hook_event_name: "UserPromptSubmit", session_id: id, prompt: "go on" });
const stop = (id: string): HookPayload => ({ hook_event_name: "Stop", session_id: id });
const end = (id: string, reason: string): HookPayload => ({ hook_event_name: "SessionEnd", session_id: id, reason });

/** X and B at work in two folders; then /clear in X's terminal: X ends, Y
 *  begins there and finishes a turn. */
const cleared = (): Array<[number, HookPayload]> => [
  [T0, start(X)], [T0 + 1000, prompt(X)], [T0 + 2000, start(B, "startup", "/w/shop")], [T0 + 3000, prompt(B)],
  [T0 + 60_000, end(X, "clear")], [T0 + 60_040, start(Y, "clear")], [T0 + 61_000, prompt(Y)], [T0 + 70_000, stop(Y)],
];

const S = (id: string): StageTarget => ({ kind: "session", id });
/** Two panes side by side: p1 holds `left`, p2 holds B. p1 has the keys. */
const two = (left: StageTarget[], shown: StageTarget): SplitState => ({
  root: { kind: "split", dir: "row", ratio: 0.5, a: { kind: "leaf", id: "p1" }, b: { kind: "leaf", id: "p2" } },
  targets: { p1: shown, p2: S(B) }, focused: "p1", max: null, next: 3, tabs: { p1: left, p2: [S(B)] },
});

describe("the pane links (number and active mark)", () => {
  it("go on the row of the session the tab draws after a /clear, not the one that ended", () => {
    const state = board(cleared());
    const shows = (id: string) => terminalSessionId(state.agents, id);
    const split = two([S(X)], S(X));
    expect(Object.fromEntries(sessionPaneLinks(split, S(X))), "by the tab's own id: the ended row").toEqual({
      [X]: { number: 1, active: true }, [B]: { number: 2, active: false },
    });
    expect(Object.fromEntries(sessionPaneLinks(split, S(X), undefined, shows))).toEqual({
      [Y]: { number: 1, active: true }, [B]: { number: 2, active: false },
    });
  });

  it("keep a cleared tab the pane does not show at its pane's number, not active", () => {
    const state = board([...cleared(), [T0 + 80_000, start(Z, "startup", "/w/docs")]]);
    const links = sessionPaneLinks(two([S(X), S(Z)], S(Z)), S(Z), undefined, id => terminalSessionId(state.agents, id));
    expect(links.get(Y)).toEqual({ number: 1, active: false });
    expect(links.get(Z)).toEqual({ number: 1, active: true });
    expect(links.has(X)).toBe(false);
  });

  it("follow a second /clear on to the third conversation", () => {
    const state = board([...cleared(), [T0 + 120_000, end(Y, "clear")], [T0 + 120_030, start(Z, "clear")]]);
    const links = sessionPaneLinks(two([S(X)], S(X)), S(X), undefined, id => terminalSessionId(state.agents, id));
    expect([...links.keys()].sort()).toEqual([Z, B].sort());
  });

  it("light the new conversation's row in the list, and leave the ended one's plain", () => {
    const state = board(cleared());
    const openPanes = sessionPaneLinks(two([S(X)], S(X)), S(X), undefined, id => terminalSessionId(state.agents, id));
    const html = renderToStaticMarkup(createElement(SessionList, {
      state, now: T0 + 71_000, selectedIds: new Set([Y]), onSelect: () => {}, onClose: () => {}, openPanes,
    }));
    const row = (id: string) => html.match(new RegExp(`<button\\b[^>]*data-session="${id}"[^>]*>`))?.[0] ?? "";
    expect(row(Y)).toMatch(/class="sl-row selected"/);
    expect(row(Y)).toContain("data-pane-active=\"true\"");
    expect(row(Y)).toContain("Active pane 1");
    expect(row(X), "the ended session keeps its row").toContain(`data-session="${X}"`);
    expect(row(X)).not.toContain("selected");
    expect(row(X)).not.toContain("data-pane-active");
    expect(row(X)).not.toContain("pane 1");
    expect(row(B)).toContain("Pane 2");
  });
});

describe("the selection after a /clear in the tab on show", () => {
  const state = board(cleared());
  const was: PaneShows = { tab: X, session: X };
  const now: PaneShows = { tab: X, session: terminalSessionId(state.agents, X) };

  it("moves from the ended session to the new one", () => {
    expect(now.session).toBe(Y);
    expect(selectionAfterClear(state.agents, was, now, X)).toBe(Y);
  });

  it("moves once: the next render, with the same tab on the same session, leaves it", () => {
    expect(selectionAfterClear(state.agents, now, now, Y)).toBeNull();
    expect(selectionAfterClear(state.agents, now, now, X), "nor brings the old one back to the new").toBeNull();
  });

  it("never takes a selection the reader moved to another session", () => {
    expect(selectionAfterClear(state.agents, was, now, B)).toBeNull();
  });

  it("follows from a card of the ended session too: a subagent's card is its session's", () => {
    const withCard = new Map(state.agents);
    withCard.set(`${X}::helper`, { ...state.agents.get(X)!, id: `${X}::helper`, kind: "subagent", sessionId: X });
    expect(selectionAfterClear(withCard, was, now, `${X}::helper`)).toBe(Y);
  });

  it("is not a /clear when the pane moved to another tab, or had none to show", () => {
    expect(selectionAfterClear(state.agents, { tab: B, session: B }, now, B)).toBeNull();
    expect(selectionAfterClear(state.agents, null, now, X)).toBeNull();
    expect(selectionAfterClear(state.agents, was, null, X)).toBeNull();
    expect(selectionAfterClear(state.agents, was, now, null), "nothing selected: nothing to move").toBeNull();
  });

  it("goes on through a second /clear, from the session the first one followed to", () => {
    const later = board([...cleared(), [T0 + 120_000, end(Y, "clear")], [T0 + 120_030, start(Z, "clear")]]);
    expect(selectionAfterClear(later.agents, now, { tab: X, session: terminalSessionId(later.agents, X) }, Y)).toBe(Z);
  });
});

describe("what is on screen after a /clear", () => {
  it("is the new conversation: its finished turn is watched, not unseen", () => {
    const state = board(cleared());
    const at = T0 + 71_000;
    const rowY = (watching: Set<string>) => buildRows(state, at, watching).find(r => r.sessionId === Y);
    expect(rowY(sessionsOf(state, [X]))?.unseen, "by the tab's own id alone").toBe(true);
    expect(rowY(sessionsOf(state, [X, terminalSessionId(state.agents, X)]))?.unseen).toBe(false);
  });
});
