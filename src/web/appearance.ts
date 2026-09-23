import { readStored } from "./storage";
import { levelFrom } from "./sound";

export const CHARACTER_ENABLED_KEY = "agent-dag.character-enabled";
export const FM_VOLUME_KEY = "agent-dag.fm-volume";

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
