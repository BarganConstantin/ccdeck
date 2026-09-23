import { readStored } from "./storage";
import { levelFrom } from "./sound";

export const CHARACTER_ENABLED_KEY = "agent-dag.character-enabled";
export const FM_VOLUME_KEY = "agent-dag.fm-volume";
export const FM_SOURCE_KEY = "agent-dag.fm-source";

export type FmSource = "claude-fm" | "lofi-relax" | "lofi-game" | "lofi-vibe" | "lofi-sleep" | "radio-mix" | "best-of-nostalgia" | "good-life-radio" | "cafe-music-bgm";

export interface FmSourceOption {
  group?: string;
  value: FmSource;
  label: string;
}

export const FM_SOURCE_OPTIONS: FmSourceOption[] = [
  { value: "claude-fm", label: "🎧 Claude FM" },
  { group: "📻 Lofi Girl", value: "lofi-relax", label: "📚 Relax / study" },
  { group: "📻 Lofi Girl", value: "lofi-game", label: "🎮 Chill / game" },
  { group: "📻 Lofi Girl", value: "lofi-vibe", label: "🌅 Vibe / chill" },
  { group: "📻 Lofi Girl", value: "lofi-sleep", label: "💤 Sleep / chill" },
  { group: "📻 Radio Mix", value: "radio-mix", label: "📡 Live radio mix" },
  { group: "📻 Best of Nostalgia", value: "best-of-nostalgia", label: "📼 Best of nostalgia live" },
  { group: "📻 The Good Life Radio", value: "good-life-radio", label: "🌴 The Good Life Radio" },
  { group: "☕ Cafe Music BGM", value: "cafe-music-bgm", label: "☕ Cafe music BGM" },
];

export function resolveFmSource(stored: string | null | undefined): FmSource {
  return stored === "lofi-relax" || stored === "lofi-game" || stored === "lofi-vibe" || stored === "lofi-sleep" || stored === "radio-mix" || stored === "best-of-nostalgia" || stored === "good-life-radio" || stored === "cafe-music-bgm"
    ? stored
    : "claude-fm";
}

export function storedFmSource(): FmSource {
  return resolveFmSource(readStored(FM_SOURCE_KEY));
}

export function resolveCharacterEnabled(stored: string | null | undefined): boolean {
  return stored !== "0";
}

export function storedCharacterEnabled(): boolean {
  return resolveCharacterEnabled(readStored(CHARACTER_ENABLED_KEY));
}

/**
 * How loud the live stream plays, as the slider's 0–100 level.
 *
 * Delegated to sound.ts's `levelFrom` rather than re-spelled here: the strict
 * parse, the snap-to-step and the collapse of anything missing or corrupt to
 * DEFAULT_LEVEL are decisions #711 already made and argued for, and a second
 * spelling of the same three rules is the drift this suite's source-reading
 * tests exist to catch. The delegation is also exact rather than approximate —
 * the player's `setVolume` takes a 0–100 integer, which is what a snapped,
 * clamped level already is.
 */
export function resolveFmVolume(stored: string | null | undefined): number {
  return levelFrom(stored);
}

export function storedFmVolume(): number {
  return resolveFmVolume(readStored(FM_VOLUME_KEY));
}
