// The Decision card's state machine: the twelve frames as rows of a table, and
// the promises that make the card safe. Pure: no React, no DOM.
//
// THE PROMISES. Nothing is sent until the prompt is checked again and says ok.
// With no way to check (the deck wires none) a pick sends nothing. A locked row
// is read, never answered. Esc closes and never answers; in the free field it
// goes back to the choices and keeps the text. A question that changed, ended,
// is held or was answered elsewhere stays on screen until it is dismissed.
import { describe, expect, it } from "vitest";
import {
  answerCount, initialState, LOCKED_ANNOUNCE, step,
  type DecisionContext, type DecisionEffect, type DecisionEvent, type DecisionState,
} from "../components/decision/decision-machine";
import { MULTI, OUTSIDE, PERMISSION, PLAN } from "./screens-fixtures";

const ctx = (model = PERMISSION, canRecheck = true): DecisionContext => ({ model, canRecheck });

/** Play events from a state; every effect seen, in order. */
function play(start: DecisionState, events: DecisionEvent[], c: DecisionContext) {
  let state = start;
  const effects: DecisionEffect[] = [];
  for (const e of events) {
    const out = step(state, e, c);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}
const fresh = (c = ctx()) => initialState(c.model);
const types = (effects: DecisionEffect[]) => effects.map(e => e.type);

describe("the twelve frames, as state", () => {
  const rows: Array<[string, () => DecisionState, Partial<DecisionState>, string]> = [
    ["1 Default", () => fresh(), { mode: "choose", focus: null }, "none"],
    ["2 Keyboard focus", () => play(fresh(), [{ type: "move", by: 1 }], ctx()).state, { mode: "choose", focus: 0 }, "none"],
    ["3 Checking the prompt", () => play(fresh(), [{ type: "pick", index: 0 }], ctx()).state, { focus: 0 }, "checking"],
    ["4 Sent", () => play(fresh(), [{ type: "pick", index: 0 }, { type: "result", result: "ok" }], ctx()).state, { focus: 0 }, "sent"],
    ["5 The question changed", () => play(fresh(), [{ type: "pick", index: 0 }, { type: "result", result: { kind: "changed", now: "npm run lint" } }], ctx()).state, {}, "changed"],
    ["6 The session ended", () => play(fresh(), [{ type: "pick", index: 0 }, { type: "result", result: { kind: "ended" } }], ctx()).state, {}, "ended"],
    ["7 Tell Claude what to do", () => play(fresh(), [{ type: "pick", index: 2 }], ctx()).state, { mode: "free", focus: 2 }, "none"],
    ["8 Several answers", () => initialState(MULTI), { mode: "multi" }, "none"],
    ["9 Read only", () => initialState(OUTSIDE), { mode: "readOnly" }, "none"],
    ["10 Plan to approve", () => initialState(PLAN), { mode: "choose" }, "none"],
    ["11 Held", () => play(fresh(), [{ type: "pick", index: 0 }, { type: "result", result: { kind: "held" } }], ctx()).state, {}, "held"],
    ["12 Answered in the terminal", () => play(fresh(), [{ type: "elsewhere", at: "14:03" }], ctx()).state, {}, "elsewhere"],
  ];
  for (const [name, make, want, outcome] of rows) {
    it(name, () => {
      const state = make();
      expect(state).toMatchObject(want);
      expect(state.outcome.kind).toBe(outcome);
      expect(state.closed).toBe(false);
    });
  }
});

describe("nothing is sent until the prompt is checked again", () => {
  it("a pick asks for the re-read and sends nothing", () => {
    const { effects, state } = play(fresh(), [{ type: "pick", index: 0 }], ctx());
    expect(effects).toEqual([{ type: "recheck", answer: { kind: "option", index: 0 } }]);
    expect(state.outcome.kind).toBe("checking");
  });

  it("sends, and writes the record, only when the re-read says ok", () => {
    const { effects } = play(fresh(), [{ type: "pick", index: 0 }, { type: "result", result: "ok" }], ctx());
    expect(types(effects)).toEqual(["recheck", "send", "record"]);
    expect(effects[1]).toEqual({ type: "send", answer: { kind: "option", index: 0 } });
  });

  it("sends nothing when the re-read finds the question changed, ended or held", () => {
    for (const result of [{ kind: "changed", now: "x" }, { kind: "ended" }, { kind: "held" }] as const) {
      const { effects } = play(fresh(), [{ type: "pick", index: 0 }, { type: "result", result }], ctx());
      expect(types(effects)).toEqual(["recheck"]);
    }
  });

  it("with no way to check (the deck wires none), a pick moves the ring and does nothing else", () => {
    const c = ctx(PERMISSION, false);
    const out = play(fresh(c), [{ type: "pick", index: 0 }, { type: "submit" }], c);
    expect(out.effects).toEqual([]);
    expect(out.state.outcome.kind).toBe("none");
    expect(out.state.focus).toBe(0);
  });

  it("a result with no check pending is ignored", () => {
    const out = play(fresh(), [{ type: "result", result: "ok" }], ctx());
    expect(out.effects).toEqual([]);
    expect(out.state.outcome.kind).toBe("none");
  });

  it("a second pick while checking or after sent does nothing (no double send)", () => {
    const out = play(fresh(), [{ type: "pick", index: 0 }, { type: "pick", index: 0 }, { type: "result", result: "ok" }, { type: "pick", index: 0 }], ctx());
    expect(types(out.effects)).toEqual(["recheck", "send", "record"]);
  });
});

describe("a locked row is read and never answered", () => {
  it("announces 'Only in the terminal' for pick and for Enter, and sends nothing", () => {
    const pick = play(fresh(), [{ type: "pick", index: 1 }], ctx());
    expect(pick.effects).toEqual([{ type: "announce", text: LOCKED_ANNOUNCE }]);
    expect(pick.state.outcome.kind).toBe("none");
    const enter = play(fresh(), [{ type: "focus", index: 1 }, { type: "submit" }], ctx());
    expect(enter.effects).toEqual([{ type: "announce", text: "Only in the terminal" }]);
  });

  it("is reachable by the ring, so it can be read", () => {
    expect(play(fresh(), [{ type: "move", by: 1 }, { type: "move", by: 1 }], ctx()).state.focus).toBe(1);
  });
});

describe("the ring", () => {
  it("never moves on its own and clamps at both ends", () => {
    expect(fresh().focus).toBeNull();
    expect(play(fresh(), [{ type: "move", by: -1 }], ctx()).state.focus).toBe(2);
    expect(play(fresh(), [{ type: "move", by: 1 }, { type: "move", by: 1 }, { type: "move", by: 1 }, { type: "move", by: 1 }], ctx()).state.focus).toBe(2);
    expect(play(fresh(), [{ type: "move", by: 1 }, { type: "move", by: -1 }, { type: "move", by: -1 }], ctx()).state.focus).toBe(0);
  });

  it("Enter sends the answer the ring is on, and with the ring nowhere sends nothing", () => {
    expect(play(fresh(), [{ type: "submit" }], ctx()).effects).toEqual([]);
    expect(types(play(fresh(), [{ type: "move", by: 1 }, { type: "submit" }], ctx()).effects)).toEqual(["recheck"]);
  });

  it("is left alone in the read-only card", () => {
    const c = ctx(OUTSIDE);
    const out = play(initialState(OUTSIDE), [{ type: "move", by: 1 }, { type: "pick", index: 0 }, { type: "submit" }], c);
    expect(out.state.focus).toBeNull();
    expect(out.effects).toEqual([]);
  });
});

describe("Esc", () => {
  it("closes the card and never answers", () => {
    const out = play(fresh(), [{ type: "move", by: 1 }, { type: "escape" }], ctx());
    expect(out.effects).toEqual([{ type: "close" }]);
    expect(out.state.closed).toBe(true);
  });

  it("never answers even while the prompt is being checked", () => {
    const out = play(fresh(), [{ type: "pick", index: 0 }, { type: "escape" }], ctx());
    expect(types(out.effects)).toEqual(["recheck", "close"]);
  });

  it("goes back to the choices from the free field and keeps the text", () => {
    const out = play(fresh(), [{ type: "pick", index: 2 }, { type: "typeFree", text: "Run only the unit tests" }, { type: "escape" }], ctx());
    expect(out.state.mode).toBe("choose");
    expect(out.state.text).toBe("Run only the unit tests");
    expect(out.state.closed).toBe(false);
    expect(out.effects).toEqual([]);
  });
});

describe("Tell Claude what to do (the free field)", () => {
  it("Enter sends what was written, after the re-read; empty text sends nothing", () => {
    const empty = play(fresh(), [{ type: "pick", index: 2 }, { type: "submit" }], ctx());
    expect(empty.effects).toEqual([]);
    const typed = play(fresh(), [{ type: "pick", index: 2 }, { type: "typeFree", text: "  Run only the unit tests " }, { type: "submit" }], ctx());
    expect(typed.effects).toEqual([{ type: "recheck", answer: { kind: "text", index: 2, text: "Run only the unit tests" } }]);
  });

  it("the arrows leave the field's own keys alone", () => {
    const out = play(fresh(), [{ type: "pick", index: 2 }, { type: "move", by: -1 }], ctx());
    expect(out.state.focus).toBe(2);
  });
});

describe("Several answers", () => {
  const c = ctx(MULTI);
  it("toggles rows, counts them for 'Send N answers', and sends the checked set", () => {
    const out = play(initialState(MULTI), [{ type: "toggle", index: 1 }, { type: "pick", index: 0 }], c);
    expect(out.state.checked).toEqual([0, 1]);
    expect(answerCount(out.state)).toBe(2);
    const sent = play(out.state, [{ type: "submit" }, { type: "result", result: "ok" }], c);
    expect(sent.effects[0]).toEqual({ type: "recheck", answer: { kind: "many", indexes: [0, 1] } });
    expect(types(sent.effects)).toContain("send");
  });

  it("sends nothing with nothing checked", () => {
    expect(play(initialState(MULTI), [{ type: "submit" }], c).effects).toEqual([]);
  });

  it("unchecks a checked row", () => {
    const out = play(initialState(MULTI), [{ type: "toggle", index: 0 }, { type: "toggle", index: 0 }], c);
    expect(out.state.checked).toEqual([]);
  });
});

describe("what stays on screen", () => {
  const outcomes: Array<[string, DecisionEvent]> = [
    ["changed", { type: "outcome", input: { kind: "changed", now: "npm run lint" } }],
    ["ended", { type: "outcome", input: { kind: "ended" } }],
    ["elsewhere", { type: "outcome", input: { kind: "elsewhere", at: "14:03" } }],
  ];
  for (const [kind, event] of outcomes) {
    it(`${kind} stays until dismissed, and answers no pick meanwhile`, () => {
      const shown = play(fresh(), [event, { type: "pick", index: 0 }, { type: "submit" }], ctx());
      expect(shown.state.outcome.kind).toBe(kind);
      expect(shown.effects).toEqual([]);
      expect(play(shown.state, [{ type: "dismissOutcome" }], ctx()).state.outcome.kind).toBe("none");
    });
  }

  it("held says 'pick again': a pick after it asks for a new re-read", () => {
    const held = play(fresh(), [{ type: "outcome", input: { kind: "held" } }, { type: "pick", index: 0 }], ctx());
    expect(types(held.effects)).toEqual(["recheck"]);
  });

  it("an answer in the terminal closes into the record and sends nothing from here", () => {
    const out = play(fresh(), [{ type: "elsewhere", at: "14:03" }, { type: "dismissOutcome" }], ctx());
    expect(out.state.closed).toBe(true);
    expect(types(out.effects)).toEqual([]);
  });

  it("Show it and Open Term are the host's to do", () => {
    expect(play(fresh(), [{ type: "showNew" }, { type: "showTerm" }], ctx()).effects).toEqual([{ type: "showNew" }, { type: "showTerm" }]);
  });
});

describe("a plan is the same machine", () => {
  it("picks a plan option, and its locked first row is read only", () => {
    const c = ctx(PLAN);
    expect(play(initialState(PLAN), [{ type: "pick", index: 0 }], c).effects[0]).toEqual({ type: "announce", text: LOCKED_ANNOUNCE });
    expect(types(play(initialState(PLAN), [{ type: "pick", index: 1 }], c).effects)).toEqual(["recheck"]);
  });
});
