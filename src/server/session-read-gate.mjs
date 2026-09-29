// The gate every enrichment pass puts in front of its read: one read per
// session at a time, and none sooner than a window after the last one began.
//
// It was written out six times — the model, usage, session-name and context
// passes in session-enrichment.mjs, the Codex memory scan beside them, and the
// Codex usage read in codex-enrichment.mjs — each as its own pair of a
// `last…ReadAt` map and a `pending…Reads` set with the same eight lines in
// front of its read. Six copies of one rule are six places for it to drift,
// and the only thing that differed between them was the window. So the pair
// lives here, once, behind the three operations its callers used on it.

/**
 * A per-session read gate with a window of `ms`.
 *
 * `run(sid, read)` calls `read()` unless a read for `sid` is still in flight or
 * the last one began less than `ms` ago. The stamp is taken as the read starts,
 * so a read that fails or finds nothing still holds the next one back for the
 * window — that is the throttle. `read` is called before `run` returns, as
 * every copy called it, and returns a promise. Whatever that rejects with is
 * swallowed, because nothing awaits a pass fired off the hot path, and the
 * session is let through again once it settles.
 *
 * `forget(sid)` drops one session's stamp and `forgetAll()` drops every stamp,
 * so the next event for it reads at once. Neither touches a read in flight: it
 * settles and lets its session through exactly as it would have.
 */
export function sessionReadGate(ms) {
  const lastReadAt = new Map();   // sid -> ms timestamp the last read began
  const pending = new Set();      // sid currently being read
  return {
    run(sid, read) {
      if (pending.has(sid)) return;
      const now = Date.now();
      const last = lastReadAt.get(sid) ?? 0;
      if (now - last < ms) return;
      lastReadAt.set(sid, now);
      pending.add(sid);
      read()
        .catch(() => {})
        .finally(() => pending.delete(sid));
    },
    forget(sid) {
      lastReadAt.delete(sid);
    },
    forgetAll() {
      lastReadAt.clear();
    },
  };
}
