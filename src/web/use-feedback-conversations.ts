// Your conversations, as the dialog holds them: the list, one open thread, the
// reply being written, and what is marked read. Every read and write goes
// through the deck's own routes (/api/account/feedback/threads*), which make
// the call with the device token; the page never holds it. Nothing is kept
// here past the page: conversations are fetched when they are wanted.
//
// NO POLLING. The deck learns about a reply from its status frames (every
// fifteen seconds), and the account's summary reaches the page through
// feedback-unread.ts. `latestAt` changing there is the cue: the list is fetched
// again when its tab opens and when it changes, and so is the open thread.
//
// READ WHEN SEEN. Opening a thread, and new items arriving while it is shown
// and the page is visible, post `read` up to the highest item shown — and a
// page that comes back into view does it then. The answer is the account's
// summary, which clears the dot at once (account-service.mjs).
//
// A REPLY IS NEVER LOST. Its draft lives in a module-level map per thread for
// as long as the page is open, through a look at the list and back; a reply
// that fails keeps every word in the box and says why. Send reply is never
// disabled: while one is out it says aria-busy and this refuses a second press
// itself, off a ref (#518).
//
// IN THE ACCOUNT'S OWN CHUNK, with feedback-conversations.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import { selfPressAccepted } from "./panel-press";
import {
  CONVERSATION_GONE, CONVERSATIONS_UNAVAILABLE, NEW_REPLY, REPLY_REFUSED, REPLY_SENT, REPLY_UNAVAILABLE,
  highestSeq, limitLine, mergeItems, parseReplyCreated, parseThreadList, parseThreadView,
  type ThreadItem, type ThreadSummary, type ThreadView,
} from "./feedback-conversations";

export const THREADS_ROUTE = "/api/account/feedback/threads";
const threadRoute = (id: string) => `${THREADS_ROUTE}/${encodeURIComponent(id)}`;

/** A local route's answer: the status and the body, null when it would not read. */
async function call(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  try {
    const r = await fetch(path, { headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) }, ...init });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}
const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

/** Reply drafts, per thread, for the page's life. */
export const replyDrafts = new Map<string, string>();

/** What a refused reply says, by the deck's `reason` (ccdeck-account-routes.mjs). */
export function replyFailure(status: number, answer: { reason?: unknown; limit?: unknown; retryAfterSec?: unknown } | null, now = Date.now()): string {
  const reason = answer?.reason;
  if (reason === "too_many" && Number.isInteger(answer?.limit) && Number.isInteger(answer?.retryAfterSec)) {
    return limitLine("replies", answer!.limit as number, new Date(now + (answer!.retryAfterSec as number) * 1000));
  }
  if (reason === "not_found" || status === 404) return CONVERSATION_GONE;
  if (reason === "invalid" || reason === "too_large" || reason === "bad_request") return REPLY_REFUSED;
  return REPLY_UNAVAILABLE;
}

export type ListState = "loading" | "ready" | "failed";

/** The list: fetched when `active` becomes true and whenever `latestAt`
 *  changes while it is, latest activity first, with "More" for the next page. */
export function useThreadList(active: boolean, latestAt: string | null) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<ListState>("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  /** Each fetch's number: an answer to an older one is dropped. */
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const { status, body } = await call(THREADS_ROUTE);
    if (mine !== generation.current) return;
    const list = status === 200 ? parseThreadList(body) : null;
    if (!list) { setState(s => (s === "ready" ? s : "failed")); return; }
    setThreads(list.threads);
    setNext(list.next);
    setState("ready");
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, latestAt, load]);

  const more = useCallback(async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    const mine = generation.current;
    const { status, body } = await call(`${THREADS_ROUTE}?before=${encodeURIComponent(next)}`);
    setLoadingMore(false);
    if (mine !== generation.current) return;
    const page = status === 200 ? parseThreadList(body) : null;
    if (!page) return;
    setThreads(shown => [...shown, ...page.threads.filter(t => !shown.some(s => s.id === t.id))]);
    setNext(page.next);
  }, [next, loadingMore]);

  return { threads, next, state, loadingMore, more, reload: load };
}

export type ThreadState = "loading" | "ready" | "gone" | "failed";

/**
 * One thread: fetched when it opens and whenever `latestAt` changes; earlier
 * pages on asking; read when seen; and its reply. `announce` speaks in the
 * dialog's one live region.
 */
export function useThread(id: string, latestAt: string | null, announce: (words: string) => void) {
  const [view, setView] = useState<ThreadView | null>(null);
  const [state, setState] = useState<ThreadState>("loading");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [draft, setDraftState] = useState(() => replyDrafts.get(id) ?? "");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState("");
  const sendingRef = useRef(false);
  const generation = useRef(0);
  /** The highest team item seen so far, so a refetch that brings a newer one
   *  says so. -1 until the first page is in. */
  const lastTeam = useRef(-1);
  /** The highest seq a read was posted for. */
  const readUpTo = useRef(-1);
  const announceRef = useRef(announce);
  announceRef.current = announce;

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const { status, body } = await call(threadRoute(id));
    if (mine !== generation.current) return;
    if (status === 404 && body?.reason === "not_found") { setState("gone"); return; }
    const page = status === 200 ? parseThreadView(body) : null;
    if (!page) { setState(s => (s === "ready" ? s : "failed")); return; }
    setView(shown => (shown ? { thread: page.thread, items: mergeItems(shown.items, page.items), earlier: shown.earlier } : page));
    setState("ready");
  }, [id]);

  useEffect(() => { void load(); }, [load, latestAt]);

  const items = view?.items;
  const readSeq = view?.thread.readSeq ?? -1;

  // A team item newer than any seen before, arriving while the thread is open.
  useEffect(() => {
    if (!items) return;
    const team = items.reduce((n, i) => (i.side === "team" ? Math.max(n, i.seq) : n), -1);
    if (lastTeam.current >= 0 && team > lastTeam.current) announceRef.current(NEW_REPLY);
    lastTeam.current = Math.max(lastTeam.current, team, 0);
  }, [items]);

  // Read when seen: on opening, on new items, and when the page comes back.
  useEffect(() => {
    if (!items || items.length === 0) return;
    const top = highestSeq(items);
    const markRead = () => {
      if (document.visibilityState !== "visible") return;
      if (top <= Math.max(readSeq, readUpTo.current)) return;
      readUpTo.current = top;
      void post(`${threadRoute(id)}/read`, { seq: top });
    };
    markRead();
    document.addEventListener("visibilitychange", markRead);
    return () => document.removeEventListener("visibilitychange", markRead);
  }, [id, items, readSeq]);

  const earlier = useCallback(async () => {
    const before = view?.earlier;
    if (before == null || loadingEarlier) return;
    setLoadingEarlier(true);
    const { status, body } = await call(`${threadRoute(id)}?before=${before}`);
    setLoadingEarlier(false);
    const page = status === 200 ? parseThreadView(body) : null;
    if (!page) return;
    setView(shown => (shown ? { ...shown, items: mergeItems(page.items, shown.items), earlier: page.earlier } : page));
  }, [id, view?.earlier, loadingEarlier]);

  const setDraft = useCallback((text: string) => {
    setDraftState(text);
    if (text) replyDrafts.set(id, text);
    else replyDrafts.delete(id);
  }, [id]);

  /** Send the reply in the box. Refused while one is out; an empty box is
   *  left to the composer to say. */
  const reply = useCallback(async () => {
    if (!selfPressAccepted(sendingRef.current)) return false;
    const text = draft.trim();
    if (!text) return false;
    sendingRef.current = true;
    setSending(true);
    setFailure("");
    const { status, body } = await post(`${threadRoute(id)}/replies`, { body: text });
    sendingRef.current = false;
    setSending(false);
    const made = status === 201 ? parseReplyCreated(body) : null;
    if (!made) {
      setFailure(replyFailure(status, body));
      return false;
    }
    setDraft("");
    setView(shown => (shown ? { ...shown, thread: made.thread, items: mergeItems(shown.items, [made.item]) } : shown));
    announceRef.current(REPLY_SENT);
    // A reply on Fixed or Won't do reopens it, as an item right after the
    // reply's: fetched, with the status it changed to.
    void load();
    return true;
  }, [draft, id, load, setDraft]);

  return {
    view, state, items: items ?? ([] as ThreadItem[]), loadingEarlier, earlier, reload: load,
    draft, setDraft, sending, failure, reply,
    /** The words to show when the thread will not load. */
    problem: state === "gone" ? CONVERSATION_GONE : state === "failed" ? CONVERSATIONS_UNAVAILABLE : "",
  };
}
