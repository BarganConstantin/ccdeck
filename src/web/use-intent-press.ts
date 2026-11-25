// The pane's half of an answer chosen on an alert (answer-intent.ts): while
// the pane shows the intent's session in Chat and the card that answers its
// prompt is up, the card is told which row to press, once, after a short arm.
//
// THE CARD STILL DECIDES. What this hands out is a press: the Decision card
// runs it as a pick (re-read of the screen, then the keys, step by step), the
// question card as its Send. A row whose words moved, a locked row, a card of
// another kind, or no card in INTENT_LAND_MS: the intent is given up, the
// prompt left to the reader, and `onOutcome` says why.
import { useEffect, useRef, useState } from "react";
import {
  answerIntents, INTENT_ARM_MS, INTENT_LAND_MS, matchIntent, useIntentVersion,
  type AnswerIntent, type IntentMatch, type IntentOutcome, type IntentRow, type IntentStore,
} from "./answer-intent";

/** A press for a card: its row, the intent it answers, and the card it is for. */
export interface CardPress {
  id: number;
  index: number;
  /** The card's own id (the Decision card's model id, the question card's
   *  questions): a press is for that card, never one that replaced it. */
  for: string;
}

/** The card the pane shows now for the session, as an intent reads it. */
export interface IntentTarget {
  /** A plan is never answered from an alert: an intent meeting one is given up. */
  kind: AnswerIntent["kind"] | "plan";
  /** The card's id, carried into the press. */
  id: string;
  rows: readonly IntentRow[];
  /** The call the card names (a command), when it names one. */
  call?: string;
}

export interface IntentPressOptions {
  /** The session the pane shows in Chat and can write to, or null. */
  sessionId: string | null;
  /** The card that answers its prompt, when one is up. */
  target: IntentTarget | null;
  /** What became of an intent: pressed, or given up and why. */
  onOutcome(kind: IntentOutcome["kind"]): void;
  /** The pane's terminal screen as it reads now, checked for the alert's call
   *  before a press (read only while an intent is held). */
  readScreen?: () => string | null;
  store?: IntentStore;
  now?: () => number;
}

/** What to do with the intent and the card in front of it: wait for a card,
 *  arm the press, or give the intent up. */
export function intentStep(intent: AnswerIntent | null, target: IntentTarget | null, now: number, screen?: string | null):
  | { kind: "none" } | { kind: "wait" } | { kind: "drop"; reason: IntentOutcome["kind"] } | { kind: "arm"; index: number } {
  if (!intent) return { kind: "none" };
  if (!target) return now >= intent.expiresAt ? { kind: "drop", reason: "expired" } : { kind: "wait" };
  if (target.kind !== intent.kind) return { kind: "drop", reason: "changed" };
  const m: IntentMatch = matchIntent(intent, target.rows, now, target.call, screen);
  return m.ok ? { kind: "arm", index: m.index } : { kind: "drop", reason: m.reason };
}

export function useIntentPress(o: IntentPressOptions): CardPress | null {
  const store = o.store ?? answerIntents;
  const clock = o.now ?? Date.now;
  useIntentVersion(store);
  const intent = o.sessionId ? store.peek(o.sessionId, clock()) : null;
  const [press, setPress] = useState<CardPress | null>(null);
  const live = useRef(o);
  live.current = o;
  const target = o.target;
  const step = intentStep(intent, target, clock(), intent && target && o.readScreen ? o.readScreen() : undefined);
  const intentId = intent?.id ?? 0;
  const targetId = target?.id ?? "";
  const stepKind = step.kind;

  // No card yet: wait for one, but not for ever. The pane may be connecting
  // and the transcript loading; a card that does not come is a prompt the
  // reader answers.
  useEffect(() => {
    if (!intentId || stepKind !== "wait") return;
    const timer = setTimeout(() => {
      if (store.take(intentId)) live.current.onOutcome("timeout");
    }, INTENT_LAND_MS);
    return () => clearTimeout(timer);
  }, [intentId, stepKind, store]);

  // A card is up: give the intent up now, or press once the arm has passed,
  // read again against the card as it is then.
  useEffect(() => {
    if (!intentId) return;
    if (step.kind === "drop") {
      if (store.take(intentId)) live.current.onOutcome(step.reason);
      return;
    }
    if (step.kind !== "arm") return;
    const timer = setTimeout(() => {
      const now = live.current;
      const held = now.sessionId ? store.peek(now.sessionId, clock()) : null;
      if (!held || held.id !== intentId) return;
      const again = intentStep(held, now.target, clock(), now.target && now.readScreen ? now.readScreen() : undefined);
      if (again.kind === "drop") {
        if (store.take(intentId)) now.onOutcome(again.reason);
        return;
      }
      if (again.kind !== "arm" || !now.target || !store.take(intentId)) return;
      setPress({ id: intentId, index: again.index, for: now.target.id });
      now.onOutcome("answered");
    }, INTENT_ARM_MS);
    return () => clearTimeout(timer);
    // The step's kind and the card's id decide; the rows are read again when it fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentId, stepKind, targetId, store]);

  // A press is for its card: once the card is another one, or gone, it is spent.
  useEffect(() => {
    if (press && press.for !== targetId) setPress(null);
  }, [press, targetId]);
  return press && press.for === targetId ? press : null;
}

/** The card in front of an intent: the Decision card when it is up, else the
 *  question card still waiting for its answer, else none. */
export function intentTarget(
  decision: { id?: string; kind: string; options: readonly IntentRow[]; command?: string } | undefined,
  turns: readonly { kind: string }[],
): IntentTarget | null {
  if (decision) {
    const kind = decision.kind === "permission" ? "permission" : decision.kind === "plan" ? "plan" : "question";
    return { kind, id: decision.id ?? "", rows: decision.options, ...(decision.command ? { call: decision.command } : null) };
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i] as { kind: string; running?: boolean; questions?: { question: string; multi: boolean; options: { label: string }[] }[] };
    if (turn.kind !== "ask" || !turn.running || !turn.questions) continue;
    const questions = turn.questions;
    // One question, one pick: its options are the rows. Anything else has no
    // row an alert could name, and the intent is given up.
    const rows = questions.length === 1 && !questions[0].multi ? questions[0].options.map(o => ({ label: o.label })) : [];
    return { kind: "question", id: questions.map(q => q.question).join("\n"), rows };
  }
  return null;
}
