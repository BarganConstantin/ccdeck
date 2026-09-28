// The machine panel's rules for turning a reading into words and a colour.
//
// Lifted out of MachinePanel.tsx unchanged: which band a temperature falls
// in, how throttling is said, the one condition worth flagging at the top,
// how bytes, an uptime and a network path are written. None of it touches
// React, so each can be asked what it says rather than read.
import type { NetRoute, Snapshot } from "./machine-snapshot";

/** How a bar is painted. `calm` is the resting appearance and carries no class
 *  of its own, which is what keeps the memory rows drawing exactly as before. */
export type Tone = "calm" | "warn" | "hot";

/**
 * Which band a temperature falls in.
 *
 * The numbers are the sensor's own wherever the platform publishes them — Linux
 * hwmon carries `temp*_max` and `temp*_crit` per sensor — because one scale for
 * every source would be a threshold this app invented. 75 and 90 are the
 * fallback for the platforms that publish none.
 */
export function thermalTone(celsius: number, warnAt: number, critAt: number): Tone {
  if (celsius >= critAt) return "hot";
  if (celsius >= warnAt) return "warn";
  return "calm";
}

/**
 * Throttling, stated as the share of the CPU's speed that has been TAKEN AWAY.
 *
 * `pmset -g therm` reports the share still allowed, and the obvious rendering
 * — "Thermal headroom 100%", a full bar — would put a full bar meaning "all is
 * well" directly beneath a memory bar where a full bar means "nearly out". Two
 * opposite conventions in one panel is a panel that has to be read twice. So it
 * is inverted here: every bar in this section fills with the problem, and an
 * empty track means nothing is wrong on every row and every platform.
 *
 * The note is the sentence somebody actually needs. A speed limit is already
 * the consequence a temperature has to be interpreted into, so it is worth
 * saying in words rather than leaving as a number.
 */
export function throttleRow(
  speedLimit: number,
  /** What the history says has already happened. A desktop reads 0% forever —
   *  measured: ninety seconds of AES-NI on twelve cores never moved this — and
   *  a row that only ever says 0% reads as a readout that does not work. It was
   *  reported that way twice. The current value is still the value; the note is
   *  where "and it did happen, at 12:21" belongs. */
  past?: { peak: number; lastMs: number } | null,
  now = Date.now(),
): { pct: number; value: string; tone: Tone; note: string } {
  const held = Math.max(0, Math.min(100, 100 - speedLimit));
  return {
    pct: held,
    // A number, never the word "none", and that was a bug report: a healthy
    // machine read as though the check had not run. Every other reading in this
    // panel is a figure on a scale — "20.5 GB of 32.0 GB", "84.49", "63 °C" —
    // so a word where a number goes is the one token that looks like an absent
    // value rather than a measured one. A speedometer at rest reads 0; it does
    // not read "none". And 0% sits on the same scale as the 9% that appears
    // under load, which is what makes it legible as a reading.
    value: `${held}%`,
    // Any throttling at all is worth a colour: it means the machine is slower
    // than the one you think you are running on. A third of the clock gone is
    // where that stops being a detail.
    tone: held === 0 ? "calm" : held >= 30 ? "hot" : "warn",
    // Short enough to sit on one line in a 280px panel: the longer phrasings
    // wrapped and orphaned their last word.
    note: held > 0
      ? `CPU held to ${speedLimit}% of full speed to cool down`
      : past
        ? `at full speed · held to ${100 - past.peak}% ${sinceLabel(past.lastMs, now)}`
        : "running at full speed, and never held back",
  };
}

/**
 * How long ago something happened, in the fewest words that stay true.
 *
 * Coarse on purpose. The buckets are a minute wide, so "42 seconds ago" would
 * be a precision the reading does not have, and the question this answers is
 * "recently, or this morning" rather than "exactly when".
 */
function sinceLabel(atMs: number, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - atMs) / 60_000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.floor(mins / 60);
  return h === 1 ? "an hour ago" : `${h} hours ago`;
}

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function uptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * The one condition in this snapshot worth saying at the top, or nothing.
 *
 * NOT A HEALTH SCORE, and not a badge that says "all good" on a quiet machine:
 * a permanent green word is read once and then stops being read, and it would
 * have to be computed from thresholds this app does not have for most of what
 * it measures. Three conditions qualify, all of them measured rather than
 * inferred, and each is already a warning colour in the section it comes from:
 *
 *   1. the machine is being held below full speed — `pmset` reports the limit;
 *   2. physical memory is at the 90% the memory row already turns amber at;
 *   3. the API host was asked and did not answer.
 *
 * One at a time, worst first. A stack of flags at the top of a 280px panel is
 * a second panel, and the section each one comes from says it again in place.
 */
export function attentionFlag(sys: Pick<Snapshot, "thermal" | "memory" | "network">): string | null {
  const limit = sys.thermal?.throttle?.speedLimit;
  if (limit != null && limit < 100) return `throttled to ${limit}% of full speed`;
  if (sys.memory && sys.memory.usedPct >= 90) return `physical memory ${Math.round(sys.memory.usedPct)}% full`;
  if (sys.network?.api && sys.network.api.ms == null) return "the Claude API is not answering";
  return null;
}

/** The path, in the words the server's own route label uses. */
export function pathText(route: NetRoute): string {
  if (route.kind === "tailscale-exit") return route.node ? `Tailscale exit node ${route.node}` : "a Tailscale exit node";
  if (route.kind === "tailscale") return "Tailscale";
  return `${route.name ? `${route.name} ` : ""}VPN${route.iface ? ` (${route.iface})` : ""}`;
}
