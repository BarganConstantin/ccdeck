// The load average, and the one rule for when it is a reading at all.
//
// Two things in system-metrics.mjs ask for it: the `load:1m` series the sampler
// records on every CPU tick, and the `loadavg` that /api/system answers. Each
// used to carry its own copy of the platform test and its own copy of the
// comment defending it, the second pointing at the first. #1028 was a bug in
// BOTH copies at once — the same extra clause on each — so this file is the rule
// spelled once, with both callers asking it.
import os from "node:os";

/**
 * The one-, five- and fifteen-minute load averages, to two places, or null on a
 * platform that publishes none.
 *
 * `os.loadavg()` reads a kernel value — no syscall worth the name — which is why
 * the sampler can afford it on every CPU tick. Windows returns [0,0,0], which is
 * not a reading and is not reported as one.
 *
 * THE PLATFORM TEST IS THE WHOLE TEST. It used to be joined by
 * `load.some(n => n > 0)`, which reads as belt and braces and is not: Node
 * documents `os.loadavg()` as always [0,0,0] on Windows, so the platform test
 * alone already excludes every non-reading — and the extra clause could only
 * ever reject a reading that was REAL. `/proc/loadavg` on a genuinely quiet
 * Linux box says `0.00 0.00 0.00`, so "Queued work" recorded no points at all
 * for every quiet minute, and after the machine woke the chart read as though
 * the deck had been switched off through them. And MachinePanel gates the whole
 * section on `{loadavg && …}`, so an idle Linux box had the section disappear
 * from under it (#1028).
 */
export function loadReading(platform = process.platform, load = os.loadavg()) {
  return platform !== "win32" ? load.map(n => Math.round(n * 100) / 100) : null;
}
