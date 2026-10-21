import { useCallback, useEffect, useState } from "react";
import { readStored, writeStored } from "./storage";
import { RADIO_CACHE_KEY, RADIO_FAVORITES_KEY, RADIO_RECENT_KEY, readRadioIds, recentRadioIds, resolveRadioStations, type RadioStation } from "./radio-library";

export function useRadioLibrary() {
  const [favorites, setFavorites] = useState(() => readRadioIds(readStored(RADIO_FAVORITES_KEY)));
  const [recent, setRecent] = useState(() => readRadioIds(readStored(RADIO_RECENT_KEY)));
  const [catalogue, setCatalogue] = useState<RadioStation[]>(() => {
    try { return resolveRadioStations(JSON.parse(readStored(RADIO_CACHE_KEY) ?? "[]")); } catch { return []; }
  });
  useEffect(() => { writeStored(RADIO_FAVORITES_KEY, JSON.stringify(favorites)); }, [favorites]);
  useEffect(() => { writeStored(RADIO_RECENT_KEY, JSON.stringify(recent)); }, [recent]);
  const remember = useCallback((id: string) => setRecent(ids => recentRadioIds(ids, id)), []);
  const toggleFavorite = useCallback((id: string) => setFavorites(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id].slice(-100)), []);
  const updateCatalogue = useCallback((stations: RadioStation[]) => {
    setCatalogue(stations);
    writeStored(RADIO_CACHE_KEY, JSON.stringify(stations));
  }, []);
  return { favorites, recent, catalogue, remember, toggleFavorite, updateCatalogue };
}
