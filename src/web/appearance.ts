import { readStored } from "./storage";

export const CHARACTER_ENABLED_KEY = "agent-dag.character-enabled";

export function resolveCharacterEnabled(stored: string | null | undefined): boolean {
  return stored !== "0";
}

export function storedCharacterEnabled(): boolean {
  return resolveCharacterEnabled(readStored(CHARACTER_ENABLED_KEY));
}
