// What each history series reads RIGHT NOW, keyed the way the ring keys it.
//
// The footer strip draws two things per cell from two different sources, and
// the split is deliberate. The SPARKLINE comes from /api/system/history, whose
// buckets are a minute wide. The NUMBER comes from /api/system, which the panel
// already polls every three seconds.
//
// Taking the number from the buckets too would have been one source instead of
// two, and it would have been wrong: the modal covers the panel, so closing it
// puts a live reading and an up-to-a-minute-stale one of the same quantity on
// screen seconds apart. One of them is then always the lie, and the strip is
// the one people would stop trusting.
//
// The formulas below MIRROR the server's `record(...)` calls, and that is the
// risk this module exists to concentrate: two places compute `mem:swap`, and
// they have to agree. They are asserted against each other rather than left to
// a reviewer — see machine-live.test.ts, which reads the server's own source.
//
// THE KEY, NOT THE LABEL. `Swap` is `Commit` on Windows and the temperature
// labels are whatever the chip publishes, so a join on the display label breaks
// on exactly the platform nobody re-checks.

/** The shape of `/api/system` this needs, structurally — SystemMeter's own
 *  `Snapshot` satisfies it, without this module importing that component and
 *  closing an import cycle back through the modal that renders the strip. */
export interface LiveSource {
  cpu: number | null;
  perCore: number[] | null;
  memory: { total: number; available: number; usedPct: number } | null;
  swap: { total: number; used: number } | null;
  loadavg: number[] | null;
  thermal: {
    celsius: { label: string; celsius: number }[];
    throttle: { speedLimit: number } | null;
  } | null;
}

/** The name the server records throttling under. One spelling, exported, so a
 *  rename on either side is a failing test rather than a cell that quietly
 *  stops updating.
 *
 *  Not `THROTTLE_KEY`: in this client a constant ending in `KEY` is a browser
 *  storage key, and display-name.test.ts reads that convention off the source
 *  to keep every one of them inside the `agent-dag.*` namespace. This is a
 *  series name, and it was that test that said so. */
export const THROTTLE_SERIES = "thermal:Throttling";

/**
 * Every reading this snapshot can answer for, by series key.
 *
 * Absent rather than zero for anything the machine does not publish: no
 * `load:1m` on Windows, no `thermal:*` on a machine with no sensor. A zero
 * would draw a cell reading `0` under a sparkline of real history, which is the
 * "this readout is broken" shape the panel already refuses to draw.
 */
export function liveReadings(sys: LiveSource): Record<string, number> {
  const out: Record<string, number> = {};
  if (sys.cpu != null) out["cpu:all"] = sys.cpu;
  if (sys.perCore?.length) out["cpu:busiest"] = Math.max(...sys.perCore);
  if (sys.memory) out["mem:physical"] = sys.memory.usedPct;
  // The server's own rounding, not a re-derivation: `Math.round(x * 1000) / 10`
  // is one decimal, and computing the same ratio to full precision here would
  // put 61.7 in the panel and 61.66666 in the strip.
  if (sys.swap && sys.swap.total > 0) {
    out["mem:swap"] = Math.round((sys.swap.used / sys.swap.total) * 1000) / 10;
  }
  if (sys.loadavg?.length) out["load:1m"] = sys.loadavg[0];
  for (const r of sys.thermal?.celsius ?? []) out[`thermal:${r.label}`] = r.celsius;
  if (sys.thermal?.throttle) {
    out[THROTTLE_SERIES] = Math.max(0, 100 - sys.thermal.throttle.speedLimit);
  }
  return out;
}

/**
 * How a reading is printed in a cell 116px wide.
 *
 * Tabular width matters more than precision here: the strip sits under a list
 * that reflows every four seconds, and a number that changes character count
 * makes its own cell twitch. So a percentage is whole and a load average keeps
 * the two decimals the panel gives it, because a load that reads `78` when the
 * panel says `78.89` is a different number to anyone comparing the two.
 */
export function fmtReading(v: number, unit: "C" | "%" | ""): string {
  if (unit === "C") return `${Math.round(v)}°`;
  if (unit === "%") return `${Math.round(v)}%`;
  return v.toFixed(2);
}
