// The one road the GitHub and GitLab clients take to their forge (#2179).
//
// github-api.mjs and gitlab-api.mjs say WHAT to ask; this file is HOW, and it
// is where the promises about the token are kept, so they are kept once:
//
// THE TOKEN GOES ONLY WHERE IT WAS GIVEN FOR. A transport is made for one
// connection with the origins that connection's provider allowed — GitLab's
// own instance, api.github.com — and the token is attached to a request only
// when its URL is on one of them. Redirects are followed by hand, never by
// fetch, so a hop to another origin (GitHub sends a job's log to a signed
// blob-storage URL) goes out WITHOUT it. A token never rides to a host the
// user did not type.
//
// NOTHING HERE SAYS THE TOKEN. Errors carry the forge's own words and the
// status; never a header, never the request. The messages are diagnostic —
// the panel picks its sentence from `kind`.
//
// ONE VOCABULARY FOR FAILURE. Every failure leaves as a ForgeError whose kind
// is one of forge-types.ts's ForgeErrorKind, because each kind has a different
// recovery on screen: auth and expired send the user to the connection,
// permission names the missing scope, unreachable and tls are about the
// network or the instance, rate-limit says when to try again.
import { cappedText } from "./provider-status.mjs";

const DEFAULT_TIMEOUT_MS = 20_000;
// A page of fifty merge requests with their reviewers is ~200 KB; a GraphQL
// detail query with every discussion, well under 2 MB. Sixteen is room for a
// big one without letting a wrong address stream a disk image into memory.
const DEFAULT_MAX_BYTES = 16 << 20;
const MAX_REDIRECTS = 3;
// The forge's own error body is read for its message only.
const ERROR_BODY_BYTES = 64 << 10;
// Lines a log tail keeps beyond what it was asked for, while it streams.
const TAIL_SLACK = 32;

/** A failure, in the panel's vocabulary. */
export class ForgeError extends Error {
  /**
   * @param {string} kind
   * @param {string} message
   * @param {{ status?: number, retryAfter?: number }} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "ForgeError";
    this.kind = kind;
    if (extra.status) this.status = extra.status;
    if (Number.isFinite(extra.retryAfter)) this.retryAfter = extra.retryAfter;
  }

  toJSON() {
    return {
      kind: this.kind,
      message: this.message,
      ...(this.status ? { status: this.status } : {}),
      ...(Number.isFinite(this.retryAfter) ? { retryAfter: this.retryAfter } : {}),
    };
  }
}

/** Any thrown thing as the route answers it. A non-ForgeError is a bug of
 *  ours, and says so without passing its message through. */
export function forgeErrorInfo(err) {
  if (err instanceof ForgeError) return err.toJSON();
  return { kind: "upstream", message: "unexpected error reading the forge" };
}

// What Node's fetch (undici) puts in `cause.code` when the certificate is the
// problem. ERR_TLS_* and ERR_SSL_* are matched by prefix below.
const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_REVOKED", "CERT_UNTRUSTED", "CERT_REJECTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "HOSTNAME_MISMATCH",
]);

/** The first error code anywhere down an error's causes — undici wraps the
 *  socket's error in `cause`, and a dual-stack connect in an AggregateError. */
function errorCode(err, depth = 0) {
  if (!err || depth > 4) return null;
  if (typeof err.code === "string" && err.code !== "UND_ERR") return err.code;
  if (Array.isArray(err.errors)) {
    for (const e of err.errors) {
      const c = errorCode(e, depth + 1);
      if (c) return c;
    }
  }
  return errorCode(err.cause, depth + 1);
}

/** A request that got no answer at all, as a ForgeError. */
export function networkError(err, origin) {
  if (err instanceof ForgeError) return err;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return new ForgeError("unreachable", `${origin} did not answer in time`);
  }
  const code = errorCode(err);
  if (code && (TLS_CODES.has(code) || /^ERR_(?:TLS|SSL)_/.test(code))) {
    return new ForgeError("tls", `${origin}: the certificate is not trusted (${code})`);
  }
  return new ForgeError("unreachable", `${origin}: ${code ?? "no answer"}`);
}

/**
 * Seconds until the forge will answer again, from whichever header it sent:
 * Retry-After (seconds or a date), GitHub's x-ratelimit-reset or GitLab's
 * RateLimit-Reset (both epoch seconds). Undefined when it said nothing.
 */
export function retryAfterSeconds(headers, nowMs) {
  const get = (name) => headers?.get?.(name) ?? null;
  const retry = get("retry-after");
  if (retry != null) {
    const s = Number(retry);
    if (Number.isFinite(s)) return Math.max(0, Math.ceil(s));
    const at = Date.parse(retry);
    if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - nowMs) / 1000));
  }
  const reset = Number(get("x-ratelimit-reset") ?? get("ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, Math.ceil(reset - nowMs / 1000));
  return undefined;
}

/** The forge's own sentence out of an error body: GitHub says `message`,
 *  GitLab `message` or `error_description` or `error`. */
function bodyMessage(body, fallback) {
  if (body && typeof body === "object") {
    const m = body.error_description ?? body.message ?? body.error;
    if (typeof m === "string" && m.trim()) return m.trim().slice(0, 300);
    // GitLab sends validation failures as { message: { field: [..] } }.
    if (m && typeof m === "object") return JSON.stringify(m).slice(0, 300);
  }
  if (typeof body === "string" && body.trim() && !/^\s*</.test(body)) return body.trim().slice(0, 300);
  return fallback;
}

/** A response that is not 2xx, as a ForgeError. Reads (a capped piece of) the
 *  body for the forge's message. */
export async function httpError(res, nowMs) {
  let body = null;
  try {
    const text = await cappedText(res, ERROR_BODY_BYTES);
    try { body = JSON.parse(text); } catch { body = text; }
  } catch { /* the status alone will do */ }
  const status = res.status;
  const message = bodyMessage(body, `http ${status}`);
  const retryAfter = retryAfterSeconds(res.headers, nowMs);
  if (status === 401) {
    // GitLab: { error: "invalid_token", error_description: "Token is expired…" }.
    return new ForgeError(/expired/i.test(message) ? "expired" : "auth", message, { status });
  }
  if (status === 429) return new ForgeError("rate-limit", message, { status, retryAfter });
  if (status === 403) {
    // GitHub answers an exhausted limit with 403, not 429: the remaining
    // count says which 403 this is, and its secondary limit says so in words.
    const limited = res.headers?.get?.("x-ratelimit-remaining") === "0"
      || /rate limit/i.test(message)
      || res.headers?.get?.("retry-after") != null;
    return limited
      ? new ForgeError("rate-limit", message, { status, retryAfter })
      : new ForgeError("permission", message, { status });
  }
  if (status === 404) return new ForgeError("not-found", message, { status });
  // A self-hosted instance that is down usually answers through its proxy.
  if (status === 502 || status === 503 || status === 504) return new ForgeError("unreachable", message, { status });
  return new ForgeError("upstream", message, { status });
}

/** The ForgeError for a GraphQL answer with errors and no data. GitHub types
 *  its errors; GitLab says it in words. */
export function graphqlError(errors) {
  const list = Array.isArray(errors) ? errors : [];
  const message = list.map(e => e?.message).filter(m => typeof m === "string").join("; ").slice(0, 300)
    || "the forge answered without data";
  const types = new Set(list.map(e => e?.type ?? e?.extensions?.code).filter(Boolean));
  if (types.has("RATE_LIMITED") || /rate limit/i.test(message)) return new ForgeError("rate-limit", message);
  if (types.has("INSUFFICIENT_SCOPES") || types.has("FORBIDDEN") || /insufficient.scope|not have permission/i.test(message)) {
    return new ForgeError("permission", message);
  }
  if (types.has("NOT_FOUND") || /does not exist|could not resolve/i.test(message)) return new ForgeError("not-found", message);
  return new ForgeError("upstream", message);
}

/** The URL of the next page from a Link header, or null. */
export function nextLink(headers) {
  const link = headers?.get?.("link");
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1];
  }
  return null;
}

/** An ISO time as epoch ms, or null. */
export function epoch(s) {
  if (typeof s !== "string" || !s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Run `fn` over `items` with at most `limit` at once, in order. Used where a
 *  forge needs one call per row (GitLab's ahead/behind per branch). */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// CSI and OSC escape sequences, and the two-byte ones — what CI runners colour
// and move the cursor with.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// GitLab's collapsible-section markers: `section_start:1700000000:step_script[collapsed=true]`.
const GITLAB_SECTION = /section_(?:start|end):\d+:[A-Za-z0-9_.-]+(?:\[[^\]]*\])?/g;

/**
 * One raw log line as a person reads it. A carriage return inside a line is a
 * progress bar redrawn — the text after the last one is what the terminal
 * showed — and GitLab puts its section markers before one too.
 */
export function cleanLogLine(line) {
  let s = String(line ?? "").replace(/\r+$/, "");
  const cr = s.lastIndexOf("\r");
  if (cr >= 0) s = s.slice(cr + 1);
  return s.replace(GITLAB_SECTION, "").replace(ANSI, "").trimEnd();
}

/**
 * A transport for one connection.
 *
 * @param {object} opts
 * @param {string} opts.token
 * @param {(token: string) => Record<string, string>} opts.authHeaders  how this forge wants the token
 * @param {string[]} opts.allowedOrigins  where the token may go
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxBytes]
 */
export function createForgeTransport({
  token,
  authHeaders,
  allowedOrigins,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
}) {
  const origins = new Set((allowedOrigins ?? []).map(o => new URL(o).origin));

  function headersFor(url, extra) {
    const h = { accept: "application/json", "user-agent": "ccdeck", ...extra };
    if (token && origins.has(new URL(url).origin)) Object.assign(h, authHeaders(token));
    return h;
  }

  /** One request, redirects followed by hand: the token is re-decided at
   *  every hop, so a hop off the allowed origins drops it. */
  async function send(url, { method = "GET", headers, body, timeout = timeoutMs } = {}) {
    let target = String(url);
    const signal = AbortSignal.timeout(timeout);
    for (let hop = 0; ; hop++) {
      let res;
      try {
        res = await fetchImpl(target, { method, headers: headersFor(target, headers), body, redirect: "manual", signal });
      } catch (err) {
        throw networkError(err, new URL(target).origin);
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers?.get?.("location") : null;
      if (!location) return res;
      res.body?.cancel?.().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new ForgeError("upstream", "too many redirects", { status: res.status });
      target = new URL(location, target).toString();
      // A redirect is a GET from here on (303, and what browsers do for 302).
      if (method !== "GET" && res.status !== 307 && res.status !== 308) {
        method = "GET";
        body = undefined;
      }
    }
  }

  /** GET (or send) and parse JSON. A 2xx that is not JSON is the wrong
   *  address — a login page, a proxy's splash — and says so as incompatible. */
  async function json(url, opts = {}) {
    const res = await send(url, opts);
    if (!res.ok) throw await httpError(res, now());
    const type = res.headers?.get?.("content-type") ?? "";
    if (!/json/i.test(type)) {
      res.body?.cancel?.().catch(() => {});
      throw new ForgeError("incompatible", `${new URL(url).origin} answered ${type || "without a content type"}, not the API`, { status: res.status });
    }
    let text;
    try {
      text = await cappedText(res, maxBytes);
    } catch (err) {
      throw new ForgeError("upstream", err?.message === "body too large" ? "answer too large" : "answer cut off", { status: res.status });
    }
    try {
      return { data: JSON.parse(text), headers: res.headers, status: res.status };
    } catch {
      throw new ForgeError("upstream", "unreadable JSON", { status: res.status });
    }
  }

  /** POST a GraphQL query. Errors WITH data are returned for the caller to
   *  weigh (a field the token cannot see); errors without data throw. */
  async function graphql(url, query, variables = {}) {
    const { data: body } = await json(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    if (!body?.data) throw graphqlError(errors);
    return { data: body.data, errors };
  }

  /**
   * The last `lines` lines of a text resource — a job's log. Asks for only the
   * end first (a suffix Range); a server that ignores Range sends it all, and
   * that is streamed with only the last lines kept, up to `maxBytes`.
   */
  async function tail(url, { lines = 80, tailBytes = 256 << 10, maxBytes: cap = 64 << 20, clean = cleanLogLine } = {}) {
    const res = await send(url, { headers: { accept: "text/plain, */*", range: `bytes=-${tailBytes}` }, timeout: 60_000 });
    if (!res.ok) throw await httpError(res, now());
    const partial = res.status === 206;
    let kept = [];
    let dropped = false;
    let carry = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    const take = (text, final) => {
      const parts = (carry + text).split("\n");
      carry = final ? "" : parts.pop();
      for (const p of parts) kept.push(p);
      // Trimmed with room to spare: the blank lines a log ends on are
      // dropped below, and must not take the place of real ones.
      if (kept.length > lines * 2 + TAIL_SLACK) {
        kept = kept.slice(-(lines + TAIL_SLACK));
        dropped = true;
      }
    };
    const reader = res.body?.getReader?.();
    if (!reader) {
      take(await res.text(), true);
    } else {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > cap) {
          reader.cancel().catch(() => {});
          throw new ForgeError("upstream", "log too large to read the end of");
        }
        take(decoder.decode(value, { stream: true }), false);
      }
      take(decoder.decode(), true);
    }
    // A suffix range starts mid-line: the first line is a fragment.
    if (partial && kept.length > 0) {
      kept.shift();
      dropped = true;
    }
    let out = kept.map(clean);
    while (out.length && out[out.length - 1] === "") out.pop();
    if (out.length > lines) {
      out = out.slice(-lines);
      dropped = true;
    }
    return { lines: out, truncated: dropped };
  }

  return { send, json, graphql, tail };
}
