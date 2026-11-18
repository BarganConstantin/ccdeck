// The compact clocks a rail row prints, which the topbar's waiting queue, quick
// open and the stage print too, so a name in any of them and its row say the
// same wait. Its own module so the rail's row copy and the list that draws it
// do not import each other; SessionList.tsx re-exports elapsedShort for the
// callers that already import it from there.
//
// ONE WAIT, ONE PRECISION. A wait and a running turn read to the second under
// an hour, "6m 42s", in the pane's header, the empty pane and the topbar's
// queue alike. Ages ("3m ago", "read 12m ago") keep the minute: nobody reads
// how long ago something ended to the second.
//
// The Sessions list's rows are an inbox, not a stopwatch (V4 top-10, inbox):
// each says one age to the minute, ageShort, the wait included. That is the
// same clock with the seconds left off, so a row's "6m" and the header's
// "6m 42s" never disagree; they only differ in how closely they are read.

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

/** "now" / "4m" / "1h 12m" / "2h" / "3d": how old a Sessions row's state is,
 *  the figure at its right edge (rail-row-copy.ts railTime). Under a minute it
 *  is `nowWord`, the reader's own word, since this module holds no catalog;
 *  then clockShort without its seconds, a round hour without its "0m"; from a
 *  day, whole days. Nothing finer than the minute, so the figure moves at most
 *  once a minute however often the list is drawn. A clock set back reads
 *  `nowWord`. */
export function ageShort(since: number, now: number, nowWord: string): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return nowWord;
  if (s >= 86_400) return `${Math.floor(s / 86_400)}d`;
  return clockShort(s, false).replace(/ 0m$/, "");
}
