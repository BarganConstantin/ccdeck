// Chat's Decision card for Claude Code's permission prompt and plan approval:
// the screen is read while the transcript says a call or a plan waits, and the
// card is the prompt it finds (screen-prompt.ts, prompt-decision.ts).
//
// THE CARD LIVES AS LONG AS THE PROMPT. A prompt on screen is a card; another
// prompt is another card; a prompt gone is no card, answered in Term or not.
// One answered from here keeps saying what happened for SENT_LINGER_MS after
// the prompt has gone, so "Sent" is read and not flashed.
//
// NOTHING GOES OUT UNREAD. A pick re-reads the screen first (the card's
// recheck): the same prompt sends, another says so and sends nothing. The
// keys then go a step at a time, each only once the screen shows what it
// answers (use-terminal-session.ts sendAsk), as a question card's do.
//
// THE CARD'S WORDS FOLLOW THE CALL UNTIL IT IS ANSWERED. The transcript names
// the call (the card's title and its line in mono); once answered, the card
// keeps the call it was answered for, so the call finishing does not turn it
// into a new card while it still says "Sent".
//
// AN ANSWERED CARD BELONGS TO ITS CALL. Claude Code asks the same words again
// for the next call (the same command run twice), so a prompt that reads the
// same is a new card once the transcript waits on a later call; and while
// "No, keep planning" takes words the screen shows them in that row, which is
// still the prompt that was answered.
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "./i18n";
import type { AskStep } from "./ask-keys";
import type { ChatTurn } from "./components/chat/chat-model";
import type { DecisionCardProps } from "./components/decision/DecisionCard";
import type { DecisionAnswer, DecisionOutcomeInput, RecheckResult } from "./components/decision/decision-model";
import { mayPrompt, promptDecision } from "./prompt-decision";
import { promptSteps, readScreenPrompt, sameAsAnswered, samePrompt, type ScreenPrompt } from "./screen-prompt";
import type { AskSendResult } from "./use-terminal-session";

/** How often the screen is read while a call or a plan waits. */
export const PROMPT_POLL_MS = 500;
/** How long a card answered from here stays once its prompt has gone. */
export const SENT_LINGER_MS = 2500;

export interface HeldPrompt {
  prompt: ScreenPrompt;
  /** The transcript the card's words come from. */
  turns: readonly ChatTurn[];
  /** Where the call or plan the card answers waits in that transcript (waitingAt). */
  at: number;
  /** Answered from here: its keys went, or were tried. */
  sent?: boolean;
  /** What the host reports to the card. */
  outcome?: DecisionOutcomeInput;
  /** The prompt has left the screen: the card goes after SENT_LINGER_MS. */
  gone?: boolean;
}

/** Where the last call or plan still waiting sits in the transcript, or -1. A
 *  sub-agent still running counts as a call: its own calls can ask too. */
export function waitingAt(turns: readonly ChatTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if ((turn.kind === "tool" || turn.kind === "plan" || turn.kind === "agent") && turn.running) return i;
  }
  return -1;
}

/** The card held after a read of the screen (`read`, null for no prompt) with
 *  the transcript as it is now. */
export function nextHeld(prev: HeldPrompt | null, read: ScreenPrompt | null, turns: readonly ChatTurn[]): HeldPrompt | null {
  if (read) {
    const at = waitingAt(turns);
    const fresh = (): HeldPrompt => ({ prompt: read, turns, at });
    if (!prev) return fresh();
    if (prev.sent) {
      // A later call asks the same words: a new card. The answered prompt, its
      // words row showing what was typed, keeps the card that says "Sent".
      if ((at >= 0 && at !== prev.at) || !sameAsAnswered(prev.prompt, read)) return fresh();
      return prev.gone ? { ...prev, gone: false } : prev;
    }
    if (!samePrompt(prev.prompt, read)) return fresh();
    // The call finished before the prompt left the screen: the card keeps its call.
    return prev.turns === turns ? prev : { ...prev, turns, at: at >= 0 ? at : prev.at };
  }
  if (!prev?.sent) return null;
  return prev.gone ? prev : { ...prev, gone: true };
}

/** The keys that pick `answer` on `prompt`; null when Chat may not. */
export function stepsFor(prompt: ScreenPrompt, answer: DecisionAnswer): AskStep[] | null {
  if (answer.kind === "many") return null;
  return promptSteps(prompt, answer.index, answer.kind === "text" ? answer.text : undefined);
}

export interface PromptDecisionOptions {
  /** Chat is on screen for a Claude session that can be written to, and the card's flag is on. */
  on: boolean;
  turns: readonly ChatTurn[];
  /** The session's name, as the card says it. */
  session: string;
  /** The session's subjectKey: reads and keys go to it only. */
  subject: string;
  readScreen(subject: string): string | null;
  sendAsk(steps: readonly AskStep[], subject: string): Promise<AskSendResult>;
  /** Keys went: the transcript is read again. */
  onSent(): void;
  onShowTerm(): void;
}

export function usePromptDecision(o: PromptDecisionOptions): DecisionCardProps | undefined {
  const t = useT();
  const [held, setHeld] = useState<HeldPrompt | null>(null);
  const live = useRef(o);
  live.current = o;

  // Another session in the pane: nothing held carries over. Before the read
  // below, so the new session's screen is the one kept.
  useEffect(() => { setHeld(null); }, [o.subject]);

  const watching = o.on && mayPrompt(o.turns);
  useEffect(() => {
    const read = () => {
      const now = live.current;
      const screen = now.readScreen(now.subject);
      setHeld(prev => nextHeld(prev, screen === null ? null : readScreenPrompt(screen), now.turns));
    };
    if (!watching) {
      setHeld(prev => nextHeld(prev, null, live.current.turns));
      return;
    }
    read();
    const timer = setInterval(read, PROMPT_POLL_MS);
    return () => clearInterval(timer);
  }, [watching, o.subject]);

  useEffect(() => {
    if (!held?.gone) return;
    const timer = setTimeout(() => setHeld(prev => (prev === held ? null : prev)), SENT_LINGER_MS);
    return () => clearTimeout(timer);
  }, [held]);

  const prompt = held?.prompt;
  const heldTurns = held?.turns;
  const at = held?.at;
  const model = useMemo(() => {
    if (!prompt || !heldTurns) return null;
    const decision = promptDecision(prompt, heldTurns, o.session, t);
    // One card per call (the card is keyed by its id): the same words asked
    // for a later call are a new card, not the one that says "Sent".
    return { ...decision, id: `${decision.id}\n@${at}` };
  }, [prompt, heldTurns, at, o.session, t]);

  // Off screen (Term, or a session Chat cannot write to), no card at all: the
  // slot would draw one handed to it on its own.
  if (!held || !model || !o.on) return undefined;
  // The card these props are drawn for: a pick answers this prompt only, even
  // if a read of the screen has since held another.
  const card = held;
  return {
    model,
    outcome: card.outcome,
    async recheck(): Promise<RecheckResult> {
      const now = live.current;
      const screen = now.readScreen(now.subject);
      // No screen to read: the card says it could not check, and sends nothing.
      if (screen === null) throw new Error("no screen");
      const shown = readScreenPrompt(screen);
      return samePrompt(shown, card.prompt) ? "ok" : { kind: "changed", now: shown?.question ?? "" };
    },
    onAnswer(answer) {
      const mark = (patch: Partial<HeldPrompt>) =>
        setHeld(prev => (prev && prev.prompt === card.prompt ? { ...prev, ...patch } : prev));
      const steps = stepsFor(card.prompt, answer);
      if (!steps) { mark({ outcome: { kind: "stopped", part: false } }); return; }
      mark({ sent: true });
      const now = live.current;
      void now.sendAsk(steps, now.subject).then(result => {
        if (result === "sent" || result === "partial") live.current.onSent();
        if (result === "sent") return;
        if (result === "partial") { mark({ outcome: { kind: "stopped", part: true } }); return; }
        if (result === "changed") {
          const screen = live.current.readScreen(live.current.subject);
          mark({ outcome: { kind: "changed", now: (screen === null ? null : readScreenPrompt(screen))?.question ?? "" } });
          return;
        }
        mark({ outcome: { kind: "stopped", part: false } });
      });
    },
    onShowTerm: () => live.current.onShowTerm(),
  };
}
