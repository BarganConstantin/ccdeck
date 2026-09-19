import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import type { Theme } from "../theme";
import { useModalDismiss } from "./use-modal-dismiss";

const THEMES: Theme[] = ["light", "dark"];

interface Props {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  characterEnabled: boolean;
  onToggleCharacter: () => void;
  onClose: () => void;
  openerRef: RefObject<HTMLElement | null>;
}

export default function AppearanceMenu({
  theme, onTheme, characterEnabled, onToggleCharacter, onClose, openerRef,
}: Props) {
  const dialogRef = useModalDismiss<HTMLDivElement>(onClose);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || dialogRef.current?.contains(target) || openerRef.current?.contains(target)) return;
      closeRef.current();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [dialogRef, openerRef]);

  const moveTheme = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key))) return;
    event.preventDefault();
    const current = THEMES.indexOf(theme);
    const next = (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + THEMES.length) % THEMES.length;
    onTheme(THEMES[next]);
    (event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next])?.focus();
  };

  return (
    <div ref={dialogRef} id="appearance-menu" className="appearance-menu" role="dialog" aria-label="Appearance settings">
      {/* The heading names the whole menu, not the theme group: "Theme" sat over
          the character switch too, which is not a theme. The group keeps the
          word as its accessible name, where Light and Dark need no caption. */}
      <h2 className="appearance-title">Appearance</h2>
      {/* One tab stop, on the choice that is set — the radio pattern. The
          arrows already walk the pair, so Tab moves on to the switch, and the
          dismiss hook's mount focus lands on the current theme, not on Light. */}
      <div className="appearance-choices" role="radiogroup" aria-label="Theme" onKeyDown={moveTheme}>
        {THEMES.map(choice => (
          <button
            key={choice}
            type="button"
            className="appearance-choice"
            role="radio"
            aria-checked={theme === choice}
            tabIndex={theme === choice ? 0 : -1}
            onClick={() => onTheme(choice)}
          >
            {choice === "light" ? "Light" : "Dark"}
          </button>
        ))}
      </div>
      {/* The sound menu's row, not a second spelling of it: the switch sits on
          the label's line and the note hangs under both, so the two popovers in
          this bar draw a setting the same way. The name comes from the words on
          screen and the note is the description, rather than an aria-label
          nobody can check against what is shown. */}
      <div className="sm-setting">
        <label className="sm-switch">
          <span className="sm-switch-label" id="appearance-character-label">Character on canvas</span>
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
        </label>
        <p className="sm-note" id="appearance-character-note">Plays Claude FM from the minimap</p>
      </div>
    </div>
  );
}
