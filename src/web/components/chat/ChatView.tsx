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
import { useEffect, useLayoutEffect, useRef } from "react";
import IntegrationSkeleton from "../IntegrationSkeleton";
import { useT } from "../../i18n";
import DecisionCard, { type DecisionCardProps } from "../decision/DecisionCard";
import type { ChatSource, ChatTurn } from "./chat-model";
import { SinceDivider, TurnRow } from "./ChatTurn";
import "./chat.css";

export interface ChatViewProps {
  source: ChatSource;
  /** The question docked under the chat. Its flag is the caller's to check. */
  decision?: DecisionCardProps;
}

/** The distance from the bottom, in px, under which the reader counts as at the bottom. */
export const BOTTOM_SLACK = 24;

/** What identifies the last turn: its kind and what it says, and a tool row's state. */
export function tailKey(turn: ChatTurn | undefined): string {
  if (!turn) return "";
  return turn.kind === "tool" ? `tool|${turn.name}|${turn.arg}|${turn.note ?? ""}|${turn.running ? 1 : 0}` : `${turn.kind}|${turn.text}`;
}

/** Before paint in a browser, so the bottom never flashes the top; a plain effect
 *  where there is no layout to wait for (rendering to a string). */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function ChatView({ source, decision }: ChatViewProps) {
  const t = useT();
  const scroller = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);
  const count = source.state === "ready" ? source.turns.length : 0;
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
      <div
        ref={scroller}
        className="chat-body"
        role="region"
        aria-label={t("board.chat.conversation")}
        tabIndex={0}
        onScroll={e => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
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
              {source.turns.map((turn, i) => <TurnRow key={i} turn={turn} />)}
            </>
          )}
        </div>
      </div>
      {decision && <DecisionCard key={decision.model.id} {...decision} />}
    </div>
  );
}
