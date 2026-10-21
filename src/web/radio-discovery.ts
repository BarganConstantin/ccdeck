import { FM_SOURCE_OPTIONS } from "./appearance";
import { customFmSelection, parseFmStationUrl, type CustomFmStation, type FmSelection } from "./fm-stations";
import type { RadioIconName } from "./components/RadioIcon";

export type RadioCollection = "discover" | "favorites" | "recent";
export interface RadioFilters { country: string; genre: string; language: string }
export interface WorkspaceStream { id: string; selection: FmSelection; name: string; metadata: string; icon: RadioIconName }
const icons: Partial<Record<FmSelection, RadioIconName>> = {
  "claude-fm": "headphones", "lofi-relax": "book", "lofi-game": "gamepad",
  "lofi-vibe": "sunset", "lofi-sleep": "moon", "radio-mix": "radio", "good-life-radio": "palm",
};
const cleanLabel = (label: string) => label.replace(/^[^\p{L}\p{N}]+/u, "");

export function workspaceStreams(custom: readonly CustomFmStation[]): WorkspaceStream[] {
  return [
    ...FM_SOURCE_OPTIONS.map(source => ({ id: source.value, selection: source.value,
      name: `${source.group?.includes("Lofi Girl") ? "Lofi Girl · " : ""}${cleanLabel(source.label)}`,
      metadata: "Global · YouTube", icon: icons[source.value] ?? "radio" })),
    ...custom.filter(station => !station.radio).map(station => ({ id: station.id, selection: customFmSelection(station.id),
      name: station.name, metadata: parseFmStationUrl(station.url)?.kind === "direct-audio" ? "Global · Custom stream" : "Global · YouTube", icon: "radio" as const })),
  ];
}

/** Unknown metadata never satisfies a directory filter. Global is a local source scope. */
export function filterWorkspaceStreams(streams: readonly WorkspaceStream[], query: string, filters: RadioFilters, collection: RadioCollection, ids: readonly string[]): WorkspaceStream[] {
  if ((filters.country && filters.country !== "GLOBAL") || filters.genre || filters.language) return [];
  const rows = streams.filter(stream => `${stream.name} ${stream.metadata}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  if (collection === "discover") return rows;
  const pool = new Map(rows.map(stream => [stream.id, stream]));
  return ids.flatMap(id => pool.get(id) ?? []);
}

export function discoverySummary(stationCount: number, streamCount: number): string {
  const parts = [];
  if (streamCount) parts.push(`${streamCount} workspace ${streamCount === 1 ? "stream" : "streams"}`);
  if (stationCount) parts.push(`${stationCount} radio ${stationCount === 1 ? "station" : "stations"}`);
  return parts.join(" · ") || "No matching results";
}
