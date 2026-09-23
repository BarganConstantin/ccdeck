import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import type { Theme } from "../theme";
import { LEVEL_MAX, LEVEL_MIN, LEVEL_STEP } from "../sound";
import { useModalDismiss } from "./use-modal-dismiss";
import { resolveFmSource, type FmSource } from "../appearance";

const THEMES: Theme[] = ["light", "dark"];
const THEME_NAME: Record<Theme, string> = { light: "Light", dark: "Dark" };

/**
 * The deck at a distance, in one theme's own colours: the top bar, the
 * accounts column, a session on the canvas and a floating panel with its quota
 * bar — the four shapes that say "ccdeck" before a word is read, and the only
 * accent is the bar, where the deck puts it too. Nothing that reads as text.
 * Drawn rather than screenshotted, like guide-art.tsx, so it cannot go stale
 * or show anybody's addresses.
 *
 * The palette is the swatch's and not the page's: a Light preview has to be
 * light while the page is dark, so `data-swatch` scopes the theme's values
 * onto it, and appearance-swatch.test.ts holds them to the tokens they copy.
 */
function ThemePreview({ theme }: { theme: Theme }) {
  return (
    <span className="appearance-preview" data-swatch={theme}>
      <svg viewBox="0 0 112 56" aria-hidden focusable="false">
        <rect className="tp-canvas" width="112" height="56" />
        <rect className="tp-surface" width="112" height="7" />
        <rect className="tp-rule" y="7" width="112" height="1" />
        <rect className="tp-surface" y="8" width="25" height="48" />
        <rect className="tp-rule" x="25" y="8" width="1" height="48" />
        <rect className="tp-card" x="36.5" y="27.5" width="28" height="14" rx="2.5" />
        <rect className="tp-tag" x="39.5" y="25.5" width="13" height="4" rx="2" />
        <rect className="tp-card" x="76.5" y="14.5" width="29" height="20" rx="2.5" />
        <rect className="tp-rule" x="81" y="23" width="20" height="2" rx="1" />
        <rect className="tp-accent" x="81" y="23" width="12" height="2" rx="1" />
      </svg>
    </span>
  );
}

interface Props {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  characterEnabled: boolean;
  onToggleCharacter: () => void;
  /** The stream's loudness, as the slider's own 0–100 level. */
  fmVolume: number;
  onFmVolume: (level: number) => void;
  fmSource: FmSource;
  onFmSource: (source: FmSource) => void;
  onClose: () => void;
  openerRef: RefObject<HTMLElement | null>;
}

export default function AppearanceMenu({
  theme, onTheme, characterEnabled, onToggleCharacter, fmVolume, onFmVolume, fmSource, onFmSource, onClose, openerRef,
}: Props) {
  // A popover: the canvas stays in view around it, so its letters stay live.
  const dialogRef = useModalDismiss<HTMLDivElement>(onClose, { popover: true });
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

  // THE MENU'S OWN KEYS, answered here and stopped here.
  // Space belongs to the control it is pressed on. React Flow reads Space on
  // the document as its pan key and cancels it wherever focus is, so a Space on
  // the switch or a theme never pressed it; stopped at this edge, the way
  // AnchoredPopover stops its keys, it reaches the control.
  // T is the key the caption advertises. App answers it anywhere on the deck,
  // but not in here — a focused control keeps its letters and an open popover
  // holds the shortcuts — so the hint would have named a dead key in the one
  // place it is shown. Stopped after, so a pointer-focused control that hands
  // letters back to App (#851) cannot switch it twice.
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === " ") { event.stopPropagation(); return; }
    if ((event.key !== "t" && event.key !== "T") || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    const next: Theme = theme === "dark" ? "light" : "dark";
    onTheme(next);
    if ((event.target as Element).getAttribute("role") === "radio") {
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[THEMES.indexOf(next)]?.focus();
    }
  };

  return (
    <div
      ref={dialogRef}
      id="appearance-menu"
      className="appearance-menu"
      role="dialog"
      aria-labelledby="appearance-title"
      onKeyDown={onMenuKey}
    >
      {/* Built like the deck's own panels — Usage, This machine: a title over a
          hairline, then sections under uppercase captions — so it reads as part
          of this app rather than a settings form any app could have. */}
      <div className="appearance-head">
        <h2 id="appearance-title" className="appearance-title">Appearance</h2>
      </div>

      <section className="appearance-section" aria-labelledby="appearance-theme-caption">
        <div className="appearance-caption">
          <h3 id="appearance-theme-caption">Color theme</h3>
          {/* The key App already answers anywhere on the deck. Shown where the
              choice is, the way the sound menu shows M; named to assistive tech
              by aria-keyshortcuts on the group rather than by a stray letter. */}
          <kbd className="appearance-key" aria-hidden title="Press T anywhere to switch themes">T</kbd>
        </div>
        {/* One tab stop, on the theme that is set — the radio pattern. The
            arrows walk the pair and switch as they go, as a click does. The
            preview is aria-hidden: the name is the word under it. */}
        <div
          className="appearance-themes"
          role="radiogroup"
          aria-labelledby="appearance-theme-caption"
          aria-keyshortcuts="T"
          onKeyDown={moveTheme}
        >
          {THEMES.map(choice => (
            <button
              key={choice}
              type="button"
              className="appearance-theme"
              role="radio"
              aria-checked={theme === choice}
              tabIndex={theme === choice ? 0 : -1}
              onClick={() => onTheme(choice)}
            >
              <ThemePreview theme={choice} />
              <span className="appearance-theme-name">
                {THEME_NAME[choice]}
                <svg className="appearance-check" viewBox="0 0 12 12" aria-hidden focusable="false">
                  <path d="M2.5 6.4 4.9 8.7 9.5 3.6" />
                </svg>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="appearance-section" aria-labelledby="appearance-fm-caption">
        <div className="appearance-caption">
          <h3 id="appearance-fm-caption">Music source</h3>
        </div>
        <div className="appearance-source-row">
          <label htmlFor="appearance-fm-source">Station</label>
          <select
            id="appearance-fm-source"
            className="sm-select"
            value={fmSource}
            aria-describedby="appearance-fm-source-note"
            onChange={event => onFmSource(resolveFmSource(event.target.value))}
          >
            <option value="claude-fm">🎧 Claude FM</option>
            <optgroup label="📻 Lofi Girl">
              <option value="lofi-relax">📚 Relax / study</option>
              <option value="lofi-game">🎮 Chill / game</option>
              <option value="lofi-vibe">🌅 Vibe / chill</option>
              <option value="lofi-sleep">💤 Sleep / chill</option>
            </optgroup>
            <optgroup label="📻 Radio Mix">
              <option value="radio-mix">📡 Live radio mix</option>
            </optgroup>
          </select>
        </div>
        <span id="appearance-fm-source-note" className="vis-hidden">
          Changing station starts live playback automatically.
        </span>
        {/* THE WHOLE ROW IS THE TARGET, and still one control. A <label> hands a
            press anywhere in it to the switch exactly once — a press on the
            switch itself is the switch's own and the label does not repeat it —
            so there is one tab stop and no second toggle. The switch shares the
            label's line; the note hangs under both. Showing the character and
            playing the stream are two things, and the note says which is which. */}
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
          <span id="appearance-character-note" className="vis-hidden">
            Shows the animated minimap character and enables music playback.
          </span>
        </label>
        {/* The sound menu's own slider row, borrowed rather than respelled:
            .sm-row and .sm-read are already the sheet's shape for "a level
            with a reading", and the range stays native for the reasons
            SoundMenu.tsx argues. It lives OUTSIDE the theme radiogroup on
            purpose — the arrow keys that walk the themes are handled on that
            group's own onKeyDown, and a slider's arrows belong to the slider. */}
        <div className="sm-row">
          <label htmlFor="appearance-fm-volume">Volume</label>
          <input
            id="appearance-fm-volume"
            type="range"
            min={LEVEL_MIN}
            max={LEVEL_MAX}
            step={LEVEL_STEP}
            value={fmVolume}
            aria-describedby="appearance-fm-volume-note"
            onChange={e => onFmVolume(Number(e.target.value))}
            /* The filled half, read off the same render that sets `value` —
               the pattern SoundMenu.tsx's slider comments spell out. */
            style={{ "--sm-level": `${((fmVolume - LEVEL_MIN) / (LEVEL_MAX - LEVEL_MIN)) * 100}%` } as CSSProperties}
          />
          <span className="sm-read">{fmVolume}%</span>
        </div>
        <span id="appearance-fm-volume-note" className="vis-hidden">
          Controls live music volume.
        </span>
      </section>
    </div>
  );
}
