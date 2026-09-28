// The deck's SSE subscribers, and the one discipline every frame to them is
// written under: a client too far behind is hung up on rather than buffered
// for, and a resuming client is waited for rather than dropped.
//
// These lived in src/server/index.mjs — the two client sets beside the ring,
// the backpressure section after the session expiry. The sets are shared, not
// copied: pushEvent broadcasts over them, the desktop-update routes and the
// notifier reach the app's tray connections through them, and resumeSse adds a
// client once its replay is done. The bodies are unchanged.

const sseClients = new Set();       // res handles
// The desktop app's own connections (#1160): subscribed like any client, so
// they receive every event, and ALSO kept here so they are never counted as a
// page. The app reads the stream to draw its tray icon; if that counted as a
// tab, the deck would believe a page was open whenever the app ran, and the
// notifications a closed deck raises (block-notify.mjs) would never fire —
// the one thing the app exists to deliver. See `pageCount`.
const trayClients = new Set();

/** Pages — deck tabs and the app's window — as opposed to the app's tray
 *  connection, which is a reader and not somebody looking. */
function pageCount() {
  return sseClients.size - trayClients.size;
}

/** A notification for the desktop app to raise as itself, instead of the OS
 *  helper raising it as Script Editor (osascript) or PowerShell. */
function notifyTrays(title, body, { chime = null, who = null } = {}) {
  // The app names itself above the notification, so the title is the session.
  const line = `event: notify\ndata: ${JSON.stringify({ title: who ?? title, body, chime })}\n\n`;
  for (const res of trayClients) writeSse(res, line);
  return true;
}

// ─── SSE backpressure ────────────────────────────────────────────────────
// A client that stops reading without closing its socket — a frozen tab, a
// suspended machine, a stalled `ssh -L` tunnel — never fires 'close' and never
// makes write() throw, so the old `try { res.write(line) } catch {}` had no
// way to notice it. On loopback nothing times the connection out either, so
// every event (tool responses run to megabytes) queued in that socket's write
// buffer for as long as the process lived.
//
// We drop the client rather than the events. EventSource reconnects after the
// `retry: 1500` we send on connect and resumes from Last-Event-ID, so the ring
// buffer replays whatever it missed. Dropping individual events instead would
// leave a hole the resume path cannot even see, the client's last id having
// moved past it.
//
// The ceiling has to clear the largest SINGLE frame the deck can emit, because
// one write() of such a frame puts the whole of it in the queue with nothing
// having had the chance to drain any of it — a client reading at full speed
// looks, for that instant, exactly like a frozen tab. #588 was exactly that
// failure: queuedBytes below doubled every reading, so the real ceiling was
// 4 MiB and one 4 MiB tool response hung up on every subscribed tab at once.
//
// So the number is checked against what `POST /api/event` admits rather than
// left to feel. handleEventIngest caps a body at 5,000,000 CHARACTERS. The
// event is re-serialized before it goes out, and re-serializing a value that
// came from JSON.parse of an N-character document cannot exceed N characters —
// every escape the output needs was already paid for in the input, and \uXXXX
// input comes back shorter — so one frame is at most 5,000,000 characters, plus
// this deck's envelope, measured at 127, plus the id/event/data framing. 8 MiB
// clears that by a little over 1.6x, and is the number this constant has always
// named; what #588 changed is that it now means it.
//
// Characters, not bytes, which is the one misleading thing left in the name.
// writeSse and writeResume write STRINGS, and a Writable with decodeStrings
// false — which both an OutgoingMessage and the net.Socket under it are — adds
// `chunk.length`, i.e. UTF-16 units, to its queue. Measured on Node 22.14: a
// 4,800,000-character Read of CJK text is 14,400,184 bytes on the wire and
// `res.writableLength` reports 4,800,311. That is why comparing this against a
// character-denominated ingest limit is the right comparison and comparing it
// against a byte count would not be — and it is worth stating plainly, because
// assuming a unit for writableLength instead of measuring it is the whole
// shape of the bug this comment exists to explain. The memory behind a full
// buffer is larger than the number says, up to two bytes per unit while it is
// held as a string; that is not what the cap is for, which is noticing a client
// that has stopped reading at all.
//
// Exported, with queuedBytes, so the arithmetic can be asserted directly. #588
// survived because it could only be observed through a live socket, where the
// existing tests' tolerances were wider than the error.
export const MAX_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * What this response has accepted and not yet handed to the kernel, in the
 * units writableLength reports it in — see MAX_CLIENT_BUFFER_BYTES above, which
 * is the number this is compared against.
 *
 * NOT the sum of the two writableLengths, which is what #588 was: Node's
 * `OutgoingMessage.writableLength` getter is `outputSize + this[kChunkedLength]
 * + (socket ? socket.writableLength : 0)`, so the socket's queue is already
 * inside it. For an SSE response, whose outputSize is zero from the moment the
 * headers flush, the two readings are the same number exactly — measured on
 * Node 22.14 against a paused reader, `res.writableLength=4194615
 * socket.writableLength=4194615` — so adding them reported exactly twice the
 * real backlog and made an 8 MiB constant behave as a 4 MiB one.
 *
 * Why max and not simply `res.writableLength`, which is today's whole answer.
 * That composition is a Node implementation detail and it has moved before, so
 * the expression is chosen to survive it moving again. Read the two as an
 * overlapping pair and take the larger:
 *   - composed as it is today, `own` already contains `sock`, so `own >= sock`
 *     and max is `own` — the exact total;
 *   - were the getter to stop including the socket term, `own` for a flushed
 *     SSE response is zero and max is `sock` — again the exact total;
 *   - with the socket detached (`res.socket` null, which happens between the
 *     response ending and the handle being released) max is `own`, the only
 *     reading there is.
 * Every case is right, and the failure mode if some future composition makes
 * both terms non-zero and disjoint is under-counting by at most 2x — a client
 * held a little longer than intended, which is the harmless direction. Summing
 * fails the other way, and dropping readers that are not behind is the bug.
 */
export function queuedBytes(res) {
  const own = typeof res.writableLength === "number" ? res.writableLength : 0;
  const sock = res.socket && typeof res.socket.writableLength === "number" ? res.socket.writableLength : 0;
  return Math.max(own, sock);
}

/** Hang up on a client we have decided not to keep. `delete` on a response
 *  that never made it into the set — the resume path (resumeSse, in index.mjs)
 *  hangs up on clients before they are subscribed — is a harmless no-op. */
function dropSse(res) {
  sseClients.delete(res);
  trayClients.delete(res);
  // Destroying the socket is what makes the request emit 'close', which is
  // where the ping interval is cleared.
  try { res.destroy(); } catch {}
  try { res.socket?.destroy(); } catch {}
}

/** Write one SSE frame, hanging up on a client too far behind to keep. */
function writeSse(res, frame) {
  try {
    res.write(frame);
    if (queuedBytes(res) <= MAX_CLIENT_BUFFER_BYTES) return;
  } catch { /* already dead — drop it below */ }
  dropSse(res);
}

// How long a resuming client is given to accept the bytes already queued for
// it before the deck concludes it is not reading at all. Generous on purpose:
// what it has to work through is a full MAX_CLIENT_BUFFER_BYTES, the link may
// be an `ssh -L` tunnel rather than loopback, and dropping a client that is
// merely slow costs it the whole replay. A tab that is genuinely frozen will
// not accept a byte in any budget, so the only thing a long one buys it is a
// few more seconds of holding its own buffer. The environment override exists
// so the tests can pin the drop without sitting through the real budget.
//
// It is a budget per awaited frame, and what that frame waits on is everything
// queued ahead of it draining — a full MAX_CLIENT_BUFFER_BYTES, by
// construction, since that is what the loop fills to before it stops. So this
// states a minimum rate a resuming client has to manage, and #588 doubled that
// flush in practice without touching this line: the cap it is sized against was
// really 4 MiB and is now the 8 MiB it always said. Still generous — measured
// on loopback a full cap flushes in about a quarter of a second.
const REPLAY_DRAIN_MS = Number(process.env.AGENTS_DECK_REPLAY_DRAIN_MS) > 0
  ? Number(process.env.AGENTS_DECK_REPLAY_DRAIN_MS)
  : 30_000;

/**
 * Write one frame of the resume stream under the same ceiling the live path
 * obeys, waiting rather than dropping when the client is at it. Resolves true
 * while the client is worth keeping, false once it is not.
 *
 * Waiting is the whole difference from writeSse, and the replay is why. The
 * live path writes one frame per event, so a full buffer there means the
 * client stopped reading and the only answer is to hang up. Here the burst is
 * ours: resumeSse's loop hands the socket the entire ring buffer in one turn of
 * the event loop, so even a client reading at full speed sees its buffer fill
 * — nothing has drained it yet, because nothing could. Dropping on that would
 * hang up on healthy clients, and hang up on them again every time they came
 * back: EventSource reconnects with the same Last-Event-ID, meets the same
 * oversized replay, and is dropped again 1.5 seconds later, forever. So we
 * stop writing until the socket has taken what it already has, and only give
 * up on a client that takes nothing at all for REPLAY_DRAIN_MS.
 *
 * The wait is on write()'s completion callback rather than on a 'drain' event:
 * 'drain' fires only after a write that was answered false, so waiting on it
 * means depending on an answer this call may never have seen. The cap sits far
 * above the stream's own 16 KiB high-water mark, so by the time queuedBytes is
 * at the cap the `false` that a 'drain' would eventually answer belongs to some
 * frame long since written, and its drain may already have come and gone. The
 * callback fires once this chunk —
 * and therefore everything queued ahead of it — has reached the OS, which is
 * exactly the condition being waited for. It also fires, with an error we do
 * not need to read, if the response is destroyed underneath us, so this cannot
 * hang on a client that goes away.
 */
async function writeResume(res, frame) {
  // Below the cap this is the plain write it has always been. The `await` in
  // the caller costs a microtask and nothing else: the checkpoint drains
  // before the loop can accept I/O, so no live event can slip between two
  // replay frames the way it could across a real wait.
  if (queuedBytes(res) <= MAX_CLIENT_BUFFER_BYTES) {
    try { res.write(frame); return true; } catch { return false; }
  }
  return new Promise(resolve => {
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // Unref'd so a client that stopped reading can never be the reason the
    // process stays alive, and cleared on every path out so a completed replay
    // leaves no timer behind.
    const timer = setTimeout(() => done(false), REPLAY_DRAIN_MS);
    timer.unref?.();
    try { res.write(frame, () => done(!res.destroyed)); }
    catch { done(false); }
  });
}

// What index.mjs calls besides the two exported above. Listed rather than
// marked at each declaration, so the declarations read as they did where they
// came from.
export { dropSse, notifyTrays, pageCount, sseClients, trayClients, writeResume, writeSse };
