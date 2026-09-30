// Errors the page caught, handed to the deck's own server, which sends them on
// (scrubbed) only for a person who said yes to anonymous reports (#1853). The
// page never talks to anything but its own server; see reports-routes.mjs.
//
// Ten a page at most, each message once: a render loop that throws on every
// frame is one report, not a flood. The server has its own hourly cap too.

const MAX_PER_PAGE = 10;
const MESSAGE_MAX = 500;
const STACK_MAX = 4000;
/** Noise every browser raises and no bug of ours causes. */
const IGNORED = [/ResizeObserver loop/i, /^Script error\.?$/i];

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
