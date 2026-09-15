// A stand-in for readVisitsSince that honours its floor the way the real one
// does, for the suites that drive browserWatchSnapshot through several polls.
//
// WHY THE STUBS HAD TO CHANGE (#989). The snapshot used to floor every read at
// the deck's start, so a stub that answered the same rows to every call was a
// faithful one: that is what the real reader returned. The floor now advances to
// the watermark of the last read, and a stub that ignores it hands the
// snapshot the same visits on every poll — which it then counts again, and
// judges again, as if they were new.
//
// ONLY THE FLOORS THIS STUB HANDED OUT ARE HONOURED. The first floor a profile
// is read from is `STARTED_MS`, a wall-clock moment about when this test PROCESS
// began, while fixtures are written as offsets from `Date.now()`. Honoured
// literally, whether a case saw its own rows would depend on how long vitest had
// been running when it got there. So a floor this stub never returned as a
// watermark is read as "the deck's start" and every fixture is after it, which
// is what the fixtures mean; every watermark it did return is compared exactly,
// and those are the floors the snapshot computed.
import { chromeTimeToMs, msToChromeTime } from "../../server/browser-history.mjs";

export interface Visit { url: string; timeMs: number; transition: number }

export function flooredReader(held: () => Visit[]) {
  /** Every path asked for, in order. */
  const calls: string[] = [];
  /** Every floor asked from, in order. */
  const floors: string[] = [];
  /** How many rows each read returned. */
  const asked: number[] = [];
  const issued = new Set<string>();
  const read = async (path: string, since: string) => {
    calls.push(path);
    floors.push(since);
    const all = held();
    const floorMs = issued.has(since) ? chromeTimeToMs(since) : -Infinity;
    const rows = all.filter(r => r.timeMs > floorMs);
    asked.push(rows.length);
    // The real reader hands the floor back unchanged when nothing is new, and
    // the seed must not become an issued floor by that route.
    const watermark = rows.length ? msToChromeTime(Math.max(...rows.map(r => r.timeMs))) : since;
    if (rows.length) issued.add(watermark);
    // Every visit the history holds, which is what the real reader counts above
    // the deck's start — and every fixture here is after it.
    return { rows, watermark, total: all.length, degraded: false, reason: null };
  };
  return { read, calls, floors, asked };
}
