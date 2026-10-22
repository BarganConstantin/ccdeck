// The rules that keep a saved token where it belongs (#2178): which addresses
// may carry a credential at all, the base URL a connection keeps, and the one
// image read the asset route makes itself.
//
// THE TOKEN GOES ONLY WHERE THE CONNECTION SAYS. Every connection carries
// `allowedOrigins` — its own base URL's origin, plus any the provider found it
// needs while validating — and routes.mjs saves none that isSafeTarget would
// not send a token to. A provider's own transport signs for those origins
// only and never follows a redirect elsewhere; it is the provider's, so it is
// not here (providers.mjs).
//
// REDIRECTS ARE NOT FOLLOWED BLIND. fetchImage asks fetch for
// `redirect: "manual"` and checks every hop again by hand.
//
// READ ONLY BY CONSTRUCTION. fetchImage sends GET and nothing else. Browsing a
// tracker is the whole feature; there is no route here that could change an
// issue, and there is no generic "fetch this URL with my token" route anywhere
// in the deck.
import { integrationError } from "./errors.mjs";

/** HTTPS only, with one exception: a tracker on this machine (a mock, a
 *  container on localhost), which has no certificate to check. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLocalHost(hostname) {
  return LOCAL_HOSTS.has(String(hostname).toLowerCase());
}

/** The origin of a URL ("https://jira.example.com"), or null. */
export function originOf(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch { return null; }
}

/** Whether a URL may carry a credential at all: https, or http on this machine. */
export function isSafeTarget(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && isLocalHost(u.hostname);
}

/**
 * A base URL as the user typed it, made into the one the deck keeps: scheme
 * and host lower-cased, no credentials, query or fragment, no trailing slash.
 * Throws an `invalid` IntegrationError naming the field.
 */
export function normaliseBaseUrl(raw, { field = "baseUrl", label = "the address" } = {}) {
  const typed = String(raw ?? "").trim();
  if (!typed) throw integrationError("invalid", `Enter ${label}.`, { field });
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`); }
  catch { throw integrationError("invalid", `${label[0].toUpperCase()}${label.slice(1)} is not a valid URL.`, { field }); }
  if (u.username || u.password) throw integrationError("invalid", "Leave the user name and password out of the address.", { field });
  if (u.protocol === "http:" && !isLocalHost(u.hostname)) {
    throw integrationError("invalid", "Use an https:// address. Plain http is only accepted for a server on this machine.", { field });
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw integrationError("invalid", "Use an https:// address.", { field });
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** Wait for whichever comes first: the caller's abort or the deadline. */
function deadlineSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const stop = s => () => controller.abort(s.reason);
  if (signal.aborted) controller.abort(signal.reason);
  signal.addEventListener("abort", stop(signal), { once: true });
  timeout.addEventListener("abort", stop(timeout), { once: true });
  return controller.signal;
}

/** Read a body into a Buffer, refusing one larger than `maxBytes`. */
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw integrationError("upstream", "The answer was larger than the deck accepts.");
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw integrationError("upstream", "The answer was larger than the deck accepts.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), size);
}

/** Redirect hops an image read follows before it gives up. */
const MAX_HOPS = 3;

// ── images ──────────────────────────────────────────────────────────────────

/** The image types the deck passes on: raster only. An SVG is a document that
 *  can carry script and links, and no tracker icon is worth serving one. */
export const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** Whether the bytes start the way their declared raster type does. */
export function rasterMatches(type, b) {
  if (!Buffer.isBuffer(b)) return false;
  if (type === "image/png") return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (type === "image/jpeg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/gif") return b.length > 6 && b.toString("ascii", 0, 3) === "GIF";
  if (type === "image/webp") return b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
  return false;
}

/** An address that names this machine or a private network: loopback,
 *  RFC 1918, link-local, CGNAT, unique-local IPv6, an IPv4-mapped one of
 *  those, or a name with no public suffix (an intranet host). Only a token
 *  origin — the tracker the user connected — may be one of these. */
export function isPrivateHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (isLocalHost(host) || host === "0.0.0.0" || host === "::") return true;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(host)) return true;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (host.includes(":")) {
    // Any other IPv6 literal: loopback, link-local, unique-local and mapped
    // forms are private; the deck has no reason to fetch an image from a bare
    // public IPv6 address either.
    return true;
  }
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return true; // 2130706433, 0x7f000001
  return !host.includes(".");
}

/**
 * One image for the page to draw, fetched by the deck: an avatar, an icon, a
 * picture in a description.
 *
 * `tokenOrigins` are where the connection's token goes, and `sign` is asked
 * only for those. `imageHost(url)` names the other hosts this tracker serves
 * public images from (a CDN, Gravatar), which get no token. The address and
 * EVERY redirect hop are checked against both, again, by hand; a hop to any
 * other host, or to a private address that is not the tracker itself, ends
 * the read. What comes back must be a raster image no larger than `maxBytes`,
 * read as a stream so a lying Content-Length cannot get past the cap.
 *
 * Every failure is a plain `not-found` or `permission`: an image the tracker
 * would not hand over says nothing about the token, so nothing here ever
 * reads as `auth` or `expired`.
 *
 * @returns {Promise<{ contentType: string, bytes: Buffer }>}
 */
export async function fetchImage(target, {
  tokenOrigins = [], imageHost = () => false, sign = () => ({}), secret, fetchImpl = globalThis.fetch,
  maxBytes = IMAGE_MAX_BYTES, timeoutMs = 15_000, signal,
} = {}) {
  const tokened = new Set(tokenOrigins.filter(Boolean));
  const allowed = url => {
    if (url.username || url.password) return false;
    if (tokened.has(url.origin)) return isSafeTarget(url.href);
    return url.protocol === "https:" && !isPrivateHost(url.hostname) && Boolean(imageHost(url));
  };
  let url;
  try { url = new URL(String(target)); } catch { throw integrationError("not-found", "Not an image address."); }
  const deadline = deadlineSignal(signal, timeoutMs);
  for (let hop = 0; ; hop++) {
    if (!allowed(url)) throw integrationError("permission", "That image is not on a host this connection reads from.");
    let res;
    try {
      res = await fetchImpl(url.href, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "image/webp,image/png,image/jpeg,image/gif;q=0.9",
          "User-Agent": "ccdeck",
          ...(tokened.has(url.origin) ? sign(secret, url) : {}),
        },
        signal: deadline,
      });
    } catch {
      throw integrationError("not-found", "The image could not be read.");
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      let next = null;
      try { next = res.headers.get("location") ? new URL(res.headers.get("location"), url) : null; } catch { next = null; }
      if (!next) throw integrationError("not-found", "The image moved without saying where.");
      if (hop + 1 >= MAX_HOPS) throw integrationError("not-found", "The image redirected too many times.");
      url = next;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw integrationError("not-found", `The image answered ${res.status}.`);
    }
    const type = String(res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!RASTER_TYPES.has(type)) {
      await res.body?.cancel().catch(() => {});
      throw integrationError("not-found", "That is not an image the deck shows.");
    }
    let bytes;
    try { bytes = await readCapped(res, maxBytes); } catch { throw integrationError("not-found", "The image is larger than the deck shows."); }
    if (!rasterMatches(type, bytes)) throw integrationError("not-found", "That is not an image the deck shows.");
    return { contentType: type, bytes };
  }
}
