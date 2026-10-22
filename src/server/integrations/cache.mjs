// A provider client's memory (#2178): the slow, rarely changing reads — a
// board list, a field map, a server's time-tracking settings — kept for a
// while. One per client, and the core keeps one client per connection and
// makes a new one whenever the connection changes (routes.mjs), so nothing
// cached here outlives the token or the address it was read with.

/** A bounded key/value memory with per-read ages. */
export function createCache({ max = 500 } = {}) {
  const entries = new Map();
  const set = (key, value) => {
    entries.delete(key);
    entries.set(key, { at: Date.now(), value });
    // A bound, not a policy: a provider caching per board per page is still
    // a few hundred entries.
    while (entries.size > max) entries.delete(entries.keys().next().value);
    return value;
  };
  const peek = (key, ttlMs) => {
    const hit = entries.get(key);
    return hit && Date.now() - hit.at < ttlMs ? hit.value : undefined;
  };
  /** Loads in flight, so two panels asking at once share one read. */
  const pending = new Map();
  return {
    /** The value under `key` younger than `ttlMs`, or a fresh one from `load`. */
    async remember(key, ttlMs, load) {
      const hit = peek(key, ttlMs);
      if (hit !== undefined) return hit;
      if (pending.has(key)) return pending.get(key);
      const promise = (async () => {
        try { return set(key, await load()); } finally { pending.delete(key); }
      })();
      pending.set(key, promise);
      return promise;
    },
    /** The value under `key` younger than `ttlMs`, or undefined. */
    peek,
    set,
    forget(key) { entries.delete(key); },
    clear() { entries.clear(); },
  };
}
