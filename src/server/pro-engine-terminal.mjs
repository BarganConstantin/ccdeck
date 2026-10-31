// The Command Panel's socket and routes, which the optional local engine
// runs.
//
// terminal-socket.mjs keeps everything the browser touches — the upgrade's
// gates in their order, the shutdown 503, the ticket and its origin,
// MAX_TERMINALS, the WebSocket itself — and hands a socket here only once all
// of that has said yes and the ticket's binding is an engine handle. What
// happens here is the engine's attach and then the relay: each message the
// panel sends goes to the engine as it came, and each one the engine sends
// goes to the panel as it came, in order, one WebSocket message for one
// message on the stream. The wire is docs/contracts/pro-engine-host-v1.md,
// "Terminal streams".
//
// NOTHING HERE NAMES A PANE. The engine is handed the handle a route got from
// it and a stream id, and it answers with that id and the panel's own
// messages. No pid, pane, socket or path crosses, in either direction.
//
// THE ROUTES ARE ASKED THE SAME WAY. terminal-routes.mjs keeps the switch, the
// gates, the body's cap and the ticket store; the engine answers each route's
// question with the status and body the page reads, and where that carries a
// ticket, an opaque `handle` the deck mints its ticket over
// (routeThroughEngine). What the engine could not take is answered as a
// refusal the page can draw (engineRefusal), never by some other terminal:
// there is none behind it.
//
// Neither terminal-socket.mjs nor terminal-routes.mjs reaches a client from
// here: the deck builds engineTerminals(client) where it creates the client
// and passes it to the routes and the upgrade as `engine`.

/**
 * The refusals the panel's routes answer when the engine cannot take the
 * question, by `code`: `{ ok: false, error, code }`, `error` one short
 * sentence the page may show. 409 is a state of this machine the panel says
 * and stops at; 503 is a moment it waits out, reconnecting; 400 is a request
 * the engine would not read. A failure that may have changed something is
 * none of these: it throws, which is the deck's 500, and is never asked
 * again.
 */
const REFUSALS = Object.freeze({
  unsupported: [409, "The Command Panel is not available on this platform yet."],
  "not-installed": [409, "The Command Panel's engine is not installed on this machine."],
  "not-verified": [409, "The Command Panel's engine could not be verified, so it was not started."],
  "no-terminal": [409, "The Command Panel's engine here cannot open sessions."],
  failed: [409, "The Command Panel's engine would not start."],
  restarting: [503, "The Command Panel's engine is restarting."],
  busy: [503, "The Command Panel is busy. Try again in a moment."],
  "no-answer": [503, "The Command Panel's engine did not answer in time."],
  "bad-request": [400, "The Command Panel could not read that request."],
});

/** The route answer for refusal `code` (a key of REFUSALS), in the shape the
 *  engine's own answers take: `{ status, body }`. */
export function engineRefusal(code) {
  const known = Object.hasOwn(REFUSALS, code) ? code : "failed";
  const [status, error] = REFUSALS[known];
  return { status, body: { ok: false, error, code: known } };
}

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
 *  start a wrapper), a claim (which labels a pane) and an end of the sessions
 *  on an older session host. Once one may have reached the engine it is
 *  never asked again — that could be a second agent, or an end nobody
 *  reviewed. */
const MUTATIONS = new Set(["claim", "open", "adopt", "launch", "endHosts"]);

/** A request's errors that say the engine never ran it, whatever the route,
 *  and the refusal each is: not serving terminals, too many requests, one
 *  that was not well formed, or no engine to send it to yet. */
const NOT_RUN = new Map([
  ["unavailable", "no-terminal"],
  ["busy", "busy"],
  ["invalid_request", "bad-request"],
  ["bad_params", "bad-request"],
  ["backoff", "restarting"],
  ["disabled", "failed"],
]);

/** What a read (status, target, hosts) that went unanswered is refused as: the
 *  engine went away under it, or it took too long. Asking a read again
 *  changes nothing, so the page waits and asks. */
const READ_LOST = new Map([
  ["timeout", "no-answer"],
  ["exited", "restarting"],
  ["closed", "restarting"],
  ["transport", "restarting"],
  ["heartbeat", "restarting"],
  ["protocol", "restarting"],
  ["startup", "restarting"],
  ["cancellation_failed", "restarting"],
  ["incompatible", "failed"],
]);

/** What an engine route answers: `status` and `body` for the page, and maybe
 *  a `handle` where that body's ticket is and a line for the deck's log.
 *  `fixable` is an older engine's offer of a tmux download, which the deck no
 *  longer makes: it is read as an answer and otherwise ignored. */
const ANSWER_KEYS = new Set(["status", "body", "handle", "log", "fixable"]);
const HANDLE = /^[0-9a-f]{64}$/;

/**
 * What the deck takes as the optional local engine's terminal, for `client`
 * (pro-engine-client.mjs), built once where the client is created and handed
 * to the routes and the upgrade as `engine`: whether the client is enabled,
 * the attach for an upgrade admitted with an engine ticket
 * (installTerminalUpgrade's `engine`), and the route methods
 * (terminal-routes.mjs).
 */
export function engineTerminals(client) {
  return Object.freeze({
    get enabled() { return client.enabled === true; },
    attach: (handle, socket) => attachThroughEngine(client, handle, socket),
    route: (method, body) => routeThroughEngine(client, method, body),
  });
}

/**
 * The engine's answer to one of the panel's routes (`method` is the route's
 * name: status, target, hosts, claim, open, adopt, launch, endHosts), asked as
 * `terminal.<method>` with `{ body }`, the route's parsed question. Answers
 * the checked answer, or the refusal (engineRefusal) for an engine that did
 * not take it:
 *
 *   - it would not start: `restarting` while its restart waits out a backoff
 *     or it is closing, `no-answer` when starting took too long,
 *     `not-verified` for an installation that did not verify, `failed` for
 *     anything else;
 *   - its hello said it serves no terminal here: `no-terminal`;
 *   - it turned the request away before running it (NOT_RUN);
 *   - a read it did not answer (READ_LOST).
 *
 * Throws — the deck's own 500, through `guard` — for `internal`, for a
 * mutation that may have reached it and was not answered (MUTATIONS), for any
 * other error, and for an answer that is not one.
 */
export async function routeThroughEngine(client, method, body) {
  try {
    await client.start();
  } catch (error) {
    return engineRefusal(startRefusal(error?.code));
  }
  const backend = client.capabilities?.terminal?.backend;
  if (!backend || backend === "unavailable") return engineRefusal("no-terminal");
  let answer;
  try {
    answer = await client.request(`terminal.${method}`, { body });
  } catch (error) {
    const code = error?.code;
    if (NOT_RUN.has(code)) return engineRefusal(NOT_RUN.get(code));
    if (!MUTATIONS.has(method) && READ_LOST.has(code)) return engineRefusal(READ_LOST.get(code));
    throw error;
  }
  if (!isAnswer(answer)) throw new Error("The terminal engine's answer was not a route answer.");
  return answer;
}

/** The refusal for a client that would not start, by its error's code. A
 *  verification failure has none (pro-engine-install.mjs). */
function startRefusal(code) {
  if (code === "backoff" || code === "closed") return "restarting";
  if (code === "timeout") return "no-answer";
  if (code === undefined) return "not-verified";
  return "failed";
}

function isAnswer(a) {
  if (!a || typeof a !== "object" || Array.isArray(a) || !Object.keys(a).every((k) => ANSWER_KEYS.has(k))) return false;
  if (!Number.isInteger(a.status) || a.status < 200 || a.status > 599 || !("body" in a)) return false;
  const object = !!a.body && typeof a.body === "object" && !Array.isArray(a.body);
  // A handle stands where the body's ticket is; `fixable` came with a tmux to answer for.
  if (a.handle !== undefined && (typeof a.handle !== "string" || !HANDLE.test(a.handle) || !object || a.body.ticket !== null)) return false;
  if (a.fixable !== undefined && (typeof a.fixable !== "boolean" || !object || !a.body.tmux || typeof a.body.tmux !== "object")) return false;
  return a.log === undefined || typeof a.log === "string";
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
