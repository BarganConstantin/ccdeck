// Feedback from inside the deck (#1853): the rules, apart from React.
//
// The dialog asks for one thing, the message. Everything the API needs beyond
// it is worked out here rather than asked for: the title it requires comes
// from the message's own first line, and the version and system ride along
// from the deck's server, which says what they are before Send is pressed
// (GET /api/feedback, the same function that attaches them to the post).
//
// The API's contract is unchanged (ccdeck-api FeedbackRequest): a kind, a
// title of 3 to 120 characters, a body of 1 to 10,000, an optional contact of
// up to 200, and the version and platform this deck's server adds itself.
// Nothing else is sent, and nothing here adds a field.

import { isApplePlatform } from "./platform";

export type Kind = "bug" | "idea" | "other";

/** How a caller seeds the dialog — the error boundary opens it as a filled-in
 *  bug, the account popover as the issue it explains. Absent fields keep the
 *  empty defaults, so an unseeded open is exactly what it always was. */
export interface FeedbackPrefill {
  initialKind?: Kind;
  initialBody?: string;
}

/** Everything the form says that depends on the kind chosen. */
export interface KindCopy {
  value: Kind;
  /** The segment's word. */
  label: string;
  /** The question over the message. */
  question: string;
  /** How a message of this kind usually begins, shown until somebody types. */
  placeholder: string;
}

export const KINDS: readonly KindCopy[] = [
  { value: "bug", label: "Bug", question: "What happened?", placeholder: "I was trying to…\nWhat did you expect to happen?" },
  { value: "idea", label: "Idea", question: "What would make ccdeck better?", placeholder: "It would be useful if…" },
  { value: "other", label: "Other", question: "What would you like to tell us?", placeholder: "Write anything…" },
];

/** The copy for one kind. Total: every Kind has a row above. */
export function kindCopy(kind: Kind): KindCopy {
  return KINDS.find(k => k.value === kind) ?? KINDS[0];
}

/** The API's limits, all counted after a trim. */
export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
export const BODY_MAX = 10_000;
export const CONTACT_MAX = 200;

/** What an empty message is told when Send is pressed. */
export const MESSAGE_MISSING = "Write something first.";

/** Whether there is anything to send. The one thing Send needs. */
export function hasMessage(body: string): boolean {
  return body.trim() !== "";
}

/** The title a message gives itself: its first line, cut at the end of the
 *  first sentence when that sentence can stand as a title, without the full
 *  stop a title does not wear. A first line too short to be one gives way to
 *  the whole message on one line. Past the API's 120 it is cut at a word and
 *  ends in an ellipsis. */
export function titleFromBody(body: string): string {
  const text = body.trim();
  if (text === "") return "";
  const line = oneLine(text.split(/\r?\n/, 1)[0]);
  const sentence = /^(.+?[.!?])(?=\s|$)/.exec(line)?.[1] ?? line;
  const lead = withoutFullStop(sentence).length >= TITLE_MIN ? withoutFullStop(sentence) : withoutFullStop(line);
  return clipTitle(lead.length >= TITLE_MIN ? lead : oneLine(text));
}

/** The title that goes. A message too short to name itself — "ok", a thumbs
 *  up — is still a message, so rather than asking for more words to satisfy
 *  the API's three characters, the kind's word goes in front of it. */
export function feedbackTitle(kind: Kind, body: string): string {
  const own = titleFromBody(body);
  return own.length >= TITLE_MIN ? own : `${kindCopy(kind).label}: ${own}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One full stop off the end, and never the last of three dots, a question
 *  mark or an exclamation, which say something a full stop does not. */
function withoutFullStop(text: string): string {
  return /[^.]\.$/.test(text) ? text.slice(0, -1) : text;
}

/** At most TITLE_MAX, cut at the last word that fits and marked with an
 *  ellipsis, which counts toward the limit. A word too long to leave room is
 *  cut where it stands. Never half of a surrogate pair. */
function clipTitle(text: string): string {
  if (text.length <= TITLE_MAX) return text;
  const room = text.slice(0, TITLE_MAX - 1);
  const space = room.lastIndexOf(" ");
  const cut = space >= TITLE_MAX / 2 ? room.slice(0, space) : room;
  return `${cut.replace(/[\uD800-\uDBFF]$/, "").replace(/[\s,;:.\-–—]+$/, "")}…`;
}

export interface FeedbackDraft { kind: Kind; body: string; contact: string }
export interface FeedbackFields { kind: Kind; title: string; body: string; contact?: string }

/** What the page posts, from what was typed: the title worked out, both texts
 *  trimmed, and no contact at all when none was given. */
export function fieldsToSend({ kind, body, contact }: FeedbackDraft): FeedbackFields {
  const fields: FeedbackFields = { kind, title: feedbackTitle(kind, body), body: body.trim() };
  if (contact.trim() !== "") fields.contact = contact.trim();
  return fields;
}

// ── what goes with it ────────────────────────────────────────────────────────

/** What this deck's server adds to a report, as GET /api/feedback says. */
export interface FeedbackFacts { appVersion: string; platform: string }

/** The server's answer, or null for anything that is not one — a deck from
 *  before the route answers 404, and the dialog then says it in general terms. */
export function parseFacts(answer: unknown): FeedbackFacts | null {
  const a = answer as { ok?: unknown; appVersion?: unknown; platform?: unknown } | null | undefined;
  if (a?.ok !== true || typeof a.appVersion !== "string" || typeof a.platform !== "string") return null;
  if (a.appVersion === "" || a.platform === "") return null;
  return { appVersion: a.appVersion, platform: a.platform };
}

const OS_NAMES: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** The system as its owner would say it. The server sends `os-arch` as Node
 *  names them, `darwin-arm64`; the line before Send reads `macOS · arm64`.
 *  An operating system this does not know is shown as it is sent. */
export function systemLabel(platform: string): string {
  const at = platform.indexOf("-");
  const os = at === -1 ? platform : platform.slice(0, at);
  const arch = at === -1 ? "" : platform.slice(at + 1);
  const name = OS_NAMES[os] ?? os;
  return arch ? `${name} · ${arch}` : name;
}

/** `ccdeck 3.36.0 · macOS · arm64`, or null until the server has said. */
export function factsLabel(facts: FeedbackFacts | null): string | null {
  return facts ? `ccdeck ${facts.appVersion} · ${systemLabel(facts.platform)}` : null;
}

/** Said after the facts, so the line reads as what rides with the message. */
export const FACTS_SUFFIX = "sent with it";
/** Said instead, until the server has answered or when it cannot. */
export const FACTS_UNKNOWN = "Your ccdeck version and system are sent with it.";

// ── the secondary section ────────────────────────────────────────────────────

export const ADD_DETAILS = "Add details";
export const CONTACT_LABEL = "How to reach you";
export const CONTACT_PLACEHOLDER = "Email or GitHub @name";
export const CONTACT_HINT = "Only if you would like an answer.";
/** Where it goes and what may become of it, said once, in the section that
 *  holds the contact. True today: a report is only stored; the people who
 *  make ccdeck read it and may open a public issue from it, choosing what that
 *  issue says, and never with the contact or the images. */
export const WHERE_IT_GOES = [
  "It all goes to the people who make ccdeck, with the version and system below.",
  "Nothing becomes public by being sent. They may open a public GitHub issue from it, choosing its title and text; your contact and screenshots are never put on one.",
] as const;

// ── the keyboard ─────────────────────────────────────────────────────────────

/** The keystroke fields a shortcut is read from. Structural, so a test can pass
 *  a plain object; a real KeyboardEvent satisfies it. */
export interface EnterKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

/** ⌘+Enter or Ctrl+Enter sends from anywhere in the form, on every platform —
 *  the message keeps a bare Enter for a new line. Never while an input method
 *  is composing: that Enter commits the characters, not the message. */
export function isSendShortcut(e: EnterKey): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !e.isComposing;
}

/** A bare Enter. In the contact field it does nothing, rather than submitting
 *  the form the way a one-line field would: Send and the shortcut are the only
 *  two ways a report leaves. */
export function isPlainEnter(e: EnterKey): boolean {
  return e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.isComposing;
}

/** The caps the footer draws for the send shortcut: the one this platform's
 *  keyboard says. Both chords work everywhere; this only picks which to show. */
export function sendShortcutCaps(platform: string): [string, string] {
  return isApplePlatform(platform) ? ["⌘", "Enter"] : ["Ctrl", "Enter"];
}

/** A cap that is one symbol rather than a word — ⌘ — and is drawn a size up in
 *  the system face, because the mono stack draws the glyph at a fraction of the
 *  word beside it. */
export function isSymbolCap(cap: string): boolean {
  return [...cap].length === 1;
}

// ── the answer ───────────────────────────────────────────────────────────────

export type Outcome =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "sent" }
  | { state: "failed"; message: string };

/** What the dialog shows, and says, once a report has arrived. */
export const SENT_LINE = "Thanks — feedback sent.";

/** What the server's answer means for the person who pressed Send. `errors` is
 *  a 400's, keyed by field; an image's is quoted, since it names which one. */
export function feedbackFailure(status: number, reason: unknown, errors?: unknown): string {
  if (reason === "vetoed") return "This deck was started with AGENTS_DECK_NO_INSTALL=1, which keeps it off the network, so nothing was sent.";
  if (status === 429 || reason === "too_many") return "Too much feedback from this network in the last hour. Try again later; your text is still here.";
  if (status === 413 || reason === "too_large") return "The images are too large to send together. Remove one and send again; your text is still here.";
  const imageError = (errors as { images?: unknown } | null | undefined)?.images;
  if (status === 400 && Array.isArray(imageError) && typeof imageError[0] === "string") {
    return `The server did not accept an image. ${imageError[0]} Remove it and send again; your text is still here.`;
  }
  if (status === 400) return "The server did not accept the message. It is still here; check it and send again.";
  // One line at the dialog's width, so the failure that invites pressing Send
  // again grows the dialog by one line and Send stays under the pointer that
  // just pressed it. Send, still there and still named Send, is the retry.
  return "ccdeck's server could not be reached. Nothing was sent; your text is still here.";
}

/** What the dialog's live region says for each outcome. The region is drawn from
 *  the first render, so the change is what a screen reader hears. */
export function outcomeAnnouncement(outcome: Outcome["state"]): string {
  if (outcome === "sending") return "Sending…";
  if (outcome === "sent") return SENT_LINE;
  return "";
}

/** How long the thanks stays before the dialog closes itself, and how long its
 *  fade out takes. Long enough to read four words and see the mark drawn
 *  (340ms); the exit is faster than anything that arrived. */
export const SENT_HOLD_MS = 1400;
export const SENT_EXIT_MS = 160;
