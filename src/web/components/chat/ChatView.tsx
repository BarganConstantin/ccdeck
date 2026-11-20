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
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import IntegrationSkeleton from "../IntegrationSkeleton";
import type { Provider } from "../../types";
import { useT } from "../../i18n";
import DecisionCard, { type DecisionCardProps } from "../decision/DecisionCard";
import type { ChatAsk, ChatSource, ChatTurn } from "./chat-model";
import { conversationBlocks } from "./chat-model";
import { AssistantBlock, RecordLine, SinceDivider, YourMessage } from "./ChatTurn";
import "./chat.css";

export interface ChatViewProps {
  source: ChatSource;
  provider?: Provider;
  /** The question docked under the chat. Its flag is the caller's to check. */
  decision?: DecisionCardProps;
  /** How a waiting question is answered from here; without it the card is read only. */
  ask?: ChatAsk;
}

/** The turn a waiting question card answers: the last turn, when it is one. */
export function liveAskAt(turns: readonly ChatTurn[]): number {
  const at = turns.length - 1;
  const last = turns[at];
  return last?.kind === "ask" && last.running ? at : -1;
}

/** The distance from the bottom, in px, under which the reader counts as at the bottom. */
export const BOTTOM_SLACK = 24;

/** What identifies the last turn: its kind and what it says, and a tool row's
 *  or a question card's state. */
export function tailKey(turn: ChatTurn | undefined): string {
  if (!turn) return "";
  if (turn.kind === "tool") return `tool|${turn.name}|${turn.arg}|${turn.note ?? ""}|${turn.running ? 1 : 0}`;
  if (turn.kind === "ask") return `ask|${turn.questions.map(q => q.question).join("\n")}|${turn.running ? 1 : 0}|${(turn.answers ?? []).join("\n")}|${turn.reply ?? ""}`;
  return `${turn.kind}|${turn.text}`;
}

/** Before paint in a browser, so the bottom never flashes the top; a plain effect
 *  where there is no layout to wait for (rendering to a string). */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function ChatView({ source, provider, decision, ask }: ChatViewProps) {
  const t = useT();
  const scroller = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);
  const [following, setFollowing] = useState(true);
  const count = source.state === "ready" ? source.turns.length : 0;
  const live = source.state === "ready" ? liveAskAt(source.turns) : -1;
  const tail = source.state === "ready" ? tailKey(source.turns[source.turns.length - 1]) : "";
  // New lines keep the reader at the bottom, unless they scrolled up. The last
  // turn counts as well as how many there are: once a host's cap slides the
  // window, a new line pushes an old one out and the count stays the same.
  useBeforePaint(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [count, tail]);
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
          {source.state === "error" && (
            <div className="chat-error" role="alert">
              <span>{source.message}</span>
              {source.onRetry && <button type="button" className="chat-retry" onClick={source.onRetry}>{t("board.chat.retry")}</button>}
            </div>
          )}
          {source.state === "ready" && (
            <>
              {source.since && <SinceDivider since={source.since} />}
              {source.turns.length === 0 && <p className="chat-empty">{t("board.chat.empty")}</p>}
              {conversationBlocks(source.turns).map(block => block.kind === "assistant"
                ? <AssistantBlock key={block.index} turns={block.turns} provider={provider}
                  ask={ask && live >= block.index && live < block.index + block.turns.length ? { ...ask, at: live - block.index } : undefined} />
                : block.kind === "user" ? <YourMessage key={block.index} text={block.text} />
                : <RecordLine key={block.index} text={block.text} />)}
            </>
          )}
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
    </div>
  );
}
