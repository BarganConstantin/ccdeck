import type { FmSource } from "./appearance";

export const FM_CUSTOM_STATIONS_KEY = "agent-dag.fm-custom-stations";
export const FM_MUTED_KEY = "agent-dag.fm-muted";
export const CUSTOM_FM_PREFIX = "custom:";

export interface CustomFmStation {
  id: string;
  name: string;
  url: string;
}

export type FmSelection = FmSource | `${typeof CUSTOM_FM_PREFIX}${string}`;

export type ParsedFmStationUrl =
  | { kind: "youtube-channel"; url: string; channel: string }
  | { kind: "youtube-handle"; url: string; handle: string }
  | { kind: "youtube-video"; url: string; video: string }
  | { kind: "direct-audio"; url: string; format: "audio" | "hls" };

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const AUDIO_EXT = /\.(mp3|aac|ogg)$/i;
const HLS_EXT = /\.m3u8$/i;
/** Longer than any stream link a radio portal hands out, and short enough that
 *  the stored list cannot grow into a meaningful share of localStorage. */
export const STATION_URL_MAX = 2048;
export const STATION_NAME_MAX = 80;

export function customFmSelection(id: string): FmSelection {
  return `${CUSTOM_FM_PREFIX}${id}`;
}

export function customFmId(selection: string): string | null {
  if (!selection.startsWith(CUSTOM_FM_PREFIX)) return null;
  const id = selection.slice(CUSTOM_FM_PREFIX.length);
  return ID.test(id) ? id : null;
}

/** The key a station's availability is kept under: a custom station's id, or
 *  a built-in station's own value. The two cannot collide, since a custom
 *  selection always carries its prefix. */
export function fmAvailabilityKey(selection: string): string {
  return customFmId(selection) ?? selection;
}

/** What the menu says under the picker when the chosen station cannot play,
 *  so silence is never left to explain itself. */
export function fmUnavailableNote(custom: boolean): string {
  return custom
    ? "This station could not be played. Check its link, pick another, or pick it again to retry."
    : "This station is not live right now. Pick another, or pick it again later to retry.";
}

export function parseFmStationUrl(value: string): ParsedFmStationUrl | null {
  const text = value.trim();
  if (text.length > STATION_URL_MAX) return null;
  let parsed: URL;
  try { parsed = new URL(text); } catch { return null; }
  if (parsed.protocol !== "https:") return null;
  // A login in the link would be stored in plain text on this machine, and a
  // browser refuses to send one on a media request anyway, so a station built
  // on it could only ever show as unavailable.
  if (parsed.username || parsed.password) return null;

  const url = parsed.toString();
  const host = parsed.hostname.toLowerCase();
  const youtube = host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com";
  if (youtube) {
    // The same rule the server's resolver keeps (src/server/fm-station.mjs): a
    // port on a YouTube link is not something anybody copied out of YouTube.
    if (parsed.port) return null;
    const channel = /^\/channel\/([^/]+)(?:\/live)?\/?$/.exec(parsed.pathname)?.[1];
    if (channel && CHANNEL_ID.test(channel)) return { kind: "youtube-channel", url, channel };

    const handle = /^\/@([^/]+)\/live\/?$/.exec(parsed.pathname)?.[1];
    if (handle && /^[A-Za-z0-9._-]{1,64}$/.test(handle)) return { kind: "youtube-handle", url, handle };

    if (parsed.pathname === "/watch") {
      const video = parsed.searchParams.get("v") ?? "";
      if (VIDEO_ID.test(video)) return { kind: "youtube-video", url, video };
    }
    return null;
  }

  if (HLS_EXT.test(parsed.pathname)) return { kind: "direct-audio", url, format: "hls" };
  if (AUDIO_EXT.test(parsed.pathname)) return { kind: "direct-audio", url, format: "audio" };
  return null;
}

export function resolveFmMuted(stored: string | null | undefined): boolean {
  return stored === "1";
}

export function resolveCustomFmStations(stored: string | null | undefined): CustomFmStation[] {
  if (!stored) return [];
  let value: unknown;
  try { value = JSON.parse(stored); } catch { return []; }
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const stations: CustomFmStation[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const id = typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : "";
    const name = typeof (item as { name?: unknown }).name === "string" ? (item as { name: string }).name.trim() : "";
    const url = typeof (item as { url?: unknown }).url === "string" ? (item as { url: string }).url.trim() : "";
    const parsed = parseFmStationUrl(url);
    if (!ID.test(id) || seen.has(id) || !name || name.length > STATION_NAME_MAX || !parsed) continue;
    seen.add(id);
    stations.push({ id, name, url: parsed.url });
  }
  return stations;
}

export function resolveFmSelection(
  stored: string | null | undefined,
  customStations: readonly CustomFmStation[],
  builtIn: (value: string | null | undefined) => FmSource,
): FmSelection {
  const id = customFmId(stored ?? "");
  if (id && customStations.some(station => station.id === id)) return customFmSelection(id);
  return builtIn(stored);
}

export function selectionAfterRemovingStation(selection: FmSelection, removedId: string): FmSelection {
  return selection === customFmSelection(removedId) ? "claude-fm" : selection;
}

/** A new station's id. `crypto.randomUUID` exists only in a secure context, and
 *  a deck reached over the LAN is plain http — the same fallback presence.ts
 *  uses, in the alphabet `ID` accepts. */
function newStationId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* not a secure context */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newCustomFmStation(name: string, url: string, id = newStationId()): CustomFmStation | null {
  const cleanName = name.trim();
  const parsed = parseFmStationUrl(url);
  if (!cleanName || cleanName.length > STATION_NAME_MAX || !ID.test(id) || !parsed) return null;
  return { id, name: cleanName, url: parsed.url };
}
