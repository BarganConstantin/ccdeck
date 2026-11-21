// The pieces of a conversation, one per kind of line (the kit's Chat parts):
// what you typed, what the assistant said, a tool call, the record of an
// answer, and the divider that says what happened since you looked.
//
// NEW LINES APPEAR WITH NO MOTION. A line is drawn where it belongs and that is
// all; there is no entrance, no highlight, no scroll animation.
import {
  ChevronRightGlyph, DoneGlyph, FileGlyph, SearchGlyph, ToolTerminalGlyph,
} from "./chat-icons";
import { t as tNow, useT, type TFunction } from "../../i18n";
import type { ChatAsk, ChatQuestion, ChatSince, ChatTurn as Turn } from "./chat-model";
import type { Provider } from "../../types";
import ProviderAvatar from "../ProviderAvatar";
import ChatMarkdown from "./ChatMarkdown";
import { useEffect, useId, useState } from "react";
import { answerable, MAX_ASK_TEXT, picksComplete, type AskPick } from "../../ask-keys";
import type { AskSendResult } from "../../use-terminal-session";
import { copyText } from "../../copy-text";
import { CopyGlyph } from "../terminal/stage-icons";

export function YourMessage({ text }: { text: string }) {
  const t = useT();
  return <div className="chat-you"><span className="chat-author">{t("board.chat.you")}</span><p className="chat-you-text">{text.replace(/\r\n?/g, "\n")}</p></div>;
}

export function AssistantText({ text }: { text: string }) {
  return <div className="chat-said"><ChatMarkdown text={text} /></div>;
}

const MARKS = { file: FileGlyph, search: SearchGlyph, terminal: ToolTerminalGlyph } as const;

export function ToolRow({ turn }: { turn: Extract<Turn, { kind: "tool" }> }) {
  const Mark = MARKS[turn.mark ?? (turn.name === "Bash" ? "terminal" : turn.name === "Explore" ? "search" : "file")];
  const content = <>
    <span className="chat-tool-mark"><Mark /></span>
    <span className="chat-tool-name">{turn.name}</span>
    <span className="chat-tool-arg" title={turn.arg}>{turn.arg}</span>
    {turn.note && <span className="chat-tool-note">{turn.note}</span>}
  </>;
  if (!turn.arg) return <div className="chat-tool" data-running={turn.running || undefined}>{content}</div>;
  return (
    <details className="chat-tool-call">
    <summary className="chat-tool" data-running={turn.running || undefined}>
      <span className="chat-disclosure"><ChevronRightGlyph /></span>
      {content}
    </summary>
    <pre className="chat-tool-input"><code>{turn.arg}</code></pre>
    </details>
  );
}

/** The disclosure contains the actual calls; it never implies unseen output. */
export function ToolGroup({ turns }: { turns: Extract<Turn, { kind: "tool" }>[] }) {
  const t = useT();
  const running = turns.some(turn => turn.running);
  return <details className="chat-activity" open={running || undefined}>
    <summary className="chat-activity-head">
      <span className="chat-disclosure"><ChevronRightGlyph /></span>
      <span>{t("board.chat.tools", { count: turns.length })}</span>
      {running && <span className="chat-activity-running">{t("board.chat.running")}</span>}
    </summary>
    <div className="chat-activity-calls">{turns.map((turn, i) => <ToolRow key={i} turn={turn} />)}</div>
  </details>;
}

/** How a waiting question is answered, and which of the block's turns it is. */
export type LiveAsk = ChatAsk & { at: number };

/** Identify each response once. */
export function AssistantBlock({ turns, provider = "claude", ask }: { turns: Turn[]; provider?: Provider; ask?: LiveAsk }) {
  const author = provider === "codex" ? "Codex" : "Claude Code";
  const t = useT();
  const [copied, setCopied] = useState(false);
  const answer = turns.filter((turn): turn is Extract<Turn, { kind: "assistant" }> => turn.kind === "assistant").map(turn => turn.text).join("\n\n");
  useEffect(() => setCopied(false), [answer]);
  const parts: { index: number; turns: Turn[] }[] = [];
  turns.forEach((turn, index) => {
    const last = parts.at(-1);
    if (turn.kind === "tool" && last?.turns[0]?.kind === "tool") last.turns.push(turn);
    else parts.push({ index, turns: [turn] });
  });
  return <section className="chat-response" aria-label={author}>
    <div className="chat-response-author"><ProviderAvatar provider={provider} /><span>{author}</span>
      {answer && <button type="button" className="glyph-btn chat-copy" title={t(copied ? "board.stage.copied" : "board.stage.copy")}
        aria-label={t(copied ? "board.stage.copied" : "board.stage.copy")}
        onClick={() => { void copyText(answer).then(ok => setCopied(ok)); }}><CopyGlyph /></button>}
    </div>
    <div className="chat-response-content">{parts.map(part => {
      const first = part.turns[0];
      return first.kind === "tool"
        ? <ToolGroup key={part.index} turns={part.turns as Extract<Turn, { kind: "tool" }>[]} />
        : <TurnRow key={part.index} turn={first} ask={ask?.at === part.index ? ask : undefined} />;
    })}</div>
  </section>;
}

/** Which options an answer names, and what it says besides them. Claude Code
 *  joins several choices with ", "; a label is matched whole first, so one
 *  that holds a comma still counts as one. */
export function readAnswer(question: ChatQuestion, answer: string): { chosen: Set<number>; other: string } {
  const chosen = new Set<number>();
  if (!answer) return { chosen, other: "" };
  const whole = question.options.findIndex(option => option.label === answer);
  if (whole >= 0) return { chosen: chosen.add(whole), other: "" };
  if (!question.multi) return { chosen, other: answer };
  const rest: string[] = [];
  for (const part of answer.split(", ")) {
    const at = question.options.findIndex(option => option.label === part);
    if (at >= 0) chosen.add(at);
    else rest.push(part);
  }
  return { chosen, other: rest.join(", ") };
}

export type AskState = "waiting" | "answered" | "unanswered";

export function askState(turn: Extract<Turn, { kind: "ask" }>): AskState {
  if (turn.running) return "waiting";
  return turn.reply || (turn.answers ?? []).some(Boolean) ? "answered" : "unanswered";
}

/** Whether a question takes your own words as well as its options: Claude Code
 *  offers "Type something" for one choice, but not beside a preview. */
export function takesText(question: ChatQuestion): boolean {
  return answerable(question) && !question.multi && !question.preview;
}

/** A pick after `n` was clicked: one choice replaces the last; several toggle. */
export function choose(question: ChatQuestion, pick: AskPick, n: number): AskPick {
  if (!question.multi) return { options: [n] };
  const options = pick.options.includes(n) ? pick.options.filter(o => o !== n) : [...pick.options, n];
  return { options: options.sort((a, b) => a - b) };
}

const RESULT_KEYS: Record<AskSendResult, string> = {
  sent: "board.chat.ask.result.sent",
  changed: "board.chat.ask.result.changed",
  partial: "board.chat.ask.result.partial",
  unavailable: "board.chat.ask.result.unavailable",
};

/** The questions the assistant asked you, their options, and what you chose.
 *  While one waits and the stage can answer it, its options are picked here and
 *  sent as the keys Term takes; otherwise the card is read only. */
export function AskCard({ turn, ask }: { turn: Extract<Turn, { kind: "ask" }>; ask?: ChatAsk }) {
  const t = useT();
  const id = useId();
  const state = askState(turn);
  const live = state === "waiting" ? ask : undefined;
  const [picks, setPicks] = useState<AskPick[]>(() => turn.questions.map(() => ({ options: [] })));
  // Your own words stay while an option is tried, as a draft would.
  const [drafts, setDrafts] = useState<string[]>(() => turn.questions.map(() => ""));
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<AskSendResult | null>(null);
  // Typed text or a number is not picked from a list: such a question is answered in Term.
  const reachable = turn.questions.every(answerable);
  // Once keys went, the same answer is never sent twice from here.
  const done = result === "sent" || result === "partial";
  const locked = !live || sending || done || live.blocked !== undefined || !reachable;
  const ready = !locked && picksComplete(turn.questions, picks);

  function update(i: number, pick: AskPick) {
    setPicks(previous => previous.map((old, at) => (at === i ? pick : old)));
    setResult(null);
  }

  async function send() {
    if (!live || !ready) return;
    setSending(true);
    setResult(null);
    let outcome: AskSendResult;
    try { outcome = await live.send(turn.questions, picks); }
    catch { outcome = "unavailable"; }
    setSending(false);
    setResult(outcome);
  }

  const questions = turn.questions.map((question, i) => {
    const { chosen, other } = readAnswer(question, turn.answers?.[i] ?? "");
    const pick = picks[i] ?? { options: [] };
    const name = `${id}-q${i}`;
    return (
      <div className="chat-ask-q" key={i} role="group" aria-labelledby={`${name}-text`}>
        {(question.header || question.multi) && (
          <div className="chat-ask-meta">
            {question.header && <span className="chat-ask-tag">{question.header}</span>}
            {question.multi && <span className="chat-ask-multi">{t("board.chat.ask.multi")}</span>}
          </div>
        )}
        <p className="chat-ask-question" id={`${name}-text`}>{question.question}</p>
        {question.options.length > 0 && (
          <ol className="chat-ask-options">
            {question.options.map((option, n) => {
              const text = (
                <span className="chat-ask-option-text">
                  <span className="chat-ask-option-label">{option.label}</span>
                  {option.description && <span className="chat-ask-option-note">{option.description}</span>}
                </span>
              );
              if (live) {
                const on = pick.text === undefined && pick.options.includes(n);
                return (
                  <li key={n} className="chat-ask-option chat-ask-choice" data-chosen={on || undefined}>
                    <label className="chat-ask-pick">
                      <input type={question.multi ? "checkbox" : "radio"} name={name} checked={on} disabled={locked}
                        onChange={() => update(i, choose(question, pick.text === undefined ? pick : { options: [] }, n))} />
                      {text}
                      {on && done && <span className="chat-ask-chosen"><DoneGlyph />{t("board.chat.ask.chosen")}</span>}
                    </label>
                  </li>
                );
              }
              return (
                <li key={n} className="chat-ask-option" data-chosen={chosen.has(n) || undefined}>
                  <span className="chat-ask-n" aria-hidden="true">{n + 1}</span>
                  {text}
                  {chosen.has(n) && <span className="chat-ask-chosen"><DoneGlyph />{t("board.chat.ask.chosen")}</span>}
                </li>
              );
            })}
            {live && takesText(question) && (
              <li className="chat-ask-option chat-ask-choice chat-ask-other" data-chosen={pick.text !== undefined || undefined}>
                <label className="chat-ask-pick">
                  <input type="radio" name={name} checked={pick.text !== undefined} disabled={locked}
                    onChange={() => update(i, { options: [], text: drafts[i] ?? "" })} />
                  <span className="chat-ask-option-label">{t("board.chat.ask.other")}</span>
                  {pick.text !== undefined && done && <span className="chat-ask-chosen"><DoneGlyph />{t("board.chat.ask.chosen")}</span>}
                </label>
                <input type="text" className="chat-ask-text" value={drafts[i] ?? ""} maxLength={MAX_ASK_TEXT} disabled={locked}
                  aria-label={t("board.chat.ask.other")} placeholder={t("board.chat.ask.otherHint")}
                  onChange={event => {
                    const value = event.currentTarget.value;
                    setDrafts(previous => previous.map((old, at) => (at === i ? value : old)));
                    update(i, { options: [], text: value });
                  }} />
              </li>
            )}
          </ol>
        )}
        {!live && other && <p className="chat-ask-answer"><span className="chat-ask-answer-label">{t("board.chat.ask.yourAnswer")}</span>{other}</p>}
      </div>
    );
  });

  // Blocked (connecting, offline, read only), the card only locks its options:
  // the reply box under it is handed the same reason and shows it with Show
  // Term, so the card does not say it a second time 150 px above.
  const message = sending ? t("board.chat.ask.sending")
    : result ? t(RESULT_KEYS[result])
    : !reachable ? t("board.chat.ask.inTerm")
    : "";
  const showTerm = live?.onShowTerm && !sending && result !== "sent"
    && (result !== null || !reachable);

  return (
    <section className="chat-ask" data-state={state} aria-label={t("board.chat.ask.title", { count: turn.questions.length })}>
      <div className="chat-ask-head">
        <span className="chat-ask-title">{t("board.chat.ask.title", { count: turn.questions.length })}</span>
        <span className="chat-ask-state">{t(`board.chat.ask.${state}`)}</span>
      </div>
      {live ? (
        <form className="chat-ask-form" data-locked={locked || undefined} onSubmit={event => { event.preventDefault(); void send(); }}>
          {questions}
          <div className="chat-ask-actions">
            <button className="btn primary chat-ask-send" type="submit" disabled={!ready}>{t("board.chat.ask.send")}</button>
            <p id={`${id}-status`} className="chat-ask-status" role="status" aria-live="polite" aria-atomic="true"
              data-result={result ?? undefined}>{message}</p>
            {showTerm && <button className="chat-ask-term" type="button" onClick={live.onShowTerm}>{t("board.chat.showTerm")}</button>}
          </div>
        </form>
      ) : questions}
      {turn.reply && <p className="chat-ask-answer"><span className="chat-ask-answer-label">{t("board.chat.ask.yourReply")}</span>{turn.reply}</p>}
    </section>
  );
}

/** A plan the assistant asks you to approve, drawn as prose so it can be read
 *  here. It waits in --warn as a question card does; the answer itself is the
 *  Decision card's, docked under the chat, so this card only says where it is.
 *  A plan longer than the transcript keeps says the rest is in Term. */
export function PlanCard({ turn }: { turn: Extract<Turn, { kind: "plan" }> }) {
  const t = useT();
  const state = turn.running ? "waiting" : turn.approved ? "approved" : "declined";
  return (
    <section className="chat-ask chat-plan" data-state={state === "waiting" ? "waiting" : state === "approved" ? "answered" : "unanswered"}
      aria-label={t("board.chat.plan.title")}>
      <div className="chat-ask-head">
        <span className="chat-ask-title">{t("board.chat.plan.title")}</span>
        <span className="chat-ask-state">{t(`board.chat.plan.${state}`)}</span>
      </div>
      {turn.text && <div className="chat-said chat-plan-text"><ChatMarkdown text={turn.text} /></div>}
      {turn.cut && <p className="chat-plan-cut">{t("board.chat.plan.cut")}</p>}
    </section>
  );
}

/** "You answered  1 · Yes, run it  ·  6m 42s after it asked": the text is the
 *  host's, spaces and all, and is drawn as given. */
export function RecordLine({ text }: { text: string }) {
  return <p className="chat-record">{text}</p>;
}

/** "Since you looked · 4 tool calls · now asking". */
export function sinceText(since: ChatSince, t: TFunction = tNow): string {
  return t("board.chat.since", { count: since.toolCalls, label: since.label });
}

export function SinceDivider({ since }: { since: ChatSince }) {
  const text = sinceText(since, useT());
  return (
    <div className="chat-since" role="separator" aria-label={text}>
      <span className="chat-since-line" aria-hidden="true" />
      <span className="chat-since-text" aria-hidden="true">{text}</span>
      <span className="chat-since-line" aria-hidden="true" />
    </div>
  );
}

export function TurnRow({ turn, ask }: { turn: Turn; ask?: ChatAsk }) {
  switch (turn.kind) {
    case "user": return <YourMessage text={turn.text} />;
    case "assistant": return <AssistantText text={turn.text} />;
    case "tool": return <ToolRow turn={turn} />;
    // Other questions are another card: what was picked for the last never carries over.
    case "ask": return <AskCard key={turn.questions.map(q => q.question).join("\n")} turn={turn} ask={ask} />;
    case "plan": return <PlanCard turn={turn} />;
    case "record": return <RecordLine text={turn.text} />;
  }
}
