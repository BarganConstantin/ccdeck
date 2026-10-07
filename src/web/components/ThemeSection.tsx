// Settings › General: the colour theme, as two pictures of the deck.
//
// Lifted out of the Appearance modal unchanged when that modal became the
// General section of Settings. T still switches the theme from anywhere on the
// deck, and from inside Settings too (SettingsModal.tsx answers it there).
import type { KeyboardEvent } from "react";
import type { Theme } from "../theme";

export const THEMES: Theme[] = ["light", "dark"];
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
}

export default function ThemeSection({ theme, onTheme }: Props) {
  const moveTheme = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key))) return;
    event.preventDefault();
    const current = THEMES.indexOf(theme);
    const next = (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + THEMES.length) % THEMES.length;
    onTheme(THEMES[next]);
    (event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next])?.focus();
  };

  return (
    <section className="settings-group" aria-labelledby="appearance-theme-caption">
      <div className="settings-caption">
        <div>
          <h3 id="appearance-theme-caption">Color theme</h3>
          <p className="settings-caption-note">Choose how the dashboard looks.</p>
        </div>
        {/* The key App already answers anywhere on the deck. Shown where the
            choice is, the way Settings › Sounds shows M; named to assistive
            tech by aria-keyshortcuts on the group rather than by a stray
            letter. */}
        <kbd className="settings-key" aria-hidden title="Press T anywhere to switch themes">T</kbd>
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
  );
}
