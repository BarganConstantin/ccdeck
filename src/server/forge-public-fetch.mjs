// The road a forge read takes when it leaves the connection's own hosts.
//
// A job log's tail may follow a redirect to a host nobody typed: GitHub sends
// it to a signed blob-storage address. forge-http.mjs lets such a hop go only
// to a public https NAME, but a name is not where a socket goes: whoever runs
// its DNS can answer 127.0.0.1, a LAN address or the cloud metadata address,
// and answer differently the second time it is asked (DNS rebinding). So a
// request to such a host is made here, not through fetch: the name is resolved
// once, by `publicLookup`, every address it gave is checked, and the socket
// connects to the checked address and nothing else. One answer that is not a
// public address refuses the whole name.
//
// Refused: loopback, RFC 1918, link-local (169.254/16, fe80::/10), CGNAT
// (100.64/10), unique-local (fc00::/7), multicast, the unspecified and
// reserved ranges, the documentation and benchmarking ranges, and every IPv6
// form that carries one of those IPv4 addresses (::ffff:a.b.c.d, ::a.b.c.d,
// 64:ff9b::/96, 2002::/16).
//
// The connection's own hosts never come here: a self-hosted instance on the
// LAN is where the user pointed the deck, and fetch keeps reading it.
import { lookup as dnsLookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";

/** The error code a refused address carries; forge-http.mjs answers it as a
 *  permission failure, never as the network's. */
export const NOT_PUBLIC = "ERR_FORGE_NOT_PUBLIC";

function notPublic(host) {
  const err = new Error(`${host} is not a public address`);
  err.code = NOT_PUBLIC;
  return err;
}

function v4Public([a, b, c]) {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return a < 224; // multicast, reserved, broadcast
}

function v4Of(text) {
  const parts = text.split(".").map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

/** An IPv6 address as its eight 16-bit groups, or null. */
function v6Groups(text) {
  let s = text.toLowerCase().split("%")[0];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const v4 = v4Of(dotted[2]);
    if (!v4) return null;
    s = `${dotted[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map(g => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const embedded = (hi, lo) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

/** Whether a socket may connect to `address` for a host nobody typed. Anything
 *  that is not an IP address is not public. */
export function isPublicAddress(address) {
  const text = String(address ?? "").replace(/^\[|\]$/g, "");
  const family = isIP(text);
  if (family === 4) return v4Public(v4Of(text));
  if (family !== 6) return false;
  const g = v6Groups(text);
  if (!g) return false;
  // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (mapped).
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0 || g[5] === 0xffff)) {
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return false;
    return v4Public(embedded(g[6], g[7]));
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    // NAT64: the well-known prefix carries an IPv4 address; the local-use one is private.
    return g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && v4Public(embedded(g[6], g[7]));
  }
  if (g[0] === 0x2002) return v4Public(embedded(g[1], g[2])); // 6to4
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // discard-only
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return false; // Teredo, documentation
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique-local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return false; // link-local, site-local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  return true;
}

/**
 * A `lookup` for a socket (the shape of dns.lookup) that resolves the name
 * with `resolve` and hands the socket only public addresses. Every address
 * the name has is checked, and one that is not public refuses the name: a
 * socket that would try them in turn must not reach a private one.
 */
export function publicLookup(resolve = dnsLookup) {
  return function lookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const opts = typeof options === "number" ? { family: options } : { ...(options ?? {}) };
    resolve(hostname, { ...opts, all: true }, (err, found, foundFamily) => {
      if (err) return callback(err);
      const list = (Array.isArray(found) ? found : typeof found === "string" ? [{ address: found, family: foundFamily }] : [])
        .filter(a => a && typeof a.address === "string")
        .map(a => ({ address: a.address, family: a.family === 4 || a.family === 6 ? a.family : isIP(a.address) }));
      if (list.length === 0) {
        const none = new Error(`${hostname} did not resolve`);
        none.code = "ENOTFOUND";
        return callback(none);
      }
      if (list.some(a => !isPublicAddress(a.address))) return callback(notPublic(hostname));
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

/**
 * fetch for a host nobody typed: https only, the name resolved by
 * publicLookup and the socket connected to what it checked. It answers a
 * Response as fetch does, never follows a redirect (forge-http.mjs decides
 * every hop), and keeps no connection open for another request.
 *
 * @param {{ resolve?: typeof dnsLookup }} [opts]
 * @returns {typeof fetch}
 */
export function publicFetch({ resolve = dnsLookup } = {}) {
  const lookup = publicLookup(resolve);
  return (url, { method = "GET", headers = {}, body, signal } = {}) => new Promise((done, fail) => {
    let u;
    try {
      u = new URL(String(url));
    } catch (err) {
      fail(err);
      return;
    }
    const host = u.hostname.replace(/^\[|\]$/g, "");
    // A socket asks no lookup about an address, so an address is checked here.
    if (u.protocol !== "https:" || u.username || u.password || (isIP(host) && !isPublicAddress(host))) {
      fail(notPublic(host));
      return;
    }
    const req = request({
      host,
      port: u.port || 443,
      path: `${u.pathname}${u.search}`,
      method,
      headers,
      lookup,
      signal,
      agent: false,
    }, (res) => {
      try {
        done(responseOf(res, method));
      } catch (err) {
        res.destroy();
        fail(err);
      }
    });
    req.on("error", fail);
    req.end(body ?? undefined);
  });
}

/** An http.IncomingMessage as fetch's Response: its status, its headers and
 *  its body as a stream, read as it arrives (a log tail keeps only its end). */
export function responseOf(res, method = "GET") {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value != null) headers.set(name, String(value));
  }
  const status = res.statusCode ?? 0;
  const empty = method === "HEAD" || status === 204 || status === 205 || status === 304;
  const response = new Response(empty ? null : streamOf(res), { status, statusText: res.statusMessage ?? "", headers });
  if (empty) res.resume();
  return response;
}

/** A Node stream as a web ReadableStream, paused while the reader is behind.
 *  Not Readable.toWeb: on Node 18 it can throw "Controller is already closed"
 *  out of a close event, where nothing catches it. Nothing here throws. */
function streamOf(res) {
  let settled = false;
  const settle = (fn) => {
    if (settled) return;
    settled = true;
    try { fn(); } catch { /* the reader has gone */ }
  };
  return new ReadableStream({
    start(controller) {
      res.on("data", (chunk) => {
        if (settled) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
          if ((controller.desiredSize ?? 1) <= 0) res.pause();
        } catch {
          settled = true;
          res.destroy();
        }
      });
      res.on("end", () => settle(() => controller.close()));
      res.on("error", (err) => settle(() => controller.error(err)));
      // Closed before its end: the connection was cut.
      res.on("close", () => settle(() => controller.error(Object.assign(new Error("answer cut off"), { code: "ECONNRESET" }))));
    },
    pull() {
      res.resume();
    },
    cancel() {
      settled = true;
      res.destroy();
    },
  });
}
