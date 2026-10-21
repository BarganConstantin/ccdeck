// What can go wrong between the deck and a tracker it is connected to (#2178),
// as a short list of kinds the page can act on rather than a status code it
// would have to interpret.
//
// One vocabulary for every provider: Jira today, GitHub and GitLab next. A
// provider maps its own answers onto these kinds, and the page draws one state
// per kind — "Jira no longer accepts this token" with a Reconnect, "try again in
// 30 s", "this server is older than 8.14" — without knowing which tracker said
// it. The message is ours, written for the person reading the panel; a remote
// body is never passed through whole, so nothing the tracker echoes (a header, a
// URL with a query) can ride out on an error.
import { cooldownFromHeader } from "../quota-oauth.mjs";

/** Every kind an integration error can be, and the status the deck answers
 *  the page with for it — the contract every provider shares (#2178, #2179):
 *  401 for a refused or expired token, 403 for an account that may not read
 *  it, 404 for what is not there, 429 for a rate limit, and 502 for every way
 *  the tracker itself failed. `invalid` is the deck's own: a form, or a
 *  parameter, that is not the shape it must be (400). */
export const ERROR_STATUS = Object.freeze({
  auth: 401,
  expired: 401,
  permission: 403,
  "not-found": 404,
  "rate-limit": 429,
  unreachable: 502,
  tls: 502,
  incompatible: 502,
  upstream: 502,
  invalid: 400,
});

/** Whether a thrown thing carries one of the kinds — an IntegrationError, or a
 *  provider's own typed error (#2179's ForgeError) with the same fields. */
export function isTypedError(err) {
  return Boolean(err && typeof err === "object" && typeof err.kind === "string" && Object.hasOwn(ERROR_STATUS, err.kind)
    && typeof err.message === "string");
}

export class IntegrationError extends Error {
  /**
   * @param {keyof typeof ERROR_STATUS} kind
   * @param {string} message what the panel says, in the deck's own words
   * @param {{ status?: number, retryAfter?: number, field?: string, detail?: string }} [extra]
   *   status is the tracker's own HTTP status, when it answered one;
   *   retryAfter in seconds for a rate limit; field names the form input a bad
   *   value came from; detail is a short remote reason safe to show (a JQL
   *   error Jira wrote, never a header or a token)
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "IntegrationError";
    this.kind = Object.hasOwn(ERROR_STATUS, kind) ? kind : "upstream";
    if (Number.isInteger(extra.status) && extra.status >= 100 && extra.status < 600) this.status = extra.status;
    if (Number.isFinite(extra.retryAfter)) this.retryAfter = Math.max(1, Math.round(extra.retryAfter));
    if (typeof extra.field === "string") this.field = extra.field;
    if (typeof extra.detail === "string" && extra.detail) this.detail = extra.detail.slice(0, 300);
  }
}

export function integrationError(kind, message, extra) {
  return new IntegrationError(kind, message, extra);
}

/** The JSON body an error is answered with — the one envelope every provider
 *  answers with: `{ ok: false, error: { kind, message, status?, retryAfter? } }`,
 *  plus `field` and `detail` when the deck has them. Nothing else of the error
 *  goes out: not its stack, not a cause, not anything the tracker echoed. */
export function errorBody(err) {
  const e = isTypedError(err) ? err : new IntegrationError("upstream", "The deck failed while reading the tracker.");
  const retryAfter = Number.isFinite(e.retryAfter) ? Math.max(1, Math.round(e.retryAfter)) : null;
  return {
    ok: false,
    error: {
      kind: e.kind,
      message: String(e.message).slice(0, 500),
      ...(Number.isInteger(e.status) ? { status: e.status } : {}),
      ...(retryAfter ? { retryAfter } : {}),
      ...(typeof e.field === "string" && e.field ? { field: e.field.slice(0, 40) } : {}),
      ...(typeof e.detail === "string" && e.detail ? { detail: e.detail.slice(0, 300) } : {}),
    },
  };
}

export function errorStatus(err) {
  return isTypedError(err) ? ERROR_STATUS[err.kind] : 500;
}

/** A thrown error as a route answers it, `{ status, body }`: a provider's
 *  `routes` catches and returns this rather than spelling the envelope. An
 *  error that carries no kind is a bug of ours, a 500 that says nothing more. */
export function errorResponse(err) {
  return { status: errorStatus(err), body: errorBody(err) };
}

/** Seconds to wait, from a Retry-After header: the deck's own floor and ceiling
 *  (cooldownFromHeader), because a remote header is not entitled to decide
 *  either. 30 s when the header is missing or unreadable. */
export function retryAfterSeconds(raw) {
  return Math.round(cooldownFromHeader(raw, 30_000, 5_000, 3600_000) / 1000);
}

/** The node:tls verification codes a fetch through undici surfaces as
 *  `err.cause.code`. A certificate the deck cannot verify is a `tls` error
 *  with its own message — there is deliberately no way to ignore one. */
const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_REVOKED", "CERT_UNTRUSTED", "CERT_REJECTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH", "ERR_SSL_WRONG_VERSION_NUMBER", "EPROTO", "ERR_TLS_HANDSHAKE_TIMEOUT",
]);

/** A fetch that threw before any answer came back, as an IntegrationError. */
export function errorFromFetchFailure(err, label = "the tracker") {
  if (err instanceof IntegrationError) return err;
  const cause = err?.cause ?? {};
  const code = String(cause.code ?? err?.code ?? "");
  if (TLS_CODES.has(code) || /certificate|self[- ]signed|SSL routines|tls/i.test(String(cause.message ?? ""))) {
    return new IntegrationError("tls",
      `The deck could not verify ${label}'s HTTPS certificate (${code || "certificate error"}). ` +
      "Check that the address is right and that the server's certificate is valid for it.");
  }
  if (err?.name === "TimeoutError" || err?.name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return new IntegrationError("unreachable", `${capital(label)} did not answer in time.`);
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new IntegrationError("unreachable", `The deck could not find ${label}'s address. Check the URL and your network.`);
  }
  return new IntegrationError("unreachable",
    `The deck could not reach ${label}${code ? ` (${code})` : ""}. Check the URL, your network or VPN.`);
}

/** An HTTP answer that was not a success, as an IntegrationError. `phase` is
 *  "validate" while a form is being checked and "use" afterwards: a token
 *  refused while it is being entered is a wrong token, and refused after it
 *  has worked is an expired or revoked one. */
export function errorFromStatus(status, headers, { phase = "use", label = "the tracker", detail } = {}) {
  const get = name => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]) ?? null;
  if (status === 401) {
    return phase === "validate"
      ? new IntegrationError("auth", `${capital(label)} did not accept these credentials.`, { status })
      : new IntegrationError("expired", `${capital(label)} no longer accepts the saved token. It may have expired or been revoked — reconnect with a new one.`, { status });
  }
  if (status === 403) {
    return new IntegrationError("permission", `${capital(label)} refused: the account or token is not allowed to read this.`, { status, detail });
  }
  if (status === 429) {
    const retryAfter = retryAfterSeconds(get("retry-after") ?? get("beta-retry-after"));
    return new IntegrationError("rate-limit", `${capital(label)} is limiting requests. Try again in ${retryAfter} s.`, { status, retryAfter });
  }
  if (status === 404) return new IntegrationError("not-found", `${capital(label)} has no such page or record, or this account cannot see it.`, { status, detail });
  if (status === 400) return new IntegrationError("upstream", `${capital(label)} refused the request.`, { status, detail });
  if (status === 502 || status === 503 || status === 504) {
    const wait = get("retry-after");
    return new IntegrationError("unreachable", `${capital(label)} is not answering right now (${status}). Try again shortly.`,
      { status, ...(wait ? { retryAfter: retryAfterSeconds(wait) } : {}) });
  }
  return new IntegrationError("upstream", `${capital(label)} answered ${status}.`, { status, detail });
}

function capital(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
