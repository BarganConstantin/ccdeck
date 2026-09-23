import { type CSSProperties, type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Theme } from "../theme";
import { LEVEL_MAX, LEVEL_MIN, LEVEL_STEP } from "../sound";
import { useModalDismiss } from "./use-modal-dismiss";
import { FM_SOURCE_OPTIONS } from "../appearance";
import {
  customFmId, customFmSelection, newCustomFmStation,
  type CustomFmStation, type FmSelection,
} from "../fm-stations";
import { isEscapeKey } from "../modal-dismiss";

const THEMES: Theme[] = ["light", "dark"];
const THEME_NAME: Record<Theme, string> = { light: "Light", dark: "Dark" };
const FM_SOURCES = FM_SOURCE_OPTIONS;

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
  fmMuted: boolean;
  onFmMuted: () => void;
  fmSource: FmSelection;
  onFmSource: (source: FmSelection) => void;
  customFmStations: CustomFmStation[];
  unavailableFmStations: Set<string>;
  onAddFmStation: (station: CustomFmStation) => void;
  onRenameFmStation: (id: string, name: string) => void;
  onRemoveFmStation: (id: string) => void;
  onClose: () => void;
}

export default function AppearanceMenu({
  theme, onTheme, characterEnabled, onToggleCharacter, fmVolume, onFmVolume, fmMuted, onFmMuted,
  fmSource, onFmSource, customFmStations, unavailableFmStations,
  onAddFmStation, onRenameFmStation, onRemoveFmStation, onClose,
}: Props) {
  const dialogRef = useModalDismiss<HTMLDivElement>(onClose);
  const fmSources = [
    ...FM_SOURCES,
    ...customFmStations.map(station => ({
      group: "🎵 Your stations",
      value: customFmSelection(station.id),
      label: unavailableFmStations.has(station.id) ? `${station.name} · unavailable` : station.name,
      unavailable: unavailableFmStations.has(station.id),
    })),
  ];
  const [sourceOpen, setSourceOpen] = useState(false);
  const [highlightedSource, setHighlightedSource] = useState(() => Math.max(0, fmSources.findIndex(source => source.value === fmSource)));
  const [addingStation, setAddingStation] = useState(false);
  const [stationName, setStationName] = useState("");
  const [stationUrl, setStationUrl] = useState("");
  const [stationError, setStationError] = useState("");
  const [renamingStation, setRenamingStation] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const sourceTriggerRef = useRef<HTMLButtonElement>(null);
  const sourceListRef = useRef<HTMLDivElement>(null);
  const activeCustomId = customFmId(fmSource);
  const activeCustomStation = activeCustomId ? customFmStations.find(station => station.id === activeCustomId) : undefined;

  useEffect(() => {
    const selectedIndex = fmSources.findIndex(source => source.value === fmSource);
    setHighlightedSource(selectedIndex < 0 ? 0 : selectedIndex);
  }, [fmSource, customFmStations, unavailableFmStations]);

  useEffect(() => {
    setRenamingStation(false);
    setRenameValue(activeCustomStation?.name ?? "");
  }, [activeCustomStation?.id, activeCustomStation?.name]);

  useEffect(() => {
    if (!sourceOpen) return;
    document.getElementById(`appearance-fm-option-${highlightedSource}`)?.scrollIntoView({ block: "nearest" });
  }, [highlightedSource, sourceOpen]);

  useEffect(() => {
    if (!sourceOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!sourceTriggerRef.current?.contains(target) && !sourceListRef.current?.contains(target)) {
        setSourceOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [sourceOpen]);

  const chooseSource = (index: number) => {
    const source = fmSources[index];
    if (!source || ("unavailable" in source && source.unavailable)) return;
    setHighlightedSource(index);
    onFmSource(source.value);
    setSourceOpen(false);
    sourceTriggerRef.current?.focus();
  };

  const moveSource = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (isEscapeKey(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      setSourceOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (sourceOpen) chooseSource(highlightedSource);
      else setSourceOpen(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    setSourceOpen(true);
    setHighlightedSource(current => {
      if (event.key === "Home") return 0;
      if (event.key === "End") return fmSources.length - 1;
      return Math.min(fmSources.length - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)));
    });
  };

  const addStation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const station = newCustomFmStation(stationName, stationUrl);
    if (!station) {
      setStationError("Use a name and an https YouTube live/channel link or .mp3, .aac, .ogg, or .m3u8 stream.");
      return;
    }
    onAddFmStation(station);
    onFmSource(customFmSelection(station.id));
    setStationName("");
    setStationUrl("");
    setStationError("");
    setAddingStation(false);
  };

  const saveRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeCustomId || !renameValue.trim()) return;
    onRenameFmStation(activeCustomId, renameValue);
    setRenamingStation(false);
  };

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

  return createPortal(
    (
    <div className="modal-backdrop appearance-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        id="appearance-menu"
        className="modal appearance-menu appearance-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="appearance-title"
        onClick={event => event.stopPropagation()}
        onKeyDown={onMenuKey}
      >
      <div className="appearance-head">
        <div className="appearance-heading">
          <h2 id="appearance-title" className="appearance-title">Appearance</h2>
          <p className="appearance-subtitle">Tune the deck to your workspace.</p>
        </div>
        <button
          type="button"
          className="glyph-btn appearance-close"
          onClick={onClose}
          aria-label="Close appearance settings"
          title="Close (Esc)"
        >×</button>
      </div>

      <section className="appearance-section" aria-labelledby="appearance-theme-caption">
        <div className="appearance-caption">
          <div>
            <h3 id="appearance-theme-caption">Color theme</h3>
            <p className="appearance-section-note">Choose how the dashboard looks.</p>
          </div>
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
        <div className="appearance-controls">
          <div className="appearance-source-row">
            <label htmlFor="appearance-fm-source">Station</label>
            <div className={`appearance-source-picker${sourceOpen ? " is-open" : ""}`}>
            <button
              ref={sourceTriggerRef}
              type="button"
              id="appearance-fm-source"
              className="appearance-source-trigger"
              role="combobox"
              aria-haspopup="listbox"
              aria-expanded={sourceOpen}
              aria-controls="appearance-fm-source-list"
              aria-activedescendant={sourceOpen ? `appearance-fm-option-${highlightedSource}` : undefined}
              aria-describedby="appearance-fm-source-note"
              onClick={() => setSourceOpen(open => !open)}
              onKeyDown={moveSource}
            >
              <span>{fmSources.find(source => source.value === fmSource)?.label ?? FM_SOURCES[0].label}</span>
              <svg viewBox="0 0 12 12" aria-hidden focusable="false"><path d="m2.5 4.5 3.5 3 3.5-3" /></svg>
            </button>
            {sourceOpen && (
              <div ref={sourceListRef} id="appearance-fm-source-list" className="appearance-source-list" role="listbox" aria-label="Music stations">
                {fmSources.map((source, index) => (
                  <div key={source.value}>
                    {source.group && (index === 0 || fmSources[index - 1].group !== source.group) && (
                      <div className="appearance-source-group" role="presentation">{source.group}</div>
                    )}
                    <div
                      className="appearance-source-option"
                      role="option"
                      id={`appearance-fm-option-${index}`}
                      aria-selected={fmSource === source.value}
                      aria-disabled={("unavailable" in source && source.unavailable) || undefined}
                      data-highlighted={highlightedSource === index || undefined}
                      onMouseEnter={() => setHighlightedSource(index)}
                      onClick={() => chooseSource(index)}
                    >
                      <span>{source.label}</span>
                      {fmSource === source.value && <span aria-hidden>✓</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            </div>
          </div>
          <span id="appearance-fm-source-note" className="vis-hidden">
            Choose a station, then press the minimap character to play it.
          </span>
          <div className="appearance-station-manage">
            <button type="button" className="appearance-station-button" onClick={() => { setAddingStation(open => !open); setStationError(""); }}>
              {addingStation ? "Cancel add" : "Add station"}
            </button>
            {activeCustomStation && !renamingStation && (
              <>
                <button type="button" className="appearance-station-button" onClick={() => { setRenameValue(activeCustomStation.name); setRenamingStation(true); }}>Rename</button>
                <button type="button" className="appearance-station-button" onClick={() => onRemoveFmStation(activeCustomStation.id)}>Remove</button>
              </>
            )}
          </div>
          {addingStation && (
            <form className="appearance-station-form" onSubmit={addStation}>
              <input value={stationName} onChange={event => setStationName(event.target.value)} placeholder="Station name" aria-label="Station name" maxLength={80} />
              <input value={stationUrl} onChange={event => setStationUrl(event.target.value)} placeholder="https://…" aria-label="Station URL" inputMode="url" />
              {stationError && <p className="appearance-station-error" role="alert">{stationError}</p>}
              <button type="submit" className="appearance-station-button is-primary">Add</button>
            </form>
          )}
          {activeCustomStation && renamingStation && (
            <form className="appearance-station-form is-rename" onSubmit={saveRename}>
              <input value={renameValue} onChange={event => setRenameValue(event.target.value)} aria-label="Rename station" maxLength={80} autoFocus />
              <button type="submit" className="appearance-station-button is-primary">Save</button>
              <button type="button" className="appearance-station-button" onClick={() => setRenamingStation(false)}>Cancel</button>
            </form>
          )}
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
          <label className="appearance-row">
            <span className="appearance-row-label" id="appearance-fm-mute-label">Mute music</span>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={fmMuted}
              aria-labelledby="appearance-fm-mute-label"
              onClick={onFmMuted}
            >
              <span className="switch-knob" />
            </button>
          </label>
        </div>
        <span id="appearance-fm-volume-note" className="vis-hidden">
          Controls live music volume.
        </span>
      </section>
      </div>
    </div>
    ),
    document.body,
  );
}
