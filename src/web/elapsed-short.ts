// "<1s" / "42s" / "3m" / "1h 15m": the compact clock a rail row prints, which
// the topbar's waiting queue and quick open print too, so a name in any of them
// and its row say the same wait. Its own module so the rail's row copy and the
// list that draws it do not import each other; SessionList.tsx re-exports it
// for the callers that already import it from there.
export function elapsedShort(start: number, end: number | undefined, now: number): string {
  const ms = (end ?? now) - start;
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
