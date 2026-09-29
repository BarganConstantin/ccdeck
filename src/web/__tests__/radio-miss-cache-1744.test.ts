// The four built-in live stations remember a miss for a minute — or were meant
// to. `settle(null)` stored it as `cache = null` with the one-minute TTL, and the
// fast path asked `cache && …`, so a null was never answered from memory: while
// a station was off air, every canvas mount and station switch downloaded its
// YouTube channel page again. Each case below is asked three times inside the
// minute and must reach the network once, then again once the minute is over.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// @ts-expect-error — plain .mjs module, no types
const radioMix = await import("../../server/live-radio-mix.mjs");
// @ts-expect-error — plain .mjs module, no types
const nostalgia = await import("../../server/best-of-nostalgia.mjs");
// @ts-expect-error — plain .mjs module, no types
const goodLife = await import("../../server/good-life-radio.mjs");
// @ts-expect-error — plain .mjs module, no types
const cafe = await import("../../server/cafe-music-bgm.mjs");

type Fetch = (url: string, init?: unknown) => Promise<unknown>;

const STATIONS: Array<[string, (o: { fetchImpl: Fetch }) => Promise<unknown>, () => void]> = [
  ["live radio mix", radioMix.fetchLiveRadioMix, radioMix.forgetLiveRadioMix],
  ["best of nostalgia", nostalgia.fetchBestOfNostalgia, nostalgia.forgetBestOfNostalgia],
  ["good life radio", goodLife.fetchGoodLifeRadio, goodLife.forgetGoodLifeRadio],
  ["cafe music bgm", cafe.fetchCafeMusicBgm, cafe.forgetCafeMusicBgm],
];

/** The modules' own MISS_CACHE_MS, which none of them exports. */
const MISS_CACHE_MS = 60_000;

const MISSES: Array<[string, Fetch]> = [
  ["an off-air page", async () => ({ ok: true, status: 200, text: async () => "<html>nothing live here</html>" })],
  ["an HTTP 500", async () => ({ ok: false, status: 500, text: async () => "" })],
  ["a network error", async () => { throw new TypeError("fetch failed"); }],
];

let clock = 1_000_000_000;

beforeEach(() => {
  clock = 1_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  for (const [, , forget] of STATIONS) forget();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(STATIONS)("%s", (_name, fetchStation) => {
  it.each(MISSES)("answers %s from memory for a minute", async (_miss, answer) => {
    const fetchImpl = vi.fn(answer);
    const answers = [];
    for (let i = 0; i < 3; i++) {
      answers.push(await fetchStation({ fetchImpl }));
      clock += 1_000;
    }
    expect(answers).toEqual([null, null, null]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // And asks again once the minute has passed.
    clock += MISS_CACHE_MS;
    expect(await fetchStation({ fetchImpl })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
