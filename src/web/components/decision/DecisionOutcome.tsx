// What happened after a pick, under the options: the panel the Figma card calls
// `dout`. Seven outcomes, one panel shape: a glyph, a title, a line, and at most
// one text link. It is a live region, the one place the product announces the
// outcome of a decision.
//
// NO COLOUR FLASH, NO POP. The outcome swaps in at Fast; Checking shows its
// glyph only after the loader delay, so a re-read that returns at once draws
// no flicker (decision.css). "Ended" is not red: the title is --text, and the
// card turns neutral while the question stays readable.
import type { ReactNode } from "react";
import { useT, type TFunction } from "../../i18n";
import { StateMark } from "../StateMark";
import { ExternalLinkGlyph } from "../action-glyphs";
import { richText } from "../settings-rich";
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

const mono = (text: string) => <code className="dc-mono">{text}</code>;

/** "Running npm test." only when the picked row runs the card's command: a
 *  refusal, or words for Claude, run nothing. */
function runsCommand(o: Extract<Outcome, { kind: "sent" }>, model: DecisionModel): boolean {
  const answer = o.answer;
  return !!model.command && answer.kind !== "many" && model.options[answer.index]?.runs === true;
}

/** The words of an outcome, or null when there is no panel to draw. */
export function outcomeWords(o: Outcome, model: DecisionModel, a: OutcomeActions, t: TFunction): Words | null {
  const openTerm = { label: t("board.decision.openTerm"), run: a.onShowTerm };
  switch (o.kind) {
    case "none":
      return null;
    case "checking":
      return { glyph: <StageGlyph kind="working" />, title: t("board.decision.checking.title"), sub: t("board.decision.checking.sub") };
    case "sent":
      return {
        glyph: <StageGlyph kind="done" />,
        title: t("board.decision.sent.title", { session: model.session }),
        tone: "ok",
        sub: runsCommand(o, model)
          ? richText(t("board.decision.sent.running", { command: "{command}" }), { command: mono(model.command!) })
          : t("board.decision.sent.answer"),
      };
    case "changed":
      // No question the card can name: the screen moved on to something else.
      return o.now
        ? {
          glyph: <ChangedGlyph />,
          title: t("board.decision.changed.title"),
          sub: richText(t("board.decision.changed.now", { question: "{question}" }), { question: mono(o.now) }),
          link: { label: t("board.decision.changed.show"), run: a.onShowNew },
        }
        : { glyph: <ChangedGlyph />, title: t("board.decision.changed.title"), sub: t("board.decision.changed.term"), link: openTerm };
    case "ended":
      return {
        glyph: <span className="dc-err"><StateMark kind="err" size={14} /></span>,
        title: t("board.decision.ended.title", { session: model.session }),
        sub: t("board.decision.ended.sub"),
        link: { label: t("board.decision.ended.transcript"), run: a.onOpenTranscript },
      };
    case "held":
      return { glyph: <StageGlyph kind="idle" />, title: t("board.decision.held.title"), sub: t("board.decision.held.sub"), link: openTerm };
    case "elsewhere":
      return { glyph: <StageGlyph kind="done" />, title: t("board.decision.elsewhere.title", { at: o.at }), sub: t("board.decision.elsewhere.sub") };
    case "stopped":
      return o.part
        ? { glyph: <ChangedGlyph />, title: t("board.decision.partial.title"), sub: t("board.decision.partial.sub"), link: openTerm }
        : { glyph: <ChangedGlyph />, title: t("board.decision.stopped.title"), sub: t("board.decision.stopped.sub"), link: openTerm };
  }
}

export default function DecisionOutcome({ outcome, model, ...actions }: { outcome: Outcome; model: DecisionModel } & OutcomeActions) {
  const t = useT();
  const words = outcomeWords(outcome, model, actions, t);
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
