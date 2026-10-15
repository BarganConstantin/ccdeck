import CharacterPicker from "./CharacterPicker";
import type { Character } from "../character";

export default function CharacterSection({ characterEnabled, onToggleCharacter, character = "deck", onCharacter }: {
  characterEnabled: boolean; onToggleCharacter: () => void;
  character: Character; onCharacter: (character: Character) => void;
}) {
  return (
    <section className="settings-group" aria-labelledby="appearance-character-caption">
      <div className="settings-caption">
        <h3 id="appearance-character-caption">Character</h3>
        <button
          type="button"
          className="switch"
          role="switch"
          aria-checked={characterEnabled}
          aria-labelledby="appearance-character-caption"
          onClick={onToggleCharacter}
        >
          <span className="switch-knob" />
        </button>
      </div>
      <CharacterPicker character={character} onCharacter={onCharacter} />
    </section>
  );
}
