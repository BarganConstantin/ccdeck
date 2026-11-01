import { t } from "./i18n";
import { readStored } from "./storage";

export const CHARACTER_KEY = "agent-dag.character";
export type Character = "deck" | "fox" | "penguin";
export const CHARACTERS: readonly { id: Character; name: string }[] = [
  { id: "deck", get name() { return t("settings.character.name.deck"); } },
  { id: "fox", get name() { return t("settings.character.name.fox"); } },
  { id: "penguin", get name() { return t("settings.character.name.penguin"); } },
];

export function resolveCharacter(value: string | null | undefined): Character {
  return value === "fox" || value === "penguin" ? value : "deck";
}

export function storedCharacter(): Character {
  return resolveCharacter(readStored(CHARACTER_KEY));
}
