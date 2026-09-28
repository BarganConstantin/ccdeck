// What /api/system answers, in the shapes the machine panel reads.
//
// Lifted out of MachinePanel.tsx unchanged. The panel's sections, the rules
// that turn a reading into words (machine-readings.ts) and the poll that fetches
// it all read these, so the shapes are nobody's component's to own.

export interface Memory { total: number; available: number; usedPct: number }
export interface Swap { total: number; used: number }
/** `warnAt`/`critAt` come from the chip itself where the platform publishes
 *  them — Linux hwmon does — because a laptop package sensor and an NVMe drive
 *  do not share a comfortable range. Elsewhere the server fills in 75/90. */
export interface ThermalReading { label: string; celsius: number; warnAt: number; critAt: number }
/** Two fields, not one list: degrees and a throttle percentage are different
 *  readings, and a shape that could hold either under one label is how a
 *  percentage ends up printed under a °C heading. */
export interface Thermal {
  celsius: ThermalReading[];
  throttle: { speedLimit: number } | null;
  /** Whether the machine has been held back at all since the deck started, and
   *  when it last was. Null on one that never has. */
  heldBack?: { peak: number; lastMs: number } | null;
}
/** The path traffic takes when it is not this machine's own connection. */
export interface NetRoute {
  kind: "tailscale-exit" | "tailscale" | "vpn";
  iface?: string;
  node?: string | null;
  relay?: string | null;
  name?: string | null;
  to: "claude" | "internet";
}
/** Throughput is sampled all the time; latency and route only while this panel
 *  is open (system-metrics.mjs), so each can be missing for the first poll.
 *
 *  THE THREE FIGURES ARE NOT ONE MEASUREMENT. `down` and `up` are this
 *  machine's own counters across every physical interface it has; `api` is a
 *  TCP handshake with one host. The section sets them apart rather than in a
 *  row of three, and the disclosure under them says so in words. */
export interface Network {
  down: number | null;
  up: number | null;
  /** `ms` null is a host that did not answer. */
  api: { host: string; ms: number | null } | null;
  route: NetRoute | null;
}
export interface Snapshot {
  ok: boolean;
  cpu: number | null;
  cpuHistory: number[];
  cores: number;
  memory: Memory | null;
  swap: Swap | null;
  perCore: number[] | null;
  uptimeSec: number;
  platform: string;
  loadavg: number[] | null;
  /** Null on a machine that publishes nothing, and then no section is drawn at
   *  all — not 0°C, not a dash, not an empty bar. */
  thermal: Thermal | null;
  /** Null until anything about the network has been read. */
  network?: Network | null;
  intervalMs: number;
}
