import type { Act, Facing } from "../claude-fm";
import type { Character } from "../character";
import FmSprite from "./FmSprite";
import FoxSprite from "./FoxSprite";
import PenguinSprite from "./PenguinSprite";

export default function CharacterSprite({ character, act, facing }: {
  character: Character; act: Act | null; facing: Facing;
}) {
  if (character === "penguin") return <PenguinSprite act={act} facing={facing} />;
  return character === "fox" ? <FoxSprite act={act} facing={facing} /> : <FmSprite act={act} facing={facing} />;
}
