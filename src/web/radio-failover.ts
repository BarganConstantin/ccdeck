import { nextAvailableRadioStation, type RadioStation } from "./radio-library";

/** Allow a moment to read the failure; cancel if playback or selection changes. */
export function scheduleRadioFailover(stations: readonly RadioStation[], current: string, failed: Set<string>, pick: (station: RadioStation) => void): () => void {
  const next = nextAvailableRadioStation(stations, current, failed);
  if (!next) return () => {};
  const timer = setTimeout(() => {
    failed.add(current);
    pick(next);
  }, 1000);
  return () => clearTimeout(timer);
}
