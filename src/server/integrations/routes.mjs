// /api/integrations — the connections to trackers (#2178), and the doorway to
// each provider's own read routes.
//
//   GET    /api/integrations                            providers and connections (no secrets)
//   POST   /api/integrations/connections                create: { kind, name?, input }
//   PATCH  /api/integrations/connections/<id>           edit:   { name?, input? } — re-validates when
//                                                        the address, the token or the provider's
//                                                        options change
//   POST   /api/integrations/connections/<id>/test      ask the tracker again with the saved token
//   DELETE /api/integrations/connections/<id>           disconnect: the connection and its token
//   GET    /api/integrations/<kind>/<id>/asset?url=     an image, read by the provider's client from its
//                                                        own image hosts (raster only; empty 403/404)
//   GET    /api/integrations/<kind>/<id>/<subpath…>     the provider's own reads (registry.mjs)
//
// Every GET here is a guarded read (request-gates.mjs, GUARDED_READ_PREFIXES):
// what a tracker holds is the user's work, and the deck's own page is the only
// caller. Every mutation already needs the page or the deck token.
//
// A SECRET NEVER LEAVES THIS FILE IN AN ANSWER. Connections come out of the
// store already without one (store.mjs); the routes below add only
// `tokenSaved`. The secret is read for exactly two things: handing it to the
// provider to build a client, and through that client, signing a request.
import { createHash } from "node:crypto";
import { readBody, send } from "../http-io.mjs";
import { errorBody, errorResponse, integrationError, isTypedError } from "./errors.mjs";
import { fetchImage, IMAGE_MAX_BYTES, isSafeTarget, normaliseBaseUrl, originOf, RASTER_TYPES, rasterMatches } from "./proxy.mjs";
import { getProvider, providerList } from "./registry.mjs";
import { integrationsStore } from "./store.mjs";
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
      const contentType = String(got?.contentType ?? "").split(";")[0].trim().toLowerCase();
      const bytes = got?.bytes;
      // The route checks again what every client promised.
      if (!RASTER_TYPES.has(contentType) || !Buffer.isBuffer(bytes) || bytes.length > IMAGE_MAX_BYTES || !rasterMatches(contentType, bytes)) {
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
 *  learned outlives the check that no longer finds it. */
async function validateCandidate(provider, candidate, secret, { phase, signal, fetchImpl, inputMeta = {} }) {
  const conn = { allowedOrigins: [originOf(candidate.baseUrl)].filter(Boolean), ...candidate };
  const client = provider.createClient(conn, secret, { fetchImpl });
  const result = await client.validate({ phase, signal });
  const origins = new Set([originOf(candidate.baseUrl), ...(Array.isArray(client.allowedOrigins) ? client.allowedOrigins : [])].filter(Boolean));
  for (const origin of origins) {
    if (!isSafeTarget(origin)) throw integrationError("invalid", `The deck will not send a token to ${origin}.`);
  }
  return {
    baseUrl: candidate.baseUrl,
    account: result?.account ?? {},
    meta: { ...inputMeta, ...(result?.meta ?? {}), checkedAt: new Date().toISOString() },
    allowedOrigins: [...origins],
  };
}

async function readJsonBody(req, res) {
  const raw = await readBody(req, res).catch(() => null);
  if (raw == null) return null;
  try {
    const body = JSON.parse(raw);
    return body && typeof body === "object" && !Array.isArray(body) ? body : {};
  } catch { return {}; }
}

const reply = (res, err) => {
  const { status, body } = errorResponse(err);
  send(res, status, body);
};

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

  try {
    if (segments.length === 0) {
      if (method !== "GET" && method !== "HEAD") return notAllowed(res);
      return send(res, 200, { ok: true, providers: providerList(), connections: (await store.list()).map(forPage) });
    }

    if (segments[0] === "connections") {
      const [, id, action] = segments;
      if (!id && method === "POST" && segments.length === 1) {
        const body = await readJsonBody(req, res);
        if (body == null) return;
        const provider = getProvider(String(body.kind ?? ""));
        if (!provider) throw integrationError("invalid", "Choose which tracker to connect.", { field: "kind" });
        const candidate = parseInput(provider, body.input ?? {}, null);
        const checked = await validateCandidate(provider, { kind: provider.kind, name: "", baseUrl: candidate.baseUrl, meta: candidate.meta ?? {} }, candidate.secret,
          { phase: "validate", signal, fetchImpl, inputMeta: candidate.meta });
        const name = String(body.name ?? candidate.name ?? "").trim().slice(0, 120)
          || (provider.defaultName ? provider.defaultName(checked) : provider.label);
        const connection = await store.create({ kind: provider.kind, name, ...checked }, candidate.secret);
        return send(res, 201, { ok: true, connection: forPage(connection) });
      }
      if (!id || segments.length > 3) return notFound(res);
      const existing = await store.get(id);
      if (!existing) throw integrationError("not-found", "That connection is not there any more.");
      const provider = getProvider(existing.kind);
      if (!provider) throw integrationError("incompatible", `This deck no longer knows how to talk to ${existing.kind}.`);

      if (!action && method === "DELETE") {
        forgetConnection(id);
        await store.remove(id);
        return send(res, 200, { ok: true });
      }

      if (action === "test" && method === "POST") {
        const secret = await store.secret(id);
        if (secret == null) throw integrationError("expired", "No token is saved for this connection. Edit it and enter one.");
        const checked = await validateCandidate(provider, existing, secret, { phase: "use", signal, fetchImpl });
        const connection = await store.update(id, checked);
        forgetConnection(id);
        return send(res, 200, { ok: true, connection: forPage(connection) });
      }

      if (!action && (method === "PATCH" || method === "POST")) {
        const body = await readJsonBody(req, res);
        if (body == null) return;
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : undefined;
        if (body.input && typeof body.input === "object") {
          const existingSecret = await store.secret(id);
          const candidate = parseInput(provider, body.input, { conn: existing, secret: existingSecret });
          if (candidate.secret == null) throw integrationError("invalid", "Enter a token.", { field: "token" });
          if (needsValidation(existing, existingSecret, candidate)) {
            const checked = await validateCandidate(provider, { ...existing, baseUrl: candidate.baseUrl, meta: { ...existing.meta, ...(candidate.meta ?? {}) } }, candidate.secret,
              { phase: "validate", signal, fetchImpl, inputMeta: candidate.meta });
            const connection = await store.update(id, { ...checked, ...(name ? { name } : {}) }, candidate.secret);
            forgetConnection(id);
            return send(res, 200, { ok: true, connection: forPage(connection), validated: true });
          }
        }
        const connection = await store.update(id, name ? { name } : {});
        return send(res, 200, { ok: true, connection: forPage(connection), validated: false });
      }
      return notAllowed(res);
    }

    // /api/integrations/<kind>/<id>/<subpath…>
    const [kind, id, ...rest] = segments;
    const provider = getProvider(kind);
    if (!provider || !id || rest.length === 0) return notFound(res);
    if (method !== "GET" && method !== "HEAD") return notAllowed(res);

    // An image: whatever goes wrong, an empty 403 or 404, and the connection
    // is not touched (see the asset route above).
    if (rest.length === 1 && rest[0] === "asset") {
      let conn, secret;
      try {
        conn = await store.get(id);
        secret = conn && conn.kind === kind ? await store.secret(id) : null;
      } catch { return assetRefused(res, 404); }
      if (!conn || conn.kind !== kind || secret == null) return assetRefused(res, 404);
      let client;
      try { client = clientFor(provider, conn, secret, { fetchImpl }); } catch { return assetRefused(res, 404); }
      return await serveAsset(res, conn, client, url.searchParams.get("url"), { signal, method, fetchImpl });
    }

    const conn = await store.get(id);
    if (!conn || conn.kind !== kind) throw integrationError("not-found", "That connection is not there any more.");
    const secret = await store.secret(id);
    if (secret == null) throw integrationError("expired", "No token is saved for this connection. Reconnect it in Settings.");
    const client = clientFor(provider, conn, secret, { fetchImpl });

    const answer = await provider.routes(client, method, rest.join("/"), url.searchParams, req, { signal });
    if (res.writableEnded || signal.aborted) return;
    const status = Number.isInteger(answer?.status) ? answer.status : 500;
    return send(res, status, answer?.body ?? errorBody(null));
  } catch (err) {
    if (isTypedError(err)) return reply(res, err);
    throw err;
  }
}
