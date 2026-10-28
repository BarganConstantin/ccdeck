// One conversation with the people who make ccdeck, drawn as one: what the
// person wrote on the right, the team's replies on the left with the signature
// they were sent with over the first of a run, the status changes and other
// events as quiet lines between, a divider for each day, and a time under each
// run. The composer is at the bottom. It reads as a conversation and is not
// live chat: no presence, no typing, no read receipts — the API's statuses say
// where it stands (FeedbackConversations.tsx).
//
// THE API WORDS EVERY EVENT AND EVERY STATUS: an event line is the item's own
// text, a pill its label, and a type this deck does not know is drawn the same
// way, neutral (feedback-conversations.ts timeline). Links in what either side
// wrote are found by `linkify` and drawn as elements, never as HTML.
//
// THE COMPOSER. A box that grows with what is typed up to six lines, then
// scrolls; Send reply, never greyed out — aria-busy while a reply is out, a
// second press refused by the hook (#518) — and ⌘/Ctrl+Enter, as the Write
// tab sends. Opening a thread puts the caret in it. A reply that fails keeps
// every word and says why under the box; the draft outlives a look at the list.
//
// Screenshots stay on the web: the deck shows how many the opening message
// carried and links to the conversation on app.ccdeck.dev, opened only when
// the address is one a browser may be sent to (openableUrl).
import { Fragment, useEffect, useLayoutEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import { selfPressProps } from "../panel-press";
import { BODY_MAX, isSendShortcut } from "../feedback";
import {
  ALL_CONVERSATIONS, LINK_REL, LOADING_CONVERSATION, REPLY_LABEL, REPLY_PLACEHOLDER, REPLY_SEND, REPLY_SENDING, SHOW_EARLIER,
  TRY_AGAIN, highestSeq, imagesOnWeb, linkify, startedLine, statusTone, timeline, trackedLabel,
  type StatusView, type ThreadItem, type ThreadSummary,
} from "../feedback-conversations";
import { useThread } from "../use-feedback-conversations";
import { openableUrl } from "../use-account";

/** A status as its pill: the API's label, toned by its code. */
export function StatusPill({ status }: { status: StatusView }) {
  return <span className="fc-pill" data-tone={statusTone(status.code)}>{status.label}</span>;
}

/** What somebody wrote, with its web addresses as links. */
export function MessageText({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((part, i) => (part.url
        ? <a key={i} className="fc-link" href={part.url} rel={LINK_REL} target="_blank">{part.text}</a>
        : <Fragment key={i}>{part.text}</Fragment>))}
    </>
  );
}

/** The opening message's screenshots, as a way to them on the web. */
function ImagesOnWeb({ item, webUrl }: { item: ThreadItem; webUrl: string }) {
  const n = item.images?.length ?? 0;
  if (n === 0 || !openableUrl(webUrl)) return null;
  return <a className="fc-link fc-images" href={webUrl} target="_blank" rel="noopener noreferrer">{imagesOnWeb(n)}</a>;
}

/** The rows of a thread, as the timeline lays them out. */
export function Timeline({ items, webUrl, now }: { items: readonly ThreadItem[]; webUrl: string; now: number }) {
  return (
    <>
      {timeline(items, now).map(row => {
        if (row.kind === "day") return <p key={row.key} className="fc-day"><span>{row.label}</span></p>;
        if (row.kind === "event") {
          return (
            <p key={row.key} className="fc-event" data-type={row.known ? row.item.type : "other"}>
              <span><MessageText text={row.item.text} /></span>
              <time className="fc-time" dateTime={row.item.at}>{row.time}</time>
            </p>
          );
        }
        const last = row.messages[row.messages.length - 1];
        return (
          <div key={row.key} className="fc-run" data-side={row.side}>
            {row.side === "team"
              ? <p className="fc-signature">{row.signature ?? "ccdeck team"}</p>
              : <p className="vis-hidden">You</p>}
            {row.messages.map(m => (
              <div key={m.seq} className="fc-message">
                <p className="fc-bubble"><MessageText text={m.text} /></p>
                <ImagesOnWeb item={m} webUrl={webUrl} />
              </div>
            ))}
            <time className="fc-time" dateTime={last.at}>{row.time}</time>
          </div>
        );
      })}
    </>
  );
}

export default function FeedbackThread({ summary, latestAt, announce, onBack }: {
  summary: ThreadSummary;
  latestAt: string | null;
  announce: (words: string) => void;
  onBack: () => void;
}) {
  const t = useThread(summary.id, latestAt, announce);
  const thread = t.view?.thread ?? summary;
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  /** The newest and oldest item last drawn, and how far the view was from
   *  the bottom, so an earlier page keeps the reader where they were. */
  const shownTop = useRef(-1);
  const shownFirst = useRef(-1);
  const fromBottom = useRef(0);
  const now = Date.now();

  // Opening a thread puts the caret in its reply.
  useEffect(() => { composerRef.current?.focus(); }, []);

  // The latest in view: on the first page, and whenever a newer item arrives.
  // A page of earlier ones keeps what was being read where it was.
  useLayoutEffect(() => {
    const el = timelineRef.current;
    if (!el || t.items.length === 0) return;
    const top = highestSeq(t.items);
    const first = t.items[0].seq;
    if (top > shownTop.current) el.scrollTop = el.scrollHeight;
    else if (first < shownFirst.current) el.scrollTop = el.scrollHeight - fromBottom.current;
    shownTop.current = top;
    shownFirst.current = first;
    fromBottom.current = el.scrollHeight - el.scrollTop;
  }, [t.items]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!t.draft.trim()) {
      composerRef.current?.focus();
      return;
    }
    void t.reply();
  }

  function keys(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!isSendShortcut(e.nativeEvent)) return;
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  }

  const opening = t.items.find(i => i.seq === 0);

  return (
    <div className="fc-thread">
      <div className="fc-thread-head">
        <button type="button" className="fb-tool fc-back" onClick={onBack}>
          <span aria-hidden="true">←</span> {ALL_CONVERSATIONS}
        </button>
        <h3 className="fc-thread-title">{thread.title}</h3>
        <p className="fc-thread-meta">
          <StatusPill status={thread.status} />
          {thread.trackedIssue && openableUrl(thread.trackedIssue.url) && (
            <a className="fc-link" href={thread.trackedIssue.url} target="_blank" rel="noopener noreferrer">{trackedLabel(thread.trackedIssue)}</a>
          )}
          <span>{startedLine(thread.createdAt, opening?.via, now)}</span>
        </p>
      </div>
      <div ref={timelineRef} className="fc-timeline">
        {t.view?.earlier != null && (
          <button type="button" className="btn fc-earlier" onClick={() => void t.earlier()} {...selfPressProps(t.loadingEarlier)}>
            {SHOW_EARLIER}
          </button>
        )}
        {t.state === "loading" && <p className="fc-note">{LOADING_CONVERSATION}</p>}
        {t.problem && (
          <div className="fc-missing">
            <p className="fc-note">{t.problem}</p>
            {t.state === "failed" && <button type="button" className="btn" onClick={() => void t.reload()}>{TRY_AGAIN}</button>}
          </div>
        )}
        <Timeline items={t.items} webUrl={thread.webUrl} now={now} />
      </div>
      <form className="fc-composer" onSubmit={submit} noValidate>
        <label className="vis-hidden" htmlFor="fc-reply">{REPLY_LABEL}</label>
        <textarea
          ref={composerRef}
          id="fc-reply"
          className="ap-manage-input fc-reply"
          value={t.draft}
          maxLength={BODY_MAX}
          rows={1}
          placeholder={REPLY_PLACEHOLDER}
          onChange={e => t.setDraft(e.target.value)}
          onKeyDown={keys}
          aria-describedby={t.failure ? "fc-reply-error" : undefined}
        />
        <button type="submit" className="btn primary fc-send" aria-keyshortcuts="Meta+Enter Control+Enter" {...selfPressProps(t.sending)}>
          <span className="fb-send-label">
            <span className="fb-send-idle">{REPLY_SEND}</span>
            <span className="fb-send-busy">{REPLY_SENDING}</span>
          </span>
        </button>
      </form>
      {t.failure && <p id="fc-reply-error" className="fb-error fc-reply-error" role="alert">{t.failure}</p>}
    </div>
  );
}
