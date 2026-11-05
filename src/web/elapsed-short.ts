// The compact clocks a rail row prints, which the topbar's waiting queue, quick
// open and the stage print too, so a name in any of them and its row say the
// same wait. Its own module so the rail's row copy and the list that draws it
// do not import each other; SessionList.tsx re-exports elapsedShort for the
// callers that already import it from there.
//
// ONE WAIT, ONE PRECISION. A wait and a running turn read to the second under
// an hour, "6m 42s", as V4 draws them in the row, the pane's header and the
// empty pane alike. Ages ("3m ago", "read 12m ago") keep the minute: nobody
// reads how long ago something ended to the second.

/** A span of whole seconds: "42s", "6m 07s" under an hour, then "1h 15m".
 *  The seconds are padded once a minute leads, as the card's own clock pads
 *  them, so the figure keeps its width while it ticks. `toTheSecond` false
 *  drops them: "6m". */
export function clockShort(s: number, toTheSecond = true): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return toTheSecond ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** "<1s" / "42s" / "6m 07s" / "1h 15m": how long a wait or a turn has run. */
export function elapsedShort(start: number, end: number | undefined, now: number): string {
  const ms = (end ?? now) - start;
  if (ms < 1000) return "<1s";
  return clockShort(Math.floor(ms / 1000));
}

/** "<1s" / "42s" / "3m" / "1h 15m": how long ago something happened, to the
 *  minute once it is a minute old. */
export function agoShort(start: number, end: number | undefined, now: number): string {
  const ms = (end ?? now) - start;
  if (ms < 1000) return "<1s";
  return clockShort(Math.floor(ms / 1000), false);
}
