// The terminal panel's WebSocket: the upgrade that admits one, the single-use
// tickets that say which pane it may reach, and the bridge that carries a
// pane's bytes down it and the keys typed in the panel back up.
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
// THE BRIDGE IS THE PROTOCOL src/web/terminal-protocol.ts SPEAKS, in order:
// `hello`; then nothing until the panel's first `size`, so the first frame is
// drawn at the panel's size and not at whatever the pane was; the pane resized
// to it when the panel owns the size; then `reset` and ONE binary frame of
// seed — the bytes that make a reset xterm show what tmux shows — and from
// then on the pane's output as it happens. tmux-control.mjs owns the hard part
// (the seed boundary, %pause, the pane dying); this file only keeps the order
// on the wire and never lets two seeds cross.
//
// NOTHING THROWS OUT OF HERE. An exception inside an 'upgrade' listener or a
// socket callback has nothing above it to catch it: it is an uncaughtException,
// the worker exits, and every terminal and SSE stream on the deck goes with it.
// Every entry point catches and ends only its own connection.
import { randomBytes } from "node:crypto";
import { isLoopbackHost, originMatchesHost } from "./request-gates.mjs";
import { clampSize } from "./terminal-sessions.mjs";
import { openControl } from "./tmux-control.mjs";
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

/** How many bytes may sit unsent on one socket before the pane's output stops
 *  being forwarded. A tab in the background, or a slow link, otherwise makes
 *  the deck hold every byte a busy TUI writes. Above this the stream is let go
 *  and the panel is re-seeded once the socket drains — it then shows what the
 *  pane shows, which is all the skipped bytes were ever going to amount to. */
export const HIGH_WATER_BYTES = 4 << 20;

/** The panel sends a size on every frame of a drag. tmux redraws the pane for
 *  each one, so they are settled for this long and only the last is applied. */
export const RESIZE_DEBOUNCE_MS = 50;

/** Lines of scrollback a seed carries above the screen. */
export const SEED_HISTORY = 2000;

/** How long a refused upgrade's socket is held for its answer to drain before
 *  it is destroyed anyway. */
const REFUSAL_GRACE_MS = 1_000;

/** What tmux-control's exit reasons are called on the wire. `closed` is this
 *  bridge's own close() and is never said to the panel. */
const EXIT_REASONS = Object.freeze({ ended: "ended", detached: "detached", error: "error" });

/** The one sentence an `error` exit carries. tmux's own words are not sent:
 *  they name socket paths, and the panel has no use for them. */
const ERROR_SENTENCE = "The deck lost its connection to tmux.";

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

/**
 * Add the terminal's one 'upgrade' listener to `server`.
 *
 *   enabled()     whether the panel is switched on, asked on every upgrade
 *   tickets       a createTicketStore() the routes mint into
 *   openBridge({ conn, socket, binding })   starts the session bridge for an
 *                 admitted socket and answers `{ message, closed, shutdown }`;
 *                 terminalBridge is the real one
 *   max           live terminal sockets allowed (MAX_TERMINALS)
 *
 * A refused upgrade gets a plain HTTP status and its socket hung up — never a
 * 101. An admitted one gets the 101, a wsConnection, and its bridge.
 */
export function installTerminalUpgrade(server, { enabled = () => false, tickets, openBridge, max = MAX_TERMINALS } = {}) {
  const live = new Set();
  const isOn = () => {
    try { return enabled() === true; } catch { return false; }
  };

  server.on("upgrade", (req, socket, head) => {
    // At once, before anything that can wait: a peer that resets now would
    // otherwise raise an 'error' with no listener, which ends the process.
    socket.on("error", () => {});
    try {
      admit(req, socket, head);
    } catch {
      refuseSocket(socket, 500);
    }
  });

  function admit(req, socket, head) {
    const verdict = upgradeVerdict(req, { enabled: isOn, live: live.size, max, remoteAddress: socket.remoteAddress });
    if (!verdict.ok) return refuseSocket(socket, verdict.status, verdict.headers);
    if (shuttingDown) return refuseSocket(socket, 503);
    const binding = tickets?.redeem(verdict.ticket) ?? null;
    if (!binding) return refuseSocket(socket, 401);
    // A ticket minted for one origin is not good for another: the page that
    // asked for it is the page that opens the socket.
    if (binding.origin && binding.origin !== verdict.origin) return refuseSocket(socket, 403);

    // An upgraded socket keeps whatever timeout the HTTP server gave it, and
    // an idle terminal is not a hung request. The keepalive in wsConnection
    // is what notices a peer that has gone.
    socket.setTimeout?.(0);
    socket.write(upgradeResponse(verdict.key));
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
      entry.bridge = openBridge({ conn: entry.conn, socket, binding });
    } catch {
      entry.conn.close(1011, "the terminal could not be opened");
    }
  }
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
  let told = 0;
  for (const entry of [...everyTerminal]) {
    told += 1;
    try {
      if (entry.bridge) entry.bridge.shutdown(reason);
      else entry.conn?.close(1001, "the deck is shutting down");
    } catch { /* this one is going away regardless */ }
    // Ended rather than left for the close handshake: the shutdown has a
    // second and a half, and a panel that answers its close does so to a
    // socket that is already on its way out.
    try { entry.socket.end(); } catch { /* already gone */ }
  }
  return told;
}

/** Terminal sockets open in this process, for tests and diagnostics. */
export function openTerminalCount() {
  return everyTerminal.size;
}

/**
 * The session bridge for one admitted socket: a tmux control-mode client on
 * the ticket's pane, and the protocol between it and the panel. Answers `{
 * message(m), closed(code, reason), shutdown(reason) }` for the upgrade to
 * call. See the header for the conversation.
 *
 *   conn       the wsConnection
 *   socket     the raw socket, for its 'drain' (see HIGH_WATER_BYTES)
 *   binding    what the ticket was minted for: { kind, tmux, socket, target,
 *              pane, ignoreSize, readOnly? }
 *   open       openControl, or a stand-in
 *   history, debounceMs, highWater   SEED_HISTORY, RESIZE_DEBOUNCE_MS,
 *              HIGH_WATER_BYTES
 *
 * The pane owns the size when the binding says ignoreSize (the user's own
 * tmux, case B): the panel is then told the pane's size whenever it changes,
 * and its own sizes after the first are ignored. Otherwise the panel owns it,
 * and its sizes resize the pane.
 */
export function terminalBridge({
  conn, socket, binding,
  open = openControl, history = SEED_HISTORY, debounceMs = RESIZE_DEBOUNCE_MS, highWater = HIGH_WATER_BYTES,
}) {
  const paneOwned = binding?.ignoreSize === true;
  const readOnly = binding?.readOnly === true;
  // `ended` once an exit has been said or the socket has gone; nothing is
  // sent after it. `started` once the panel's first size has arrived, which
  // is what the first seed waits for. `seeded` once a reset and its seed have
  // gone out, so an `ended` exit knows whether there is a frame on screen.
  let ended = false;
  let started = false;
  let seeded = false;
  let congested = false;
  // Reseeds asked for, and the latest of those a delivered seed answered. A
  // %pause during a seed asks for another, and the one in flight is then
  // stale: comparing the two is how it knows not to send itself.
  let asks = 0;
  let queued = false;
  let resizeTimer = null;
  let pendingSize = null;
  // Every seed and the exit go through this one chain, so two seeds never
  // cross on the wire and an exit is never said ahead of the seed before it.
  let chain = Promise.resolve();
  const later = (fn) => {
    chain = chain.then(fn).catch(() => {});
    return chain;
  };

  const handle = { message, closed, shutdown };

  conn.sendText(JSON.stringify({ t: "hello", kind: String(binding?.kind ?? ""), sizeOwner: paneOwned ? "pane" : "dock", readOnly }));

  let control = null;
  try {
    control = open({
      tmux: binding?.tmux,
      socket: binding?.socket,
      target: binding?.target,
      pane: binding?.pane,
      ignoreSize: paneOwned,
      readOnly,
    });
  } catch {
    end("error", ERROR_SENTENCE);
    return handle;
  }
  control.on("output", onOutput);
  control.on("reseed", askReseed);
  control.on("size", onPaneSize);
  control.on("exit", onExit);

  /** Capture and send one seed. Nothing is awaited between the capture and
   *  the two writes: tmux-control starts the stream the moment seed()
   *  resolves, and output must follow the seed on the wire, not precede it. */
  async function deliverSeed() {
    if (ended) return;
    const at = asks;
    let seed;
    try {
      seed = await control.seed({ history });
    } catch {
      // The pane could not be captured: it has gone, and the control client's
      // 'exit' says how.
      return;
    }
    if (ended) return;
    // A reseed was asked for while this one was being captured, and is queued
    // behind it: this frame is already out of date and the stream is shut.
    if (asks !== at && queued) return;
    conn.sendText(JSON.stringify({ t: "reset", cols: seed.cols, rows: seed.rows }));
    conn.sendBinary(seed.bytes);
    seeded = true;
  }

  function askReseed() {
    asks += 1;
    // Before the first size there is nothing on screen to replace; the first
    // seed, when it comes, is newer than whatever asked.
    if (ended || !started || queued) return;
    queued = true;
    later(async () => {
      queued = false;
      await deliverSeed();
    });
  }

  function onOutput(data) {
    if (ended || congested) return;
    if (conn.bufferedAmount > highWater) {
      // Let the stream go rather than queue it: what was skipped is redrawn by
      // a seed once the socket has caught up.
      congested = true;
      const drained = () => {
        congested = false;
        askReseed();
      };
      if (typeof socket?.once === "function") socket.once("drain", drained);
      else drained();
      return;
    }
    conn.sendBinary(data);
  }

  function onPaneSize({ cols, rows }) {
    // Only when the pane owns the size, and only once a frame is on screen:
    // before that, the reset that comes with the first seed carries it.
    if (ended || !paneOwned || !seeded) return;
    conn.sendText(JSON.stringify({ t: "size", cols, rows }));
  }

  function onExit({ reason } = {}) {
    if (ended || reason === "closed") return;
    const said = EXIT_REASONS[reason] ?? "error";
    later(async () => {
      if (ended) return;
      // A pane that died under remain-on-exit still has its last frame, and
      // the client stays attached so it can be read: a panel that never got a
      // frame is shown that one, frozen, rather than an empty box.
      if (said === "ended" && !seeded) await deliverSeed();
      end(said, said === "error" ? ERROR_SENTENCE : undefined);
    });
  }

  function message({ type, data } = {}) {
    if (ended) return;
    if (type === "binary") {
      if (!readOnly) control.input(data);
      return;
    }
    let msg;
    try { msg = JSON.parse(Buffer.from(data ?? "").toString("utf8")); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "size") onPanelSize(msg.cols, msg.rows);
    else if (msg.t === "paste" && typeof msg.text === "string" && !readOnly) control.paste(msg.text);
    // Anything else is a newer page saying something this deck has not heard
    // of. Ignored, like the page ignores what it does not know.
  }

  function onPanelSize(cols, rows) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const size = clampSize(cols, rows);
    if (!started) {
      started = true;
      later(async () => {
        if (ended) return;
        // The resize first, and its reply awaited: the seed is then captured
        // at the panel's size, and the first frame is drawn once, not twice.
        if (!paneOwned) await control.resize(size.cols, size.rows);
        await deliverSeed();
      });
      return;
    }
    if (paneOwned) return;
    pendingSize = size;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (!ended && pendingSize) control.resize(pendingSize.cols, pendingSize.rows);
    }, debounceMs);
    resizeTimer.unref?.();
  }

  // Say why, close, and let the tmux client go. The session it was attached to
  // keeps running whatever the reason — closing a panel is never stopping an
  // agent.
  function end(reason, text) {
    if (ended) return;
    ended = true;
    clearTimeout(resizeTimer);
    conn.sendText(JSON.stringify(text ? { t: "exit", reason, message: text } : { t: "exit", reason }));
    try {
      conn.close(reason === "server-shutdown" ? 1001 : 1000, reason);
    } catch { /* already closing */ }
    release();
  }

  function release() {
    try { control?.close(); } catch { /* the client is already gone */ }
  }

  /** The socket went away, from either side. */
  function closed() {
    ended = true;
    clearTimeout(resizeTimer);
    release();
  }

  /** The deck is going away: closeAllTerminals. */
  function shutdown(reason = "server-shutdown") {
    end(reason);
  }

  return handle;
}
