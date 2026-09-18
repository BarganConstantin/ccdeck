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
      <section aria-labelledby="appearance-theme-label">
        <h2 id="appearance-theme-label" className="appearance-label">Theme</h2>
        <div className="appearance-choices" role="radiogroup" aria-labelledby="appearance-theme-label" onKeyDown={moveTheme}>
          {THEMES.map(choice => (
            <button
              key={choice}
              type="button"
              className="appearance-choice"
              role="radio"
              aria-checked={theme === choice}
              onClick={() => onTheme(choice)}
            >
              {choice === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </section>
      <div className="appearance-divider" />
      <label className="appearance-switch">
        <span>
          <strong>Show character</strong>
          <small>Play scenes on the canvas</small>
        </span>
        <button
          type="button"
          className="switch"
          role="switch"
          aria-checked={characterEnabled}
          aria-label="Show character"
          onClick={onToggleCharacter}
        >
          <span className="switch-knob" />
        </button>
      </label>
    </div>
  );
}
