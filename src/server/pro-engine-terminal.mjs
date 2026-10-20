// The terminal panel's socket and routes when the optional local engine runs
// them.
//
// terminal-socket.mjs keeps everything the browser touches — the upgrade's
// gates in their order, the shutdown 503, the ticket and its origin,
// MAX_TERMINALS, the WebSocket itself — and hands a socket here only once all
// of that has said yes and the ticket's binding is an engine handle. What
// happens here is the engine's attach and then the relay: each message the
// panel sends goes to the engine as it came, and each one the engine sends
// goes to the panel as it came, in order, one WebSocket message for one
// message on the stream. The bridge on the other side speaks the protocol
// terminalBridge speaks, so the panel cannot tell the two apart. The wire is
// docs/contracts/pro-engine-host-v1.md, "Terminal streams".
//
// NOTHING HERE NAMES A PANE. The engine is handed the handle a route got from
// it and a stream id, and it answers with that id and the panel's own
// messages. No pid, pane, socket or path crosses, in either direction.
//
// THE ROUTES ARE ASKED THE SAME WAY. terminal-routes.mjs keeps the flag, the
// gates, the body's cap and the ticket store; the engine answers each route's
// question with the status and body the JS route would send, and where that
// carries a ticket, an opaque `handle` the deck mints its ticket over
// (routeThroughEngine). Whatever the engine did not take, the deck's own route
// answers, as it does with no engine.
//
// Neither terminal-socket.mjs nor terminal-routes.mjs imports anything from
// here. A deck that enables the engine builds engineTerminals(client) where it
// creates the client and passes it to startServer as `terminal.engine`, which
// hands it to the routes and to the upgrade: so a deck with no engine never
// reads this file, and one with an engine reads it with the client, not on a
// request's demand after a self-update may have replaced the tree under it
// (pinned-build.mjs).

/** How an attach the engine refused is answered: a request it could not read
 *  is the deck's own fault (500), a handle it would not redeem is a ticket
 *  that was no good (401). Anything else — busy, switched off, no answer in
 *  time, the engine gone — is a deck that cannot take the socket now (503). */
const REFUSED = new Map([["bad_params", 500], ["invalid_handle", 401]]);

/** How long a shutdown waits for the engine's own close before the socket is
 *  ended anyway: the deck's whole shutdown has a second and a half. */
export const SHUTDOWN_GRACE_MS = 1_500;

/** A relayed socket whose engine has gone away is closed 1011 with no `exit`
 *  before it, so its panel reconnects with a new ticket. The reason is the one
 *  a failing handler gets in ws-frames, so it says no more than that does. */
const LOST_REASON = "the server could not handle a message";

/** The routes that change something: a launch, an adopt, an open (which may
 *  start a wrapper) and a claim (which labels a pane). Once one may have
 *  reached the engine it is never asked again, of the engine or of the deck's
 *  own route — that could be a second agent. */
const MUTATIONS = new Set(["claim", "open", "adopt", "launch"]);

/** The engine's refusals that say it did not run the request at all — not
 *  serving terminals, too many requests, or one the client would not write —
 *  so the deck's own route answers it instead, whatever it was. */
const NOT_RUN = new Set(["unavailable", "busy", "invalid_request"]);

/** What an engine route answers: `status` and `body` as the JS route sends
 *  them, and maybe a `handle` where that body's ticket is, a line for the
 *  deck's log, and `fixable` when there is no usable tmux and the deck could
 *  fetch its own. */
const ANSWER_KEYS = new Set(["status", "body", "handle", "log", "fixable"]);
const HANDLE = /^[0-9a-f]{64}$/;

/**
 * What the deck takes as the optional local engine's terminal, for `client`
 * (pro-engine-client.mjs), built once where the client is created and handed
 * to startServer as its `terminal.engine`: whether the client is enabled, the
 * attach for an upgrade admitted with an engine ticket (installTerminalUpgrade's
 * `engine`), and the route methods (terminal-routes.mjs).
 */
export function engineTerminals(client) {
  return Object.freeze({
    get enabled() { return client.enabled === true; },
    attach: (handle, socket) => attachThroughEngine(client, handle, socket),
    route: (method, body) => routeThroughEngine(client, method, body),
    forgetTmux: () => forgetTmuxInEngine(client),
  });
}

/**
 * The engine's answer to one of the panel's routes (`method` is the route's
 * name: status, target, claim, open, adopt, launch), asked as
 * `terminal.<method>` with `{ body }`, the route's parsed question. Answers
 * the checked answer, or null when the engine did not take the question and
 * the deck's own route should answer it:
 *
 *   - it would not start, or its hello said it has no terminal (nothing was
 *     asked);
 *   - it turned the request away before running it (NOT_RUN);
 *   - a read it did not answer, for any other reason: asking the deck's own
 *     route instead changes nothing.
 *
 * Throws — the deck's own 500, through `guard` — for `internal`, as the JS
 * route rethrew an unknown error, for a mutation that may have reached it and
 * was not answered (MUTATIONS), and for an answer that is not one.
 */
export async function routeThroughEngine(client, method, body) {
  try {
    await client.start();
  } catch {
    return null;
  }
  const backend = client.capabilities?.terminal?.backend;
  if (!backend || backend === "unavailable") return null;
  let answer;
  try {
    answer = await client.request(`terminal.${method}`, { body });
  } catch (error) {
    if (error?.code !== "internal" && (NOT_RUN.has(error?.code) || !MUTATIONS.has(method))) return null;
    throw error;
  }
  if (!isAnswer(answer)) throw new Error("The terminal engine's answer was not a route answer.");
  return answer;
}

function isAnswer(a) {
  if (!a || typeof a !== "object" || Array.isArray(a) || !Object.keys(a).every((k) => ANSWER_KEYS.has(k))) return false;
  if (!Number.isInteger(a.status) || a.status < 200 || a.status > 599 || !("body" in a)) return false;
  const object = !!a.body && typeof a.body === "object" && !Array.isArray(a.body);
  // A handle stands where the body's ticket is; `fixable` comes with a tmux to answer for.
  if (a.handle !== undefined && (typeof a.handle !== "string" || !HANDLE.test(a.handle) || !object || a.body.ticket !== null)) return false;
  if (a.fixable !== undefined && (typeof a.fixable !== "boolean" || !object || !a.body.tmux || typeof a.body.tmux !== "object")) return false;
  return a.log === undefined || typeof a.log === "string";
}

/** A managed tmux just landed: a running engine forgets the miss it
 *  remembered, as the deck's own lookup does. One not running has none. */
function forgetTmuxInEngine(client) {
  if (!client.running) return;
  client.request("terminal.forgetTmux", { body: null }).catch(() => {});
}

/**
 * Ask `engine` to attach `handle` for `socket`, whose upgrade is not answered
 * yet. Answers `{ ok: true, start(conn), giveUp() }` once the engine has
 * attached it, or `{ ok: false, status }` with the status to refuse the
 * upgrade with. A socket that goes away before the answer gives the attach up
 * at once, which tells the engine (`close`) and frees its place.
 */
export async function attachThroughEngine(engine, handle, socket) {
  if (socket.destroyed) return { ok: false, status: 503 };
  const abort = new AbortController();
  const gone = () => abort.abort();
  socket.once("close", gone);
  let stream;
  try {
    stream = await engine.attachTerminal(handle, { signal: abort.signal });
  } catch (error) {
    return { ok: false, status: REFUSED.get(error?.code) ?? 503 };
  } finally {
    socket.off("close", gone);
  }
  return {
    ok: true,
    giveUp: () => stream.close(),
    start: (conn) => {
      try {
        return relay(stream, conn, socket);
      } catch (error) {
        stream.close();
        throw error;
      }
    },
  };
}

/**
 * The relay for one attached stream, in the shape installTerminalUpgrade
 * expects of a bridge: `{ message(m), closed(code, reason), shutdown(reason,
 * text) }`. What the engine sent before the 101 goes down the socket first.
 */
function relay(stream, conn, socket) {
  // Set by shutdown: the socket is ended once the engine's close has gone
  // down it, or when this runs out, whichever is first.
  let ending = null;
  // Reading stopped for the input window (paused) — never resumed by anything
  // but what paused it, so the socket is not set flowing ahead of its reader.
  let paused = false;
  const end = () => {
    clearTimeout(ending);
    try { socket.end(); } catch { /* already gone */ }
  };
  const resume = () => {
    if (!paused) return;
    paused = false;
    socket.resume();
  };
  const drained = () => stream.flow();
  socket.on("drain", drained);

  // The stream has ended: what the panel sends now goes nowhere, but its
  // answer to the close still has to be read.
  function finish(code, reason) {
    resume();
    try { conn.close(code, reason); } catch { /* already closing */ }
    if (ending) end();
  }

  stream.start({
    binary: (bytes) => conn.sendBinary(bytes),
    text: (bytes) => conn.sendText(bytes.toString("utf8")),
    close: (code, reason) => finish(code, reason),
    lost: () => finish(1011, LOST_REASON),
    // bufferedAmount only while the socket waits for 'drain'; the bridge's
    // decisions are all far above Node's own high-water mark.
    buffered: () => (socket.writableNeedDrain ? conn.bufferedAmount : 0),
    resume,
  });

  return {
    message({ type, data }) {
      if (stream.send(type === "binary" ? "binary" : "text", data)) return;
      // Held for the input window, with everything after it: nothing more is
      // read from the socket until the engine has taken enough.
      paused = true;
      socket.pause();
    },
    closed() {
      clearTimeout(ending);
      socket.off("drain", drained);
      stream.close();
    },
    shutdown(reason = "server-shutdown", text) {
      if (ending) return;
      ending = setTimeout(end, SHUTDOWN_GRACE_MS);
      ending.unref?.();
      let sent = false;
      try { sent = stream.shutdown(reason, text); } catch { /* not a reason the engine can be sent */ }
      if (sent) return;
      // Nothing left to tell it: closed here, as closeOpenTerminals closes a
      // socket with no bridge.
      try { conn.close(reason === "server-shutdown" ? 1001 : 1000, reason); } catch { /* already closing */ }
      end();
    },
  };
}
