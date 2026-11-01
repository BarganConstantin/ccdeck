// The Decision card as one pure state machine: (state, event, context) in,
// (state, effects) out. No React and no DOM, so each of the twelve frames is a
// row in a table (v4-decision-machine.test.ts).
//
// THREE AXES make the twelve frames: the mode (choose, free text, several
// answers, read only), the outcome (none, checking, sent, changed, ended, held,
// answered elsewhere) and the kind of question (permission, plan, question),
// which is the model's and changes words, not behaviour.
//
// WHAT THE MACHINE NEVER DOES: send. It asks, with the `recheck` effect, and
// only a `result` of "ok" produces `send`. "Nothing is typed into the terminal
// until the prompt is checked again" is this file's one promise, and with no
// way to check (`canRecheck` false: the deck wires none) a pick moves the ring
// and does nothing else. A locked row (it changes the session's rules or mode)
// is read, never answered. Esc closes and never answers; in the free field it
// goes back to the choices and keeps the text. A pick the outcome has settled
// (sent, changed, ended, elsewhere) does nothing until `dismissOutcome`.
import type { DecisionAnswer, DecisionModel, DecisionOutcomeInput, RecheckResult } from "./decision-model";

export type DecisionMode = "choose" | "free" | "multi" | "readOnly";

export type Outcome =
  | { kind: "none" }
  | { kind: "checking"; answer: DecisionAnswer }
  | { kind: "sent"; answer: DecisionAnswer }
  | { kind: "changed"; now: string }
  | { kind: "ended" }
  | { kind: "held" }
  | { kind: "elsewhere"; at: string };

export interface DecisionState {
  mode: DecisionMode;
  outcome: Outcome;
  /** The row the ring is on, or null: it never moves on its own. */
  focus: number | null;
  /** Several answers: the rows that are checked. */
  checked: number[];
  /** The free field's text, kept across Esc. */
  text: string;
  /** Esc, or a dismissed outcome, closed the card. */
  closed: boolean;
  /** Which pick the re-read in flight belongs to: a counter, bumped by every
   *  pick, cancel and reset. An answer that carries another number is stale. */
  token: number;
}

export type DecisionEvent =
  | { type: "focus"; index: number | null }
  | { type: "move"; by: 1 | -1 }
  | { type: "pick"; index: number }
  | { type: "submit" }
  | { type: "toggle"; index: number }
  | { type: "openFree" }
  | { type: "typeFree"; text: string }
  | { type: "escape" }
  /** `token` is the pick's (state.token when the re-read was asked). */
  | { type: "result"; result: RecheckResult; token?: number }
  /** The re-read itself failed: it leaves THAT pick's checking and nothing else. */
  | { type: "checkFailed"; token?: number }
  /** A different question arrived: start over on the model in the context. */
  | { type: "reset" }
  | { type: "elsewhere"; at: string }
  | { type: "outcome"; input: DecisionOutcomeInput }
  | { type: "dismissOutcome" }
  | { type: "showTerm" }
  | { type: "showNew" };

export type DecisionEffect =
  | { type: "recheck"; answer: DecisionAnswer }
  | { type: "send"; answer: DecisionAnswer }
  | { type: "close" }
  | { type: "showTerm" }
  | { type: "showNew" }
  | { type: "record"; answer: DecisionAnswer }
  | { type: "announce"; text: string };

export interface DecisionContext {
  model: DecisionModel;
  /** The host can re-read the live prompt. Without it nothing is ever sent. */
  canRecheck: boolean;
}

export interface Step {
  state: DecisionState;
  effects: DecisionEffect[];
}

/** Said (in the live region) on a locked row. */
export const LOCKED_ANNOUNCE = "Only in the terminal";
/** Said when the re-read could not be done: nothing was sent, the choices are back. */
export const CHECK_FAILED_ANNOUNCE = "Could not read the prompt again, so nothing was sent";

export function initialState(model: DecisionModel): DecisionState {
  return {
    mode: model.origin === "outside" ? "readOnly" : model.multi ? "multi" : "choose",
    outcome: { kind: "none" },
    focus: null,
    checked: [],
    text: "",
    closed: false,
    token: 0,
  };
}

/** The outcome a host reports, as the state holds it. */
export function outcomeOf(input: DecisionOutcomeInput): Outcome {
  return input;
}

const stay = (state: DecisionState, effects: DecisionEffect[] = []): Step => ({ state, effects });

/** A pick can start only while nothing has settled the question: no outcome yet,
 *  or Held, which says "then pick again". */
function open(state: DecisionState): boolean {
  return state.outcome.kind === "none" || state.outcome.kind === "held";
}

/** THE ONE RULE EVERY SEND PATH ANSWERS TO, when the answer is asked for and
 *  again when the re-read says ok: no target row is locked, a typed answer
 *  targets the free row, and a many-answer has rows. */
function sendable(answer: DecisionAnswer, ctx: DecisionContext): boolean {
  const rows = ctx.model.options;
  const usable = (i: number) => Number.isInteger(i) && !!rows[i] && !rows[i].locked;
  switch (answer.kind) {
    case "option": return usable(answer.index);
    case "text": return usable(answer.index) && !!rows[answer.index].free && answer.text.trim() !== "";
    case "many": return answer.indexes.length > 0 && answer.indexes.every(usable);
  }
}

function check(state: DecisionState, answer: DecisionAnswer, ctx: DecisionContext): Step {
  // Nothing to check with, or an answer that may not go out: nothing is sent, nothing changes.
  if (!ctx.canRecheck || !sendable(answer, ctx)) return stay(state);
  return stay({ ...state, token: state.token + 1, outcome: { kind: "checking", answer } }, [{ type: "recheck", answer }]);
}

/** Cancel the pick in flight, if any: a late answer to it finds another token. */
function cancelled(state: DecisionState): DecisionState {
  return state.outcome.kind === "checking" ? { ...state, token: state.token + 1, outcome: { kind: "none" } } : state;
}

/** Pick row `index` as an answer: a locked row is announced, a free row opens,
 *  anything else goes to the re-read. */
function pickRow(state: DecisionState, index: number, ctx: DecisionContext): Step {
  const row = ctx.model.options[index];
  if (!row || !open(state)) return stay(state);
  const focused = { ...state, focus: index };
  if (row.locked) return stay(focused, [{ type: "announce", text: LOCKED_ANNOUNCE }]);
  if (row.free) return stay({ ...focused, mode: "free" });
  return check(focused, { kind: "option", index }, ctx);
}

export function step(state: DecisionState, event: DecisionEvent, ctx: DecisionContext): Step {
  const n = ctx.model.options.length;
  switch (event.type) {
    case "focus":
      if (event.index == null) return stay({ ...state, focus: null });
      if (state.mode === "readOnly" || event.index < 0 || event.index >= n) return stay(state);
      // Another row than the free one takes the ring out of the field; the text waits.
      if (state.mode === "free" && !ctx.model.options[event.index]?.free) return stay({ ...state, mode: "choose", focus: event.index });
      return stay({ ...state, focus: event.index });
    case "move": {
      if (state.mode === "readOnly" || state.mode === "free" || n === 0) return stay(state);
      const at = state.focus == null ? (event.by === 1 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, state.focus + event.by));
      return stay({ ...state, focus: at });
    }
    case "pick":
      if (state.mode === "readOnly" || state.mode === "free") return stay(state);
      if (state.mode === "multi") return step(state, { type: "toggle", index: event.index }, ctx);
      return pickRow(state, event.index, ctx);
    case "toggle": {
      if (state.mode !== "multi" || !open(state) || event.index < 0 || event.index >= n) return stay(state);
      if (ctx.model.options[event.index].locked) return stay({ ...state, focus: event.index }, [{ type: "announce", text: LOCKED_ANNOUNCE }]);
      const has = state.checked.includes(event.index);
      const checked = has ? state.checked.filter(i => i !== event.index) : [...state.checked, event.index].sort((a, b) => a - b);
      return stay({ ...state, focus: event.index, checked });
    }
    case "submit": {
      if (!open(state)) return stay(state);
      if (state.mode === "choose") return state.focus == null ? stay(state) : pickRow(state, state.focus, ctx);
      if (state.mode === "free") {
        const text = state.text.trim();
        const target = state.focus == null ? undefined : ctx.model.options[state.focus];
        if (!text || state.focus == null || !target?.free || target.locked) return stay(state);
        return check(state, { kind: "text", index: state.focus, text }, ctx);
      }
      if (state.mode === "multi") {
        if (!state.checked.length) return stay(state);
        return check(state, { kind: "many", indexes: state.checked }, ctx);
      }
      return stay(state);
    }
    case "openFree": {
      if (state.mode !== "choose" || !open(state)) return stay(state);
      const at = ctx.model.options.findIndex(o => o.free && !o.locked);
      return at < 0 ? stay(state) : stay({ ...state, mode: "free", focus: at });
    }
    case "typeFree":
      return state.mode === "free" ? stay({ ...state, text: event.text }) : stay(state);
    case "escape":
      // The field first: back to the choices, the text kept. Then the card.
      // A pick being checked is cancelled by either: its late answer sends nothing.
      if (state.mode === "free") return stay({ ...cancelled(state), mode: "choose" });
      return stay({ ...cancelled(state), closed: true }, [{ type: "close" }]);
    case "result": {
      if (state.closed || state.outcome.kind !== "checking") return stay(state);
      if (event.token !== undefined && event.token !== state.token) return stay(state);
      const { answer } = state.outcome;
      const r = event.result;
      if (r === "ok" && !sendable(answer, ctx)) return stay({ ...state, outcome: { kind: "none" } });
      if (r === "ok") return stay({ ...state, outcome: { kind: "sent", answer } }, [{ type: "send", answer }, { type: "record", answer }]);
      return stay({ ...state, outcome: outcomeOf(r) });
    }
    case "checkFailed": {
      // Only the pick that asked: any other outcome on screen stays until dismissed.
      if (state.closed || state.outcome.kind !== "checking") return stay(state);
      if (event.token !== undefined && event.token !== state.token) return stay(state);
      return stay({ ...state, outcome: { kind: "none" } }, [{ type: "announce", text: CHECK_FAILED_ANNOUNCE }]);
    }
    case "reset":
      return stay({ ...initialState(ctx.model), token: state.token + 1 });
    case "elsewhere":
      // The terminal answered first: nothing to send from here.
      return stay({ ...state, outcome: { kind: "elsewhere", at: event.at } });
    case "outcome":
      // The host says what happened on its own (the question changed, the
      // session ended, the terminal holds text, the terminal answered).
      return stay({ ...state, outcome: outcomeOf(event.input) });
    case "dismissOutcome":
      return stay({ ...state, outcome: { kind: "none" }, closed: state.outcome.kind === "sent" || state.outcome.kind === "elsewhere" ? true : state.closed });
    case "showTerm":
      return stay(state, [{ type: "showTerm" }]);
    case "showNew":
      return stay(state, [{ type: "showNew" }]);
    default:
      return stay(state);
  }
}

/** The number of answers a multi card would send. */
export const answerCount = (state: DecisionState) => state.checked.length;
