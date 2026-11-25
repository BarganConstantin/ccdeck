// How a command typed in a terminal talks to the deck already running (#2183).
//
// `ccdeck accounts` and `ccdeck switch` are asked over SSH as often as at the
// desk, by somebody who has no tab open and no wish to forward one. The deck
// already answers everything they need — the roster, the switch, the sessions
// it is watching — so the command is a client of it rather than a second
// implementation beside it.
//
// AND IT HAS TO BE. The account store's mutex is in the deck's own process
// (store-lock.mjs, "not defence against another process"), so a terminal that
// ran `cswap switch` itself while a deck was up would race the Accounts panel,
// the auto-switch tick and a sign-in in flight — the race #1039 closed inside
// the deck. Through the deck, the switch takes that lock, invalidates the
// roster and the quota the panel is showing, and lands in the swap log, exactly
// as a click does.
//
// THE SAME DOOR `--stop` USES. The registry record (0600, this user's) holds
// the deck's port and token; a request on 127.0.0.1 with `x-ccdeck-token` and
// no browser headers is what request-gates.mjs admits for a guarded read and a
// mutation alike. The token is read again on every call, because a deck that
// restarted has a new one.
//
// A leaf, like stop-deck.mjs: node:http and running-deck.mjs, and nothing that
// starts a server or arms a timer.
import { request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";
import { liveDecks } from "./running-deck.mjs";

/** Long enough for a roster read, which can wait on claude-swap's store; short
 *  enough that a wedged deck does not hold the terminal. A switch passes its
 *  own, since `cswap switch` is given thirty seconds inside the deck. */
export const ASK_MS = 10_000;

/**
 * How late a timeout may come before it says more about this process than
 * about the deck.
 *
 * Node writes to a terminal synchronously, so `ccdeck tui` on a terminal that
 * stopped reading — an SSH link that stalled, a pane nobody scrolls — stands
 * still as a whole. When it runs again, timers run before I/O: every request in
 * flight times out while the deck's answer is already in its socket, and the
 * TUI lets go of a deck that answered. A timeout that comes this much past due
 * gives the request a fresh wait instead. Nothing is sent again, so a POST is
 * as safe as a GET, and a deck that really stopped still times out, one wait
 * later.
 */
export const STOOD_STILL_MS = 1_000;
const FRESH_WAITS = 3;

/**
 * The deck a command talks to, or null when none is running.
 *
 * `--port` names one. Otherwise there is meant to be exactly one — a start
 * keeps at most one per Claude config directory (running-deck.mjs) — and when a
 * leftover from before that rule is still up, the newest version wins, then the
 * lowest port, so the answer is the same every time it is asked.
 */
export async function findDeck({ port = null, live = liveDecks } = {}) {
  const decks = await live().catch(() => []);
  if (port != null) return decks.find(d => d.port === Number(port)) ?? null;
  if (!decks.length) return null;
  return [...decks].sort((a, b) => newer(b.version, a.version) || a.port - b.port)[0];
}

/** Positive when `a` is a newer x.y.z than `b`. A missing version is oldest. */
function newer(a, b) {
  const parts = (v) => String(v ?? "").split(".").map(n => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/**
 * One request to a deck, answered as `{ ok, status, body }`.
 *
 * Never rejects, for the reason askDeckToStop gives: every failure is a verdict
 * the caller has something to say about. `ok` is the HTTP status, and `body` the
 * parsed JSON or null — the deck's own `{ ok: false, reason }` arrives with a
 * 400 and is worth more to the reader than the status alone, so it is kept.
 *
 * `client` names the command asking, in `x-ccdeck-client`, for the deck's
 * usage tally to count where it was looked at from (feature-use.mjs). Only
 * `ccdeck tui` passes one, "tui"; every other command sends nothing new, and a
 * name that is not a bare lowercase word is not sent.
 */
export function askDeck(rec, {
  method = "GET", path, body = undefined, timeoutMs = ASK_MS, request = httpRequest, client = undefined,
} = {}) {
  return new Promise(resolve => {
    let settled = false;
    // The socket a fresh wait listens on (onTimeout): its listener goes when
    // the request ends, not with a socket the pool hands on to the next one.
    let waitingOn = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      waitingOn?.removeListener("timeout", onTimeout);
      waitingOn = null;
      resolve(v);
    };
    const payload = body === undefined ? null : JSON.stringify(body);
    // When the socket last did something this side saw: its idle timeout is
    // due `timeoutMs` after that, and one that comes far later came late.
    let heardAt = performance.now();
    const heard = () => { heardAt = performance.now(); };
    let freshWaits = 0;
    let req;
    function onTimeout() {
      if (settled) return;
      // Heard from only just now: the same timeout said twice (should Node ever
      // hand it on to the request every time), not a wait that ran out.
      if (performance.now() - heardAt < timeoutMs / 2) return;
      // Past due by more than a beat: this process stood still, and the deck
      // was not given the wait it was promised (STOOD_STILL_MS). Node hands a
      // socket's timeout on to the request once, so the fresh wait listens to
      // the socket itself.
      const socket = req.socket;
      if (socket && !socket.destroyed && freshWaits < FRESH_WAITS
        && performance.now() - (heardAt + timeoutMs) > STOOD_STILL_MS) {
        freshWaits += 1;
        heard();
        if (waitingOn !== socket) { waitingOn?.removeListener("timeout", onTimeout); waitingOn = socket; socket.on("timeout", onTimeout); }
        socket.setTimeout(timeoutMs);
        return;
      }
      req.destroy();
      finish({ ok: false, status: 0, body: null, reason: "timeout" });
    }
    try {
      req = request({
        hostname: "127.0.0.1",
        port: rec.port,
        path,
        method,
        timeout: timeoutMs,
        // A connection of its own, every time. Node keeps one to the deck alive
        // between requests; the deck closes it once it has sat idle, and a
        // `ccdeck tui` that stood still (STOOD_STILL_MS) never heard it go: the
        // first request after it ran again went down a closed connection and
        // came back ECONNRESET, a deck lost that was fine. On 127.0.0.1 a new
        // connection costs next to nothing.
        agent: false,
        headers: {
          // The token, and nothing a browser would send: a request that carried
          // an Origin or Sec-Fetch-Site would be judged as a page's, and a page
          // is not who this is.
          "x-ccdeck-token": String(rec.token ?? ""),
          ...(typeof client === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(client) ? { "x-ccdeck-client": client } : {}),
          ...(payload === null
            ? { "content-length": "0" }
            : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }),
        },
      }, res => {
        heard();
        let text = "";
        res.setEncoding("utf8");
        res.on("data", d => { heard(); text += d; });
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* not JSON: the status speaks */ }
          const status = res.statusCode ?? 0;
          finish({ ok: status >= 200 && status < 300, status, body: parsed });
        });
        // A reply cut off half way — the deck stopped, or its socket did —
        // ends with neither `end` nor a request error, and a promise left
        // waiting for one is a command that never returns.
        res.on("error", () => {});
        res.on("close", () => {
          if (!res.complete) finish({ ok: false, status: res.statusCode ?? 0, body: null, reason: "cut_off" });
        });
      });
    } catch (err) {
      return finish({ ok: false, status: 0, body: null, reason: err?.code ?? "request_failed" });
    }
    req.on("error", err => finish({ ok: false, status: 0, body: null, reason: err?.code ?? "unreachable" }));
    // A kept-alive socket comes connected and never says `connect` again: only
    // one still connecting is listened to, or each request would leave a
    // listener behind on it.
    req.on("socket", socket => { heard(); if (socket?.connecting) socket.once("connect", heard); });
    req.on("timeout", onTimeout);
    if (payload !== null) req.write(payload);
    req.end();
  });
}
