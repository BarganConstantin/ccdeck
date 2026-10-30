// /api/integrations — the connections to trackers (#2178), and the doorway to
// each provider's own read routes.
//
//   GET    /api/integrations                            every registered provider, with whether it
//                                                        is available now, and every connection
//                                                        (no secrets)
//   POST   /api/integrations/connections                create: { kind, name?, input }
//   PATCH  /api/integrations/connections/<id>           edit:   { name?, input? } — re-validates when
//                                                        the address, the token or the provider's
//                                                        options change
//   POST   /api/integrations/connections/<id>/test      ask the tracker again with the saved token
//   DELETE /api/integrations/connections/<id>           disconnect: the connection and its token,
//                                                        with or without a provider for its kind
//   GET    /api/integrations/<kind>/<id>/asset?url=     an image, read by the provider's client from its
//                                                        own image hosts (raster only; empty 403/404)
//   GET    /api/integrations/<kind>/<id>/<subpath…>     the provider's own reads (registry.mjs)
//   POST   /api/integrations/jira/<id>/board/<boardId>/move
//                                                      one validated issue's group/rank (jira-move.mjs)
//
// A route that would ask a provider that is not answering (registry.mjs,
// `available`), or ask for a saved connection whose provider this deck does
// not have, answers `unavailable` (503) and asks nothing; an image is an
// empty 404 as always; Disconnect needs no provider at all.
//
// Every GET here is a guarded read (request-gates.mjs, GUARDED_READ_PREFIXES):
// what a tracker holds is the user's work, and the deck's own page is the only
// caller. Every mutation already needs the page or the deck token.
//
// A SECRET NEVER LEAVES THIS FILE IN AN ANSWER. Connections come out of the
// store already without one (store.mjs); the routes below add only
// `tokenSaved`. The secret is read for exactly two things: handing it to the
// provider to build a client, and through that client, signing a request.
// And what comes back is sent without it: a tracker that echoes the token
// reaches the page, the saved connection and the log as `[redacted]`.
import { createHash } from "node:crypto";
import { readBody, readBytes, send } from "../http-io.mjs";
import { errorBody, errorResponse, integrationError, isTypedError } from "./errors.mjs";
import { fetchImage, IMAGE_MAX_BYTES, isSafeTarget, normaliseBaseUrl, originOf, RASTER_TYPES, rasterTypeOf } from "./proxy.mjs";
import { getProvider, isAvailable, providerList } from "./registry.mjs";
import { integrationsStore } from "./store.mjs";
import { jiraWriteGuard } from "./jira-write-guard.mjs";
import { parseJiraMove } from "./jira-move.mjs";
import "./providers.mjs";

// ── one client per connection ───────────────────────────────────────────────

/** id -> { print, client }. A client holds the provider's short caches (a
 *  field map, a board list), so it is kept, and rebuilt the moment what it
 *  was made from changes: the kind, the address, the token, or the saved
 *  connection itself (an edit or a Test moves `updatedAt`). */
const clients = new Map();

function fingerprint(conn, secret) {
  return createHash("sha256")
    .update(JSON.stringify([conn.kind, conn.baseUrl, conn.updatedAt, conn.allowedOrigins, secret]))
    .digest("base64url");
}

/** The kept client for a saved connection, made again when it is stale. */
export function clientFor(provider, conn, secret, { fetchImpl } = {}) {
  const print = fingerprint(conn, secret);
  const kept = clients.get(conn.id);
  if (kept && kept.print === print && kept.fetchImpl === fetchImpl) return kept.client;
  const client = provider.createClient(conn, secret, { fetchImpl });
  clients.set(conn.id, { print, client, fetchImpl });
  forgetAssets(conn.id);
  return client;
}

/** Drop a connection's client and every image read through it. */
export function forgetConnection(id) {
  clients.delete(id);
  forgetAssets(id);
}

// ── the asset route ─────────────────────────────────────────────────────────
//
// GET /api/integrations/<kind>/<id>/asset?url=  — an image the panel draws (an
// avatar, an icon, a picture in a description), read by the deck and passed on
// from its own origin.
//
// THE CLIENT DECIDES WHERE AN IMAGE MAY COME FROM. `client.allowedOrigins` are
// where the token goes, not where images live — a Cloud avatar is on
// Atlassian's CDN, a GitHub one on githubusercontent.com, and neither may ever
// see the token. So a provider's `client.fetchAsset(url)` owns the read: its
// own list of image hosts, checked on the address and on every redirect hop;
// the token on its token origins only; raster images only; a streamed cap. A
// provider without one gets the generic read below, from its token origins
// and nowhere else, unsigned.
//
// AN IMAGE THAT FAILS SAYS NOTHING. Any failure is a 403 (not a host this
// connection reads from) or a 404 (anything else) with an empty body: the
// page's <img> falls back to what it draws itself, and nothing about the
// failure reaches the connection — a 401 on an avatar is not an expired token.

/** Images read recently, in memory, briefly; and the ones that failed, for a
 *  minute, so a list of rows with one broken icon asks once, not per row. */
const assetCache = new Map();
const assetFailures = new Map();
const ASSET_TTL_MS = 5 * 60_000;
const ASSET_FAILURE_TTL_MS = 60_000;
const ASSET_CACHE_BYTES = 24 * 1024 * 1024;
/** One image larger than this is served but not kept. */
const ASSET_KEEP_BYTES = 1024 * 1024;
let assetCacheBytes = 0;

function forgetAssets(id) {
  for (const [key, value] of assetCache) {
    if (key.startsWith(`${id}|`)) { assetCache.delete(key); assetCacheBytes -= value.bytes.length; }
  }
  for (const key of assetFailures.keys()) if (key.startsWith(`${id}|`)) assetFailures.delete(key);
}

/** The headers an image is answered with: its raster type, never sniffed,
 *  sandboxed if it is ever opened as a document, kept only by this browser. */
function assetHeaders(contentType, length) {
  return {
    "Content-Type": contentType,
    "Content-Length": String(length),
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

function rememberAsset(key, entry) {
  const old = assetCache.get(key);
  if (old) { assetCacheBytes -= old.bytes.length; assetCache.delete(key); }
  if (entry.bytes.length > ASSET_KEEP_BYTES) return;
  assetCache.set(key, entry);
  assetCacheBytes += entry.bytes.length;
  while (assetCacheBytes > ASSET_CACHE_BYTES && assetCache.size) {
    const [oldest, value] = assetCache.entries().next().value;
    assetCache.delete(oldest);
    assetCacheBytes -= value.bytes.length;
  }
}

/** A failed image: an empty 403 or 404, never a JSON error and never kept. */
function assetRefused(res, status = 404) {
  if (res.writableEnded || res.headersSent) return;
  res.writeHead(status === 403 ? 403 : 404, { "Content-Length": "0", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end();
}

/** The read a provider without its own fetchAsset gets: its token origins
 *  only, no token, the same checks. */
function genericAsset(client, url, opts) {
  const origins = Array.isArray(client.allowedOrigins) ? client.allowedOrigins : [];
  return fetchImage(url, { ...opts, tokenOrigins: origins, sign: () => ({}) });
}

async function serveAsset(res, conn, client, raw, { signal, method, fetchImpl }) {
  let target;
  try { target = new URL(String(raw ?? "")); } catch { return assetRefused(res, 404); }
  if (!raw || raw.length > 4000 || (target.protocol !== "https:" && target.protocol !== "http:")) return assetRefused(res, 404);
  const key = `${conn.id}|${target.href}`;
  const failed = assetFailures.get(key);
  if (failed && Date.now() - failed.at < ASSET_FAILURE_TTL_MS) return assetRefused(res, failed.status);
  let image = assetCache.get(key);
  if (!image || Date.now() - image.at >= ASSET_TTL_MS) {
    try {
      const got = typeof client.fetchAsset === "function"
        ? await client.fetchAsset(target.href, { maxBytes: IMAGE_MAX_BYTES, signal })
        : await genericAsset(client, target.href, { maxBytes: IMAGE_MAX_BYTES, signal, fetchImpl });
      const declared = String(got?.contentType ?? "").split(";")[0].trim().toLowerCase();
      const bytes = got?.bytes;
      // The route checks again what every client promised, and serves the
      // image as the type its bytes are, whichever raster type it was labelled.
      const contentType = Buffer.isBuffer(bytes) ? rasterTypeOf(bytes) : null;
      if (!RASTER_TYPES.has(declared) || !contentType || bytes.length > IMAGE_MAX_BYTES) {
        throw integrationError("not-found", "Not an image the deck shows.");
      }
      image = { at: Date.now(), contentType, bytes };
      rememberAsset(key, image);
    } catch (err) {
      if (signal?.aborted) return;
      const status = isTypedError(err) && err.kind === "permission" ? 403 : 404;
      assetFailures.set(key, { at: Date.now(), status });
      if (assetFailures.size > 2000) assetFailures.delete(assetFailures.keys().next().value);
      return assetRefused(res, status);
    }
  }
  res.writeHead(200, assetHeaders(image.contentType, image.bytes.length));
  res.end(method === "HEAD" ? undefined : image.bytes);
}

// ── connections ─────────────────────────────────────────────────────────────

/** The form's values as a candidate, by the provider's rules or the default
 *  ones: an address and a token, a blank token keeping the saved one. */
function parseInput(provider, input, existing) {
  if (typeof provider.parseInput === "function") return provider.parseInput(input, existing);
  const baseUrl = normaliseBaseUrl(input?.baseUrl, { field: "baseUrl", label: `the ${provider.label} address` });
  const typed = typeof input?.token === "string" ? input.token.trim() : "";
  const secret = typed || existing?.secret || null;
  if (!secret) throw integrationError("invalid", "Enter a token.", { field: "token" });
  return { baseUrl, secret, meta: {} };
}

/** Ask the tracker, with a fresh client for the candidate, who this is — and
 *  settle what the connection may reach. What the provider answers is the
 *  whole of the new meta; `inputMeta` (the form's own choices, from
 *  parseInput) fills only what it left out, so nothing a previous check
 *  learned outlives the check that no longer finds it. What the tracker said
 *  about the account is kept without the secret in it (see below). */
async function validateCandidate(provider, candidate, secret, { phase, signal, fetchImpl, inputMeta = {} }) {
  const conn = { allowedOrigins: [originOf(candidate.baseUrl)].filter(Boolean), ...candidate };
  const client = provider.createClient(conn, secret, { fetchImpl });
  const result = await client.validate({ phase, signal });
  const origins = new Set([originOf(candidate.baseUrl), ...(Array.isArray(client.allowedOrigins) ? client.allowedOrigins : [])].filter(Boolean));
  for (const origin of origins) {
    if (!isSafeTarget(origin)) throw integrationError("invalid", `The deck will not send a token to ${origin}.`);
  }
  const needles = secretNeedles(secret);
  return {
    baseUrl: candidate.baseUrl,
    account: redactSecrets(result?.account ?? {}, needles),
    meta: redactSecrets({ ...inputMeta, ...(result?.meta ?? {}), checkedAt: new Date().toISOString() }, needles),
    allowedOrigins: [...origins],
  };
}

// ── the connection's own secret, in nothing the deck sends ──────────────────
//
// A tracker may echo what it was sent — a 401 that quotes the Authorization
// header, a proxy's error page, an account name — and a provider passes the
// tracker's words on: an error's reason, the account it found. So whatever
// this file sends or keeps once a secret is in hand — an answer, an error,
// the account saved with a connection, a failure handed to the log and the
// error report — has the connection's own secret taken out of it first, each
// time as `[redacted]`.

export const REDACTED = "[redacted]";
/** A string of a secret shorter than this is not looked for: "basic" or a
 *  scheme name occurs anywhere, and no token is this short. */
const REDACT_MIN = 8;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/**
 * What of one or more secrets must never leave the deck, longest first: each
 * string in a secret of REDACT_MIN characters or more — but an email address,
 * which names who signs and is the account the page already shows — and the
 * HTTP Basic credential one of its strings makes with another. The secret
 * stays opaque: nothing here reads one of its fields by name.
 */
export function secretNeedles(...secrets) {
  const needles = new Set();
  for (const secret of secrets) {
    const strings = [];
    const walk = (value, depth) => {
      if (typeof value === "string") strings.push(value);
      else if (value && typeof value === "object" && depth < 8) for (const v of Object.values(value)) walk(v, depth + 1);
    };
    walk(secret, 0);
    const own = strings.filter(s => s.length >= REDACT_MIN && !EMAIL.test(s));
    for (const s of own) needles.add(s);
    for (const user of strings) for (const s of own) {
      if (user !== s) needles.add(Buffer.from(`${user}:${s}`, "utf8").toString("base64"));
    }
  }
  return [...needles].sort((a, b) => b.length - a.length);
}

function redactText(text, needles) {
  let out = text;
  for (const needle of needles) if (out.includes(needle)) out = out.split(needle).join(REDACTED);
  return out;
}

/**
 * `value` with every needle replaced in every string in it, its keys too —
 * or `value` itself, untouched, when no needle is anywhere in it (the
 * answer as JSON is searched first, so an ordinary read costs one pass).
 */
export function redactSecrets(value, needles) {
  if (!needles.length || value == null) return value;
  if (typeof value === "string") return redactText(value, needles);
  let json;
  try { json = JSON.stringify(value); } catch { return value; }
  if (json === undefined || !needles.some(n => json.includes(JSON.stringify(n).slice(1, -1)))) return value;
  const walk = v => {
    if (typeof v === "string") return redactText(v, needles);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactText(k, needles), walk(x)]));
    return v;
  };
  return walk(JSON.parse(json));
}

/** A saved connection without its own secret in what a page reads of it.
 *  Every save here already takes it out, but builds before this host did kept
 *  the account a tracker answered as it came, echo and all. Its id, kind and
 *  address are left as they are, so it can always be found and disconnected. */
function withoutOwnSecret(conn, secret) {
  const needles = secretNeedles(secret);
  if (!needles.length) return conn;
  return { ...conn, name: redactSecrets(conn.name, needles), account: redactSecrets(conn.account, needles), meta: redactSecrets(conn.meta, needles) };
}

/** A failure that is a bug rather than a typed error, as the log and the
 *  error report get it: its message and stack without the secret, and none
 *  of what it carried besides (a cause may hold a request). */
function redactedError(err, needles) {
  const copy = new Error(redactText(String(err?.message ?? err), needles));
  copy.name = typeof err?.name === "string" ? err.name : "Error";
  copy.stack = typeof err?.stack === "string" ? redactText(err.stack, needles) : copy.stack;
  return copy;
}

async function readJsonBody(req, res) {
  const raw = await readBody(req, res).catch(() => null);
  if (raw == null) return null;
  try {
    const body = JSON.parse(raw);
    return body && typeof body === "object" && !Array.isArray(body) ? body : {};
  } catch { return {}; }
}

/** A connection as the page draws it: the account's avatar made loadable,
 *  through the asset route, where the provider's client decides whether its
 *  host is one to read from (and whether the token goes with it). */
export function forPage(conn) {
  if (!conn) return conn;
  const raw = conn.account?.avatarUrl;
  const avatarUrl = raw && isSafeTarget(raw)
    ? `/api/integrations/${encodeURIComponent(conn.kind)}/${encodeURIComponent(conn.id)}/asset?url=${encodeURIComponent(raw)}`
    : "";
  return { ...conn, account: { ...conn.account, avatarUrl } };
}

/** Whether an edit asks for a re-check: a new address, a new token, or a
 *  provider option (Cloud or Server) the saved meta does not already say. */
function needsValidation(existing, existingSecret, candidate) {
  if (candidate.baseUrl !== existing.baseUrl) return true;
  if (JSON.stringify(candidate.secret) !== JSON.stringify(existingSecret)) return true;
  for (const [key, value] of Object.entries(candidate.meta ?? {})) {
    if (JSON.stringify(existing.meta?.[key]) !== JSON.stringify(value)) return true;
  }
  return false;
}

const notFound = res => send(res, 404, errorBody(integrationError("not-found", "No such integrations route.")));
const notAllowed = res => send(res, 405, errorBody(integrationError("invalid", "That method is not allowed here.")));
/** The provider for this kind is not on this deck, or not answering it. */
const unavailable = label => integrationError("unavailable", `${label} is not available on this deck.`);

/**
 * Every /api/integrations request. `deps` is for the suite: a store in a temp
 * directory and a fetch that answers as a tracker would.
 */
export async function handleIntegrations(req, res, url, deps = {}) {
  const store = deps.store ?? integrationsStore;
  const fetchImpl = deps.fetchImpl;
  const segments = url.pathname.split("/").filter(Boolean).slice(2).map(s => {
    try { return decodeURIComponent(s); } catch { return "\u0000"; }
  });
  const method = req.method;
  // The page's request: a panel closed mid-read stops the read upstream too.
  const controller = new AbortController();
  res.on?.("close", () => { if (!res.writableEnded) controller.abort(); });
  const signal = controller.signal;

  // Every secret this request has in hand — a saved one, a candidate, the
  // token as it was typed — and the answer without any of them.
  const held = [];
  const hold = secret => { if (secret != null) held.push(secret); return secret; };
  const needles = () => secretNeedles(...held);
  const answer = (status, body) => send(res, status, held.length ? redactSecrets(body, needles()) : body);
  const clean = text => (held.length ? redactSecrets(text, needles()) : text);

  try {
    if (segments.length === 0) {
      if (method !== "GET" && method !== "HEAD") return notAllowed(res);
      // Every registered provider, with whether this deck can connect and read
      // it now (`available`): the page offers a kind only while that is true,
      // and keeps reading the list where a provider is listed, so one that
      // cannot serve at load shows once it can. A kind with no
      // registered provider is not listed: a deck with none lists none.
      // Every saved connection is listed whatever its kind, so it can always
      // be disconnected.
      const providers = providerList();
      return send(res, 200, { ok: true, providers, connections: (await store.list({ own: withoutOwnSecret })).map(forPage) });
    }

    if (segments[0] === "connections") {
      const [, id, action] = segments;
      if (!id && method === "POST" && segments.length === 1) {
        const body = await readJsonBody(req, res);
        if (body == null) return;
        const provider = getProvider(String(body.kind ?? ""));
        if (!provider) throw integrationError("invalid", "Choose which tracker to connect.", { field: "kind" });
        if (!isAvailable(provider)) throw unavailable(provider.label);
        hold(typeof body.input?.token === "string" ? body.input.token : null);
        const candidate = parseInput(provider, body.input ?? {}, null);
        hold(candidate.secret);
        const checked = await validateCandidate(provider, { kind: provider.kind, name: "", baseUrl: candidate.baseUrl, meta: candidate.meta ?? {} }, candidate.secret,
          { phase: "validate", signal, fetchImpl, inputMeta: candidate.meta });
        const name = clean(String(body.name ?? candidate.name ?? "").trim()).slice(0, 120)
          || clean(provider.defaultName ? provider.defaultName(checked) : provider.label);
        const connection = await store.create({ kind: provider.kind, name, ...checked }, candidate.secret);
        return answer(201, { ok: true, connection: forPage(connection) });
      }
      if (!id || segments.length > 3) return notFound(res);
      const existing = await store.get(id);
      if (!existing) throw integrationError("not-found", "That connection is not there any more.");

      // Disconnect asks no provider: a connection, and the token saved with
      // it, can always be deleted — also one whose provider this deck does not
      // have, which nothing else here can read or check.
      if (!action && method === "DELETE") {
        forgetConnection(id);
        await store.remove(id);
        return send(res, 200, { ok: true });
      }

      // Test and Edit ask the provider: without one that answers, they say so.
      const provider = getProvider(existing.kind);
      if (!isAvailable(provider)) throw unavailable(provider?.label ?? existing.kind);

      if (action === "test" && method === "POST") {
        const secret = hold(await store.secret(id));
        if (secret == null) throw integrationError("expired", "No token is saved for this connection. Edit it and enter one.");
        const checked = await validateCandidate(provider, existing, secret, { phase: "use", signal, fetchImpl });
        const connection = await store.update(id, checked);
        forgetConnection(id);
        return answer(200, { ok: true, connection: forPage(connection) });
      }

      if (!action && (method === "PATCH" || method === "POST")) {
        const body = await readJsonBody(req, res);
        if (body == null) return;
        const existingSecret = hold(await store.secret(id));
        const name = typeof body.name === "string" ? clean(body.name.trim()).slice(0, 120) : undefined;
        if (body.input && typeof body.input === "object") {
          hold(typeof body.input.token === "string" ? body.input.token : null);
          const candidate = parseInput(provider, body.input, { conn: existing, secret: existingSecret });
          if (candidate.secret == null) throw integrationError("invalid", "Enter a token.", { field: "token" });
          hold(candidate.secret);
          if (needsValidation(existing, existingSecret, candidate)) {
            const checked = await validateCandidate(provider, { ...existing, baseUrl: candidate.baseUrl, meta: { ...existing.meta, ...(candidate.meta ?? {}) } }, candidate.secret,
              { phase: "validate", signal, fetchImpl, inputMeta: candidate.meta });
            const connection = await store.update(id, { ...checked, ...(name ? { name } : {}) }, candidate.secret);
            forgetConnection(id);
            return answer(200, { ok: true, connection: forPage(connection), validated: true });
          }
        }
        const connection = await store.update(id, name ? { name } : {});
        return answer(200, { ok: true, connection: forPage(connection), validated: false });
      }
      return notAllowed(res);
    }

    // /api/integrations/<kind>/<id>/<subpath…>
    const [kind, id, ...rest] = segments;
    if (!id || rest.length === 0) return notFound(res);
    // The only provider mutation is this narrowly shaped Jira operation.
    // The server's normal mutation authentication and CSRF gates still apply.
    const jiraMove = kind === "jira" && method === "POST" && rest.length === 3
      && rest[0] === "board" && /^[1-9]\d{0,11}$/.test(rest[1]) && rest[2] === "move";
    const jiraTransition = kind === "jira" && method === "POST" && rest.length === 3 && rest[0] === "issue"
      && /^[A-Z][A-Z0-9_]{0,40}-[1-9]\d{0,11}$/.test(rest[1]) && rest[2] === "transitions";
    const jiraComment = kind === "jira" && method === "POST" && rest.length === 3 && rest[0] === "issue"
      && /^[A-Z][A-Z0-9_]{0,40}-[1-9]\d{0,11}$/.test(rest[1]) && rest[2] === "comment";
    const guardRead = kind === "jira" && rest.length === 1 && rest[0] === "write-guard" && (method === "GET" || method === "HEAD");
    const guardAck = kind === "jira" && rest.length === 2 && rest[0] === "write-guard" && rest[1] === "acknowledge" && method === "POST";
    if (method !== "GET" && method !== "HEAD" && !jiraMove && !jiraTransition && !jiraComment && !guardAck) return notAllowed(res);
    let moveBody;
    if (jiraMove || jiraTransition || jiraComment) {
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
        throw integrationError("invalid", "Send the move as application/json.");
      }
      const bytes = await readBytes(req, res, jiraComment ? 65536 : 4096).catch(err => { if (!res.headersSent) throw err; return null; });
      if (bytes === null) return;
      try { moveBody = JSON.parse(bytes.toString("utf8")); }
      catch { throw integrationError("invalid", "The move body is not valid JSON."); }
    }
    const provider = getProvider(kind);

    // An image: whatever goes wrong, an empty 403 or 404, and the connection
    // is not touched (see the asset route above) — also when no provider
    // here can read it.
    if (rest.length === 1 && rest[0] === "asset") {
      if (!provider) return assetRefused(res, 404);
      let conn, secret;
      try {
        conn = await store.get(id);
        secret = conn && conn.kind === kind ? await store.secret(id) : null;
      } catch { return assetRefused(res, 404); }
      if (!conn || conn.kind !== kind || secret == null || !isAvailable(provider)) return assetRefused(res, 404);
      let client;
      try { client = clientFor(provider, conn, secret, { fetchImpl }); } catch { return assetRefused(res, 404); }
      return await serveAsset(res, conn, client, url.searchParams.get("url"), { signal, method, fetchImpl });
    }

    const conn = await store.get(id);
    if (!provider) {
      // No provider for this kind on this deck. A saved connection of the kind
      // is there and cannot be read here, and says so; anything else is not a
      // route at all.
      if (conn && conn.kind === kind) throw unavailable(kind);
      return notFound(res);
    }
    if (!conn || conn.kind !== kind) throw integrationError("not-found", "That connection is not there any more.");
    const guard = deps.jiraWriteGuard ?? jiraWriteGuard;
    if (guardRead) return answer(200, { ok: true, operations: await guard.list(id) });
    if (guardAck) {
      const body = await readJsonBody(req, res);
      if (body == null) return;
      const result = await guard.acknowledge(id, body.operationId);
      if (!result.ok) return answer(409, { ok: false, code: "jira_write_guard_conflict", ...(result.conflict ? { operation: result.conflict } : {}) });
      return answer(200, { ok: true });
    }
    if (!isAvailable(provider)) throw unavailable(provider.label);
    const secret = hold(await store.secret(id));
    if (secret == null) throw integrationError("expired", "No token is saved for this connection. Reconnect it in Settings.");
    const mutation = jiraMove || jiraTransition || jiraComment;
    let operation, attempted = false, possibleWrite = false;
    let client;
    if (mutation) {
      const scope = jiraMove ? { kind: "move", boardId: rest[1], issueKeys: parseJiraMove(moveBody).issueKeys }
        : { kind: jiraComment ? "comment" : "status", issueKey: rest[1] };
      const reservation = await guard.begin({ connectionId: id, ...scope });
      if (reservation.conflict) return answer(409, { ok: false, code: "jira_write_guard_conflict", operation: reservation.conflict });
      operation = reservation.operation;
      // A private client associates each upstream write with this request; reads
      // and the existing cached client remain untouched.
      const transport = fetchImpl ?? globalThis.fetch;
      const trackedFetch = async (url, opts = {}) => {
        const write = opts.method && !["GET", "HEAD"].includes(String(opts.method).toUpperCase());
        if (!write) return transport(url, opts);
        attempted = true;
        try {
          const response = await transport(url, opts);
          // A response can come from an intermediary after the write reached
          // Jira. No HTTP status alone proves the request had no effect.
          possibleWrite = true;
          return response;
        } catch (err) { possibleWrite = true; throw err; }
      };
      try { client = provider.createClient(conn, secret, { fetchImpl: trackedFetch }); }
      catch (err) { await guard.finish(operation, true); throw err; }
    } else client = clientFor(provider, conn, secret, { fetchImpl });

    let read;
    try {
      read = await provider.routes(client, method, rest.join("/"), url.searchParams, req, { signal, ...(mutation ? { moveBody } : {}) });
    } catch (err) {
      if (!operation || !possibleWrite) throw err;
      // Preserve typed provider errors; an unexpected failure after a write
      // must still give the caller the durable operation to reconcile.
      read = errorResponse(err);
    } finally {
      if (mutation && attempted) forgetConnection(id);
      if (operation) {
        const confirmed = read?.status >= 200 && read.status < 300 && read?.body?.ok === true;
        await guard.finish(operation, confirmed ? 'confirmed' : !attempted || !possibleWrite);
      }
    }
    if (res.writableEnded || signal.aborted) return;
    const status = Number.isInteger(read?.status) ? read.status : 500;
    const body = read?.body ?? errorBody(null);
    if (operation && status >= 200 && status < 300 && body.ok === true) return answer(status, { ...body, operationId: operation.operationId });
    if (operation && possibleWrite) {
      const current = (await guard.list(id)).find(entry => entry.operationId === operation.operationId);
      if (current) return answer(status, { ...body, operation: current });
    }
    return answer(status, body);
  } catch (err) {
    if (isTypedError(err)) {
      const { status, body } = errorResponse(err);
      return answer(status, body);
    }
    throw held.length ? redactedError(err, needles()) : err;
  }
}
