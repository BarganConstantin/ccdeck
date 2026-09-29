// The Machine panel's sampler as one text, for the sweeps that read what it
// records.
//
// system-metrics.mjs is being taken apart one concern at a time — the command
// runner, the process list, the thermal and memory sources, the load-average
// rule, the minute ring, the network sampler and the thermal sampler have each
// moved into a module of their own, and the process list's command column out
// of that one — and an assertion that means "the sampler does this" reads the
// file that owns the code. A sweep cannot: "every name the ring is keyed by",
// read out of system-metrics.mjs alone, quietly loses the network's three the
// moment the network sampler moves out, and a set that shrinks when code moves
// is a set that no longer means what the test says it does. So those read this
// instead: system-metrics.mjs and every file lifted out of it, in one string.
//
// Raw rather than comment-stripped, like browser-watch-server-surface.ts, and
// joined by a newline and nothing else so a line-anchored pattern cannot span
// two files.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `src/server`, with a trailing separator, resolved from this file. */
const SERVER_DIR = fileURLToPath(new URL("../../server/", import.meta.url));

/** system-metrics.mjs and what was lifted out of it, relative to `src/server`.
 *  A file extracted from system-metrics.mjs is added here in the same change. */
export const SYSTEM_METRICS_FILES = [
  "system-metrics.mjs",
  "metrics-run.mjs",
  "process-list.mjs",
  "process-command.mjs",
  "thermal-metrics.mjs",
  "memory-metrics.mjs",
  "load-average.mjs",
  "metrics-history.mjs",
  "network-sampler.mjs",
  "thermal-sampler.mjs",
] as const;

let joined: string | null = null;

/** Every file in SYSTEM_METRICS_FILES, raw, joined by a newline. */
export function systemMetricsSurface(): string {
  joined ??= SYSTEM_METRICS_FILES.map(rel => readFileSync(`${SERVER_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
