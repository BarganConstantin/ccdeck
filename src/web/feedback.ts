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
import { t } from "./i18n";

export type Kind = "bug" | "idea" | "other";

/** How a caller seeds the dialog — the error boundary opens it as a filled-in
 *  bug, the account popover as the issue it explains. Absent fields keep the
 *  empty defaults, so an unseeded open is exactly what it always was.
 *  `initialTab` is the one door that opens on Your conversations: the topbar's
 *  Feedback pressed while it shows the dot. It is not part of a seed, so it
 *  never picks a draft. */
export interface FeedbackPrefill {
  initialKind?: Kind;
  initialBody?: string;
  initialTab?: FeedbackTab;
}

/** The connected dialog's two tabs (components/FeedbackTabs.tsx). */
export type FeedbackTab = "write" | "conversations";

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

/** Getters, so each read is worded in the language on show. */
export const KINDS: readonly KindCopy[] = [
  { value: "bug", get label() { return t("shell.feedback.kind.bug"); }, get question() { return t("shell.feedback.q.bug"); }, get placeholder() { return t("shell.feedback.ph.bug"); } },
  { value: "idea", get label() { return t("shell.feedback.kind.idea"); }, get question() { return t("shell.feedback.q.idea"); }, get placeholder() { return t("shell.feedback.ph.idea"); } },
  { value: "other", get label() { return t("shell.feedback.kind.other"); }, get question() { return t("shell.feedback.q.other"); }, get placeholder() { return t("shell.feedback.ph.other"); } },
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
export const messageMissing = (): string => t("shell.feedback.missing");

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
  return own.length >= TITLE_MIN ? own : t("shell.feedback.titleKind", { kind: kindCopy(kind).label, text: own });
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

export interface FeedbackDraft { kind: Kind; body: string; contact: string; anonymous?: boolean }
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
export const factsWith = (): string => t("shell.feedback.factsWith");
/** Said instead, until the server has answered or when it cannot. */
export const factsUnknown = (): string => t("shell.feedback.factsUnknown");

// ── the secondary section ────────────────────────────────────────────────────

export const addDetails = (): string => t("shell.feedback.addDetails");
export const contactLabel = (): string => t("shell.feedback.contact");
export const contactPlaceholder = (): string => t("shell.feedback.contactPh");
export const contactHint = (): string => t("shell.feedback.contactHint");
/** Where it goes and what may become of it, said once, in the section that
 *  holds the contact. True today: a report is only stored; the people who
 *  make ccdeck read it and may open a public issue from it, choosing what that
 *  issue says, and never with the contact or the images. */
export const whereItGoes = (): readonly string[] => [t("shell.feedback.where1"), t("shell.feedback.where2")];

// ── sent as the ccdeck account ───────────────────────────────────────────────
//
// With a ccdeck account connected, what is written goes as the account and
// starts a conversation the people who make ccdeck answer — in the dialog's
// second tab, on app.ccdeck.dev, and by email while the API mails replies
// (the summary's `mail`; false when it sends no mail, and then no word here
// promises one). The anonymous path stays exactly as above, one tick away:
// Send without my account.

export const ACCOUNT_DIALOG_TITLE = "Feedback";
export const WRITE_TAB = "Write";
export const CONVERSATIONS_TAB = "Your conversations";
export const SEND_WITHOUT_ACCOUNT = "Send without my account";

/** Who it goes as, under the message, and where the replies come: the
 *  address once the deck has said; by email only while `mail`. */
export function accountSentAs(email: string | null, mail = true): string {
  const replies = mail ? "you'll get replies here and by email" : "you'll get replies here and on app.ccdeck.dev";
  return email ? `Sent as ${email} — ${replies}` : `Sent from your ccdeck account — ${replies}`;
}

/** WHERE_IT_GOES for a send as the account: no contact to keep off an issue,
 *  and the account's email never put on one. */
export const WHERE_IT_GOES_ACCOUNT = [
  "It goes to the people who make ccdeck from your account, with the version and system below. They reply here and by email.",
  "Nothing becomes public by being sent. They may open a public GitHub issue from it, choosing its title and text; your email and screenshots are never put on one.",
] as const;

/** WHERE_IT_GOES_ACCOUNT while replies are not mailed. */
export const WHERE_IT_GOES_ACCOUNT_NO_MAIL = [
  "It goes to the people who make ccdeck from your account, with the version and system below. They reply here and on app.ccdeck.dev.",
  WHERE_IT_GOES_ACCOUNT[1],
] as const;

export const whereItGoesAccount = (mail = true) => (mail ? WHERE_IT_GOES_ACCOUNT : WHERE_IT_GOES_ACCOUNT_NO_MAIL);

/** The thanks once a conversation has started. */
export const SENT_LINE_ACCOUNT = "Sent — replies will show in Your conversations and by email.";
/** SENT_LINE_ACCOUNT while replies are not mailed. */
export const SENT_LINE_ACCOUNT_NO_MAIL = "Sent — replies will show in Your conversations and on app.ccdeck.dev.";

/** The account's conversations could not be reached; the anonymous path is
 *  still there, and nothing typed was lost. */
export const ACCOUNT_UNAVAILABLE = "Your account's conversations can't be reached right now. Try again, or tick Send without my account; your text is still here.";

/** `HH:mm` in the reader's own clock. */
export function clockTime(at: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(at);
}

/** A daily limit reached: which, how many, and when it opens again. */
export function limitLine(kind: "conversations" | "replies", limit: number, at: Date, timeZone?: string): string {
  const what = kind === "conversations" ? "new conversations" : "replies";
  return `You've reached today's limit of ${limit} ${what}. You can try again at ${clockTime(at, timeZone)}; your text is still here.`;
}

/** What a refusal from the account's routes (ccdeck-account-routes.mjs) means
 *  for somebody starting a conversation. The image and size refusals read as
 *  they do anonymously; a limit says when to come back. */
export function accountFailure(
  status: number,
  answer: { reason?: unknown; errors?: unknown; limit?: unknown; retryAfterSec?: unknown } | null | undefined,
  now = Date.now(),
): string {
  const reason = answer?.reason;
  if (reason === "too_many" && Number.isInteger(answer?.limit) && Number.isInteger(answer?.retryAfterSec)) {
    return limitLine("conversations", answer!.limit as number, new Date(now + (answer!.retryAfterSec as number) * 1000));
  }
  if (reason === "invalid" || reason === "too_large") return feedbackFailure(status, reason, answer?.errors);
  return ACCOUNT_UNAVAILABLE;
}

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
/** The thanks for how it went: as the account (by email only while `mail`), or as before. */
export const sentLine = (asAccount = false, mail = true): string =>
  (asAccount ? (mail ? SENT_LINE_ACCOUNT : SENT_LINE_ACCOUNT_NO_MAIL) : t("shell.feedback.sent"));

/** The deck's own sentence about an image it refused, in the language on show;
 *  anything else (the API's own words) as it came. The two sentences about a
 *  form built by hand ("Send each image as a file part.") are not here: the
 *  dialog cannot send that shape. */
export function imageProblem(text: string): string {
  const count = /^At most (\d+) images\.$/.exec(text);
  if (count) return t("shell.feedback.problem.count", { n: count[1] });
  const size = /^Image (\d+) is over (\d+) MB\.$/.exec(text);
  if (size) return t("shell.feedback.problem.size", { n: size[1], mb: size[2] });
  const format = /^Image (\d+) is not a PNG or a JPEG\.$/.exec(text);
  if (format) return t("shell.feedback.problem.format", { n: format[1] });
  return text;
}

/** What the server's answer means for the person who pressed Send. `errors` is
 *  a 400's, keyed by field; an image's is quoted, since it names which one. */
export function feedbackFailure(status: number, reason: unknown, errors?: unknown): string {
  if (reason === "vetoed") return t("shell.feedback.fail.vetoed");
  if (status === 429 || reason === "too_many") return t("shell.feedback.fail.tooMany");
  if (status === 413 || reason === "too_large") return t("shell.feedback.fail.tooLarge");
  const imageError = (errors as { images?: unknown } | null | undefined)?.images;
  if (status === 400 && Array.isArray(imageError) && typeof imageError[0] === "string") {
    return t("shell.feedback.fail.image", { reason: imageProblem(imageError[0]) });
  }
  if (status === 400) return t("shell.feedback.fail.rejected");
  // One line at the dialog's width, so the failure that invites pressing Send
  // again grows the dialog by one line and Send stays under the pointer that
  // just pressed it. Send, still there and still named Send, is the retry.
  return t("shell.feedback.fail.unreachable");
}

/** What the dialog's live region says for each outcome. The region is drawn from
 *  the first render, so the change is what a screen reader hears. */
export function outcomeAnnouncement(outcome: Outcome["state"], asAccount = false, mail = true): string {
  if (outcome === "sending") return t("shell.feedback.sending");
  if (outcome === "sent") return sentLine(asAccount, mail);
  return "";
}

/** How long the thanks stays before the dialog closes itself, and how long its
 *  fade out takes. Long enough to read four words and see the mark drawn
 *  (340ms); the exit is faster than anything that arrived. */
export const SENT_HOLD_MS = 1400;
export const SENT_EXIT_MS = 160;
