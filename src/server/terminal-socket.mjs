// The Command Panel's WebSocket: the upgrade that admits one, and the
// single-use tickets that say which session it may reach. What runs behind an
// admitted socket is the optional local engine's (see "THE BRIDGE IS THE
// ENGINE'S" below).
//
// THE UPGRADE RUNS ITS OWN GATES, because nothing else will. The moment a
// server has one 'upgrade' listener, Node hands that listener EVERY request
// that carries an Upgrade header — on any path — and the route table in
// index.mjs, with the four gates in front of it, never sees them. So this
// handler is the whole of the protection for the socket, and it asks the same
// questions in the same words: a loopback Host (isLoopbackHost, the rebinding
// defence), an Origin that is present and names this very server
// (originMatchesHost — browsers apply no same-origin policy to a WebSocket, so
// this is the only thing between a page on another site and a typeable
// terminal), and fetch metadata, when there is any, saying `same-origin`. A
// path that is not the attach path, or a deck with the panel switched off, is
// answered exactly as an /api path with no route is: a 404, and the socket
// hung up. Nothing here ever answers 101 to a request it has not admitted.
//
// A TICKET, BECAUSE THE BROWSER CANNOT SEND A CREDENTIAL. A WebSocket handshake
// carries no custom header the page can set, so the token every other client
// of this deck presents has no way onto it. The page asks one of the POST
// routes — which pass the mutation gate the ordinary way — and is handed a
// ticket: 32 random bytes, good once, for thirty seconds, bound to the one
// pane the route resolved. The binding stays here; the page never names a
// pane, a socket or a tmux, so a page cannot ask for anything the routes did
// not already decide it may have. What a ticket is not is authentication
// against a local process that forges headers — request-gates.mjs says why
// nothing on this machine can be — so it adds replay protection and binding,
// and the gates do the rest.
//
// THE BRIDGE IS THE ENGINE'S. An admitted socket whose ticket is bound to an
// engine handle is relayed to the optional local engine (`engine`, below;
// pro-engine-terminal.mjs), which speaks the protocol
// src/web/terminal-protocol.ts speaks. A test may hand `openBridge` instead,
// for a ticket the JS backend minted (terminal-bridge.mjs); the deck passes
// none, and a ticket nothing can serve is refused before the 101.
//
// NOTHING THROWS OUT OF HERE. An exception inside an 'upgrade' listener or a
// socket callback has nothing above it to catch it: it is an uncaughtException,
// the worker exits, and every terminal and SSE stream on the deck goes with it.
// Every entry point catches and ends only its own connection.
import { randomBytes } from "node:crypto";
import { isLoopbackHost, originMatchesHost } from "./request-gates.mjs";
import { httpRefusal, upgradeResponse, validateUpgrade, wsConnection } from "./ws-frames.mjs";

/** The one path a terminal socket is opened on. Every other upgrade is a 404.
 *  src/web/terminal-protocol.ts states it again, and a test holds the two. */
export const ATTACH_PATH = "/api/terminal/attach";

/** How long a minted ticket may wait for its socket. The page opens the socket
 *  the moment the POST answers, so this is a round trip plus a slow tab; a
 *  ticket that outlives it has leaked somewhere or been forgotten. */
export const TICKET_TTL_MS = 30_000;

/** The most tickets that may be outstanding at once. Minting is behind the
 *  mutation gate, but the question OPEN_MUTATIONS asks of every route — what
 *  does an unbounded number of these accumulate in — has an answer here too:
 *  this Map, and no further. The oldest is dropped first; a panel whose ticket
 *  was dropped asks for another. */
export const MAX_TICKETS = 32;

/** The most terminal sockets one deck keeps open. The panel shows one session
 *  at a time; four is that panel in a few tabs, and a fifth is refused with a
 *  503 rather than letting tabs pile up tmux clients nobody is looking at. */
export const MAX_TERMINALS = 4;

/** How long a refused upgrade's socket is held for its answer to drain before
 *  it is destroyed anyway. */
const REFUSAL_GRACE_MS = 1_000;

/**
 * A store of single-use tickets: `mint(binding)` answers a fresh ticket for
 * the binding, `redeem(ticket)` answers that binding once — and null for a
 * ticket it never minted, one already redeemed, or one older than `ttlMs`.
 *
 * A ticket is 32 random bytes in base64url, so it can ride in a query string
 * untouched. Redeeming takes it out whether or not it was still in date, so a
 * ticket is spent by the first attempt to use it.
 *
 * Looked up as a Map key rather than compared in constant time: a hash lookup
 * of a 256-bit random value says nothing usable about any other value, and the
 * timing of a string comparison is only a leak when the caller can grow a
 * correct prefix one byte at a time — which a hash table never lets it do.
 */
export function createTicketStore({ ttlMs = TICKET_TTL_MS, now = Date.now, max = MAX_TICKETS } = {}) {
  const held = new Map();
  const sweep = (t) => {
    for (const [ticket, entry] of held) if (entry.expires <= t) held.delete(ticket);
  };
  return {
    mint(binding) {
      const t = now();
      sweep(t);
      // A Map iterates in insertion order, so the first key is the oldest.
      while (held.size >= max) held.delete(held.keys().next().value);
      const ticket = randomBytes(32).toString("base64url");
      held.set(ticket, { binding, expires: t + ttlMs });
      return ticket;
    },
    redeem(ticket) {
      if (typeof ticket !== "string" || ticket === "") return null;
      const entry = held.get(ticket);
      if (!entry) return null;
      held.delete(ticket);
      return entry.expires > now() ? entry.binding : null;
    },
    /** Tickets minted and not yet redeemed or expired. For tests. */
    get size() {
      sweep(now());
      return held.size;
    },
  };
}

/**
 * Whether an upgrade request may become a terminal socket, from the request
 * alone: `{ ok: true, key, ticket, origin }`, or `{ ok: false, status,
 * headers? }` with the HTTP status to refuse it with. Pure, so the order the
 * questions are asked in is pinned without a socket.
 *
 * The order is the answer a caller sees, so it goes from the cheapest and
 * least revealing to the most: not this path or not switched on (404, the
 * same as a route that does not exist); not addressed to this machine, or not
 * from it (403); not this deck's own page (403); not a WebSocket handshake
 * this server speaks (ws-frames' own status); no room (503); no ticket (401).
 * The ticket itself is redeemed by the caller only after all of this, so a
 * request turned away for any other reason does not spend it.
 *
 * `remoteAddress` is the socket's peer. The deck binds 127.0.0.1, so a peer
 * elsewhere means somebody bound it wider; the Host test alone would not
 * notice, because a tunnelled browser names a loopback Host from anywhere.
 */
export function upgradeVerdict(req, { enabled = () => false, live = 0, max = MAX_TERMINALS, remoteAddress } = {}) {
  const url = parseTarget(req?.url);
  if (!url || url.pathname !== ATTACH_PATH || !enabled()) return refusal(404);
  const headers = req?.headers ?? {};
  if (!isLoopbackHost(headers.host)) return refusal(403);
  if (typeof remoteAddress === "string" && !isLoopbackAddress(remoteAddress)) return refusal(403);
  // REQUIRED, unlike on a POST: every browser sends Origin on a WebSocket
  // handshake, so a request without one was not opened by a page, and the
  // only thing that may open this socket is the deck's own page.
  const origin = typeof headers.origin === "string" ? headers.origin.trim() : "";
  if (!origin || !originMatchesHost(origin, headers.host)) return refusal(403);
  const site = typeof headers["sec-fetch-site"] === "string" ? headers["sec-fetch-site"].trim().toLowerCase() : "";
  if (site !== "" && site !== "same-origin") return refusal(403);
  const handshake = validateUpgrade(req);
  if (!handshake.ok) return { ok: false, status: handshake.status, ...(handshake.headers ? { headers: handshake.headers } : {}) };
  if (live >= max) return refusal(503);
  const ticket = url.searchParams.get("ticket") ?? "";
  if (!ticket) return refusal(401);
  return { ok: true, key: handshake.key, ticket, origin: origin.toLowerCase() };
}

function refusal(status) {
  return { ok: false, status };
}

// The base is a constant, never the Host header, for the reason requestUrl in
// index.mjs gives: a malformed Host must not be able to throw out of here.
function parseTarget(raw) {
  try { return new URL(raw ?? "/", "http://localhost"); } catch { return null; }
}

/** A peer address that can only be this machine: 127/8, ::1, or 127/8 as an
 *  IPv4-mapped IPv6 address, which is how a dual-stack socket reports it. */
function isLoopbackAddress(address) {
  const a = address.toLowerCase().replace(/^::ffff:/, "");
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

// Every terminal socket this process has open, across every server it
// installed the upgrade on, so the shutdown can reach them all.
const everyTerminal = new Set();
// Set by closeAllTerminals: from then on the process is on its way out and
// every upgrade is a 503, so nothing starts a tmux client after the shutdown
// has already told the others to go.
let shuttingDown = false;
// Upgrades waiting on the engine's answer to their attach (relayAdmit). Not
// open yet, so not counted above, but told of a switch-off once they are.
const attaching = new Set();

/**
 * Add the terminal's one 'upgrade' listener to `server`.
 *
 *   enabled()     whether the panel is switched on, asked on every upgrade
 *   tickets       a createTicketStore() the routes mint into
 *   engine        the optional local engine's terminals (engineTerminals in
 *                 pro-engine-terminal.mjs answers them). A ticket whose
 *                 binding is an engine `handle` is relayed through it while
 *                 it is enabled (relayAdmit). This file imports nothing of
 *                 the engine's.
 *   openBridge({ conn, socket, binding })   TESTS ONLY: starts a bridge in
 *                 this process for a ticket that is not an engine handle and
 *                 answers `{ message, closed, shutdown }` — the JS backend's
 *                 (terminal-js-routes.mjs), which only a test hands
 *                 startServer. The deck passes none.
 *   max           live terminal sockets allowed (MAX_TERMINALS)
 *
 * A refused upgrade gets a plain HTTP status and its socket hung up — never a
 * 101. An admitted one gets the 101, a wsConnection, and its bridge. A ticket
 * nothing here can serve — an engine handle with no engine enabled, or any
 * other binding with no `openBridge` — is refused 503 before the 101: the
 * deck has no terminal of its own to fall back on.
 *
 * THE LISTENER IS THERE ONLY WHILE THE PANEL IS ON. Node hands every request
 * carrying an Upgrade header to an 'upgrade' listener when one exists, and to
 * the ordinary request handler when none does — so a listener left in place
 * on a deck with the panel off would turn `curl --http2`'s h2c probe, or any
 * client that offers an upgrade, from the deck's normal answer into a 404 and
 * a hang-up. The switch can flip while the deck runs (Settings), so
 * the listener follows it: checked now, and again ahead of every ordinary
 * request, which is how a page always reaches the socket — it mints its ticket
 * first. A socket already upgraded is no longer the server's and is left
 * alone either way. Answers `{ sync }` for a caller that knows better.
 */
export function installTerminalUpgrade(server, { enabled = () => false, tickets, openBridge, max = MAX_TERMINALS, engine } = {}) {
  const live = new Set();
  const isOn = () => {
    try { return enabled() === true; } catch { return false; }
  };

  const onUpgrade = (req, socket, head) => {
    // At once, before anything that can wait: a peer that resets now would
    // otherwise raise an 'error' with no listener, which ends the process.
    socket.on("error", () => {});
    try {
      admit(req, socket, head);
    } catch {
      refuseSocket(socket, 500);
    }
  };
  let armed = false;
  const sync = () => {
    const on = isOn();
    if (on && !armed) server.on("upgrade", onUpgrade);
    else if (!on && armed) server.off("upgrade", onUpgrade);
    armed = on;
  };
  sync();
  // Ahead of the deck's own handler, so the request that turned the panel on
  // — or the next one after the settings file did — arms the socket in time.
  server.prependListener("request", sync);

  function admit(req, socket, head) {
    const verdict = upgradeVerdict(req, { enabled: isOn, live: live.size, max, remoteAddress: socket.remoteAddress });
    if (!verdict.ok) return refuseSocket(socket, verdict.status, verdict.headers);
    if (shuttingDown) return refuseSocket(socket, 503);
    const binding = tickets?.redeem(verdict.ticket) ?? null;
    if (!binding) return refuseSocket(socket, 401);
    // A ticket minted for one origin is not good for another: the page that
    // asked for it is the page that opens the socket.
    if (binding.origin && binding.origin !== verdict.origin) return refuseSocket(socket, 403);
    // A ticket an engine route minted is relayed to the engine. Any other
    // ticket has a bridge in this process only where a test handed one in;
    // the deck has none, and refuses it before the 101 rather than serve it
    // some other way.
    if (typeof binding.handle === "string") {
      if (engine?.enabled === true) return relayAdmit(verdict.key, socket, head, binding.handle);
      return refuseSocket(socket, 503);
    }
    if (typeof openBridge !== "function") return refuseSocket(socket, 503);
    accept(verdict.key, socket, head, (conn) => openBridge({ conn, socket, binding }));
  }

  /** Answer an admitted upgrade with the 101 and run its socket, every
   *  message going to the bridge `open(conn)` answers. Answers the entry. */
  function accept(key, socket, head, open) {
    // An upgraded socket keeps whatever timeout the HTTP server gave it, and
    // an idle terminal is not a hung request. The keepalive in wsConnection
    // is what notices a peer that has gone.
    socket.setTimeout?.(0);
    socket.write(upgradeResponse(key));
    const entry = { socket, conn: null, bridge: null };
    entry.conn = wsConnection(socket, head, {
      // wsConnection reads nothing until the next tick, so the bridge below
      // is in place before the first message can arrive.
      onMessage: (message) => entry.bridge?.message(message),
      onClose: (code, reason) => {
        live.delete(entry);
        everyTerminal.delete(entry);
        entry.bridge?.closed(code, reason);
      },
    });
    live.add(entry);
    everyTerminal.add(entry);
    try {
      entry.bridge = open(entry.conn);
    } catch {
      entry.conn.close(1011, "the terminal could not be opened");
    }
    return entry;
  }

  /**
   * An engine ticket, past every gate above: the engine runs the bridge and
   * this socket is relayed to it (`engine.attach`). Until the engine has
   * answered there is no 101, and the upgrade holds its place among `max`.
   * A refusal is a plain status like any
   * other; a socket gone meanwhile, or a deck that began shutting down, gives
   * the attach up, as the deck refuses any upgrade then.
   */
  function relayAdmit(key, socket, head, handle) {
    const held = { told: null };
    live.add(held);
    attaching.add(held);
    attachRelay(key, socket, head, handle, held).catch(() => socket.destroy());
  }

  async function attachRelay(key, socket, head, handle, held) {
    let attached;
    try {
      attached = await engine.attach(handle, socket);
    } catch {
      attached = { ok: false, status: 500 };
    } finally {
      live.delete(held);
      attaching.delete(held);
    }
    if (!attached.ok) return refuseSocket(socket, attached.status);
    if (socket.destroyed || shuttingDown) {
      attached.giveUp();
      return refuseSocket(socket, 503);
    }
    try {
      const entry = accept(key, socket, head, attached.start);
      entry.relayed = true;
      // The switch went off while the engine was answering: told now, as it
      // would have been had the socket opened a moment sooner.
      if (held.told) entry.bridge?.shutdown(held.told.reason, held.told.text);
    } catch {
      // Past the 101 a plain status cannot be sent any more.
      attached.giveUp();
      socket.destroy();
    }
  }

  return { sync };
}

/** Answer an upgrade with a plain status and hang up. The answer is ended
 *  rather than destroyed with it, so it reaches a client that is still
 *  sending; a client that never closes its half is destroyed after a grace. */
function refuseSocket(socket, status, headers = {}) {
  if (socket.destroyed) return;
  try {
    socket.end(httpRefusal(status, headers));
  } catch {
    socket.destroy();
    return;
  }
  const grace = setTimeout(() => socket.destroy(), REFUSAL_GRACE_MS);
  grace.unref?.();
  socket.once("close", () => clearTimeout(grace));
}

/**
 * Tell every open terminal why it is closing, and close it: each panel is sent
 * `{ t: "exit", reason }` and a close frame, its tmux client is detached (the
 * session keeps running — that is the point of tmux), and its socket is ended.
 *
 * bin/deck.js calls this first in its shutdown, ahead of reaping children: an
 * upgraded socket is not in the HTTP server's connection list, so
 * closeAllConnections() never sees it, and a tmux client killed before its
 * panel was told would reach the panel as an unexplained error rather than as
 * the deck going away. Answers how many it told. After it, every new upgrade
 * is refused with a 503.
 */
export function closeAllTerminals(reason = "server-shutdown") {
  shuttingDown = true;
  return closeOpenTerminals(reason);
}

/**
 * Close every open terminal the way closeAllTerminals does — told why, tmux
 * client detached, socket ended — without refusing the next one: the switch in
 * Settings going off (prefs-routes.mjs), after which the upgrade refuses on
 * its own. `text` is the sentence the panel shows. Answers how many it told.
 */
export function closeOpenTerminals(reason, text) {
  let told = 0;
  for (const entry of [...everyTerminal]) {
    told += 1;
    try {
      if (entry.bridge) entry.bridge.shutdown(reason, text);
      else entry.conn?.close(reason === "server-shutdown" ? 1001 : 1000, reason);
    } catch { /* this one is going away regardless */ }
    // A relayed terminal ends its socket itself, once the engine's own close
    // has gone down it (pro-engine-terminal.mjs).
    if (entry.relayed && entry.bridge) continue;
    // Ended rather than left for the close handshake: the shutdown has a
    // second and a half, and a panel that answers its close does so to a
    // socket that is already on its way out.
    try { entry.socket.end(); } catch { /* already gone */ }
  }
  for (const held of attaching) held.told = { reason, text };
  return told;
}

/** Terminal sockets open in this process, for tests and diagnostics. */
export function openTerminalCount() {
  return everyTerminal.size;
}
