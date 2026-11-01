// Chat: the conversation of one session, in the Workspace pane, with the
// Decision card docked under it when a question waits.
//
// ON PROPS. ChatView draws the `source` it is handed (loading, an error, or the
// turns); the deck has no transcript to read yet, so the deck never hands it
// one, and a Chat|Term switch that would have nothing to show is not drawn
// (StageHeader draws it only when a source is given). Test and harness data
// live in __tests__/, never here.
//
// THE COLUMN stops at 760 and centres from 1920 up (chat.css). It sticks to the
// bottom as lines arrive, unless the reader scrolled up to read; there is no
// virtualisation in 4.0, and a host caps the turns it hands over.
import { useEffect, useLayoutEffect, useRef } from "react";
import IntegrationSkeleton from "../IntegrationSkeleton";
import DecisionCard, { type DecisionCardProps } from "../decision/DecisionCard";
import type { ChatSource } from "./chat-model";
import { SinceDivider, TurnRow } from "./ChatTurn";
import "./chat.css";

export const LOADING_LABEL = "Reading the conversation";
export const RETRY_LABEL = "Retry";

export interface ChatViewProps {
  source: ChatSource;
  /** The question docked under the chat. Its flag is the caller's to check. */
  decision?: DecisionCardProps;
}

/** The distance from the bottom, in px, under which the reader counts as at the bottom. */
export const BOTTOM_SLACK = 24;

/** Before paint in a browser, so the bottom never flashes the top; a plain effect
 *  where there is no layout to wait for (rendering to a string). */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function ChatView({ source, decision }: ChatViewProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);
  const count = source.state === "ready" ? source.turns.length : 0;
  // New lines keep the reader at the bottom, unless they scrolled up.
  useBeforePaint(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [count]);
  return (
    <div className="chat" data-docked={decision ? "" : undefined}>
      <div
        ref={scroller}
        className="chat-body"
        role="region"
        aria-label="Conversation"
        tabIndex={0}
        onScroll={e => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
        }}
      >
        <div className="chat-col">
          {source.state === "loading" && <IntegrationSkeleton label={LOADING_LABEL} rows={5} variant="lines" />}
          {source.state === "error" && (
            <div className="chat-error" role="alert">
              <span>{source.message}</span>
              {source.onRetry && <button type="button" className="chat-retry" onClick={source.onRetry}>{RETRY_LABEL}</button>}
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
