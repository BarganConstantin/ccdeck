import { readStored } from "./storage";

export const CHARACTER_KEY = "agent-dag.character";
export type Character = "deck" | "fox" | "penguin";
export const CHARACTERS: readonly { id: Character; name: string }[] = [
  { id: "deck", name: "Deck companion" },
  { id: "fox", name: "Fox" },
  { id: "penguin", name: "Penguin" },
];

export function resolveCharacter(value: string | null | undefined): Character {
  return value === "fox" || value === "penguin" ? value : "deck";
}

export function storedCharacter(): Character {
  return resolveCharacter(readStored(CHARACTER_KEY));
}
