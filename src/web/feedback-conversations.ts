// A ccdeck account's feedback conversations, apart from React: the shapes the
// API answers (conversation contracts, sections 3.2-3.3), read defensively; a
// thread laid out as a conversation — runs of messages, day dividers, event
// lines; links found in what was written; and the dialog's words for it.
//
// IN THE ACCOUNT'S OWN CHUNK. Only components/FeedbackConversations.tsx and
// what it draws import this, and the dialog loads that lazily, so a deck with
// the account off never fetches it. The words the Write tab needs are
// feedback.ts's, in the main bundle; limitLine is re-exported from there.
//
// THE API WORDS EVERY STATUS AND EVENT. Each item carries `text`, the API's
// own sentence for an event, so nothing here words a status: a status pill is
// its `label`, an event line its `text`, and an item of a type this deck has
// never heard of is drawn as a neutral event line from its text, so the API
// can add types without a deck release.
//
// NOTHING IS PARSED AS HTML. Links are found by `linkify`, the twin of the
// API's FeedbackText.Parts held to the shared fixture feedback-links.json, and
// drawn as React elements; dangerouslySetInnerHTML is never used.
export { limitLine } from "./feedback";

// ── the API's shapes ─────────────────────────────────────────────────────────

export interface StatusView { code: string; label: string; fixedIn: string | null; reason: string | null; released: boolean }
export interface TrackedIssue { number: number; url: string }
export interface ThreadImage { id: string; type: string; width: number; height: number; bytes: number }
export interface ThreadSummary {
  id: string;
  kind: string;
  title: string;
  status: StatusView;
  createdAt: string;
  lastActivityAt: string;
  lastSeq: number;
  readSeq: number;
  hasUnread: boolean;
  preview: { side: "user" | "team"; text: string };
  trackedIssue: TrackedIssue | null;
  images: number;
  webUrl: string;
}
export interface ThreadItem {
  seq: number;
  at: string;
  type: string;
  side: "user" | "team";
  text: string;
  via?: string;
  signature?: string;
  status?: StatusView;
  issue?: TrackedIssue;
  version?: string;
  images?: ThreadImage[];
}
export interface ThreadView { thread: ThreadSummary; items: ThreadItem[]; earlier: number | null }
export interface ThreadList { threads: ThreadSummary[]; next: string | null; unread: number; latestAt: string | null }
export interface ReplyCreated { item: ThreadItem; thread: ThreadSummary }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const int = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const side = (v: unknown): v is "user" | "team" => v === "user" || v === "team";

function parseStatus(v: unknown): StatusView | null {
  if (!isObj(v) || !str(v.code) || !str(v.label)) return null;
  return {
    code: v.code, label: v.label,
    fixedIn: str(v.fixedIn) ? v.fixedIn : null,
    reason: str(v.reason) ? v.reason : null,
    released: v.released === true,
  };
}

function parseIssue(v: unknown): TrackedIssue | null {
  return isObj(v) && int(v.number) && str(v.url) ? { number: v.number, url: v.url } : null;
}

/** One summary as the API wrote it, or null for anything that is not one. */
export function parseSummary(v: unknown): ThreadSummary | null {
  if (!isObj(v) || !str(v.id) || !str(v.title) || !str(v.createdAt) || !str(v.lastActivityAt)) return null;
  const status = parseStatus(v.status);
  const preview = isObj(v.preview) && side(v.preview.side) && str(v.preview.text) ? { side: v.preview.side, text: v.preview.text } : null;
  if (!status || !preview || !int(v.lastSeq) || !int(v.readSeq)) return null;
  return {
    id: v.id, kind: str(v.kind) ? v.kind : "other", title: v.title, status,
    createdAt: v.createdAt, lastActivityAt: v.lastActivityAt, lastSeq: v.lastSeq, readSeq: v.readSeq,
    hasUnread: v.hasUnread === true, preview, trackedIssue: parseIssue(v.trackedIssue),
    images: int(v.images) ? v.images : 0, webUrl: str(v.webUrl) ? v.webUrl : "",
  };
}

/** One timeline item, or null. Fields that do not apply are left out. */
export function parseItem(v: unknown): ThreadItem | null {
  if (!isObj(v) || !int(v.seq) || !str(v.at) || !str(v.type) || !side(v.side) || !str(v.text)) return null;
  const item: ThreadItem = { seq: v.seq, at: v.at, type: v.type, side: v.side, text: v.text };
  if (str(v.via)) item.via = v.via;
  if (str(v.signature)) item.signature = v.signature;
  const status = parseStatus(v.status);
  if (status) item.status = status;
  const issue = parseIssue(v.issue);
  if (issue) item.issue = issue;
  if (str(v.version)) item.version = v.version;
  if (Array.isArray(v.images)) {
    item.images = v.images.filter((i): i is ThreadImage =>
      isObj(i) && str(i.id) && str(i.type) && int(i.width) && int(i.height) && int(i.bytes));
  }
  return item;
}

const items = (v: unknown) => (Array.isArray(v) ? v.map(parseItem).filter((i): i is ThreadItem => i !== null) : []);

export function parseThreadView(v: unknown): ThreadView | null {
  if (!isObj(v)) return null;
  const thread = parseSummary(v.thread);
  if (!thread) return null;
  return { thread, items: items(v.items).sort((a, b) => a.seq - b.seq), earlier: int(v.earlier) ? v.earlier : null };
}

export function parseThreadList(v: unknown): ThreadList | null {
  if (!isObj(v) || !Array.isArray(v.threads)) return null;
  return {
    threads: v.threads.map(parseSummary).filter((t): t is ThreadSummary => t !== null),
    next: str(v.next) && /^[A-Za-z0-9_-]{1,64}$/.test(v.next) ? v.next : null,
    unread: int(v.unread) ? v.unread : 0,
    latestAt: str(v.latestAt) ? v.latestAt : null,
  };
}

export function parseReplyCreated(v: unknown): ReplyCreated | null {
  if (!isObj(v)) return null;
  const item = parseItem(v.item);
  const thread = parseSummary(v.thread);
  return item && thread ? { item, thread } : null;
}

/** A page of items joined onto the one already shown: one item per seq, in
 *  order — an earlier page before, a refetch's newer items after. */
export function mergeItems(shown: readonly ThreadItem[], more: readonly ThreadItem[]): ThreadItem[] {
  const bySeq = new Map<number, ThreadItem>();
  for (const item of shown) bySeq.set(item.seq, item);
  for (const item of more) bySeq.set(item.seq, item);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The highest item the reader is looking at. */
export const highestSeq = (shown: readonly ThreadItem[]) => shown.reduce((n, i) => Math.max(n, i.seq), -1);

// ── links ────────────────────────────────────────────────────────────────────

export type TextPart = { text: string; url?: undefined } | { url: string; text: string };

/** Only http and https, lowercase as written; anything after the scheme up
 *  to JavaScript's whitespace, an angle bracket, a quote or a backtick (the
 *  backtick written as \x60, so no scan of this file mistakes it for a
 *  template). */
const CANDIDATE = /https?:\/\/[^\s<>"'\x60]+/g;
const TRAILING = ".,;:!?'\"";
const OPENER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
export const MAX_URL_LENGTH = 2048;
/** What every link drawn from a message carries (FeedbackText.LinkRel). */
export const LINK_REL = "noopener noreferrer nofollow ugc";

const count = (text: string, end: number, wanted: string) => {
  let n = 0;
  for (let i = 0; i < end; i++) if (text[i] === wanted) n++;
  return n;
};

/** A candidate without what ends a sentence after it, and without a closing
 *  bracket whose opener is not inside it — one character at a time. */
function trimmed(candidate: string): string {
  let end = candidate.length;
  while (end > 0) {
    const last = candidate[end - 1];
    if (TRAILING.includes(last)) { end--; continue; }
    const opener = OPENER[last];
    if (opener && count(candidate, end, last) > count(candidate, end, opener)) { end--; continue; }
    break;
  }
  return candidate.slice(0, end);
}

/** The text in plain pieces and links, in order: empty for empty text, never
 *  an empty piece, never two plain pieces in a row. A match with nothing after
 *  its `://`, or longer than 2,048 characters, stays text. */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  if (!text) return parts;
  let plain = "";
  let at = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const url = trimmed(match[0]);
    const scheme = url.startsWith("https://") ? 8 : 7;
    if (url.length <= scheme || url.length > MAX_URL_LENGTH) continue;
    plain += text.slice(at, match.index);
    if (plain) { parts.push({ text: plain }); plain = ""; }
    parts.push({ url, text: url });
    at = match.index! + url.length;
  }
  plain += text.slice(at);
  if (plain) parts.push({ text: plain });
  return parts;
}

// ── the timeline ─────────────────────────────────────────────────────────────

/** Messages from one side this close together are one run: one signature
 *  over them, one time under them. */
export const RUN_GAP_MS = 5 * 60 * 1000;

export type TimelineRow =
  | { kind: "day"; key: string; label: string }
  | { kind: "run"; key: string; side: "user" | "team"; signature: string | null; messages: ThreadItem[]; time: string }
  | { kind: "event"; key: string; item: ThreadItem; time: string; known: boolean };

/** The event types this deck knows; any other is drawn the same way, from its
 *  text, and marked unknown. */
export const EVENT_TYPES = new Set(["status", "issue", "duplicate", "released", "reopened"]);

/** `2026-10-28` in `timeZone`: which day an instant falls on there. */
function dayKey(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(ms);
}

/** "Today", "Yesterday", "Oct 26" — and "Oct 26, 2025" in another year. */
export function dayLabel(at: string, now: number, timeZone?: string): string {
  const ms = Date.parse(at);
  const day = dayKey(ms, timeZone);
  if (day === dayKey(now, timeZone)) return "Today";
  // Noon-anchored, so a 23- or 25-hour day across a clock change still lands
  // on the calendar day before.
  const today = dayKey(now, timeZone);
  const [y, m, d] = today.split("-").map(Number);
  const yesterday = dayKey(Date.UTC(y, m - 1, d - 1, 12), "UTC");
  if (day === yesterday) return "Yesterday";
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone }).format(ms);
}

/** `09:12`: the time a run or an event was written, on the reader's clock. */
export function timeLabel(at: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(Date.parse(at));
}

/** When a conversation was last active, as a list row says it: the time
 *  today, otherwise the day. */
export function listTime(at: string, now: number, timeZone?: string): string {
  const label = dayLabel(at, now, timeZone);
  return label === "Today" ? timeLabel(at, timeZone) : label;
}

/**
 * A thread's items as the conversation draws them: a day divider before the
 * first item of each day; consecutive messages of one side — and, for the
 * team, one signature — less than RUN_GAP_MS apart as one run; everything
 * else an event line of its own.
 */
export function timeline(shown: readonly ThreadItem[], now: number, timeZone?: string): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let day = "";
  let run: Extract<TimelineRow, { kind: "run" }> | null = null;
  for (const item of shown) {
    const ms = Date.parse(item.at);
    const thisDay = dayKey(ms, timeZone);
    if (thisDay !== day) {
      day = thisDay;
      run = null;
      rows.push({ kind: "day", key: `day-${thisDay}`, label: dayLabel(item.at, now, timeZone) });
    }
    if (item.type !== "message") {
      run = null;
      rows.push({ kind: "event", key: `item-${item.seq}`, item, time: timeLabel(item.at, timeZone), known: EVENT_TYPES.has(item.type) });
      continue;
    }
    const signature = item.side === "team" ? item.signature ?? null : null;
    const last = run?.messages[run.messages.length - 1];
    if (run && last && run.side === item.side && run.signature === signature && ms - Date.parse(last.at) < RUN_GAP_MS) {
      run.messages.push(item);
      run.time = timeLabel(item.at, timeZone);
      continue;
    }
    run = { kind: "run", key: `run-${item.seq}`, side: item.side, signature, messages: [item], time: timeLabel(item.at, timeZone) };
    rows.push(run);
  }
  return rows;
}

// ── a row of the list ────────────────────────────────────────────────────────

/** The latest item, as a list row previews it: whose, and the words. */
export function previewLine(thread: ThreadSummary): string {
  return thread.preview.side === "user" ? `You: ${thread.preview.text}` : thread.preview.text;
}

/** The pill's tone, by the status code: a colour that agrees with its word. */
export function statusTone(code: string): "open" | "progress" | "done" | "closed" {
  if (code === "looking" || code === "planned") return "progress";
  if (code === "fixed") return "done";
  if (code === "wont_do") return "closed";
  return "open";
}

// ── the words ────────────────────────────────────────────────────────────────

export const ALL_CONVERSATIONS = "All conversations";
export const NO_CONVERSATIONS = "No conversations yet. What you send from your account starts one here.";
export const LOADING_CONVERSATIONS = "Loading your conversations…";
export const LOADING_CONVERSATION = "Loading the conversation…";
export const MORE_CONVERSATIONS = "More";
export const SHOW_EARLIER = "Show earlier";
export const TRY_AGAIN = "Try again";
export const REPLY_PLACEHOLDER = "Write a reply…";
export const REPLY_SEND = "Send reply";
export const REPLY_SENDING = "Sending…";
export const REPLY_LABEL = "Your reply";
export const REPLY_SENT = "Reply sent.";
export const NEW_REPLY = "New reply from the ccdeck team.";
export const CONVERSATION_GONE = "This conversation is no longer available.";
/** The list or a thread would not load: nothing to keep, so no tick to offer. */
export const CONVERSATIONS_UNAVAILABLE = "Your account's conversations can't be reached right now.";
/** A reply that did not go: the words stay in the box. */
export const REPLY_UNAVAILABLE = "Your account's conversations can't be reached right now. Try again; your text is still here.";
export const REPLY_REFUSED = "The server did not accept the reply. It is still here; check it and send again.";

/** "Tracked publicly as #123". */
export const trackedLabel = (issue: TrackedIssue) => `Tracked publicly as #${issue.number}`;

/** "2 images — view on the web". */
export function imagesOnWeb(n: number): string {
  return `${n} ${n === 1 ? "image" : "images"} — view on the web`;
}

/** Where a conversation started: "Started Oct 28 from your deck". */
export function startedLine(createdAt: string, via: string | undefined, now: number, timeZone?: string): string {
  const day = dayLabel(createdAt, now, timeZone);
  const when = day === "Today" || day === "Yesterday" ? day.toLowerCase() : day;
  const from = via === "web" ? " from the web" : via === "deck" ? " from your deck" : "";
  return `Started ${when}${from}`;
}
