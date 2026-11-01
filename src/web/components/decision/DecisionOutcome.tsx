// What happened after a pick, under the options: the panel the Figma card calls
// `dout`. Six outcomes, one panel shape: a glyph, a title, a line, and at most
// one text link. It is a live region, the one place the product announces the
// outcome of a decision.
//
// NO COLOUR FLASH, NO POP. The outcome swaps in at Fast; Checking shows its
// glyph only after the loader delay, so a re-read that returns at once draws
// no flicker (decision.css). "Ended" is not red: the title is --text, and the
// card turns neutral while the question stays readable.
import type { ReactNode } from "react";
import { StateMark } from "../StateMark";
import { ExternalLinkGlyph } from "../action-glyphs";
import { StageGlyph } from "../terminal/stage-icons";
import { ChangedGlyph } from "../chat/chat-icons";
import type { Outcome } from "./decision-machine";
import type { DecisionModel } from "./decision-model";

export interface OutcomeActions {
  onShowNew?(): void;
  onOpenTranscript?(): void;
  onShowTerm?(): void;
}

interface Words {
  glyph: ReactNode;
  title: ReactNode;
  sub: ReactNode;
  link?: { label: string; external?: boolean; run?(): void };
  tone?: "ok";
}

export const CHECKING_TITLE = "Checking the prompt is still on screen";
export const CHECKING_SUB = "Nothing is sent if it changed.";
export const CHANGED_TITLE = "The question changed, so nothing was sent";
export const ENDED_SUB = "Nothing was sent.";
export const HELD_TITLE = "Held: you have unsent text in the terminal";
export const HELD_SUB = "Send it or clear it there, then pick again.";
export const ELSEWHERE_SUB = "Nothing to send from here.";

/** The words of an outcome, or null when there is no panel to draw. */
export function outcomeWords(o: Outcome, model: DecisionModel, a: OutcomeActions): Words | null {
  switch (o.kind) {
    case "none":
      return null;
    case "checking":
      return { glyph: <StageGlyph kind="working" />, title: CHECKING_TITLE, sub: CHECKING_SUB };
    case "sent":
      return {
        glyph: <StageGlyph kind="done" />,
        title: `Sent to ${model.session}`,
        tone: "ok",
        sub: model.command ? <>Running <code className="dc-mono">{model.command}</code>.</> : "Claude has your answer.",
      };
    case "changed":
      return {
        glyph: <ChangedGlyph />,
        title: CHANGED_TITLE,
        sub: <>Claude now asks about <code className="dc-mono">{o.now}</code></>,
        link: { label: "Show it", run: a.onShowNew },
      };
    case "ended":
      return {
        glyph: <span className="dc-err"><StateMark kind="err" size={14} /></span>,
        title: `${model.session} ended before the answer went out`,
        sub: ENDED_SUB,
        link: { label: "Open the transcript", run: a.onOpenTranscript },
      };
    case "held":
      return {
        glyph: <StageGlyph kind="idle" />,
        title: HELD_TITLE,
        sub: HELD_SUB,
        link: { label: "Open Term", run: a.onShowTerm },
      };
    case "elsewhere":
      return { glyph: <StageGlyph kind="done" />, title: `Answered in the terminal at ${o.at}`, sub: ELSEWHERE_SUB };
  }
}

export default function DecisionOutcome({ outcome, model, ...actions }: { outcome: Outcome; model: DecisionModel } & OutcomeActions) {
  const words = outcomeWords(outcome, model, actions);
  // The live region is drawn empty, so a screen reader has it before it speaks.
  if (!words) return <div className="dc-out-empty" role="status" aria-atomic="true" />;
  return (
    <div className="dc-out" role="status" aria-atomic="true" data-kind={outcome.kind}>
      <span className="dc-out-glyph" aria-hidden="true">{words.glyph}</span>
      <span className="dc-out-text">
        <span className="dc-out-title" data-tone={words.tone}>{words.title}</span>
        <span className="dc-out-sub">{words.sub}</span>
      </span>
      {words.link && (
        <button type="button" className="dc-link" onClick={words.link.run}>
          {words.link.label}
          {words.link.external && <ExternalLinkGlyph />}
        </button>
      )}
    </div>
  );
}
