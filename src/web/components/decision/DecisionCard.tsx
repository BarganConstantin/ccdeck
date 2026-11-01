// The Decision card: the question docked under the chat, in twelve states.
// Nothing is typed into the terminal until the prompt is checked again.
//
// ON PROPS, AND ON NOTHING ELSE. The card draws the model it is handed and
// asks its host for the one thing it cannot know, whether the live prompt is
// still the one it shows (`recheck`). The deck passes no model and no hooks, so
// the deck draws nothing and sends nothing; a harness or a test passes a
// stand-in. The state is decision-machine.ts's, a pure reducer; this file
// wires its events to the keyboard and the pointer and runs its effects.
//
// FOCUS NEVER MOVES ON ITS OWN. The card does not take focus on arrival. Once
// focus is inside, 1 to 3 pick, the arrows and Tab move the ring, Enter sends
// the answer the ring is on, and Esc closes and never answers (decision-keys.ts).
// A digit pressed with focus anywhere else is not the card's.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useSingleKeyShortcuts } from "../../use-single-key-shortcuts";
import {
  initialState, LOCKED_ANNOUNCE, step,
  type DecisionContext, type DecisionEffect, type DecisionEvent, type DecisionState,
} from "./decision-machine";
import { decisionEventFor } from "./decision-keys";
import type { DecisionHooks, DecisionModel, DecisionOutcomeInput } from "./decision-model";
import DecisionFooter from "./DecisionFooter";
import DecisionOption from "./DecisionOption";
import DecisionOutcome from "./DecisionOutcome";
import "./decision.css";

export { LOCKED_ANNOUNCE };

export interface DecisionCardProps extends DecisionHooks {
  model: DecisionModel;
  /** What the host reports on its own: the question changed, the session ended,
   *  the terminal holds text, the terminal answered first. */
  outcome?: DecisionOutcomeInput;
  /** The card's state at first draw. For a harness and for tests; the deck has none. */
  initial?: Partial<DecisionState>;
  size?: "desktop" | "phone";
}

let nextId = 0;

export default function DecisionCard(p: DecisionCardProps) {
  const { model } = p;
  const singleKeys = useSingleKeyShortcuts();
  const [id] = useState(() => `dc-${++nextId}`);
  const [state, setState] = useState<DecisionState>(() => ({
    ...initialState(model),
    ...(p.outcome ? { outcome: p.outcome } : null),
    ...p.initial,
  }));
  const [said, setSaid] = useState("");
  const stateRef = useRef(state);
  const hooks = useRef(p);
  hooks.current = p;
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const input = useRef<HTMLInputElement | null>(null);
  const ring = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const canRecheck = typeof p.recheck === "function";
  const ctx = useMemo<DecisionContext>(() => ({ model, canRecheck }), [model, canRecheck]);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const dispatch = useCallback((event: DecisionEvent) => {
    const out = step(stateRef.current, event, ctxRef.current);
    stateRef.current = out.state;
    setState(out.state);
    for (const effect of out.effects) run(effect);
    // The effects close over refs only, so this is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function run(effect: DecisionEffect) {
    const h = hooks.current;
    switch (effect.type) {
      case "recheck":
        // A check that fails to answer sends nothing and lets the card go back.
        h.recheck?.(effect.answer).then(
          result => { if (alive.current) dispatch({ type: "result", result }); },
          () => { if (alive.current) dispatch({ type: "dismissOutcome" }); },
        );
        break;
      case "send": h.onAnswer?.(effect.answer); break;
      case "record": h.onRecord?.(effect.answer); break;
      case "close": h.onClose?.(); break;
      case "showTerm": h.onShowTerm?.(); break;
      case "showNew": h.onShowNew?.(); break;
      case "announce": setSaid(effect.text); break;
    }
  }

  // The host's own report (the question changed, the session ended…) arrives as a prop.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (p.outcome) dispatch({ type: "outcome", input: p.outcome });
  }, [p.outcome, dispatch]);

  // The ring moves the browser's focus with it, but only once the card has it.
  useEffect(() => {
    if (state.focus != null && ring.current) rows.current[state.focus]?.focus();
  }, [state.focus]);
  useEffect(() => {
    if (state.mode === "free") input.current?.focus();
  }, [state.mode]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const s = stateRef.current;
    if (s.mode === "readOnly") return;
    // The free field is a text field: its keys are its own, but Enter sends and Esc backs out.
    const inField = e.target instanceof HTMLInputElement;
    if (inField && e.key !== "Enter" && e.key !== "Escape") return;
    const event = decisionEventFor(e, singleKeys, model.options.length);
    if (!event) return;
    if (event.type === "move" && (e.key === "Tab")) {
      // Tab leaves the card from the first or last row instead of trapping it.
      const at = s.focus;
      const edge = event.by === 1 ? at === model.options.length - 1 : at === 0;
      if (at == null ? false : edge) return;
    }
    e.preventDefault();
    e.stopPropagation();
    ring.current = true;
    dispatch(event);
  };

  const o = state.outcome;
  const answered = o.kind === "checking" || o.kind === "sent" ? o.answer : null;
  const answeredIndex = answered && answered.kind !== "many" ? answered.index : -1;
  const titleId = `${id}-title`;
  const multi = state.mode === "multi";
  const tabStop = state.focus ?? 0;

  if (state.closed) return null;
  return (
    <div
      className="dc-dock"
      data-size={p.size === "phone" ? "phone" : undefined}
      data-mode={state.mode}
      data-outcome={o.kind}
      data-kind={model.kind}
    >
      <div
        className="dc-decision"
        role="group"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        onBlur={e => {
          // Focus left the card: the ring goes with it, and the keys are the page's again.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          ring.current = false;
          if (stateRef.current.focus != null && stateRef.current.mode !== "free") dispatch({ type: "focus", index: null });
        }}
      >
        <div className="dc-dq" data-outcome={o.kind}>
          <h3 className="dc-title" id={titleId}>{model.title}</h3>
          {model.plan ? (
            <ol className="dc-plan">
              {model.plan.map((line, i) => <li key={i}><span className="dc-plan-n">{i + 1}</span>{line}</li>)}
            </ol>
          ) : model.command ? (
            <code className="dc-cmd">{model.command}</code>
          ) : null}
          <p className="dc-caption">{model.caption}</p>
        </div>
        <div className="dc-tree" aria-hidden="true">
          <i className="dc-stub" />
          <i className="dc-spine" />
          {model.options.map((_, i) => <i className="dc-tick" key={i} />)}
        </div>
        <div className="dc-opts" role={multi ? "group" : "radiogroup"} aria-labelledby={titleId}>
          {model.options.map((option, i) => (
            <DecisionOption
              key={i}
              index={i}
              option={option}
              selection={multi ? "checkbox" : "radio"}
              focused={state.focus === i}
              checked={multi ? state.checked.includes(i) : answeredIndex === i}
              typing={state.mode === "free" && state.focus === i}
              text={state.text}
              readOnly={state.mode === "readOnly"}
              tabStop={tabStop === i}
              rowRef={el => { rows.current[i] = el; }}
              inputRef={input}
              onPick={() => { ring.current = true; dispatch({ type: "pick", index: i }); }}
              onFocus={() => dispatch({ type: "focus", index: i })}
              onText={text => dispatch({ type: "typeFree", text })}
              onFieldKey={e => {
                if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); dispatch({ type: "submit" }); }
                else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dispatch({ type: "escape" }); }
              }}
            />
          ))}
        </div>
          <DecisionOutcome
            outcome={o}
            model={model}
            onShowNew={() => dispatch({ type: "showNew" })}
            onShowTerm={() => dispatch({ type: "showTerm" })}
            onOpenTranscript={() => hooks.current.onOpenTranscript?.()}
          />
      </div>
      <DecisionFooter
        mode={state.mode}
        focused={state.focus != null}
        checked={state.checked.length}
        rows={model.options.length}
        onShowTerm={() => dispatch({ type: "showTerm" })}
      />
      <div className="vis-hidden" role="status" aria-atomic="true">{said}</div>
    </div>
  );
}
