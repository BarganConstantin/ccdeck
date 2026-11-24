// The pieces of a conversation, one per kind of line (the kit's Chat parts):
// what you typed, a slash command you ran, what the assistant said, a tool
// call, the record of an answer, the task list, a sub-agent, a notice, and the
// divider that says what happened since you looked.
//
// ONE QUIET LINE, DETAIL ON DEMAND. A failed call says "Failed" and an edit its
// "+4 −1" on the row; the error or the change opens under it from the row's
// own button. Only the conversation's last task list is drawn whole (ChatView
// says which); earlier ones are a line each, folded in with the tool calls.
//
// NEW LINES APPEAR WITH NO MOTION. A line is drawn where it belongs and that is
// all; there is no entrance, no highlight, no scroll animation.
import {
  AgentGlyph, ChevronRightGlyph, DoneGlyph, FileGlyph, ImageGlyph, SearchGlyph, TodoActiveGlyph, TodoPendingGlyph, ToolTerminalGlyph,
} from "./chat-icons";
import { t as tNow, useT, type TFunction } from "../../i18n";
import type { ChatActivity, ChatAsk, ChatDiff, ChatOutgoing, ChatQuestion, ChatSince, ChatTodo, ChatTurn as Turn } from "./chat-model";
import type { Provider } from "../../types";
import ProviderAvatar from "../ProviderAvatar";
import { providerLabel } from "../../provider-copy";
import ChatMarkdown from "./ChatMarkdown";
import { useEffect, useId, useRef, useState } from "react";
import { answerable, MAX_ASK_TEXT, offersChat, picksComplete, type AskPick } from "../../ask-keys";
import type { AskSendResult } from "../../use-terminal-session";
import { copyText } from "../../copy-text";
import { CopyGlyph } from "../terminal/stage-icons";
import { CODEX_TOOL_LABEL } from "../../tool-taxonomy";

/** What you typed, and a chip that counts the images you sent with it: under
 *  the words, or alone when you sent only images. The images themselves are
 *  never in the transcript Chat reads. */
export function YourMessage({ text, images }: { text: string; images?: number }) {
  const t = useT();
  return (
    <div className="chat-you">
      <span className="chat-author">{t("board.chat.you")}</span>
      {text && <p className="chat-you-text">{text.replace(/\r\n?/g, "\n")}</p>}
      {images ? <span className="chat-you-images"><span className="chat-you-images-mark"><ImageGlyph /></span>{t("board.chat.images", { count: images })}</span> : null}
    </div>
  );
}

/** A message you sent from Chat that the conversation does not show yet, with
 *  where it stands under it: on its way, or not taken by the agent, which may
 *  have left it in Term's input. Taken, it is your message as any other until
 *  the conversation is read again. Never a Retry: the first may still be in
 *  Term, and a second would be the same message twice. */
export function OutgoingMessage({ outgoing, provider, onShowTerm }: { outgoing: ChatOutgoing; provider?: Provider; onShowTerm?: () => void }) {
  const t = useT();
  const late = outgoing.state === "unconfirmed";
  return (
    <div className="chat-you" data-outgoing={outgoing.state}>
      <span className="chat-author">{t("board.chat.you")}</span>
      <p className="chat-you-text">{outgoing.text.replace(/\r\n?/g, "\n")}</p>
      {outgoing.state !== "taken" && (
        <p className="chat-you-state">
          <span>{late ? t("board.chat.progress.unconfirmed", { agent: providerLabel(provider) }) : t("board.chat.progress.sending")}</span>
          {late && onShowTerm && <button type="button" className="chat-ask-term" onClick={onShowTerm}>{t("board.chat.showTerm")}</button>}
        </p>
      )}
    </div>
  );
}

/** What the session is doing, under the conversation's last line: at work,
 *  with the header's tool and time, or silent for a while with the way to
 *  Term; or waiting on you where no card in Chat asks it. A still mark, never
 *  a spinner: nothing in Chat moves. */
export function ActivityLine({ activity, provider, onShowTerm }: { activity: ChatActivity; provider?: Provider; onShowTerm?: () => void }) {
  const t = useT();
  const words = activity.state === "working" ? t("board.chat.progress.working", { agent: providerLabel(provider) }) : t("board.chat.ask.waiting");
  const rest = activity.quiet ? t("board.chat.progress.quiet", { time: activity.quiet }) : activity.detail;
  return (
    <div className="chat-progress" data-state={activity.state} data-quiet={activity.quiet ? "" : undefined}>
      <span className="chat-progress-mark" aria-hidden="true" />
      <span className="chat-progress-text">{words}</span>
      {rest && <span className="chat-progress-detail" title={rest}>{rest}</span>}
      {activity.quiet && onShowTerm && <button type="button" className="chat-ask-term" onClick={onShowTerm}>{t("board.chat.showTerm")}</button>}
    </div>
  );
}

/** A slash command you ran, as you typed it ("/model opus"), and what it
 *  printed under it: wrapped, scrolled inside its own block, in --warn when it
 *  came on stderr as a failed call's "Failed" is. */
export function YourCommand({ turn }: { turn: Extract<Turn, { kind: "command" }> }) {
  const t = useT();
  return (
    <div className="chat-you">
      <span className="chat-author">{t("board.chat.you")}</span>
      <p className="chat-command-line"><code>{turn.args ? `${turn.name} ${turn.args}` : turn.name}</code></p>
      {turn.output && <pre className="chat-command-output" data-failed={turn.failed || undefined}><code>{turn.output}</code></pre>}
    </div>
  );
}

export function AssistantText({ text }: { text: string }) {
  return <div className="chat-said"><ChatMarkdown text={text} /></div>;
}

const MARKS = { file: FileGlyph, search: SearchGlyph, terminal: ToolTerminalGlyph } as const;

type ToolTurn = Extract<Turn, { kind: "tool" }>;
type TodoTurn = Extract<Turn, { kind: "todo" }>;

/** Which way a diff line goes: added, removed, kept, or the gap between two hunks. */
export function diffOp(line: string): "add" | "del" | "ctx" | "gap" {
  if (line === "…") return "gap";
  return line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
}

/** An edit's change: one line per diff line, scrolled inside its own block. */
export function DiffBlock({ diff }: { diff: ChatDiff }) {
  const t = useT();
  return <>
    <pre className="chat-diff"><code>{diff.lines.map((line, i) =>
      <span key={i} className="chat-diff-line" data-op={diffOp(line)}>{line}</span>)}</code></pre>
    {diff.cut && <p className="chat-diff-cut">{t("board.chat.diff.cut")}</p>}
  </>;
}

/** The word a tool row shows. Codex's raw names ("exec_command",
 *  "apply_patch") read as the board shows them ("Shell", "Edit"); the raw name
 *  stays in the tooltip. Only the table's own keys count, so a tool named
 *  "toString" is shown as it is. */
export function toolLabel(name: string): string {
  return Object.hasOwn(CODEX_TOOL_LABEL, name) ? CODEX_TOOL_LABEL[name] : name;
}

export function ToolRow({ turn }: { turn: ToolTurn }) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const Mark = MARKS[turn.mark ?? (turn.name === "Bash" ? "terminal" : turn.name === "Explore" ? "search" : "file")];
  const failed = turn.error !== undefined;
  const label = toolLabel(turn.name);
  const content = <>
    <span className="chat-tool-mark"><Mark /></span>
    <span className="chat-tool-name" title={label === turn.name ? undefined : turn.name}>{label}</span>
    <span className="chat-tool-arg" title={turn.arg}>{turn.arg}</span>
    {turn.note && <span className="chat-tool-note">{turn.note}</span>}
    {failed && <span className="chat-tool-failed">{t("board.chat.tool.failed")}</span>}
    {turn.declined && <span className="chat-tool-declined">{t("board.chat.tool.declined")}</span>}
  </>;
  // An error to read or a change to see: the row is a button that opens them,
  // with the whole argument above, as the plain row's disclosure shows it.
  if (turn.error || turn.diff?.lines.length) {
    return (
      <div className="chat-tool-call">
        <button type="button" className="chat-tool chat-tool-toggle" data-running={turn.running || undefined}
          aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(was => !was)}>
          <span className="chat-disclosure"><ChevronRightGlyph /></span>
          {content}
        </button>
        {open && (
          <div className="chat-tool-detail" id={id}>
            {turn.arg && <pre className="chat-tool-input"><code>{turn.arg}</code></pre>}
            {turn.error && <pre className="chat-tool-error"><code>{turn.error}</code></pre>}
            {turn.diff && turn.diff.lines.length > 0 && <DiffBlock diff={turn.diff} />}
          </div>
        )}
      </div>
    );
  }
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

/** "2 of 5 done": the items done, and how many there are. */
function todoCount(items: readonly ChatTodo[]) {
  return { done: items.filter(item => item.status === "done").length, total: items.length };
}

const TODO_MARKS = { done: DoneGlyph, active: TodoActiveGlyph, pending: TodoPendingGlyph } as const;

/** An earlier task list, or an emptied one: one muted line. */
export function TodoLine({ turn }: { turn: TodoTurn }) {
  const t = useT();
  const text = turn.items.length ? t("board.chat.todo.updated", todoCount(turn.items)) : t("board.chat.todo.cleared");
  return <div className="chat-tool chat-todo-line"><span className="chat-tool-mark"><DoneGlyph /></span><span className="chat-todo-line-text">{text}</span></div>;
}

/** The conversation's last task list, as a checklist: done items muted, the one
 *  being worked on picked out, the rest plain. An emptied list is its line. */
export function TodoList({ turn }: { turn: TodoTurn }) {
  const t = useT();
  if (!turn.items.length) return <TodoLine turn={turn} />;
  const head = t("board.chat.todo.head", todoCount(turn.items));
  return (
    <section className="chat-todo" aria-label={head}>
      <div className="chat-todo-head" aria-hidden="true">{head}</div>
      <ul className="chat-todo-list">{turn.items.map((item, i) => {
        const Mark = TODO_MARKS[item.status];
        return (
          <li key={i} className="chat-todo-item" data-status={item.status}>
            <span className="chat-todo-mark"><Mark /></span>
            <span className="chat-sr">{t(`board.chat.todo.${item.status}`)}</span>
            <span className="chat-todo-text">{item.text}</span>
          </li>
        );
      })}</ul>
    </section>
  );
}

/** "Sub-agent · Explore — Find the auth code", and whether it still runs. */
export function AgentLine({ turn }: { turn: Extract<Turn, { kind: "agent" }> }) {
  const t = useT();
  const state = turn.running ? "running" : turn.declined ? "declined" : turn.failed ? "failed" : turn.background ? "background" : "done";
  const label = { running: "board.chat.running", declined: "board.chat.tool.declined", failed: "board.chat.tool.failed",
    background: "board.chat.agent.background", done: "board.chat.agent.done" }[state];
  return (
    <div className="chat-tool chat-agent" data-state={state}>
      <span className="chat-tool-mark"><AgentGlyph /></span>
      <span className="chat-tool-name">{turn.type ? t("board.chat.agent.typed", { type: turn.type }) : t("board.chat.agent.title")}</span>
      {turn.description && <span className="chat-agent-desc" title={turn.description}>— {turn.description}</span>}
      <span className="chat-agent-state">{t(label)}</span>
    </div>
  );
}

/** "Interrupted", or the API's error line. */
export function NoticeLine({ turn }: { turn: Extract<Turn, { kind: "notice" }> }) {
  const t = useT();
  const text = turn.what === "interrupted" ? t("board.chat.notice.interrupted") : turn.text || t("board.chat.notice.error");
  return <p className="chat-notice" data-what={turn.what}>{text}</p>;
}

/** What folds into a run of tool calls: a call, or an earlier task list. */
type Folded = ToolTurn | TodoTurn;

/** The disclosure contains the actual calls; it never implies unseen output.
 *  Failed calls are counted on its head, so they show while it is closed. */
export function ToolGroup({ turns }: { turns: Folded[] }) {
  const t = useT();
  const running = turns.some(turn => turn.kind === "tool" && turn.running);
  const failed = turns.filter(turn => turn.kind === "tool" && turn.error !== undefined).length;
  return <details className="chat-activity" open={running || undefined}>
    <summary className="chat-activity-head">
      <span className="chat-disclosure"><ChevronRightGlyph /></span>
      <span>{t("board.chat.tools", { count: turns.length })}</span>
      {failed > 0 && <span className="chat-activity-failed">{t("board.chat.toolsFailed", { count: failed })}</span>}
      {running && <span className="chat-activity-running">{t("board.chat.running")}</span>}
    </summary>
    <div className="chat-activity-calls">{turns.map((turn, i) => turn.kind === "tool"
      ? <ToolRow key={i} turn={turn} />
      : <TodoLine key={i} turn={turn} />)}</div>
  </details>;
}

/** How a waiting question is answered, and which of the block's turns it is. */
export type LiveAsk = ChatAsk & { at: number };

/** Identify each response once. `todoAt` is which of the block's turns is the
 *  conversation's last task list, drawn whole; none when it is elsewhere. */
export function AssistantBlock({ turns, provider = "claude", ask, todoAt }: { turns: Turn[]; provider?: Provider; ask?: LiveAsk; todoAt?: number }) {
  // Never drawn for opencode or Copilot today (Chat reads no transcript of
  // theirs), and named by provider-copy.ts so it never says Claude Code if it is.
  const author = providerLabel(provider);
  const t = useT();
  const [copied, setCopied] = useState(false);
  const answer = turns.filter((turn): turn is Extract<Turn, { kind: "assistant" }> => turn.kind === "assistant").map(turn => turn.text).join("\n\n");
  useEffect(() => setCopied(false), [answer]);
  // Tool calls run together into one disclosure, and an earlier task list
  // joins them where its TodoWrite call sat. A run with no call in it is drawn
  // line by line: a disclosure of task lines alone would hide them.
  const parts: { index: number; turns: Turn[]; folded: boolean }[] = [];
  turns.forEach((turn, index) => {
    const folded = turn.kind === "tool" || (turn.kind === "todo" && index !== todoAt);
    const last = parts.at(-1);
    if (folded && last?.folded) last.turns.push(turn);
    else parts.push({ index, turns: [turn], folded });
  });
  return <section className="chat-response" aria-label={author}>
    <div className="chat-response-author"><ProviderAvatar provider={provider} /><span>{author}</span>
      {answer && <button type="button" className="glyph-btn chat-copy" title={t(copied ? "board.stage.copied" : "board.stage.copy")}
        aria-label={t(copied ? "board.stage.copied" : "board.stage.copy")}
        onClick={() => { void copyText(answer).then(ok => setCopied(ok)); }}><CopyGlyph /></button>}
    </div>
    <div className="chat-response-content">{parts.flatMap(part => {
      if (part.folded && part.turns.some(turn => turn.kind === "tool")) return [<ToolGroup key={part.index} turns={part.turns as Folded[]} />];
      return part.turns.map((turn, i) => <TurnRow key={part.index + i} turn={turn}
        ask={ask?.at === part.index + i ? ask : undefined} latest={todoAt === part.index + i} />);
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

export type AskState = "waiting" | "answered" | "unanswered" | "chatted";

/** Where a question card stands. Set aside with "Chat about this", it went
 *  without an answer on purpose: the card says so, not "Not answered". */
export function askState(turn: Extract<Turn, { kind: "ask" }>): AskState {
  if (turn.running) return "waiting";
  if (turn.chat) return "chatted";
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
 *  sent as the keys Term takes; otherwise the card is read only.
 *
 *  CHAT ABOUT THIS. Claude Code ends its question prompt with a row that sets
 *  the questions aside to talk them over first (ask-keys.ts). The card offers
 *  it the same way, last and apart from the answers: a quiet link at the end of
 *  the row that holds Send answer, never a row of its own. Pressed, it sends
 *  that row's keys through the same send as an answer, and the card says the
 *  questions were set aside; Claude then asks what you would like to clarify,
 *  and the reply goes in the box under the conversation. It shows only while
 *  it can be pressed: the question waits, the stage can write, and nothing
 *  went from the card yet. */
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
  // What the last press sent: the picks, or "Chat about this". Its outcome says which.
  const [chatting, setChatting] = useState(false);
  // Term drew the question without its "Chat about this" row (an older Claude
  // Code, or a prompt that has none): the link goes, and the status says so.
  const [chatMissing, setChatMissing] = useState(false);
  // The link goes while it sends: focus moves to the status line, which says
  // what happened, rather than falling to the page.
  const statusRef = useRef<HTMLParagraphElement>(null);
  // Typed text or a number is not picked from a list: such a question is answered in Term.
  const reachable = turn.questions.every(answerable);
  // Once keys went, the same answer is never sent twice from here.
  const done = result === "sent" || result === "partial";
  const locked = !live || sending || done || live.blocked !== undefined || !reachable;
  const ready = !locked && picksComplete(turn.questions, picks);
  // Set aside, nothing was chosen: a pick made before it wears no mark.
  const answered = done && !chatting;
  const canChat = !!live?.chat && !sending && !done && !chatMissing && live.blocked === undefined && offersChat(turn.questions);

  function update(i: number, pick: AskPick) {
    setPicks(previous => previous.map((old, at) => (at === i ? pick : old)));
    setResult(null);
  }

  async function send() {
    if (!live || !ready) return;
    setChatting(false);
    setSending(true);
    setResult(null);
    let outcome: AskSendResult;
    try { outcome = await live.send(turn.questions, picks); }
    catch { outcome = "unavailable"; }
    setSending(false);
    setResult(outcome);
  }

  async function chat() {
    if (!live?.chat || !canChat) return;
    statusRef.current?.focus({ preventScroll: true });
    setChatting(true);
    setSending(true);
    setResult(null);
    let outcome: AskSendResult;
    try { outcome = await live.chat(turn.questions); }
    catch { outcome = "unavailable"; }
    setSending(false);
    if (outcome === "changed") setChatMissing(true);
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
                      {on && answered && <span className="chat-ask-chosen"><DoneGlyph />{t("board.chat.ask.chosen")}</span>}
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
                  {pick.text !== undefined && answered && <span className="chat-ask-chosen"><DoneGlyph />{t("board.chat.ask.chosen")}</span>}
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
  // A failed "Chat about this" says what a failed answer says: part of it went,
  // or it could not go, with Show Term. When Term has no such row it says that,
  // and the answer is given there.
  const message = sending ? t(chatting ? "board.chat.ask.chatSending" : "board.chat.ask.sending")
    : result ? t(chatting && result === "sent" ? "board.chat.ask.result.chat"
      : chatting && result === "changed" ? "board.chat.ask.result.chatMissing"
      : RESULT_KEYS[result])
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
            <p id={`${id}-status`} ref={statusRef} tabIndex={-1} className="chat-ask-status" role="status" aria-live="polite"
              aria-atomic="true" data-result={result ?? undefined}>{message}</p>
            {showTerm && <button className="chat-ask-term" type="button" onClick={live.onShowTerm}>{t("board.chat.showTerm")}</button>}
            {canChat && <button className="chat-ask-term chat-ask-chat" type="button" onClick={() => { void chat(); }}>{t("board.chat.ask.chat")}</button>}
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

/** One turn. `latest` says a task list is the conversation's last, drawn whole. */
export function TurnRow({ turn, ask, latest }: { turn: Turn; ask?: ChatAsk; latest?: boolean }) {
  switch (turn.kind) {
    case "user": return <YourMessage text={turn.text} images={turn.images} />;
    case "command": return <YourCommand turn={turn} />;
    case "assistant": return <AssistantText text={turn.text} />;
    case "tool": return <ToolRow turn={turn} />;
    case "todo": return latest ? <TodoList turn={turn} /> : <TodoLine turn={turn} />;
    case "agent": return <AgentLine turn={turn} />;
    case "notice": return <NoticeLine turn={turn} />;
    // Other questions are another card: what was picked for the last never carries over.
    case "ask": return <AskCard key={turn.questions.map(q => q.question).join("\n")} turn={turn} ask={ask} />;
    case "plan": return <PlanCard turn={turn} />;
    case "record": return <RecordLine text={turn.text} />;
  }
}
