// The three routes the event pipeline is reached through: POST /api/event,
// which feeds it, and the two that read the ring back out — GET /events, the
// SSE stream with its Last-Event-ID resume, and GET /api/events, the JSON
// array — with the one serialization of an envelope both readers share.
//
// These lived in src/server/index.mjs, after pushEvent. The route table calls
// the handlers and writeJsonArray; the ring is read through event-ring.mjs's
// operations, and the subscribers' sets and backpressure are sse-clients.mjs's.
// The bodies are unchanged; isTrayRequest now sits above resumeSse's docblock
// instead of between it and its function.
import { PRODUCT } from "./brand.mjs";
// How every route reads a body and answers, and the answer for one that threw —
// see http-io.mjs.
import { OVERSIZE_DRAIN_MS, send, sendInternalError } from "./http-io.mjs";
import { presentsDeckToken } from "./request-gates.mjs";
// The ring the readers walk — see event-ring.mjs.
import { SEQ_EPOCH, ringHoldsNewerThan, ringSnapshot } from "./event-ring.mjs";
// The one door every event comes through — see event-pipeline.mjs.
import { pushEvent } from "./event-pipeline.mjs";
import { noteLogWriter } from "./event-log.mjs";
// Which CLIs this deck watches — see deck-scope.mjs.
import { deckProviders } from "./deck-scope.mjs";
// The names only the server may send — see ring-bounds.mjs.
import { isReservedEventName } from "./ring-bounds.mjs";
// The enrichment the ring evicted, handed to a page that connects behind its
// head — see withEvictedEnrichment.
import { evictedEnrichment } from "./evicted-enrichment.mjs";
// The SSE subscribers and the backpressure every frame to them is written
// under — see sse-clients.mjs.
import { dropSse, sseClients, trayClients, writeResume, writeSse } from "./sse-clients.mjs";

/**
 * Serialize one envelope, or a stub standing in for it.
 *
 * `JSON.stringify` throws on more than size. V8 walks a value recursively, so a
 * payload nested about five thousand deep overflows the C++ stack and comes
 * back as `RangeError: Maximum call stack size exceeded` — and a 36 KB POST to
 * the open ingest route is enough to put one of those in the ring, measured on
 * Node 22.14. Letting that throw escape would truncate the array mid-write and
 * leave every later read of that ring answering with invalid JSON for as long
 * as the event survives, which is a 36 KB way to poison a route permanently.
 *
 * So the envelope is replaced rather than dropped, and it keeps its `seq`: a
 * caller paging with `?since=` still walks past it, instead of asking again for
 * a hole it can never be given — the same bargain resumeSse makes about the
 * events it cannot deliver. The reason is written to stderr and not to the
 * wire, under the rule sendInternalError explains: this body is readable by a
 * DNS-rebound page and error detail is not.
 */
function envelopeJson(evt) {
  try {
    // `JSON.stringify(undefined)` is undefined, not a string, and inside an
    // array literal that would be the text "undefined" — which is not JSON.
    // `JSON.stringify([undefined])` says "null"; so does this.
    return JSON.stringify(evt) ?? "null";
  } catch (err) {
    console.error(`${PRODUCT}: event ${evt?.seq} could not be serialized:`, err);
    // Every field here is read defensively and typed to a primitive, because
    // this is the path that must not throw twice: the status line has gone out
    // and a second failure would leave the caller a truncated array.
    return JSON.stringify({
      seq: Number(evt?.seq) || 0,
      epoch: typeof evt?.epoch === "string" ? evt.epoch : SEQ_EPOCH,
      receivedAt: Number(evt?.receivedAt) || 0,
      source: typeof evt?.source === "string" ? evt.source : "unknown",
      payload: null,
      unserializable: true,
    });
  }
}

/**
 * Answer with a JSON array without ever holding it as one string.
 *
 * `send` finishes a response by handing the whole body to a single
 * `JSON.stringify`, which for every other route is a few hundred bytes and for
 * `GET /api/events` is the entire ring buffer. V8 will not build a string
 * longer than `2^29 - 24` characters, so past 536,870,888 characters of
 * serialised envelopes that call throws `RangeError: Invalid string length`
 * straight out of the request listener — and there, as requestUrl and `guard`
 * both say in their own words, nothing catches it and the worker exits.
 * Measured on Node 22.14 / macOS: 112 posts of 4,900,061 characters, which
 * `POST /api/event` accepts from anyone with no credential at all, then one
 * plain unauthenticated GET, and the deck was gone — SSE stream, hook ingest
 * and event log with it. 112 events is a twentieth of MAX_BUFFER, so this is
 * not an exotic ring: a deck watching sessions whose Read and Bash responses
 * are "routinely a good fraction of" the five-million-character ingest cap
 * reaches it on its own at an average of 268 KB an event.
 *
 * Writing the array element by element removes the ceiling rather than raising
 * it. One envelope's worth of string exists at a time, so the limit applies per
 * envelope — and ingest caps an envelope at a hundredth of it — and the peak
 * cost is the ring plus one event instead of the ring plus a contiguous copy of
 * itself, which is the quieter half of the same bug: a 400 MB ring used to need
 * 800 MB and a synchronous stall on a route that feels free on a quiet deck.
 * This is the shape resumeSse already uses for the SSE replay, for the same
 * reason, and it borrows the same writeResume, so a caller that stops reading
 * is held at MAX_CLIENT_BUFFER_BYTES here too rather than having the whole ring
 * queued in userland on its behalf.
 *
 * `items` must be a snapshot the caller owns — eventsSince returns one, `filter`
 * always allocating — because each await lets pushEvent splice the head off the
 * live ring, and iterating that while it is spliced skips entries.
 *
 * No Content-Length: it is not knowable without building the string this exists
 * to avoid, so the answer is chunked. HTTP/1.1 requires nothing more and every
 * consumer reads to EOF.
 *
 * Exported so the one property that matters can be asserted directly, on a stub
 * rather than through a socket — the same reason queuedBytes is. "Never builds
 * the whole array as one string" is invisible from outside a real response,
 * which is how it went unnoticed here for as long as it did.
 */
export async function writeJsonArray(res, items) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  let frame = "[";
  for (const item of items) {
    if (res.destroyed) return;
    if (!await writeResume(res, frame + envelopeJson(item))) {
      // Stalled past REPLAY_DRAIN_MS with the cap full. Nothing useful can be
      // said in-band — the status line went out long ago and the array is half
      // written — so hang up, exactly as the replay does.
      try { res.destroy(); } catch {}
      return;
    }
    frame = ",";
  }
  if (res.destroyed) return;
  res.end(frame === "[" ? "[]" : "]");
}

// `persist` is false when the hook posted this event to another deck as well
// and elected that one to write it to the log they share. The event is still
// buffered and broadcast here — every matching deck draws it — it is only the
// second copy on disk that is dropped.
export function handleEventIngest(req, res, persist = true) {
  let body = "";
  // Set once the cap is hit, because everything after that point is about an
  // exchange that is already over: more `data` may still be in flight, and
  // `end` must not go on to parse the truncated half.
  let refused = false;
  req.setEncoding("utf8");
  req.on("data", c => {
    if (refused) return;
    body += c;
    if (body.length > 5_000_000) {
      refused = true;
      body = "";              // nothing will read it now; let it go
      // ANSWER, rather than vanish. `req.destroy()` on its own tore the socket
      // down with no status line on it at all, so the poster learned only that
      // the connection had gone — indistinguishable from a deck that died or
      // was never there, and nothing in the exchange to tell those apart. `end`
      // never fires on a destroyed request either, so the handler below got no
      // second chance to speak. readBody was believed to get this right
      // by rejecting into a caller that replies; it destroyed the socket first,
      // so all eleven of its routes answered an oversized body with the same
      // bare reset. It answers and drains now, in this shape.
      send(res, 413, { error: "event too large" });
      // Then keep reading, and throw it away. Answering is not enough on its
      // own, because the poster is still mid-upload when the answer goes out:
      // hang up now and its next write lands on a dead socket, it aborts with
      // EPIPE, and the 413 that was already sitting in its receive buffer is
      // discarded unread — the same disappearance in a different costume.
      // `Connection: close` is the tempting version of hanging up and has
      // exactly that effect: Node destroys the socket the moment such a
      // response flushes. Draining lets the poster finish and then read the
      // answer, which is the whole point of answering. `body` no longer grows,
      // so it costs no memory.
      req.resume();
      // Bounded, because draining forever is its own denial of service: a
      // poster that stops without ending would otherwise hold the socket for as
      // long as it liked.
      const grace = setTimeout(() => req.destroy(), OVERSIZE_DRAIN_MS);
      grace.unref?.();
      req.on("close", () => clearTimeout(grace));
    }
  });
  req.on("end", () => {
    if (refused) return;
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { return send(res, 400, { error: "invalid json" }); }
    // Names beginning `__` are the deck's own control markers — `__clear` is
    // the one handleClear sends — and only the server may send them. This is
    // the one mutating route open without the deck's token, so a reserved name
    // arriving here is refused before it can reach the ring, the pages or the
    // log. No hook event is named that way.
    if (isReservedEventName(parsed?.hook_event_name)) {
      return send(res, 400, { error: "reserved event name" });
    }
    // A deck started with --no-claude takes no Claude hook event, which is what
    // its replay already decides (see replayScope) and what a current hook no
    // longer sends it. A hook installed before that still does, so the refusal
    // is an answer rather than a silent drop: a hook that elected this deck to
    // write the log hands it on to the next deck instead of losing the line.
    // Read off the provider every Claude hook has stamped since Codex support
    // arrived, so it is the payload saying whose it is.
    if (!deckProviders().claude && parsed?.provider === "claude") {
      return send(res, 409, { error: "this deck is not watching Claude" });
    }
    // Everything past the parse is inside one net, because this listener is the
    // one place in the route table `guard` cannot reach. The route does wrap the
    // call — `guard(handleEventIngest(req, res, …), res)` — but this function
    // returns undefined and hands its work to a listener the event loop calls
    // later, so `guard` has nothing to attach to and a synchronous throw in here
    // is an uncaughtException: the whole deck, for one POST. That is exactly
    // what the serialization inside pushEvent was until it was contained at the
    // line itself, and this catch is what stops the next thing added below from
    // costing a process the same way. sendInternalError puts the reason on
    // stderr and a bare 500 on the wire, and does nothing but end the response
    // if the status line has already gone out.
    try {
      noteLogWriter(parsed, persist);
      const evt = pushEvent(parsed, "hook", { persist });
      send(res, 200, { ok: true, seq: evt.seq });
    } catch (err) {
      sendInternalError(res, err);
    }
  });
  // Guarded for the same reason `end` is, and more sharply: destroying the
  // request above is itself what raises this, and answering a second time on a
  // response already sent throws ERR_HTTP_HEADERS_SENT out of an error handler,
  // where nothing is waiting to catch it. `refused` covers the 413 that
  // destroyed the request; `headersSent` covers the other half of that
  // sentence, an error arriving after `end` has already answered. That half
  // resisted every attempt to drive it from a socket — once `end` has fired the
  // message is complete and the failure goes to the socket rather than to the
  // request — so it carries no test, and is guarded anyway on the strength of
  // the hazard the sentence above already names: one condition against an
  // uncaughtException, if it turns out to be reachable at all.
  req.on("error", () => { if (!refused && !res.headersSent) send(res, 400, { error: "bad request" }); });
}

export function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 1500\n\n`);

  // A stale or absent id replays the whole ring, and so does a malformed one:
  // Number("nonsense") is NaN, every `seq <= NaN` is false, and the catch-up
  // loop below would rather compare against a number.
  //
  // An id OLDER than the ring's oldest event is a stale id and takes exactly
  // that path — nothing special-cases it, and #625 deliberately did not add a
  // second answer when it gave the ring a byte budget. Every `e.seq <=
  // sentThrough` test simply fails, so the client is handed everything still
  // held, contiguously, and the sentinel behind it; the events that were
  // evicted are missing from its HISTORY, never from its stream. The reducer's
  // guard is `env.seq <= state.lastSeq`, so the gap costs it a step forward and
  // nothing else. What the byte budget changed is how often and how far the
  // head moves, not what happens to a client that lands behind it.
  //
  // One thing in the gap is not history: the newest model, name, usage and the
  // rest of each session's last-value-wins enrichment, which an idle session
  // never sends again. That is put back in front of the replay — see
  // withEvictedEnrichment.
  const asked = Number(req.headers["last-event-id"] ?? 0);
  const lastId = Number.isFinite(asked) ? asked : 0;

  // The replay waits on the socket now, so it can no longer be part of this
  // synchronous handler. Nothing is waiting on the result here — the response
  // is already committed to a 200 and its own failure path is to hang up — so
  // start it, keep the router's contract of returning nothing, and make sure a
  // rejection ends the stream rather than the process.
  resumeSse(req, res, lastId, { tray: isTrayRequest(req) }).catch(() => dropSse(res));
}

/**
 * Is this the desktop app's tray connection? Only with the deck's own token:
 * a page cannot opt itself out of being counted, because that would let any
 * tab switch on the closed-deck notifications over itself.
 */
function isTrayRequest(req) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  return url.searchParams.get("role") === "tray" && presentsDeckToken(req.headers ?? {});
}

/**
 * Drain the ring buffer into a newly connected client, then subscribe it.
 *
 * Two things had to change when this stopped being one synchronous burst.
 * `close` is registered before the first frame, because a tab closed mid-replay
 * has to stop it. And the replay repeats until it reaches the live tail: an
 * actual wait lets pushEvent run, and an event that lands after we have walked
 * past its place but before the client is in `sseClients` would otherwise be in
 * neither stream — a hole the client cannot even ask for again, its last id
 * having moved past it.
 */
async function resumeSse(req, res, lastId, { tray = false } = {}) {
  let sentThrough = lastId;
  let ping = null;
  let closed = false;
  req.on("close", () => {
    closed = true;
    if (ping) clearInterval(ping);
    sseClients.delete(res);
    trayClients.delete(res);
  });

  for (;;) {
    // A snapshot per pass, because a wait lets pushEvent splice the head of
    // `events` off, and iterating an array being spliced from the front skips
    // entries. Events evicted that way are gone for this client, which is the
    // same bargain every resume against a rotated ring already makes.
    //
    // The snapshot earns more since #625 gave the ring a byte budget as well as
    // a count. Under the count alone the head moved one entry per push; under
    // the budget a single 5 MB event can evict hundreds at once. A replay
    // already walking this array would have skipped every one of them — but the
    // snapshot holds its own references, so the pass in flight still delivers
    // what it was given and only a LATER pass sees the shortened ring. It also
    // means a slow resumer pins one ring's worth of envelopes for as long as its
    // pass lasts, which the budget bounds too: that pin used to be unbounded for
    // the same reason the ring was.
    // Behind the ring's head, the enrichment that fell off it goes first.
    const batch = withEvictedEnrichment(ringSnapshot(), sentThrough);
    for (const e of batch) {
      if (e.seq <= sentThrough) continue;
      if (closed || res.destroyed) return;
      // Marked with `replay:true` on the envelope for the page, which reads it in
      // two places: the SSE handler coalesces renders while it is set and draws
      // once at `replay-end`, and `chimeFor` stays quiet for it, so a reconnect
      // does not play every Stop in the ring. The reducer never reads it — its
      // turn cleanup keys on each event's own time, which comes out right for
      // replayed and live events alike (HookEnvelope.replay in types.ts, and
      // dead-surface-993 pins it). This used to say the reducer's
      // UserPromptSubmit handler depended on the tag to tell a replayed prompt
      // from a new turn; nothing there reads it.
      const tagged = { ...e, replay: true };
      // Through envelopeJson for the reason writeJsonArray is: the ring may be
      // holding an envelope `JSON.stringify` cannot walk. pushEvent takes the
      // payload out of every envelope it serializes, but it serializes nothing
      // when there is no subscriber and no log — which is precisely the deck a
      // browser is about to connect to — so the first read of such an entry can
      // still be this one. Uncontained it rejected into handleSse's `.catch`,
      // which drops the client; the browser reconnects on its own 1.5s timer,
      // replays the same entry, and is dropped again, so a single small POST
      // kept the canvas from ever loading. The stub loses the `replay` tag and
      // nothing turns on that: it carries no payload for the reducer to act on,
      // and the client's own replay gate runs until the `replay-end` sentinel
      // regardless of what any one envelope says.
      if (!await writeResume(res, `id: ${e.seq}\nevent: hook\ndata: ${envelopeJson(tagged)}\n\n`)) {
        return dropSse(res);
      }
      sentThrough = e.seq;
    }
    // Caught up with the tail as it stands right now. Reached in one pass
    // unless a wait let new events in, and it terminates for the same reason
    // the client is still here at all: either it is taking bytes, in which case
    // loopback outruns any hook, or it is not, in which case writeResume gives
    // up on it.
    if (!ringHoldsNewerThan(sentThrough)) break;
  }

  if (closed || res.destroyed) return;

  // Sentinel: tells client "ring buffer drained, live stream starts now". It
  // goes out under the same rule as the frames before it, so a client that has
  // just been handed a large replay is not hung up on over the last 30 bytes of
  // it before it has had the chance to read any.
  //
  // Subscribing before waiting on that write, rather than after, is what closes
  // the last hole: writeResume puts the bytes on the socket before it returns,
  // so the sentinel still precedes every live frame, and an event pushed while
  // we wait reaches this client through the live fan-out instead of falling
  // into the gap between the two. If the wait then ends in a drop, dropSse
  // takes it back out of the set — the same exit writeSse uses.
  const flushed = writeResume(res, `event: replay-end\ndata: {}\n\n`);
  sseClients.add(res);
  if (tray) trayClients.add(res);
  // Through writeSse like every other frame: on a client that has stopped
  // reading, the ping is the one thing still being written between events, and
  // it is what eventually reveals the socket as unrecoverable.
  ping = setInterval(() => writeSse(res, `: ping\n\n`), 15000);
  if (!await flushed) dropSse(res);
}

/**
 * A replay pass's snapshot, with what this page lost to eviction put in front
 * of it.
 *
 * When the ring's oldest event is newer than the next one this page needs —
 * a fresh tab on a busy deck, a reload, a laptop waking — everything between
 * was evicted, and a session's model, name, usage, context, activity line and
 * job went with it if they were in there: they are sent when they change, so
 * an idle session's card would be drawn without them for as long as it stayed
 * idle. The newest value of each, for every session this snapshot holds an
 * event of (the cards the page will draw), is put in front under its own seq
 * (see evicted-enrichment.mjs), so the loop below sends it as one more replay
 * frame, in order, before the ring. Every pass asks, against what this page
 * has been sent so far: a slow replay the head overtook between passes is
 * handed what it lost then too, and one that is caught up is handed nothing.
 *
 * The page holds a value that arrives before its card and gives it to the
 * card when the card is made (parked-enrichment.ts).
 */
function withEvictedEnrichment(batch, sentThrough) {
  if (batch.length === 0 || batch[0].seq <= sentThrough + 1) return batch;
  try {
    const sessions = new Set();
    for (const e of batch) {
      const sid = e.payload?.session_id;
      if (typeof sid === "string" && sid) sessions.add(sid);
    }
    const lost = evictedEnrichment({ after: sentThrough, before: batch[0].seq, sessions });
    return lost.length > 0 ? lost.concat(batch) : batch;
  } catch {
    // A page is never refused its replay for this.
    return batch;
  }
}
