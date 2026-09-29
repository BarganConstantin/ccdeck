// How much the event ring may hold, and what one event is charged against it.
//
// These lived in src/server/index.mjs at the head of the ring buffer section.
// The ring itself is event-ring.mjs's — the array, the running totals that
// have to move with it, and the eviction in admitEvent that keeps these bounds
// — and the boot replay, which sizes its read against the same two numbers,
// imports them from here as well. The numbers and the walk are unchanged.

// MAX_BUFFER is how many events a late SSE subscriber can be replayed.
// MAX_BUFFER_CHARS is how much they are allowed to weigh, and until #625 there
// was no such thing — which is the whole defect, because a count is not a bound
// on memory when the thing being counted has no size of its own. `POST
// /api/event` admits a body of 5,000,000 characters and nothing between that
// door and this array shrinks it: hook/hook.js forwards the payload whole, and
// log-writer.mjs already says in as many words that a PostToolUse carrying a
// large Read or Bash response is routinely a good fraction of that. So the real
// ceiling was MAX_BUFFER multiplied by the largest event ingest accepts.
//
// Measured on Node 22.14 / macOS, posting 4,900,000-character bodies to a real
// server on loopback and reading process.memoryUsage() after a forced GC:
//
//   after  20 events: heapUsed  107MB rss  292MB   per-event 4.94MB
//   after 100 events: heapUsed  481MB rss  739MB   per-event 4.73MB
//   after 200 events: heapUsed  947MB rss 1231MB   per-event 4.69MB
//
// 4.69 MB retained per buffered event, flat as the ring fills. A full ring of
// 2000 of those is 9.4 GB against the 4144 MB heap limit V8 picks on a 32 GB
// machine, so the count cap was not reachable on any developer machine — and
// what happened instead of reaching it was not degradation. The same harness
// under `--max-old-space-size=2048`, roughly the heap an 8 GB laptop gives
// itself:
//
//   after 420 events: heapUsed 1975MB rss 2247MB
//   FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
//
// 429 events in, 1571 short of the cap. That abort is not catchable, so the SSE
// stream, the hook ingest and the log all stop together — and `/api/event` is a
// deliberate OPEN_MUTATION, so about 430 posts from a local process holding no
// credential at all end the deck. The comment at OPEN_MUTATIONS says the worst
// a caller does with that route is draw a session that is not there; this is
// the sentence that made it false.
//
// Both bounds are now enforced on every push, evicting oldest-first until each
// holds. See the eviction in admitEvent for why it is one splice and why the
// newest event is never the one evicted.
export const MAX_BUFFER = 2000;     // recent HOOK events kept for late SSE subscribers

/**
 * The enrichment this deck derives rather than receives, where only the newest
 * one per session has ever been worth anything.
 *
 * These four are last-value-wins STATE, not history: a session's model, its
 * token usage, its context fill and its name. Replaying an older UsageObserved
 * on top of a newer one changes nothing a reader can see, which is precisely
 * why they do not deserve a slot in a window measured in events.
 *
 * MEASURED, at one hook event per session every 3s — an ordinary tool-call
 * cadence, well under every documented cap. Four scanners fire per hook event,
 * throttled at 2.5s, 2.5s and 4s:
 *
 *   sessions=10   posted=60    seq_delta=160    amplification=2.67
 *   sessions=200  posted=2000  seq_delta=5190   amplification=2.60
 *
 * Flat, near enough: every hook event costs about 2.6 ring slots. At 200
 * sessions the 2000-entry ring held
 * {"PostToolUse":800,"UsageObserved":800,"ContextObserved":400} and spanned
 * 9.5 SECONDS — 60% of the resume window spent on state that is superseded
 * moments later. Close the lid, switch networks, or let a tab sleep for fifteen
 * seconds, and the Last-Event-ID is older than the ring's head: handleSse
 * replays what is left and the client steps lastSeq over the gap, so the tool
 * calls made in those seconds are never drawn and nothing reports the hole.
 *
 * `OutputObserved` is deliberately NOT here. It says something landed at a
 * given moment, which is history — two of them are two events, not one value
 * twice.
 */
const LAST_VALUE_WINS = new Set(["ModelObserved", "UsageObserved", "ContextObserved", "SessionNamed"]);

/**
 * Whether this payload is enrichment MAX_BUFFER does not count — see
 * LAST_VALUE_WINS. One test, asked by the ring's eviction and by the boot
 * replay's staging alike, so the replay reads back the window the ring keeps
 * rather than a window of log lines, most of which are enrichment (#1750).
 */
export function isEnrichment(raw) {
  return raw != null && typeof raw === "object" && LAST_VALUE_WINS.has(raw.hook_event_name);
}

/**
 * The ring's array-length backstop, distinct from its event budget.
 *
 * MAX_BUFFER now counts hook events only, so the array holds those plus
 * whatever enrichment is interleaved among them — about 2.6x the budget at the
 * amplification measured above. This is the ceiling for a ratio nobody has
 * measured yet: a future scanner, or a cadence that makes enrichment denser
 * still, must not be able to grow the array without bound. It is not the
 * working limit and should never be the binding one; MAX_BUFFER_CHARS remains
 * the memory bound.
 */
export const MAX_RING_ENTRIES = MAX_BUFFER * 4;

// The byte budget, counted in CHARACTERS — the unit the server already measures
// payloads in, and the unit MAX_CLIENT_BUFFER_BYTES in sse-clients.mjs is
// really written in despite its name (there is a long note there about why,
// which applies here unchanged: a character is one byte of heap while the
// string stays one-byte and two once it does not).
//
// 128 MiB, and the three readings that pick it:
//
//   - It is 26 times the largest single event ingest can admit (5,000,000
//     characters plus this deck's envelope), so a burst of maximum-size tool
//     responses — eight subagents each returning a big Read — is held whole
//     rather than collapsing the ring to nothing.
//   - It is thirteen times a completely FULL 2000-event ring of ordinary
//     traffic. The mean serialized event is about 5 KB, measured over 4.7k real
//     payloads in a 21 MB events.jsonl (the same sample redactDeckToken's note
//     quotes), so 2000 of them are 10 MB. Ordinary traffic therefore never
//     meets this bound at all and keeps the full count-based replay depth; only
//     the traffic that used to kill the process ever sees it.
//   - Its worst case is a bounded fraction of the heap rather than a multiple
//     of it. 128 MiB of charged characters is at most about 320 MiB of retained
//     heap — the charge below tracks real retention within 2.5x across every
//     payload shape measured — which is 16% of the 2 GB heap an 8 GB laptop
//     picks, against the 9.4 GB the count alone permitted.
//
// Exported for the same reason MAX_CLIENT_BUFFER_BYTES is: a bound whose only
// observable failure is the process running out of memory is a bound no test
// can assert. See event-ring-byte-cap.test.ts, which pins all three readings.
export const MAX_BUFFER_CHARS = 128 * 1024 * 1024;

// What one envelope costs on top of its payload — seq, epoch, receivedAt,
// source and the JSON around them. Measured at 127 characters, the same figure
// MAX_CLIENT_BUFFER_BYTES is sized against; 128 here so that an event with an
// empty payload still costs something and a flood of them cannot be free.
const ENVELOPE_CHARS = 128;

/**
 * What this payload will cost the ring, charged in characters.
 *
 * Not `JSON.stringify(raw).length`, which is the obvious answer and is wrong
 * here twice over. It allocates a full copy of a payload that can be five
 * megabytes, on the hottest path in the process; and it would defeat the
 * deliberate optimization in pushEvent that skips serializing ENTIRELY when
 * nothing is subscribed and nothing is being logged — a headless deck, and the
 * boot replay of a log that only rotates at 50 MB. That optimization is pinned
 * by sse-serialize-once.test.ts, so serializing here would fail the suite as
 * well as the machine.
 *
 * So it is a walk, allocating nothing, in the same iterative shape and for the
 * same stack-overflow reason as redactDeckToken (token-redact.mjs): a body from JSON.parse
 * is free to nest as deeply as it likes and a recursive scan would be a new way
 * to blow the stack inside the request listener, where nothing catches it.
 *
 * WHAT IT CHARGES, and why it is not just the string lengths. Measured on
 * Node 22.14 by parsing twenty copies of a 4.9M-character body of each shape
 * and reading heapUsed after a forced GC — retained per copy, against what
 * string characters alone would have charged:
 *
 *   one long string             4.67MB retained   4.67M charged   1.0x
 *   array of 8-char strings     3.91MB retained   3.40M charged   1.2x
 *   array of small numbers      4.67MB retained   0.00M charged   ∞
 *   array of tiny objects      10.20MB retained   0.85M charged  12.0x
 *   object of distinct keys    12.38MB retained   2.86M charged   4.3x
 *
 * A payload of numbers is INVISIBLE to a string-length charge while retaining
 * 4.67 MB, and an array of small objects is under-charged twelvefold — so a
 * ring bounded that way would have been the same OOM behind a different
 * payload shape. Adding 8 characters per value (V8 spends a tagged slot on
 * each, and small objects and packed arrays measured at 8–46 bytes an entry)
 * and the length of every key brings the same five shapes to 1.0x, 0.6x, 1.0x,
 * 1.7x and 2.5x — i.e. never blind, and never more than 2.5x under the truth.
 * That 2.5x is what MAX_BUFFER_CHARS is sized against. The one direction it
 * over-charges is arrays of short strings, which shortens replay depth and
 * never the other way.
 *
 * Two-byte strings cost twice what they are charged, exactly as they do for
 * MAX_CLIENT_BUFFER_BYTES: a 4.8M-character CJK payload retains 9.35 MB and is
 * charged 4.67M. Folded into the same 2.5x.
 *
 * Cost, measured against the JSON.parse the same event already pays for:
 * 0.21 µs for a realistic 5 KB hook payload, 0.04 µs for a 4.9M-character
 * single string (it is one node), and 22.6 ms for the pathological 222k-tiny-
 * object body — against 96.4 ms to JSON.parse that same body. So the walk is a
 * fifth of a parse the ingest path is paying anyway, and cheaper than
 * redactDeckToken's walk, which does substring searches this one does not.
 *
 * Exported so the charge itself can be asserted rather than inferred from the
 * ring's behaviour.
 */
export function payloadChars(raw) {
  if (typeof raw === "string") return raw.length;
  // A top-level primitive is a legal body for `POST /api/event`, same as it is
  // for redactDeckToken. One slot's worth.
  if (raw === null || typeof raw !== "object") return 8;

  let n = 0;
  const stack = [raw];
  while (stack.length > 0) {
    const node = stack.pop();
    // Arrays and objects walked separately for the reason redactDeckToken gives:
    // an indexed loop is markedly cheaper than `for…in`, and a single
    // PostToolUse response can be an array of thousands.
    if (Array.isArray(node)) {
      n += 8 * node.length;
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === "string") n += v.length;
        else if (v !== null && typeof v === "object") stack.push(v);
      }
    } else {
      for (const k in node) {
        const v = node[k];
        n += 8 + k.length;
        if (typeof v === "string") n += v.length;
        else if (v !== null && typeof v === "object") stack.push(v);
      }
    }
  }
  return n;
}

// What index.mjs reads besides the four exported above. Listed rather than
// marked at each declaration, so the declarations read as they did where they
// came from.
export { ENVELOPE_CHARS, LAST_VALUE_WINS };
