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
import { liveDecks } from "./running-deck.mjs";

/** Long enough for a roster read, which can wait on claude-swap's store; short
 *  enough that a wedged deck does not hold the terminal. A switch passes its
 *  own, since `cswap switch` is given thirty seconds inside the deck. */
export const ASK_MS = 10_000;

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
 */
export function askDeck(rec, { method = "GET", path, body = undefined, timeoutMs = ASK_MS, request = httpRequest } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const payload = body === undefined ? null : JSON.stringify(body);
    let req;
    try {
      req = request({
        hostname: "127.0.0.1",
        port: rec.port,
        path,
        method,
        timeout: timeoutMs,
        headers: {
          // The token, and nothing a browser would send: a request that carried
          // an Origin or Sec-Fetch-Site would be judged as a page's, and a page
          // is not who this is.
          "x-ccdeck-token": String(rec.token ?? ""),
          ...(payload === null
            ? { "content-length": "0" }
            : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }),
        },
      }, res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", d => { text += d; });
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
    req.on("timeout", () => { req.destroy(); finish({ ok: false, status: 0, body: null, reason: "timeout" }); });
    if (payload !== null) req.write(payload);
    req.end();
  });
}
