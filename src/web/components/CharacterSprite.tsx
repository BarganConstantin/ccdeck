import type { Act, Facing } from "../claude-fm";
import type { Character } from "../character";
import FmSprite from "./FmSprite";
import FoxSprite from "./FoxSprite";

export default function CharacterSprite({ character, act, facing }: {
  character: Character; act: Act | null; facing: Facing;
}) {
  return character === "fox" ? <FoxSprite act={act} facing={facing} /> : <FmSprite act={act} facing={facing} />;
}
