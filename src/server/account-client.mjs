// The account's one channel to the API: JSON over HTTPS, on one dedicated
// keep-alive connection.
//
// ONE CONNECTION, NOT ONE PER REQUEST. The status frames go every 15 seconds
// and the settings calls ride between them, so the agent keeps one socket
// (maxSockets: 1) and every request queues on it — one TLS handshake for the
// life of the deck instead of one per frame, and through Cloudflare a request a
// quarter of a minute after the last one finds the same connection still up.
// Node 18 and 20 have no WebSocket client and the deck takes no dependencies,
// which is why this is request/response at all (design 1.4).
//
// NOTHING FROM THE REPORTS CHANNEL RIDES HERE. Usage reports (reports.mjs)
// carry an install id and a hashed device fingerprint; this channel carries
// neither, and reports never carry the device id this channel is given. The
// two are deliberately unlinkable, so nothing here imports reports.mjs and the
// headers are exactly the ones below. account-client.test.ts holds a request
// to that.
//
// The rules a request lives by are the reporter's (reports.mjs `call`): a six
// second ceiling, a user agent that names the version and nothing else, and a
// Retry-After honoured — read here and handed to the caller, who owns the
// schedule.
import http from "node:http";
import https from "node:https";

export const CLIENT_TIMEOUT_MS = 6_000;
/** The longest a Retry-After is waited for: a header asking for a week does
 *  not silence a deck for one. The reporter's cap. */
export const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;
const BODY_MAX = 256 * 1024;

/** A Retry-After, in seconds or as an HTTP date, as milliseconds from `at` —
 *  or null when there is none or it will not read. */
export function retryAfterMs(raw, at = Date.now()) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - at;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, RETRY_AFTER_MAX_MS) : null;
}

/**
 * One request over `agent`, as the product makes it. Resolves to the status,
 * the headers (lower-case, as Node gives them) and the body text; rejects on a
 * network failure or the deadline.
 */
function nodeRequest({ method, url, headers, body, timeoutMs, agents }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === "https:" ? https : http;
    const agent = target.protocol === "https:" ? agents.https : agents.http;
    let settled = false;
    const fail = err => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } };
    const req = lib.request(target, { method, headers, agent }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", c => {
        text += c;
        if (text.length > BODY_MAX) req.destroy(new Error("response too large"));
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
      });
      res.on("error", fail);
    });
    const timer = setTimeout(() => { req.destroy(new Error("timeout")); fail(new Error("timeout")); }, timeoutMs);
    timer.unref?.();
    req.on("error", fail);
    req.end(body);
  });
}

/** Whether a content type is JSON, problem+json included. */
function isJson(type) {
  const t = String(type ?? "").split(";")[0].trim().toLowerCase();
  return t === "application/json" || t === "application/problem+json" || t.endsWith("+json");
}

/**
 * The client. `request` is the suite's stand-in for the transport and takes
 * the same object nodeRequest does; the product passes nothing and gets one
 * keep-alive agent per protocol, owned by this client alone.
 *
 * Every call resolves — never rejects — to one of:
 *   { status, ok, body, error, retryAfterMs }   the API answered
 *   { status: 0, ok: false, network: true }      it did not (offline, timeout, reset)
 * where `error` is a problem+json body's machine-readable `error`, if any.
 */
export function createAccountClient({
  apiBase,
  version = "",
  request = null,
  timeoutMs = CLIENT_TIMEOUT_MS,
  now = Date.now,
  enabled = () => true,
} = {}) {
  const agents = request ? null : {
    http: new http.Agent({ keepAlive: true, maxSockets: 1 }),
    https: new https.Agent({ keepAlive: true, maxSockets: 1 }),
  };
  const send = request ?? (opts => nodeRequest({ ...opts, agents }));
  const userAgent = `ccdeck/${version || "unknown"}`;

  async function call(method, path, { body, token, timeout = timeoutMs } = {}) {
    // THE ONE GATE EVERY REQUEST PASSES. The account is asked about on every
    // call, not once at boot: a hand-edited prefs.json that turned it off is
    // picked up by the next settings write, and from then on nothing goes —
    // the publisher, the sync and a rotation all see an unreachable API.
    if (!enabled()) return { status: 0, ok: false, network: true, disabled: true, body: null, error: null, retryAfterMs: null };
    const headers = { accept: "application/json", "user-agent": userAgent };
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    if (token) headers.authorization = `Bearer ${token}`;
    let res;
    try {
      res = await send({ method, url: apiBase + path, headers, body: payload, timeoutMs: timeout });
    } catch {
      return { status: 0, ok: false, network: true, body: null, error: null, retryAfterMs: null };
    }
    let parsed = null;
    const type = res.headers?.["content-type"];
    if (res.text && (isJson(type) || !type)) {
      try { parsed = JSON.parse(res.text); } catch { parsed = null; }
    }
    const status = res.status;
    return {
      status,
      ok: status >= 200 && status < 300,
      network: false,
      body: parsed,
      error: parsed && typeof parsed.error === "string" ? parsed.error : null,
      retryAfterMs: retryAfterMs(res.headers?.["retry-after"], now()),
    };
  }

  return {
    apiBase,
    get: (path, opts) => call("GET", path, opts),
    post: (path, body, opts) => call("POST", path, { ...opts, body }),
    put: (path, body, opts) => call("PUT", path, { ...opts, body }),
    del: (path, opts) => call("DELETE", path, opts),
    /** Close the kept connection: a disconnect, a revocation, a shutdown. */
    close() {
      agents?.http.destroy();
      agents?.https.destroy();
    },
  };
}
