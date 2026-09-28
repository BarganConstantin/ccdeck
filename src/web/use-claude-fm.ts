// Claude FM's configuration: its volume, whether it is muted, which station is
// playing, the stations somebody added by link, and which of those are not
// answering right now — each with its own storage.
//
// Lifted out of App.tsx's `Inner`, where it was three separate runs of code — the
// state, then four persistence effects after the theme's and the character's, then
// the five station operations — with nothing but position holding them together.
//
// The station list, the selection, the not-answering set and the play request are
// private now; they change only through the five named operations. That matters
// more than it sounds: removing a station also moves the selection off it if it
// was playing, and adding one clears any stale not-answering mark it carried. A
// bare setter could do the first half of either and leave the other behind.
// Volume and mute keep their setters on the way out, because for a slider and a
// toggle the setter IS the operation, and there is nothing to keep consistent.
import { useCallback, useEffect, useState } from "react";

import { FM_SOURCE_KEY, FM_VOLUME_KEY, resolveFmSource, storedFmVolume } from "./appearance";
import { type CustomFmStation, FM_CUSTOM_STATIONS_KEY, FM_MUTED_KEY, type FmSelection, STATION_NAME_MAX, fmAvailabilityKey, resolveCustomFmStations, resolveFmMuted, resolveFmSelection, selectionAfterRemovingStation } from "./fm-stations";
import { readStored } from "./storage";

export function useClaudeFm() {
  const [fmVolume, setFmVolume] = useState(storedFmVolume);
  const [customFmStations, setCustomFmStations] = useState<CustomFmStation[]>(() =>
    resolveCustomFmStations(readStored(FM_CUSTOM_STATIONS_KEY))
  );
  const [fmMuted, setFmMuted] = useState(() => resolveFmMuted(readStored(FM_MUTED_KEY)));
  const [fmSource, setFmSource] = useState<FmSelection>(() =>
    resolveFmSelection(readStored(FM_SOURCE_KEY), customFmStations, resolveFmSource)
  );
  const [unavailableFmStations, setUnavailableFmStations] = useState<Set<string>>(() => new Set());
  /** How many times somebody has picked a station. ClaudeFm starts the station
   *  when this moves and not when `fmSource` does — see its probe effect. */
  const [fmPlayRequest, setFmPlayRequest] = useState(0);

  useEffect(() => {
    try { window.localStorage.setItem(FM_VOLUME_KEY, String(fmVolume)); } catch { /* private mode */ }
  }, [fmVolume]);

  useEffect(() => {
    try { window.localStorage.setItem(FM_MUTED_KEY, fmMuted ? "1" : "0"); } catch { /* private mode */ }
  }, [fmMuted]);

  useEffect(() => {
    try { window.localStorage.setItem(FM_CUSTOM_STATIONS_KEY, JSON.stringify(customFmStations)); } catch { /* private mode */ }
  }, [customFmStations]);

  useEffect(() => {
    try { window.localStorage.setItem(FM_SOURCE_KEY, fmSource); } catch { /* private mode */ }
  }, [fmSource]);

  const addFmStation = useCallback((station: CustomFmStation) => {
    setCustomFmStations(current => current.some(item => item.id === station.id) ? current : [...current, station]);
    setUnavailableFmStations(current => {
      if (!current.has(station.id)) return current;
      const next = new Set(current); next.delete(station.id); return next;
    });
  }, []);

  const renameFmStation = useCallback((id: string, name: string) => {
    const clean = name.trim();
    if (!clean || clean.length > STATION_NAME_MAX) return;
    setCustomFmStations(current => current.map(station => station.id === id ? { ...station, name: clean } : station));
  }, []);

  const removeFmStation = useCallback((id: string) => {
    setCustomFmStations(current => current.filter(station => station.id !== id));
    setFmSource(current => selectionAfterRemovingStation(current, id));
    setUnavailableFmStations(current => {
      if (!current.has(id)) return current;
      const next = new Set(current); next.delete(id); return next;
    });
  }, []);

  // A pick of the station already playing changes nothing, as it did before
  // custom stations: counting it would restart the stream under the person.
  // A station marked unavailable is the exception, because picking it is the
  // retry — the mark comes off and the counter moves, so ClaudeFm asks again,
  // whether it is the station already set or one somebody came back to.
  const pickFmSource = useCallback((next: FmSelection) => {
    const retryId = fmAvailabilityKey(next);
    const retry = unavailableFmStations.has(retryId);
    if (next === fmSource && !retry) return;
    if (retry) {
      setUnavailableFmStations(current => {
        const rest = new Set(current); rest.delete(retryId); return rest;
      });
    }
    setFmSource(next);
    setFmPlayRequest(count => count + 1);
  }, [fmSource, unavailableFmStations]);

  const markFmStationAvailability = useCallback((selection: FmSelection, unavailable: boolean) => {
    const id = fmAvailabilityKey(selection);
    setUnavailableFmStations(current => {
      const had = current.has(id);
      if (had === unavailable) return current;
      const next = new Set(current);
      if (unavailable) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  return { fmVolume, setFmVolume, fmMuted, setFmMuted, fmSource, customFmStations,
           unavailableFmStations, fmPlayRequest, addFmStation, renameFmStation,
           removeFmStation, pickFmSource, markFmStationAvailability };
}
