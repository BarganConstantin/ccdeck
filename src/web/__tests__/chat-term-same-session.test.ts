// Chat and Term in one pane are one conversation. Claude Code's /clear goes
// on in the same terminal under a NEW session id (a SessionEnd with reason
// "clear", then a SessionStart with source "clear", from the same process),
// and the deck's own pane keeps the id it launched the agent under
// (terminal-target.mjs deckTarget). So a pane opened on the cleared session
// attached a terminal that now draws the new conversation, while Chat read
// the old one's transcript: an earlier reply under Term's newer output.
//
// The pane follows the terminal: the board pairs the two ends of a /clear
// (cleared-session.ts) and terminalSessionId answers the conversation the
// terminal holds now, so the stage's subject and Chat's session are one id.
import { describe, expect, it } from "vitest";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookPayload } from "../types";
import { terminalSessionId } from "../canvas-session";
import { CLEAR_PAIR_MS, clearedInto } from "../cleared-session";
import { stageShowFor } from "../components/terminal/stage-board";
import { subjectKey } from "../use-terminal-session";
import { subjectOf } from "../components/terminal/TerminalStage";
import { chatSessionFor } from "../use-session-transcript";
import { paneWith, tabWith, type SplitState } from "../workspace-split";

const X = "0f3c2a10-7b6e-4c1d-9a2b-000000000a01";
const Y = "0f3c2a10-7b6e-4c1d-9a2b-000000000b02";
const Z = "0f3c2a10-7b6e-4c1d-9a2b-000000000c03";
const W = "0f3c2a10-7b6e-4c1d-9a2b-000000000d04";
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
const end = (id: string, reason: string): HookPayload => ({ hook_event_name: "SessionEnd", session_id: id, reason });

/** X typed into, then /clear: X ends, Y begins in the same terminal. */
const cleared = (): Array<[number, HookPayload]> => [
  [T0, start(X)], [T0 + 1000, prompt(X)],
  [T0 + 60_000, end(X, "clear")], [T0 + 60_040, start(Y, "clear")],
];

describe("a /clear in the pane's terminal", () => {
  it("is paired: the cleared session's terminal is the new one's", () => {
    const state = board(cleared());
    expect(clearedInto(state.agents, X)).toBe(Y);
    expect(terminalSessionId(state.agents, X)).toBe(Y);
    // Y is nobody's continuation but its own.
    expect(terminalSessionId(state.agents, Y)).toBe(Y);
  });

  it("puts the pane opened on the cleared session on the new conversation, Term and Chat alike", () => {
    const state = board(cleared());
    const show = stageShowFor({ kind: "session", id: X }, state.agents, T0 + 61_000);
    expect(show.kind).toBe("session");
    if (show.kind !== "session") return;
    expect(show.session.ref.sessionId).toBe(Y);
    // The terminal the stage attaches and the transcript Chat reads name one session.
    expect(subjectKey(subjectOf(show))).toBe(`session:${chatSessionFor(true, show.session.ref)}`);
  });

  it("follows a second /clear on to the third conversation", () => {
    const state = board([...cleared(), [T0 + 90_000, prompt(Y)], [T0 + 120_000, end(Y, "clear")], [T0 + 120_030, start(Z, "clear")]]);
    expect(terminalSessionId(state.agents, X)).toBe(Z);
  });

  it("holds when the two ends arrive the other way round, as fire-and-forget hooks may", () => {
    const state = board([[T0, start(X)], [T0 + 1000, prompt(X)], [T0 + 60_000, start(Y, "clear")], [T0 + 60_020, end(X, "clear")]]);
    expect(terminalSessionId(state.agents, X)).toBe(Y);
  });
});

describe("what is not a /clear of this terminal", () => {
  it("an ending for another reason", () => {
    const state = board([[T0, start(X)], [T0 + 60_000, end(X, "prompt_input_exit")], [T0 + 60_040, start(Y, "startup")]]);
    expect(terminalSessionId(state.agents, X)).toBe(X);
  });

  it("a cleared session in another folder", () => {
    const state = board([[T0, start(X)], [T0 + 60_000, end(X, "clear")], [T0 + 60_040, start(Y, "clear", "/w/other")]]);
    expect(terminalSessionId(state.agents, X)).toBe(X);
  });

  it("a new conversation that began too long after the clear", () => {
    const state = board([[T0, start(X)], [T0 + 60_000, end(X, "clear")], [T0 + 60_000 + CLEAR_PAIR_MS + 1, start(Y, "clear")]]);
    expect(terminalSessionId(state.agents, X)).toBe(X);
  });

  it("two sessions cleared in one folder at once: not guessed", () => {
    const state = board([
      [T0, start(X)], [T0 + 10, start(W)],
      [T0 + 60_000, end(X, "clear")], [T0 + 60_010, end(W, "clear")],
      [T0 + 60_030, start(Y, "clear")], [T0 + 60_040, start(Z, "clear")],
    ]);
    expect(terminalSessionId(state.agents, X)).toBe(X);
    expect(terminalSessionId(state.agents, W)).toBe(W);
  });

  it("a cleared session that was opened again since (Reopen here, --resume)", () => {
    const state = board([...cleared(), [T0 + 200_000, start(X, "resume")]]);
    expect(terminalSessionId(state.agents, X)).toBe(X);
    // ...and it ends again later for its own reason: still its own terminal.
    const later = board([...cleared(), [T0 + 200_000, start(X, "resume")], [T0 + 300_000, end(X, "prompt_input_exit")]]);
    expect(terminalSessionId(later.agents, X)).toBe(X);
  });
});

describe("the pane's tab", () => {
  it("is found for the new conversation, so opening it never adds a second tab on the same terminal", () => {
    const state = board(cleared());
    const split: SplitState = { root: { kind: "leaf", id: "p1" }, focused: "p1", targets: {}, tabs: { p1: [{ kind: "session", id: X }] }, max: null } as unknown as SplitState;
    expect(tabWith(split, Y, { kind: "session", id: X }), "by its own id alone, the tab is not found").toBeNull();
    const found = tabWith(split, Y, { kind: "session", id: X }, undefined, id => terminalSessionId(state.agents, id));
    expect(found).toEqual({ pane: "p1", target: { kind: "session", id: X } });
    // A drop of the new conversation beside or onto a pane finds that tab too.
    expect(paneWith(split, Y, { kind: "session", id: X })).toBeNull();
    expect(paneWith(split, Y, { kind: "session", id: X }, undefined, id => terminalSessionId(state.agents, id))).toBe("p1");
  });
});
