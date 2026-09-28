// The Machine panel's history: a day of minute buckets that every section
// records into, and the reads its charts are drawn from.
//
// Moved out of system-metrics.mjs unchanged, so that a sampler lifted out of it
// can record here without importing the sampler back — which would be a cycle
// in src/server, the thing boot-module-graph.test.ts exists to refuse. The
// sampler still decides what is recorded and when, builds each section's series
// out of these reads, and answers /api/system/history (historySnapshot). This
// file holds the ring, and nothing outside it touches the array: record writes
// it, three named reads answer from it, and resetHistory empties it.

/** Minute buckets, oldest first, for every section that keeps a history.
 *  See HISTORY_MINUTES. */
const history = [];

/**
 * How much history the panel keeps, and why it is bucketed by minute.
 *
 * Each section answers "what is it now"; the chart behind it answers "what did
 * it do while that build was running", which is a different question and the
 * reason a section opens one at all. 1440 minutes is a day, which covers "since
 * the deck started" for every session anybody actually has.
 *
 * A bucket holds the MAXIMUM of its minute, never the mean, and that choice is
 * the same one for every series here. A machine that touched 94°C for twenty
 * seconds and sat at 60 for the rest of the minute averages to 66 and reads as
 * calm; a load average that spiked to 114 between two quiet stretches averages
 * away entirely. The spike is what somebody opens a chart to find.
 *
 * Kept out of systemSnapshot deliberately. That endpoint is polled every three
 * seconds by a topbar meter that draws none of this; a day of buckets on every
 * one of those responses would be the largest thing the deck sends, for charts
 * that are usually closed. It has its own route, like the process list.
 */
const HISTORY_MINUTES = 1440;
export const BUCKET_MS = 60_000;

/**
 * Fold one reading into the minute it belongs to, under a namespaced key.
 *
 * Keys are namespaced by section (`thermal:GPU`, `cpu:all`, `mem:swap`) rather
 * than kept in four rings, because they all share one clock: a bucket is a
 * minute of this machine, and every series that has something to say about that
 * minute says it in the same place. The sections sample at different rates —
 * CPU every three seconds, thermal every ten, memory every thirty — and folding
 * by maximum makes that difference invisible to the reader, which is what it
 * should be.
 */
export function record(key, value, nowMs = Date.now()) {
  if (!Number.isFinite(value)) return;
  const minute = Math.floor(nowMs / BUCKET_MS);
  let last = history[history.length - 1];
  if (!last || last.m !== minute) {
    last = { m: minute, v: {} };
    history.push(last);
    while (history.length > HISTORY_MINUTES) history.shift();
  }
  const prev = last.v[key];
  last.v[key] = prev == null ? value : Math.max(prev, value);
}

/** Every reading recorded under `key`, oldest first, one point per minute that
 *  has one. */
export function pointsOf(key) {
  return history.filter(b => b.v[key] != null)
    // Timestamps rather than indices: a bucket only exists for a minute that was
    // sampled, so a gap — the machine asleep, the process paused — stays a gap
    // rather than becoming a straight line across it.
    .map(b => ({ t: b.m * BUCKET_MS, v: b.v[key] }));
}

/** What follows `prefix` in every key recorded under it, in the order each
 *  first appeared — a series per sensor, however late the sensor turned up. */
export function labelsUnder(prefix) {
  const labels = [];
  for (const b of history) {
    for (const k of Object.keys(b.v)) {
      if (!k.startsWith(prefix)) continue;
      const label = k.slice(prefix.length);
      if (!labels.includes(label)) labels.push(label);
    }
  }
  return labels;
}

/** Where the oldest minute still held begins, or 0 before anything is. */
export function oldestBucketMs() {
  return history.length ? history[0].m * BUCKET_MS : 0;
}

/** Empty the ring. See stopSystemMetrics, which is the one caller. */
export function resetHistory() {
  history.length = 0;
}
