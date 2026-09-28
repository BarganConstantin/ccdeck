// The event ring: every envelope this deck still holds, the seq numbering they
// are given, and the eviction that keeps the ring inside its bounds.
//
// These lived in src/server/index.mjs, at the head of the ring buffer section
// and inside pushEvent. The array and the two running totals beside it have to
// move together, so they are private to this module now and reached only
// through the operations below: admitEvent numbers, charges and holds one
// envelope and evicts behind it, clearEventBuffer empties all three, and the
// readers get a copy or an answer rather than the array. The bodies are
// unchanged.
import { ENVELOPE_CHARS, LAST_VALUE_WINS, MAX_BUFFER, MAX_BUFFER_CHARS, MAX_RING_ENTRIES, payloadChars } from "./ring-bounds.mjs";

// ─── The event ring buffer ─────────────────────────────────────────────────
// Its two bounds, MAX_BUFFER and MAX_BUFFER_CHARS, and the charge an event is
// counted in against the second, payloadChars, are ring-bounds.mjs's; the
// eviction in admitEvent keeps them.

const events = [];                  // ring buffer
// The running sum of what `events` holds, in the units payloadChars charges.
// Kept beside the array rather than recomputed, because the alternative is
// walking every buffered payload on every push. It and `events` have to move
// together and nothing outside this module may touch either — see
// clearEventBuffer for the one place that empties both, and what went wrong the
// day only one of them was emptied.
let bufferedChars = 0;

/**
 * How many of the ring's entries are HOOK events — what MAX_BUFFER budgets.
 *
 * Third of the trio that has to move with `events`, for the same reason
 * `bufferedChars` does and with the same consequence if it drifts: a count that
 * names events the array no longer holds evicts against a budget already spent.
 * See LAST_VALUE_WINS for what it excludes and why, and clearEventBuffer for
 * the one place all three are emptied.
 */
let bufferedHookEvents = 0;

/** Set on the envelopes MAX_BUFFER does not count, so eviction can decrement
 *  the right total without re-reading a payload it already charged. */
const ENRICHMENT = Symbol("ring enrichment");

// Where the charge rides. A Symbol key rather than an ordinary field, because
// the envelope is JSON.stringify'd on the hot path into both the SSE frame and
// the events.jsonl line, and JSON.stringify ignores symbol-keyed properties
// entirely. So the number stays welded to the envelope it describes — which is
// what makes it impossible for `bufferedChars` and `events` to drift apart —
// without reaching the wire, the log, the client's HookEnvelope type, or the
// 127-character envelope measurement MAX_CLIENT_BUFFER_BYTES is sized against.
const CHARS = Symbol("ring charge");

/**
 * Empty the ring and the total measuring it, together.
 *
 * `/api/clear` used to be a bare `events.length = 0`, and with a running total
 * beside the array that is a permanent debt: the total would still name events
 * the array no longer holds, and every push after the first clear would evict
 * against a budget already spent — a deck that answers one clear and then keeps
 * a ring of one event for the rest of its life. The two variables move here and
 * nowhere else.
 */
export function clearEventBuffer() {
  events.length = 0;
  bufferedChars = 0;
  bufferedHookEvents = 0;
}

/**
 * What the ring holds right now — its length, what it is charged, and the seq
 * range it spans.
 *
 * Exported from index.mjs alongside MAX_BUFFER and MAX_BUFFER_CHARS so a test
 * can watch the bound hold through a real server instead of watching a process
 * die, which is the only other way this bound is observable. The seq range is
 * here for the property eviction has to keep and nothing else checks: what
 * leaves is always a PREFIX, so `newest - oldest + 1` equals the count. An
 * eviction that ever took from the middle would leave a hole no resuming
 * client could ask for again, and that is exactly what `GET /api/events` and
 * the replay loop would then hand out without noticing.
 */
export function eventBufferStats() {
  return {
    events: events.length,
    // What MAX_BUFFER budgets since #1032, and the only number a resuming
    // client's window is actually measured in. `events` minus this is the
    // enrichment riding along; the ratio between them is the amplification that
    // used to spend the window — 2.6 measured at every session count tried.
    hookEvents: bufferedHookEvents,
    chars: bufferedChars,
    oldestSeq: events.length > 0 ? events[0].seq : 0,
    newestSeq: events.length > 0 ? events[events.length - 1].seq : 0,
  };
}

let nextSeq = 1;
// Identity of *this* process's seq numbering. nextSeq restarts at 1 on every
// boot and is re-derived by replaying events.jsonl, so it is monotonic only
// within one process: rotation (50MB) or /api/clear shortens that log and the
// next boot starts numbering well below what an already-open tab saw. Stamped
// on every envelope so a client can tell "counter restarted" apart from "old
// duplicate" instead of silently dropping the live stream.
export const SEQ_EPOCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
/** Envelopes newer than `seq` from the ring buffer, oldest first. */
export function eventsSince(seq) {
  const after = Number(seq) || 0;
  return events.filter(e => e.seq > after);
}

/** The seq the newest event was given, 0 before the first — what
 *  `/api/health` reports as `seq`. */
export function lastSeq() {
  return nextSeq - 1;
}

/** Every envelope the ring holds, oldest first, in an array the caller owns —
 *  a snapshot, so a splice of the live ring's head cannot skip an entry in it. */
export function ringSnapshot() {
  return events.slice();
}

/** Whether the ring still holds an envelope newer than `seq` — false for an
 *  empty ring, whatever `seq` is. */
export function ringHoldsNewerThan(seq) {
  return events.length > 0 && events[events.length - 1].seq > seq;
}

/**
 * Number one payload, charge it, hold it, and evict behind it — the envelope
 * pushEvent goes on to serialize, broadcast and log.
 *
 * `raw` is the payload as it will be stored: pushEvent has already taken the
 * deck's token out of it and stamped the model, so what is measured here is
 * what is kept.
 */
export function admitEvent(raw, source, receivedAt) {
  const seq = nextSeq++;
  const evt = {
    seq,
    epoch: SEQ_EPOCH,
    receivedAt,
    source,
    payload: raw,
    // Charged once, here, and carried on the envelope so eviction never has to
    // walk a payload a second time. Symbol-keyed, so it is invisible to the two
    // JSON.stringify calls in pushEvent and to the `{ ...e }` the replay loop
    // makes. Charged AFTER redactDeckToken, like everything else pushEvent does
    // to an event: the payload being measured is the one that will be stored.
    [CHARS]: ENVELOPE_CHARS + payloadChars(raw),
    // Decided once, here, beside the charge and for the same reason: eviction
    // must never have to look at a payload again to know what it is giving
    // back. See LAST_VALUE_WINS.
    [ENRICHMENT]: raw != null && typeof raw === "object" && LAST_VALUE_WINS.has(raw.hook_event_name),
  };
  events.push(evt);
  bufferedChars += evt[CHARS];
  if (!evt[ENRICHMENT]) bufferedHookEvents++;

  // Evict oldest-first until BOTH bounds hold — the count that has always been
  // here, and the byte budget #625 added. See MAX_BUFFER_CHARS for the numbers.
  //
  // Counted first and spliced once, rather than shifting in a loop, because the
  // two bounds evict at very different scales. The count bound drops exactly
  // one entry per push; the byte bound can drop hundreds, since twenty-seven
  // maximum-size events fill the whole budget on their own, and a shift per
  // entry would memmove the array once for each of them.
  //
  // `drop < events.length - 1` is what keeps the event just pushed, whatever it
  // weighs. A single event is allowed to be larger than the entire budget —
  // ingest admits 5,000,000 characters, and a Codex rollout line read off disk
  // has no length bound at all — and evicting it on arrival would leave
  // pushEvent returning an envelope that `GET /api/events` never shows and no
  // resuming client can ever be handed: a hole with no id to ask for it again,
  // which is the exact failure resumeSse is written to avoid. So the true
  // ceiling is MAX_BUFFER_CHARS plus one event, and that is stated here rather
  // than pretended away.
  //
  // What this does to a resuming client is what the count bound has always done
  // to one, only sooner: the head of the ring moves, and events that fell off
  // it are gone for anybody who had not been sent them yet. That is the
  // existing bargain for a too-old Last-Event-ID — handleSse replays whatever
  // is still held and the client's `lastSeq` steps forward over the gap — and
  // the byte bound deliberately reuses it rather than inventing a second answer.
  // The difference worth knowing is that the head can now move in jumps rather
  // than one entry at a time; resumeSse's per-pass snapshot is what makes that
  // safe for a replay already in flight.
  //
  // THE COUNT BOUND IS HOOK EVENTS, NOT ENTRIES (#1032). It was entries, and
  // the deck pushes about 1.6 derived events per hook event — so the window
  // this ring IS shrank with the session count, to 9.5 measured seconds at 200
  // sessions. Counting only what a user actually did restores a 2,000-event
  // window at any number of sessions, and costs the array room for the
  // enrichment interleaved among them, which MAX_RING_ENTRIES and
  // MAX_BUFFER_CHARS both still bound.
  //
  // Enrichment falls off the head exactly as it always did — no entry is
  // skipped, held back or reordered, and the ring stays contiguous in seq.
  // What changed is only which entries the budget is spent on.
  let drop = 0;
  let freed = 0;
  let freedHookEvents = 0;
  while (drop < events.length - 1
    && (bufferedHookEvents - freedHookEvents > MAX_BUFFER
      || events.length - drop > MAX_RING_ENTRIES
      || bufferedChars - freed > MAX_BUFFER_CHARS)) {
    freed += events[drop][CHARS];
    if (!events[drop][ENRICHMENT]) freedHookEvents++;
    drop++;
  }
  if (drop > 0) {
    events.splice(0, drop);
    bufferedChars -= freed;
    bufferedHookEvents -= freedHookEvents;
  }
  return evt;
}
