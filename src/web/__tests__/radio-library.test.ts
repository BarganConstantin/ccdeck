import { describe, it, expect } from "vitest";
import { resolveRadioStations, readRadioIds, recentRadioIds, surpriseStation, dailyStation, matchesRadio, adjacentRadioStation } from "../radio-library";
import { resolveCustomFmStations, parseFmStationUrl } from "../fm-stations";
import { containPopoverKeys } from "../shortcuts";
const id = "radio-d1a54d2e-623e-4970-ab11-35f7b56c5ec3";
const raw = { id, name: "Night radio", url: "https://radio.example/stream", country: "Moldova", countryCode: "MD", tags: "jazz, ambient", language: "romanian", lat: 0, lon: 0, bitrate: 128 };
const [station] = resolveRadioStations([raw]);
describe("radio library", () => {
  it("navigates the displayed order and wraps at either end", () => {
    const second = { ...station, id: "second" }, third = { ...station, id: "third" };
    const rows = [station, second, third];
    expect(adjacentRadioStation(rows, station.id, 1)).toBe(second);
    expect(adjacentRadioStation(rows, second.id, -1)).toBe(station);
    expect(adjacentRadioStation(rows, third.id, 1)).toBe(station);
    expect(adjacentRadioStation(rows, station.id, -1)).toBe(third);
  });
  it("starts at the appropriate end when the current station is outside the results", () => {
    const second = { ...station, id: "second" };
    expect(adjacentRadioStation([station, second], undefined, 1)).toBe(station);
    expect(adjacentRadioStation([station, second], "outside", -1)).toBe(second);
  });
  it("has no adjacent station for empty results or an already-current sole result", () => {
    expect(adjacentRadioStation([], station.id, 1)).toBeNull();
    expect(adjacentRadioStation([station], station.id, -1)).toBeNull();
    expect(adjacentRadioStation([station], "outside", 1)).toBe(station);
  });
  it("keeps extensionless HLS metadata through directory normalization and local restore", () => {
    const [hlsStation] = resolveRadioStations([{ ...raw, hls: true }]);
    expect(hlsStation.radio.hls).toBe(true);
    expect(resolveCustomFmStations(JSON.stringify([hlsStation]))[0].radio?.hls).toBe(true);
    expect(resolveRadioStations([{ ...raw, hls: "true" }])[0].radio).not.toHaveProperty("hls");
  });
  it("keeps control keys off the canvas while allowing shared dismissal and focus navigation", () => {
    for (const key of ["r", " ", "ArrowDown", "Escape", "Tab"]) {
      let stopped = false;
      containPopoverKeys({ key, stopPropagation: () => { stopped = true; } });
      expect(stopped).toBe(key !== "Escape" && key !== "Tab");
    }
  });
  it("restores directory metadata across reloads, including zero coordinates", () => {
    expect(resolveCustomFmStations(JSON.stringify([station]))).toEqual([station]);
    expect(station.radio).toMatchObject({ lat: 0, lon: 0, countryCode: "MD" });
    expect(resolveRadioStations([raw, raw, { ...raw, id: "bad" }])).toHaveLength(1);
    expect(resolveRadioStations([{ ...raw, url: "http://radio.example/stream" }])).toEqual([]);
  });
  it("plays extensionless radio URLs while rejecting credentials and playlist wrappers", () => {
    expect(parseFmStationUrl("https://radio.example/listen?channel=1")).toMatchObject({ kind: "direct-audio", format: "audio" });
    expect(parseFmStationUrl("https://user:secret@radio.example/stream")).toBeNull();
    expect(parseFmStationUrl("https://radio.example/playlist.pls")).toBeNull();
  });
  it("recovers corrupt storage and bounds deduplicated favorites and recent history", () => {
    expect(readRadioIds("bad")).toEqual([]);
    expect(readRadioIds(JSON.stringify([id, id, 42, "../bad"]))).toEqual([id]);
    const ids = Array.from({ length: 70 }, (_, i) => `station-${i}`);
    const recent = recentRadioIds(ids, "station-5");
    expect(recent).toHaveLength(50); expect(recent[0]).toBe("station-5"); expect(recent.filter(item => item === "station-5")).toHaveLength(1);
  });
  it("never teleports to the current station or picks from an empty list", () => {
    const other = { ...station, id: "other" };
    expect(surpriseStation([station, other], station.id, () => 0)).toEqual(other);
    expect(surpriseStation([station], station.id)).toBeNull();
    expect(surpriseStation([], undefined)).toBeNull();
  });
  it("keeps the daily station stable when the catalogue order changes", () => {
    const other = { ...station, id: "other" };
    expect(dailyStation([station, other], "2026-10-12")).toEqual(dailyStation([other, station], "2026-10-12"));
    expect(dailyStation([], "2026-10-12")).toBeNull();
  });
  it("combines name, country, sound and language filters", () => {
    expect(matchesRadio(station, "MOLDOVA", "MD", "jazz", "romanian")).toBe(true);
    expect(matchesRadio(station, "Night", "FR", "jazz", "")).toBe(false);
    expect(matchesRadio(station, "", "MD", "rock", "")).toBe(false);
  });
});
