// Pause is a freeze of the canvas, not a disconnect from the server.
//
// The deck reads its events from one long-lived EventSource. When the pause
// flag lived in React state and the subscription effect listed it as a
// dependency, pressing Space closed that EventSource and opened a new one — and
// a brand-new EventSource carries no Last-Event-ID, so the server replayed its
// whole ring buffer (up to 2000 envelopes) down the fresh connection. The
// handler was paused by then, so every replayed envelope landed in the pause
// queue: the button read "Resume · 2000" after zero new events, memory held
// thousands of envelopes the reducer had already applied, and resuming re-ran
// all of them just for the seq check to throw each one away — then reconnected
// and replayed the lot a second time.
//
// Holding both the flag and the queue in this gate fixes that structurally.
// The gate is a plain mutable object living in a ref, so the SSE handler asks
// it about the current pause state instead of closing over a state variable,
// and the subscription effect no longer has any reason to name `paused` among
// its dependencies. One connection survives any number of pause toggles.
//
// Kept out of App.tsx so the rule can be tested without React or a DOM.
//
// ── #547: the same outcome by a route the gate did not cover ────────────────
//
// Closing the stream on a toggle was not the only way to get a ring buffer
// into the queue, and removing it left two holes.
//
// The first is that the queue had no ceiling at all. `accept` pushed and
// nothing ever trimmed, so a pause taken during a live multi-session run and
// then walked away from grew until the tab died — and every envelope in it
// pins its payload, whose `tool_input` and `tool_response` the ingest path
// admits up to five million characters of. A hold is not a store. Past some
// depth the deck is not going to apply the backlog usefully, and the honest
// thing is to stop holding and say so rather than to keep accumulating behind
// a pill that reads `paused · 99+` either way.
//
// The second is the reconnect. `EventSource` reconnects on its own — the deck's
// `error` handler only flips the live indicator — and the connection it opens
// is the server's cue to drain its ring buffer down the new socket. While the
// gate is paused every one of those replayed envelopes reaches `accept` BEFORE
// the reducer or the render coalescer, so the queue is where they land. What
// governs whether that is a re-delivery is which sequence number the resume
// asks from, and the answer is not the one the deck's own state holds: the
// reducer's `lastSeq` is the last seq APPLIED, and a pause freezes it, so
// everything held since is invisible to it. The right resume point is the last
// seq RECEIVED — applied or held — which is a number only this gate is in a
// position to know. A compliant EventSource sends exactly that in
// `Last-Event-ID`, because a browser advances its last event id when it
// dispatches an event and not when the page does something with it; the gate
// records the same high-water mark so the invariant holds on the deck's side
// too, and an envelope arriving at or below it while paused is dropped rather
// than held. That is not a duplicate filter bolted on after the drain — it is
// the resume point being enforced where the resume point lives, and it costs
// nothing, because the reducer would reject those envelopes on resume anyway.
//
// A restart is the case that number cannot cover, and it is the reason the
// ceiling is not optional. The server's seq counter starts at 1 on every boot
// and is re-derived by replaying events.jsonl, so the seq an already-open tab
// is holding means nothing to the new process. The envelopes carry a per-boot
// `epoch` for precisely this, and the rule here is the reducer's rule: a new
// epoch rebases the high-water mark to zero rather than silencing the stream.
// Which means that after a restart — the deck's own Restart button, an `npx`
// upgrade, a supervisor bounce — a paused tab genuinely is offered the whole
// re-ingested ring, and nothing can tell it apart from new traffic. The cap is
// what stands between that and the tab.
//
// ── #676: which end goes was the wrong question ─────────────────────────────
//
// The ceiling dropped by POSITION, oldest first, and the note at the eviction
// argued the tail was the safe end to keep: keeping the head would pin the
// canvas to the moment the ceiling was hit and lose every event describing the
// present, "so a tool that finished would pulse as running until the stale
// sweep reaped it". Both halves of that are true and neither is answered by
// swapping ends, because that sentence describes what keeping the TAIL does as
// well. The head of a pause queue is where the settling events for calls that
// were already in flight when the pause began live — a `Bash` open at the
// freeze returns a few seconds into it — so oldest-out drops exactly those
// `PostToolUse`s and keeps the newer traffic. Driven for real, one `Bash` open
// and 1200 envelopes from six other sessions behind it: 1000 held, 201
// dropped, and the call left `endedAt == null`, pinned in `toolIndex` with its
// whole `tool_input`, until `sweepStaleTools` stamped it failed ninety minutes
// later with a cause that was not true.
//
// What the old note got right is that position is the only thing an eviction
// can be cheap about, and that the tail is what the canvas is FOR. What it
// missed is that the two ends are not made of the same stuff. A fresh event
// from another session is one more thing to draw; a settling event for a call
// the reducer has ALREADY drawn is the only thing in the world that can close
// that call, and nothing re-delivers it — `through` and the browser's
// `Last-Event-ID` both advanced past it the moment it was offered. So the
// eviction keeps its direction and stops being blind: it drops the oldest
// event that is not the answer to something already on the canvas, and only
// falls back to the plain head when every held event is one of those. The
// ceiling itself does not move, and the survivors stay in arrival order, so
// the drain is still one strictly increasing run the reducer applies whole.
//
// The gate cannot tell which those are — it reads two fields and would have to
// grow a reducer to read more — so the caller says. `protect` is handed the
// envelope and answers against the live graph, which during a pause is frozen
// at exactly the set of calls that were open when it began. Left unset, the
// gate evicts by position as it always did.
//
// It bounds the damage rather than ending it: a hold whose every slot is a
// settling event still drops one, and an outcome can go missing for reasons
// that have nothing to do with this file. That is why the other half of #676
// lives in the reducer — see `noteDroppedEvents`. A drop policy decides how
// often the deck loses an outcome; only the reducer can decide what the deck
// SAYS about a call whose outcome it lost, and saying "the session ended
// before this call returned" about an event the deck itself threw away is the
// part that sent a user to debug a failure that never happened.

/** The greatest number of events one pause will hold.
 *
 *  Half the server's ring buffer, and the two numbers are related on purpose.
 *  A full ring replay is 2000 envelopes, so it overflows this by construction
 *  and cannot be mistaken for an ordinary backlog — which is the case that has
 *  to be visible, because it is the one that arrives in a single burst nobody
 *  asked for. In the other direction it is far deeper than any pause a person
 *  produces by hand: a heavy multi-session run emits tens of events a second,
 *  so a thousand is minutes of freeze, long past the point where the deck is
 *  reading the backlog rather than drowning in it. */
export const PAUSE_QUEUE_LIMIT = 1000;

/** What a gate can be built with. The limit is a parameter so tests can reach
 *  the ceiling in a handful of events instead of a thousand; production never
 *  passes it and takes PAUSE_QUEUE_LIMIT. */
export interface PauseGateOptions<T = unknown> {
  /** Maximum events held before the oldest start falling off the back. */
  limit?: number;
  /**
   * Whether this event SETTLES something the deck has already drawn, and so is
   * not interchangeable with a fresh one when the ceiling has to give.
   *
   * Asked once, when the event is taken into the hold, and asked of the caller
   * because the gate reads two fields of an envelope and the answer is a fact
   * about the graph. A pause freezes the graph, so "already drawn" means "open
   * when this pause began", which is the set #676 is about. The gate treats a
   * true as a preference and never as a guarantee: see the eviction.
   *
   * Absent — every existing caller but App.tsx, and every gate built before
   * #676 — leaves the eviction purely positional, oldest first.
   */
  protect?: (event: T) => boolean;
}

/** Holds events back while the deck is paused, and hands them over in arrival
 *  order — exactly once — when it resumes. */
export interface PauseGate<T> {
  /** Whether the deck is currently paused. */
  readonly paused: boolean;
  /** How many events are waiting. What the status pill counts. */
  readonly size: number;
  /**
   * How many events THIS pause has dropped because the hold was full. Zero
   * until the ceiling is reached, and cleared by a resume along with the queue
   * — it describes the hold that is currently open, not the deck's history.
   */
  readonly dropped: number;
  /** Whether this pause has reached its ceiling and started dropping. The
   *  thing the pill has to say out loud: a truncated view the user cannot see
   *  is a worse bug than the queue that grew forever. */
  readonly overflowed: boolean;
  /**
   * The greatest `seq` the gate has been offered, in the numbering of the
   * epoch that stamped it — the point a reconnect should resume the stream
   * from, and the reason it is kept here rather than read off the reducer.
   * The reducer's `lastSeq` is the last seq APPLIED and a pause freezes it;
   * this one keeps moving while events are only being held.
   */
  readonly through: number;
  /**
   * Offer an arriving event to the gate. Returns true when the caller should
   * deliver it now, false when the gate has taken it for later — or, while
   * paused, when it has refused it as something the resume point says was
   * already received, or dropped it to make room under the ceiling.
   */
  accept(event: T): boolean;
  /**
   * Set the pause flag. Returns the events held since the deck was paused, in
   * arrival order, and empties the queue — so a resume delivers each held
   * event once and a second call has nothing left to give.
   */
  setPaused(paused: boolean): T[];
}

/** The envelope shape the gate reads. Only the two fields the resume point is
 *  made of; everything else about an event is the reducer's business. */
interface Sequenced {
  seq: number;
  epoch?: string;
}

export function createPauseGate<T extends Sequenced>(opts: PauseGateOptions<T> = {}): PauseGate<T> {
  const limit = Math.max(1, Math.floor(opts.limit ?? PAUSE_QUEUE_LIMIT));
  const protect = opts.protect;
  let paused = false;
  let queue: T[] = [];
  // The held events `protect` claimed, by identity. A set rather than a flag on
  // the envelope, because the envelope belongs to the caller and this is the
  // gate's own bookkeeping; and by identity rather than by seq, because a
  // restart renumbers and two held envelopes can legitimately share a seq.
  // It only ever references envelopes the queue is already holding, so it
  // retains nothing the hold was not retaining anyway.
  let guarded = new Set<T>();
  let dropped = 0;
  // The resume point, and the epoch it is counted in. Both advance whether or
  // not the deck is paused: a gate that only tracked while paused would have
  // no high-water mark at the instant a pause begins, which is the one moment
  // it is needed.
  let through = 0;
  let epoch: string | null = null;

  return {
    get paused() { return paused; },
    get size() { return queue.length; },
    get dropped() { return dropped; },
    get overflowed() { return dropped > 0; },
    get through() { return through; },

    accept(event: T): boolean {
      const seq = typeof event?.seq === "number" ? event.seq : null;
      const stamped = event?.epoch ?? null;
      // The reducer's rule, kept in step with it deliberately: a changed epoch
      // means the server renumbered, so the old high-water mark is a number
      // about a different sequence and nothing measured against it is a
      // duplicate. Servers too old to stamp an epoch send none, and those keep
      // the plain monotonic behaviour.
      const renumbered = stamped !== null && stamped !== epoch;
      if (renumbered) {
        epoch = stamped;
        through = 0;
      }
      const alreadyReceived = seq !== null && !renumbered && seq <= through;
      if (seq !== null && seq > through) through = seq;

      // Live traffic is untouched by any of this. A duplicate reaching a
      // running deck is the reducer's to reject, as it always was, and short-
      // circuiting it here would also rob the render coalescer of a tick it
      // has been getting since before this gate existed.
      if (!paused) return true;

      // Below the resume point: the reconnect is re-offering something this
      // gate has already taken, and holding a second copy would cost the
      // memory twice and the resume a pass through the reducer that can only
      // end in the seq guard.
      if (alreadyReceived) return false;

      queue.push(event);
      if (protect?.(event)) guarded.add(event);
      // Oldest out, rather than refusing the new one. Both truncate, and the
      // difference is which end of the pause survives: keeping the head would
      // pin the canvas to the moment the ceiling was hit and lose every event
      // describing the present, so a tool that finished would pulse as running
      // until the stale sweep reaped it. Keeping the tail lands the deck as
      // close to the server's now as the hold allowed, and the survivors are
      // contiguous and strictly increasing in seq, so the resume applies all of
      // them rather than feeding the reducer a run it will half reject.
      //
      // #676: oldest out, of the events that are ONLY old. The sentence above
      // is a statement about freshness, and freshness is not what a settling
      // event carries — a `PostToolUse` for a call the reducer drew before the
      // freeze is the sole thing that can close that call, is worth one slot,
      // and if it goes the call is stranded in-flight with no way to ask for it
      // again. So the scan walks past whatever `protect` claimed and drops the
      // oldest event that is merely old. Every survivor is still in arrival
      // order and the run still increases strictly in seq, because nothing is
      // reordered and the skipped events are older than the ones behind them.
      if (queue.length > limit) {
        // Bounded by how many of the hold are guarded, which is bounded by the
        // calls open at the freeze — a handful on the busiest deck. The size
        // check keeps the all-guarded hold from re-walking the whole queue for
        // every arrival rather than leaving it to the loop to discover.
        let i = 0;
        if (guarded.size < queue.length) {
          while (guarded.has(queue[i])) i++;
        }
        // i === 0 when nothing is guarded, which is the old `shift()` exactly.
        // i === queue.length is unreachable past the size check, and the
        // fallback it would need is the same line: a hold made entirely of
        // settling events still has a ceiling, and the oldest of them goes.
        // That is the case `noteDroppedEvents` exists for.
        const [out] = queue.splice(i, 1);
        guarded.delete(out);
        dropped++;
      }
      return false;
    },

    setPaused(next: boolean): T[] {
      paused = next;
      // Pausing holds nothing back yet, and re-pausing must not spill the
      // queue or forget what it has already dropped: only a real resume drains.
      if (next) return [];
      const held = queue;
      // Queue, count and flag go together in this one step. A resume that
      // emptied the queue but left `dropped` standing would have the pill
      // reporting a truncation of a hold that is no longer open. The guarded
      // set goes with them: it names envelopes of the hold that just closed,
      // and the calls it was protecting are about to be settled by the drain.
      queue = [];
      guarded = new Set();
      dropped = 0;
      return held;
    },
  };
}
