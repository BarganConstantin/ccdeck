// Settings › Appearance: the character beside the minimap (ClaudeFm.tsx) —
// whether it is there, and which one.
//
// The switch sat in the group's heading, named by the heading alone, which
// made it the one control in Settings with no row and no line saying what it
// governs. It is a row in the shared shape now (SettingsParts.tsx, #2176), and
// the three characters stand under its list, as the theme previews stand under
// their caption: each is a framed choice of its own, and inside the list they
// were a box in a box.
import CharacterPicker from "./CharacterPicker";
import type { Character } from "../character";
import { SettingRow, SettingsGroup } from "./SettingsParts";

export const CHARACTER_NOTE = "Stands beside the minimap. Press it to play the radio.";

export default function CharacterSection({ characterEnabled, onToggleCharacter, character = "deck", onCharacter }: {
  characterEnabled: boolean; onToggleCharacter: () => void;
  character: Character; onCharacter: (character: Character) => void;
}) {
  return (
    <SettingsGroup id="appearance-character-caption" title="Character" list={false}>
      <div className="settings-list">
        <SettingRow
          settingId="character"
          name="Show the character"
          nameId="appearance-character-label"
          note={CHARACTER_NOTE}
          noteId="appearance-character-note"
          control={
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
          }
        />
      </div>
      <CharacterPicker character={character} onCharacter={onCharacter} />
    </SettingsGroup>
  );
}
