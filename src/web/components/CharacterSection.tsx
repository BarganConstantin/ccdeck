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
      </div>
      <div className="appearance-controls">
        <label className="appearance-row">
          <span className="appearance-row-label" id="appearance-character-label">Show character on minimap</span>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={characterEnabled}
            aria-labelledby="appearance-character-label"
            aria-describedby="appearance-character-note"
            onClick={onToggleCharacter}
          >
            <span className="switch-knob" />
          </button>
          <span id="appearance-character-note" className="appearance-row-note">
            Claude FM plays through the character, so hiding it also stops the music.
          </span>
        </label>
      </div>
      <CharacterPicker character={character} onCharacter={onCharacter} />
    </section>
  );
}
