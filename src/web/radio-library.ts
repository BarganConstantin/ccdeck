import { resolveRadioMetadata, parseFmStationUrl, type CustomFmStation } from "./fm-stations";

export interface RadioStation extends CustomFmStation {
  radio: NonNullable<CustomFmStation["radio"]>;
}
export const RADIO_FAVORITES_KEY = "agent-dag.radio-favorites";
export const RADIO_RECENT_KEY = "agent-dag.radio-recent";
export const RADIO_CACHE_KEY = "agent-dag.radio-catalogue";

export function resolveRadioStations(value: unknown): RadioStation[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 300).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    const name = typeof row.name === "string" ? row.name.trim().slice(0, 80) : "";
    const url = typeof row.url === "string" ? parseFmStationUrl(row.url) : null;
    const radio = resolveRadioMetadata(row.radio ?? row);
    if (!/^radio-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) || !name || !radio || !url || url.kind !== "direct-audio" || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name, url: url.url, radio }];
  });
}

export function readRadioIds(stored: string | null): string[] {
  try {
    const value: unknown = JSON.parse(stored ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(id)))].slice(0, 100) : [];
  } catch { return []; }
}

export function recentRadioIds(ids: readonly string[], id: string): string[] {
  return [id, ...ids.filter(item => item !== id)].slice(0, 50);
}

export function surpriseStation(stations: readonly RadioStation[], current: string | undefined, random = Math.random): RadioStation | null {
  const candidates = stations.filter(station => station.id !== current);
  return candidates.length ? candidates[Math.min(candidates.length - 1, Math.floor(Math.max(0, random()) * candidates.length))] : null;
}

export function dailyStation(stations: readonly RadioStation[], day: string): RadioStation | null {
  if (!stations.length) return null;
  const sorted = [...stations].sort((a, b) => a.id.localeCompare(b.id));
  let hash = 0;
  for (const char of day) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return sorted[hash % sorted.length];
}

export function matchesRadio(station: RadioStation, name: string, country: string, genre: string, language: string): boolean {
  return (!name || `${station.name} ${station.radio.country} ${station.radio.region} ${station.radio.tags}`.toLowerCase().includes(name.toLowerCase())) &&
    (!country || station.radio.countryCode === country) &&
    (!genre || station.radio.tags.toLowerCase().includes(genre.toLowerCase())) &&
    (!language || station.radio.language.toLowerCase().includes(language.toLowerCase()));
}
