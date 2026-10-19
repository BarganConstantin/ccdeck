import { useRef, type KeyboardEvent } from "react";
import { CHARACTERS, type Character } from "../character";
import { tabStripMove } from "../tablist-keys";
import CharacterSprite from "./CharacterSprite";

export default function CharacterPicker({ character, onCharacter }: {
  character: Character; onCharacter: (character: Character) => void;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  function move(event: KeyboardEvent, index: number) {
    const target = tabStripMove(event, index, CHARACTERS.length, "vertical");
    if (target.kind !== "select") return;
    event.preventDefault();
    onCharacter(CHARACTERS[target.index].id);
    buttons.current[target.index]?.focus();
  }
  return <div className="character-picker" role="radiogroup" aria-label="Choose character" data-setting="character-choice">
    {CHARACTERS.map((choice, index) => <button key={choice.id} type="button"
      className="character-choice" role="radio" aria-checked={character === choice.id}
      tabIndex={character === choice.id ? 0 : -1}
      ref={node => { buttons.current[index] = node; }}
      onClick={() => onCharacter(choice.id)} onKeyDown={event => move(event, index)}>
      <span className="character-preview"><CharacterSprite character={choice.id} act={null} facing="right" /></span>
      <span>{choice.name}</span>
      <svg className="character-check" viewBox="0 0 16 16" aria-hidden focusable="false">
        <path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>)}
  </div>;
}
