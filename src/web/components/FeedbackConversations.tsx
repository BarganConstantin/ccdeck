// Your conversations: the threads a ccdeck account has with the people who
// make ccdeck, in the feedback dialog's second tab (FeedbackTabs.tsx).
//
// A LIST, THEN ONE THREAD. The tab opens on the list — one row per
// conversation, newest activity first: its title, its status, what was said
// last and when, and a dot while a reply is unread — and a row opens the
// thread in its place (FeedbackThread.tsx), with "← All conversations" back.
// They are tickets that read as a conversation, not live chat: nothing here
// says who is online or typing, and nothing polls; a reply arrives with the
// deck's status frames and the account's summary (use-feedback-conversations).
//
// THE ACCOUNT'S OWN CHUNK. The dialog loads this with React.lazy only once the
// tab is drawn, behind a boundary of its own; a deck with the account off never
// fetches it.
import { useRef, useState } from "react";
import { selfPressProps } from "../panel-press";
import {
  LOADING_CONVERSATIONS, MORE_CONVERSATIONS, NO_CONVERSATIONS, CONVERSATIONS_UNAVAILABLE, TRY_AGAIN,
  listTime, previewLine, type ThreadSummary,
} from "../feedback-conversations";
import { useThreadList } from "../use-feedback-conversations";
import type { ConversationsProps } from "./FeedbackTabs";
import FeedbackThread, { StatusPill } from "./FeedbackThread";

export default function FeedbackConversations({ account, active, announce }: ConversationsProps) {
  const [open, setOpen] = useState<ThreadSummary | null>(null);
  /** The row a thread was opened from, focused again on the way back. */
  const backTo = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const list = useThreadList(active && open === null, account.latestAt);
  const now = Date.now();

  if (open) {
    return (
      <FeedbackThread
        key={open.id}
        summary={open}
        latestAt={account.latestAt}
        announce={announce}
        onBack={() => {
          backTo.current = open.id;
          setOpen(null);
          // Once the list is drawn again, the row the reader came from.
          requestAnimationFrame(() => {
            listRef.current?.querySelector<HTMLElement>(`[data-thread="${CSS.escape(backTo.current ?? "")}"]`)?.focus();
          });
        }}
      />
    );
  }

  return (
    <div ref={listRef} className="fc-list-view">
      {list.state === "loading" && list.threads.length === 0 && <p className="fc-note">{LOADING_CONVERSATIONS}</p>}
      {list.state === "failed" && (
        <div className="fc-missing">
          <p className="fc-note">{CONVERSATIONS_UNAVAILABLE}</p>
          <button type="button" className="btn" onClick={() => void list.reload()}>{TRY_AGAIN}</button>
        </div>
      )}
      {list.state === "ready" && list.threads.length === 0 && <p className="fc-note">{NO_CONVERSATIONS}</p>}
      {list.threads.length > 0 && (
        <ul className="fc-list">
          {list.threads.map(thread => (
            <li key={thread.id}>
              <button type="button" className="fc-row" data-thread={thread.id} onClick={() => setOpen(thread)}>
                <span className="fc-row-head">
                  <span className="fc-row-title">{thread.title}</span>
                  <time className="fc-row-time" dateTime={thread.lastActivityAt}>{listTime(thread.lastActivityAt, now)}</time>
                </span>
                <span className="fc-row-foot">
                  <StatusPill status={thread.status} />
                  <span className="fc-row-preview">{previewLine(thread)}</span>
                  {thread.hasUnread && <span className="fc-dot" aria-hidden="true" />}
                  {thread.hasUnread && <span className="vis-hidden">, unread</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.next && (
        <button type="button" className="btn fc-more" onClick={() => void list.more()} {...selfPressProps(list.loadingMore)}>
          {MORE_CONVERSATIONS}
        </button>
      )}
    </div>
  );
}
