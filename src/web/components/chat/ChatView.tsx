// Chat: the conversation of one session, in the Workspace pane, with the
// Decision card docked under it when a question waits.
//
// ON PROPS. ChatView draws the `source` it is handed (loading, an error, or the
// turns); the stage reads it from the session's transcript, and a Chat|Term
// switch with nothing to show is not drawn (StageHeader draws it only when a
// view is given). Test and harness data live in __tests__/, never here.
//
// THE COLUMN stops at 776 and centres in a wider pane (chat.css). It sticks to the
// bottom as lines arrive, unless the reader scrolled up to read; there is no
// virtualisation in 4.0, and a host caps the turns it hands over.
//
// OLDER TURNS come on request: a quiet button at the top while the host has
// more (`source.older`). When they arrive above, the line being read stays
// where it was: the height above it grew by what was put in, and the scroll
// moves by the same. `source.head` says when that happened.
//
// WHERE IT STANDS comes last (chat-progress.ts decides it): a message sent from
// here that the conversation does not show yet, with "Sending…" or why it was
// not taken under it, and what the session is doing. While the message is on
// its way, the session's work is the turn before it, so that line goes first.
// A screen reader hears each change of state once, in words, never the clock
// or the tool that ticks beside them; a switch to another session says nothing.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import IntegrationSkeleton from "../IntegrationSkeleton";
import type { Provider } from "../../types";
import { useT, type TFunction } from "../../i18n";
import { providerLabel } from "../../provider-copy";
import { stoppedInChat } from "../../chat-progress";
import DecisionCard, { type DecisionCardProps } from "../decision/DecisionCard";
import type { ChatActivity, ChatAsk, ChatOutgoing, ChatSource, ChatTurn } from "./chat-model";
import { conversationBlocks } from "./chat-model";
import { ActivityLine, AssistantBlock, OutgoingMessage, RecordLine, SinceDivider, YourCommand, YourMessage } from "./ChatTurn";
import "./chat.css";

export interface ChatViewProps {
  source: ChatSource;
  provider?: Provider;
  /** The question docked under the chat. Its flag is the caller's to check. */
  decision?: DecisionCardProps;
  /** How a waiting question is answered from here; without it the card is read only. */
  ask?: ChatAsk;
  /** Which session's conversation this is: a change of it is a switch, never news. */
  session?: string;
  /** A message sent from here that the conversation does not show yet. */
  outgoing?: ChatOutgoing;
  /** What the session is doing, under the last line. */
  activity?: ChatActivity;
  /** The way to Term, for a message not taken or a session gone quiet. */
  onShowTerm?(): void;
}

/** Where the conversation stands, in one word: what the live region follows. */
export function progressCue(outgoing?: ChatOutgoing, activity?: ChatActivity): string {
  if (outgoing && outgoing.state !== "taken") return outgoing.state;
  if (!activity) return "";
  return activity.state === "working" && activity.quiet ? "quiet" : activity.state;
}

/** What a screen reader hears when the cue moves from `was` to `cue`: the new
 *  state, or once its work is over, that the session finished, or that the
 *  turn was stopped when the conversation ends on that. */
export function progressSaid(cue: string, was: string, t: TFunction, agent: string, quiet = "", stopped = false): string {
  switch (cue) {
    case "sending": return t("board.chat.progress.sending");
    case "unconfirmed": return t("board.chat.progress.unconfirmed", { agent });
    case "working": return t("board.chat.progress.working", { agent });
    case "quiet": return t("board.chat.progress.quiet", { time: quiet });
    case "waiting": return t("board.chat.ask.waiting");
    default: return was !== "working" && was !== "quiet" ? ""
      : stopped ? t("board.chat.notice.interrupted") : t("board.chat.progress.done", { agent });
  }
}

/** The turn a waiting question card answers: the last turn, when it is one. */
export function liveAskAt(turns: readonly ChatTurn[]): number {
  const at = turns.length - 1;
  const last = turns[at];
  return last?.kind === "ask" && last.running ? at : -1;
}

/** The conversation's last task list, the one drawn whole; -1 when there is none.
 *  Each TodoWrite call is the whole list, so the earlier ones are history. */
export function lastTodoAt(turns: readonly ChatTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].kind === "todo") return i;
  return -1;
}

/** Where `at` falls in a block of `length` turns starting at `start`, or undefined outside it. */
const inBlock = (at: number, start: number, length: number) => (at >= start && at < start + length ? at - start : undefined);

/** The distance from the bottom, in px, under which the reader counts as at the bottom. */
export const BOTTOM_SLACK = 24;

/** What identifies the last turn: its kind and what it says, and a tool row's,
 *  a question card's, a task list's or a sub-agent's state, a command's output
 *  as it arrives and grows, and the images counted on a message. */
export function tailKey(turn: ChatTurn | undefined): string {
  if (!turn) return "";
  if (turn.kind === "user") return `user|${turn.text}|${turn.images ?? 0}`;
  if (turn.kind === "command") return `command|${turn.name}|${turn.args ?? ""}|${turn.failed ? 1 : 0}|${turn.output ?? ""}`;
  if (turn.kind === "tool") return `tool|${turn.name}|${turn.arg}|${turn.note ?? ""}|${turn.running ? 1 : 0}|${turn.error === undefined ? 0 : 1}|${turn.declined ? 1 : 0}`;
  if (turn.kind === "ask") return `ask|${turn.questions.map(q => q.question).join("\n")}|${turn.running ? 1 : 0}|${(turn.answers ?? []).join("\n")}|${turn.reply ?? ""}`;
  if (turn.kind === "plan") return `plan|${turn.text}|${turn.running ? 1 : 0}|${turn.approved ? 1 : 0}`;
  if (turn.kind === "todo") return `todo|${turn.items.map(item => `${item.status}:${item.text}`).join("\n")}`;
  if (turn.kind === "agent") return `agent|${turn.type}|${turn.description}|${turn.running ? 1 : 0}|${turn.failed ? 1 : 0}|${turn.declined ? 1 : 0}|${turn.background ? 1 : 0}`;
  if (turn.kind === "notice") return `notice|${turn.what}|${turn.text ?? ""}`;
  return `${turn.kind}|${turn.text}`;
}

/** Before paint in a browser, so the bottom never flashes the top; a plain effect
 *  where there is no layout to wait for (rendering to a string). */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function ChatView({ source, provider, decision, ask, session, outgoing, activity, onShowTerm }: ChatViewProps) {
  const t = useT();
  const scroller = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);
  const [following, setFollowing] = useState(true);
  const count = source.state === "ready" ? source.turns.length : 0;
  const live = source.state === "ready" ? liveAskAt(source.turns) : -1;
  const todo = source.state === "ready" ? lastTodoAt(source.turns) : -1;
  const cue = progressCue(outgoing, activity);
  // The message on its way and the session's state are the last lines too.
  const tail = `${source.state === "ready" ? tailKey(source.turns[source.turns.length - 1]) : ""}|${cue}|${outgoing?.state ?? ""}|${outgoing?.text ?? ""}`;
  // What the live region says: one sentence per change of state in this session.
  const [said, setSaid] = useState("");
  const cueWas = useRef(cue);
  const sessionWas = useRef(session);
  useEffect(() => {
    const was = cueWas.current;
    cueWas.current = cue;
    if (sessionWas.current !== session) {
      sessionWas.current = session;
      setSaid("");
      return;
    }
    if (cue !== was) setSaid(progressSaid(cue, was, t, providerLabel(provider), activity?.quiet, source.state === "ready" && stoppedInChat(source.turns)));
    // The words are chosen when the state moves, not again on a language change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cue, session]);
  const head = source.state === "ready" ? source.head ?? 0 : 0;
  const older = source.state === "ready" ? source.older : undefined;
  // How tall the conversation was before turns went in at the top: read while
  // rendering, before the new ones reach the page.
  const anchorHead = useRef(head);
  const anchorHeight = useRef(0);
  if (head !== anchorHead.current && scroller.current) anchorHeight.current = scroller.current.scrollHeight;
  const pressed = useRef(false);
  // New lines keep the reader at the bottom, unless they scrolled up. The last
  // turn counts as well as how many there are: once a host's cap slides the
  // window, a new line pushes an old one out and the count stays the same.
  useBeforePaint(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [count, tail]);
  // Turns put in at the top: the line being read stays in place.
  useBeforePaint(() => {
    const el = scroller.current;
    const wasHeight = anchorHeight.current;
    if (head === anchorHead.current) return;
    anchorHead.current = head;
    anchorHeight.current = 0;
    if (!el) return;
    if (!stuck.current) el.scrollTop += el.scrollHeight - wasHeight;
    // The button pressed is gone once the start is reached: the reading region keeps the keys.
    if (pressed.current && !older && typeof document !== "undefined" && (document.activeElement === null || document.activeElement === document.body)) {
      el.focus({ preventScroll: true });
    }
    pressed.current = false;
  }, [head]);
  const mine = outgoing ? <OutgoingMessage outgoing={outgoing} provider={provider} onShowTerm={onShowTerm} /> : null;
  const doing = activity ? <ActivityLine activity={activity} provider={provider} onShowTerm={onShowTerm} /> : null;
  return (
    <div className="chat" data-docked={decision ? "" : undefined}>
      <div className="chat-reading">
      <div
        ref={scroller}
        className="chat-body"
        role="region"
        aria-label={t("board.chat.conversation")}
        tabIndex={0}
        onScroll={e => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
          setFollowing(stuck.current);
        }}
      >
        <div className="chat-col">
          {source.state === "loading" && <IntegrationSkeleton label={t("board.chat.loading")} rows={5} variant="lines" />}
          {/* The empty conversation's own line and look: nothing went wrong. */}
          {source.state === "absent" && <p className="chat-empty">{source.message}</p>}
          {source.state === "error" && (
            <div className="chat-error" role="alert">
              <span>{source.message}</span>
              {source.onRetry && <button type="button" className="chat-retry" onClick={source.onRetry}>{t("board.chat.retry")}</button>}
            </div>
          )}
          {source.state === "ready" && (
            <>
              {older && (
                <button type="button" className="chat-retry chat-older" aria-busy={older.loading || undefined}
                  onClick={() => {
                    if (older.loading) return;
                    pressed.current = true;
                    older.load();
                  }}>
                  {t(older.loading ? "board.chat.olderLoading" : older.failed ? "board.chat.olderFailed" : "board.chat.older")}
                </button>
              )}
              {source.since && <SinceDivider since={source.since} />}
              {source.turns.length === 0 && <p className="chat-empty">{t("board.chat.empty")}</p>}
              {/* Keyed from where the turns were before any went in at the top,
                  so a turn keeps its row (and what is open in it) when older ones arrive. */}
              {conversationBlocks(source.turns).map(block => block.kind === "assistant"
                ? <AssistantBlock key={block.index - head} turns={block.turns} provider={provider}
                  ask={ask && live >= block.index && live < block.index + block.turns.length ? { ...ask, at: live - block.index } : undefined}
                  todoAt={inBlock(todo, block.index, block.turns.length)} />
                : block.kind === "user" ? <YourMessage key={block.index - head} text={block.text} images={block.images} />
                : block.kind === "command" ? <YourCommand key={block.index - head} turn={block} />
                : <RecordLine key={block.index - head} text={block.text} />)}
            </>
          )}
          {(source.state === "ready" || source.state === "error") && (outgoing && outgoing.state !== "taken" ? <>{doing}{mine}</> : <>{mine}{doing}</>)}
        </div>
      </div>
      {!following && source.state === "ready" && source.turns.length > 0 && (
        <button type="button" className="chat-latest btn" onClick={() => {
          const el = scroller.current;
          stuck.current = true;
          if (el) {
            el.scrollTop = el.scrollHeight;
            el.focus({ preventScroll: true });
          }
          setFollowing(true);
        }}>{t("board.chat.latest")}</button>
      )}
      </div>
      {decision && <DecisionCard key={decision.model.id} {...decision} />}
      <p key={session} className="chat-sr" role="status" aria-live="polite" aria-atomic="true">{said}</p>
    </div>
  );
}
