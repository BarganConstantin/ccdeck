// Why a Claude Code turn stopped, when it did not stop on a finished reply.
//
// Claude Code fires `StopFailure` INSTEAD of `Stop` when a turn ends on an API
// error (2.1.78 and later). Its payload names the error with one of a fixed set
// of values — `authentication_failed`, `rate_limit`, `overloaded`,
// `server_error` and eight more — and carries the line the terminal printed
// ("Login expired · Please run /login", "API Error: Rate limit reached").
//
// Every session on a machine shares one login, so when it dies every running
// session stops on that line within seconds of the others. Before this event
// the deck saw nothing at all: no `Stop` came, and the cards went on reading
// live until the stale sweep gave up on them.
//
// Read here, once, for both halves of the deck. The page draws the note on the
// card from it (src/web/stop-failure-copy.ts), and the server decides from it
// whether a stop is worth one notification per incident and an early
// auto-switch tick (account-watch.mjs). The page imports this file the way
// pricing.ts imports codex-review-policy.mjs, so the two cannot come to read
// one payload two ways.
//
// EVERY VALUE OFF THE PAYLOAD IS TREATED AS HOSTILE. `/api/event` takes a post
// without the deck's token, and what this returns is drawn on a card, put in a
// tooltip and handed to an OS helper's argv.

export const STOP_FAILURE = "StopFailure";

/**
 * The first Claude Code that knows the event, and why that is a gate rather
 * than a detail. An older one does not skip a hook event it does not know:
 * until 2.1.101 an unrecognised event name in settings.json made Claude Code
 * ignore the whole FILE — every permission, env var and hook in it, ours
 * included (Claude Code's changelog, 2.1.101). installer.mjs adds the entry
 * only where every Claude Code it can find is at least this one.
 */
export const STOP_FAILURE_SINCE = "2.1.78";

/** The two errors a working login cures, and what the deck calls each. Every
 *  other value, a future one included, is an API error. */
const KINDS = Object.freeze({ authentication_failed: "login", rate_limit: "usage-limit" });

/** "login", "usage-limit" or "api-error" for one of Claude Code's error values. */
export function stopKind(error) {
  return typeof error === "string" && Object.hasOwn(KINDS, error) ? KINDS[error] : "api-error";
}

/** Whether another account can cure a stop of this kind — what makes it an
 *  incident to tell the user about and a reason to run auto-switch now. */
export function switchCanCure(kind) {
  return kind === "login" || kind === "usage-limit";
}

/** Claude Code's values are short snake_case words. Anything else is not one
 *  and is not repeated anywhere. */
const ERROR_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** The payload's `error`, when it is shaped like one of Claude Code's values. */
export function stopError(raw) {
  const e = raw?.error;
  return typeof e === "string" && ERROR_RE.test(e) ? e : "unknown";
}

/** Longest error line kept: two lines of a tooltip, and what a tray shows. */
export const STOP_MESSAGE_MAX = 160;

/** One line of plain text: terminal escapes and control characters out (a
 *  bidi override included), anything shaped like a credential masked, the
 *  whitespace folded, and cut on a whole character. */
function oneLine(value) {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 …")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...text];
  return chars.length > STOP_MESSAGE_MAX ? `${chars.slice(0, STOP_MESSAGE_MAX - 1).join("").trimEnd()}…` : text;
}

/** What the terminal said: `last_assistant_message`, which on this event is
 *  the rendered error line, else `error_details`. Empty when neither is text. */
export function stopMessage(raw) {
  return oneLine(raw?.last_assistant_message) || oneLine(raw?.error_details);
}

/**
 * The facts of one StopFailure — `{ kind, error, message, at }` — or null for
 * any other event. `at` is the caller's clock: the envelope's `receivedAt` on
 * the page, the server's own on the way in.
 */
export function stopFailureOf(raw, at) {
  if (!raw || typeof raw !== "object" || raw.hook_event_name !== STOP_FAILURE) return null;
  const error = stopError(raw);
  return { kind: stopKind(error), error, message: stopMessage(raw), at };
}
