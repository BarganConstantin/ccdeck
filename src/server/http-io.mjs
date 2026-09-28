// The two ends of a JSON route's exchange with its caller: reading the body it
// posted, and answering it.
//
// These lived in src/server/index.mjs beside the static file server, and every
// route handler there calls one or both. They hold no state and know nothing
// about the deck — send writes one JSON reply at most, readBody collects a
// capped body and answers 413 itself when it is too big — so they sit in a leaf
// that a module of route handlers can import without importing the server. The
// 413 and the drain after it are one rule with two callers: handleEventIngest
// keeps its own copy of the shape for a larger cap and imports the drain's
// deadline from here.
//
// sendInternalError joined them from index.mjs when the event routes left it:
// it is the answer to a handler that threw, the route table's `guard` and its
// last line of defence both call it, and so does the ingest route.
import { PRODUCT } from "./brand.mjs";

export function send(res, status, body, headers = {}) {
  // ALREADY ANSWERED. A handler that replies after something upstream has
  // already written a status would otherwise throw ERR_HTTP_HEADERS_SENT out
  // of the route and become a 500 — or, on a streamed answer, corrupt it. The
  // oversize path below relies on this: readBody answers 413 itself and then
  // rejects into a caller whose own `send(res, 400, ...)` must be a no-op
  // rather than a second reply.
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

// How long an oversized POST is drained after it has been refused, so the 413
// reaches a poster that is still uploading. Generous next to hook.js's own
// one-second budget, and finite so nothing can sit on the socket indefinitely.
export const OVERSIZE_DRAIN_MS = 10_000;

/**
 * Collect a request body as a string, capped so a bad client can't fill memory.
 *
 * IT ANSWERS BEFORE IT HANGS UP, which it did not. `req.destroy()` ran ahead of
 * the reject, so the caller's own `send(res, 400, ...)` had no socket left to
 * write to: every one of the eleven routes through here replied to an oversized
 * body with a bare connection reset. Measured with a 70 KB body — `curl` exit
 * 56, "failure receiving network data", no status line, and nothing in the log.
 * `POST /api/lan/sync` is the one that matters, because its caller is another
 * deck rather than a person: it saw a reset it could not tell from a deck that
 * had died, and reported a network error rather than "too big".
 *
 * handleEventIngest was fixed for exactly this and its comment asserts this
 * function already got it right. It did not; this is that fix, in the shape
 * that one worked out and documents at length:
 *
 *   • answer 413 here, so there is a status on the wire;
 *   • keep reading and throw it away, because the poster is still mid-upload
 *     and hanging up now lands its next write on a dead socket — it aborts with
 *     EPIPE and discards the answer already sitting in its receive buffer;
 *   • bound the drain, because draining forever is its own denial of service.
 *
 * The reject still fires, so the callers' `.catch(() => null)` and their
 * `send(res, 400, ...)` are unchanged — `send` is a no-op once the headers have
 * gone out.
 */
export function readBody(req, res = null, limit = 64_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    let refused = false;
    req.setEncoding("utf8");
    req.on("data", c => {
      if (refused) return;
      body += c;
      if (body.length > limit) {
        refused = true;
        body = "";
        if (res) send(res, 413, { error: "body too large" });
        req.resume();
        const grace = setTimeout(() => req.destroy(), OVERSIZE_DRAIN_MS);
        grace.unref?.();
        req.on("close", () => clearTimeout(grace));
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => { if (!refused) resolve(body); });
    req.on("error", reject);
  });
}

// A request handler rejected. Two audiences, two different amounts of detail:
// the operator, who needs the whole error — stack included — to find the bug,
// and the HTTP client, which needs to know only that the request failed.
//
// They used to get the same string, on the theory that this server binds
// 127.0.0.1 and its only client is the user's own tab. A DNS-rebound page
// reaches a loopback server as same-origin and can read the body, and the
// errors that land here carry absolute paths out of the user's home directory
// — a failed rename of ~/.claude/settings.json, an ENOENT from an import. So
// stderr keeps every byte and the response body carries none of it; nothing is
// swallowed, it just stops travelling over the wire.
export function sendInternalError(res, err, log = console.error) {
  log(`${PRODUCT}: request handler failed:`, err);
  if (!res.headersSent) send(res, 500, { error: "internal error" });
  else res.end();
}
