import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleRadioFailover } from "../radio-failover";
import { resolveRadioStations } from "../radio-library";

const stations = resolveRadioStations(["first", "second", "third"].map((name, index) => ({
  id: `radio-00000000-0000-4000-8000-00000000000${index}`, name,
  url: `https://radio.example/${name}`, country: "Moldova", countryCode: "MD",
})));

describe("radio stream failover", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits one second, then advances once and records the failed station", () => {
    const failed = new Set<string>();
    const pick = vi.fn();
    scheduleRadioFailover(stations, stations[0].id, failed, pick);
    vi.advanceTimersByTime(999);
    expect(pick).not.toHaveBeenCalled();
    expect(failed.size).toBe(0);
    vi.advanceTimersByTime(1);
    expect(pick).toHaveBeenCalledTimes(1);
    expect(pick).toHaveBeenCalledWith(stations[1]);
    expect(failed.has(stations[0].id)).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it("cancels pending advancement when selection or playback changes", () => {
    const failed = new Set<string>();
    const pick = vi.fn();
    const cancel = scheduleRadioFailover(stations, stations[0].id, failed, pick);
    vi.advanceTimersByTime(500);
    cancel();
    vi.advanceTimersByTime(1000);
    expect(pick).not.toHaveBeenCalled();
    expect(failed.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tries each station once and stops when the queue is exhausted", () => {
    const failed = new Set<string>();
    const pick = vi.fn();
    for (const station of stations) {
      scheduleRadioFailover(stations, station.id, failed, pick);
      vi.advanceTimersByTime(1000);
    }
    expect(pick.mock.calls.map(([station]) => station.id)).toEqual(stations.slice(1).map(station => station.id));
    expect(vi.getTimerCount()).toBe(0);
  });
});
