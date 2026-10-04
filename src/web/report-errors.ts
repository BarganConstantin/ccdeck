// Errors the page caught, handed to the deck's own server, which sends them on
// (scrubbed) unless usage reports are switched off or vetoed (#1853). The
// page never talks to anything but its own server; see reports-routes.mjs.
//
// Ten a page at most, each message once: a render loop that throws on every
// frame is one report, not a flood. The server has its own hourly cap too.

const MAX_PER_PAGE = 10;
const MESSAGE_MAX = 500;
const STACK_MAX = 4000;
/** Noise every browser raises and no bug of ours causes. */
const IGNORED = [/ResizeObserver loop/i, /^Script error\.?$/i];

// The path and project-folder patterns of `scrub` in server/reports.mjs, the
// same text (error-report-paths.test.ts holds the two together): see there.
const NAME = String.raw`[^\s\\/:'"\`<>|?*;,]`;
const MIDDLE = String.raw`${NAME}(?:[^\\/\r\n:'"\`<>|?*;,]*${NAME})?[\\/]`;
const LAST = String.raw`[^\s\\/:'"\`<>|?*;,()]+`;
const TAIL = String.raw`(?:${MIDDLE})*(?:${LAST})?`;
export const PATH_PATTERN = String.raw`(?<![\w.~/\\\]-])(?:file://(?:/[A-Za-z]:)?[^\s:'"\`<>()]*|~[\\/]${TAIL}|[A-Za-z]:[\\/]${TAIL}|\\\\(?:[?.]\\)?(?:[A-Za-z]:\\)?${TAIL}|/(?=${NAME})${TAIL}|(?<!:)//(?=${NAME})${TAIL})`;
export const PROJECT_PATTERN = String.raw`(?<![\w-])(?:[A-Za-z]--|-[A-Za-z0-9][\w.]*-)[\w.-]*`;
const KEPT_HOME_FOLDERS = new Set([".claude", ".codex"]);

/** `<path>`, or `~/<path>` and `~/.claude/<path>` for one under a home folder. */
function hidePath(path: string): string {
  if (!path.startsWith("~")) return "<path>";
  const sep = path[1];
  const [top, ...rest] = path.slice(2).split(/[\\/]/);
  if (!top) return path;
  if (!KEPT_HOME_FOLDERS.has(top)) return `~${sep}<path>`;
  return rest.join("") ? `~${sep}${top}${sep}<path>` : path;
}

/**
 * Take out of an error text what could say who someone is, for text that is
 * shown or seeded on the page rather than sent — the crash report the error
 * boundary opens the feedback dialog with (#1853). It mirrors the passes
 * `scrub` in server/reports.mjs makes: home folders, every other path (made
 * `<path>`), project folders in Claude Code's encoding (`<project>`), email
 * addresses and strings shaped like keys or tokens. That server scrub is still
 * the one that runs on every error the page forwards, and the one the README's
 * promise rests on; this is the same shape done in the browser for the words a
 * person reads before Send — feedback is not scrubbed on its way through the
 * server, so a path must never reach the box in the first place. The browser
 * cannot know the home folder or where the deck is installed, so the home
 * patterns carry the first, and every path goes — the page's own frames are
 * addresses, which stay.
 */
export function scrubReport(text: string): string {
  return String(text ?? "")
    .replace(/\/(?:home|Users)\/[^/\s:'"]+/g, "~")
    .replace(/[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\r\n:'"]+/gi, "~")
    .replace(new RegExp(PATH_PATTERN, "g"), hidePath)
    .replace(new RegExp(PROJECT_PATTERN, "g"), "<project>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(
      /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[A-Fa-f0-9]{40,}|[A-Za-z0-9+_=-]{48,})/g,
      "<secret>",
    );
}

export interface ErrorTarget {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

type Send = (body: { message: string; stack?: string }) => void;

const post: Send = body => {
  void fetch("/api/client-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
};

/**
 * Forward one error the app's React tree threw and an error boundary caught
 * (ErrorBoundary.tsx). React does not raise a window `error` event for what a
 * boundary handles, so `forwardPageErrors` above never hears it — this hands the
 * same `/api/client-error` route the same shape of body, sliced the same way.
 * The server decides again whether anything leaves the machine and scrubs it,
 * so this stays true to "sent on only while reports are on" without the page
 * having to read the switch. Nothing is sent for an error with no message.
 */
export function forwardCaughtError(message: unknown, stack?: unknown, send: Send = post): void {
  const text = String(message ?? "").slice(0, MESSAGE_MAX).trim();
  if (!text) return;
  send({ message: text, stack: typeof stack === "string" ? stack.slice(0, STACK_MAX) : undefined });
}

/** Start forwarding while `isOn()` says so; returns the function that stops it. */
export function forwardPageErrors(isOn: () => boolean, target: ErrorTarget = window, send: Send = post): () => void {
  let sent = 0;
  const seen = new Set<string>();
  const forward = (message: unknown, stack: unknown) => {
    const text = String(message ?? "").slice(0, MESSAGE_MAX).trim();
    if (!isOn() || !text || sent >= MAX_PER_PAGE || seen.has(text) || IGNORED.some(re => re.test(text))) return;
    seen.add(text);
    sent++;
    send({ message: text, stack: typeof stack === "string" ? stack.slice(0, STACK_MAX) : undefined });
  };
  const onError = (event: { message?: string; error?: { message?: string; stack?: string } }) =>
    forward(event.error?.message ?? event.message, event.error?.stack);
  const onRejection = (event: { reason?: { message?: string; stack?: string } | string }) =>
    typeof event.reason === "object" && event.reason !== null
      ? forward(event.reason.message, event.reason.stack)
      : forward(event.reason, undefined);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
