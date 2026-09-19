// How the network section writes a speed and a latency — one module for the
// panel and for its history, so the two can never print one reading two ways.
//
// A figure is a value and a unit kept apart, because every place that draws one
// sets them in different type: the panel puts the number in the 13px weight and
// the unit in the 10px caption under it, the way Load average does, and the
// chart puts the unit after a bold number in its header.

export interface Figure { value: string; unit: string }

/** One decimal below ten and none above, so a figure's width barely moves as
 *  it changes — a readout that jumps between "8.4" and "12.37" jitters. */
function scaled(n: number): string {
  return n < 9.95 ? n.toFixed(1) : String(Math.round(n));
}

/**
 * Bytes per second, in the decimal units network speeds are quoted in.
 *
 * Bytes, not bits: the panel beside it counts memory in bytes, and a download
 * manager, a browser's download bar and Activity Monitor all count this way. The
 * boundaries are taken on the ROUNDED figure, so 999,600 B/s is "1.0 MB/s" and
 * never "1000 KB/s". Anything under 50 B/s is "0" — a few packets of keepalive
 * are not traffic worth a decimal.
 */
export function rateFigure(bytesPerSec: number): Figure {
  const v = Number.isFinite(bytesPerSec) ? Math.max(0, bytesPerSec) : 0;
  if (v < 50) return { value: "0", unit: "KB/s" };
  if (v < 999_500) return { value: scaled(v / 1e3), unit: "KB/s" };
  if (v < 999_500_000) return { value: scaled(v / 1e6), unit: "MB/s" };
  return { value: scaled(v / 1e9), unit: "GB/s" };
}

/** A round trip, in milliseconds until it is long enough to read in seconds. */
export function latencyFigure(ms: number): Figure {
  const v = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (v < 999.5) return { value: String(Math.round(v)), unit: "ms" };
  return { value: (v / 1000).toFixed(1), unit: "s" };
}

/** A figure as running text. The symbols that sit on a number — %, °C — take
 *  no space; words and abbreviations do. */
export function figureText(f: Figure): string {
  if (!f.unit) return f.value;
  return f.unit === "%" || f.unit === "°C" ? `${f.value}${f.unit}` : `${f.value} ${f.unit}`;
}
