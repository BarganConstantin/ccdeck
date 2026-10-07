// Settings › Music & character: Claude FM's station, its volume and its mute,
// and the minimap character the music plays through.
//
// Lifted out of the Appearance modal when that became the General section of
// Settings. The character had been filed under "Music source"; it is its own
// group here, with the sentence that ties the two together on screen — the
// music plays through the character, so hiding it stops the music.
import { type FocusEvent, type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import VolumeRow from "./VolumeRow";
import { FM_SOURCE_OPTIONS } from "../appearance";
import {
  STATION_NAME_MAX, STATION_URL_MAX, customFmId, customFmSelection, fmUnavailableNote, newCustomFmStation,
  type CustomFmStation, type FmSelection,
} from "../fm-stations";
import { isEscapeKey } from "../modal-dismiss";

const FM_SOURCES = FM_SOURCE_OPTIONS;
const NAME_MISSING = "Give the station a name.";
const LINK_UNUSABLE = "Use an https YouTube live or channel link, or a .mp3, .aac, .ogg or .m3u8 stream.";

export interface MusicProps {
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
}

export default function MusicSection({
  characterEnabled, onToggleCharacter, fmVolume, onFmVolume, fmMuted, onFmMuted,
  fmSource, onFmSource, customFmStations, unavailableFmStations,
  onAddFmStation, onRenameFmStation, onRemoveFmStation,
}: MusicProps) {
  const fmSources = [
    ...FM_SOURCES.map(source => ({
      ...source,
      label: unavailableFmStations.has(source.value) ? `${source.label} · not live` : source.label,
      unavailable: unavailableFmStations.has(source.value),
    })),
    ...customFmStations.map(station => ({
      group: "🎵 Your stations",
      value: customFmSelection(station.id),
      label: unavailableFmStations.has(station.id) ? `${station.name} · unavailable` : station.name,
      unavailable: unavailableFmStations.has(station.id),
    })),
  ];
  const chosenUnavailable = fmSources.some(source => source.value === fmSource && source.unavailable);
  // The list as the runs it is drawn in — Claude FM on its own, then each
  // group's options together — so a group can be a real role="group" named by
  // its header. The options keep their flat index: it is what their ids, the
  // highlight and aria-activedescendant are all keyed on.
  const sourceRuns: { group?: string; indexes: number[] }[] = [];
  fmSources.forEach((source, index) => {
    const last = sourceRuns[sourceRuns.length - 1];
    if (last && last.group === source.group) last.indexes.push(index);
    else sourceRuns.push({ group: source.group, indexes: [index] });
  });
  const [sourceOpen, setSourceOpen] = useState(false);
  const [highlightedSource, setHighlightedSource] = useState(() => Math.max(0, fmSources.findIndex(source => source.value === fmSource)));
  const [addingStation, setAddingStation] = useState(false);
  const [stationName, setStationName] = useState("");
  const [stationUrl, setStationUrl] = useState("");
  const [stationError, setStationError] = useState("");
  const [renamingStation, setRenamingStation] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const sourceTriggerRef = useRef<HTMLButtonElement>(null);
  const stationNameRef = useRef<HTMLInputElement>(null);
  const stationUrlRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
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

  // FOCUS LEAVING THE PICKER CLOSES ITS LIST, the way a press outside it does
  // above. A blur with nowhere to go — no relatedTarget — is a press on the
  // list itself or the window losing focus, and neither is leaving.
  const closeOnLeave = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && !event.currentTarget.contains(next)) setSourceOpen(false);
  };

  // AN UNAVAILABLE STATION IS CHOSEN LIKE ANY OTHER, and choosing it is the
  // retry: App clears the mark and starts it again. Refusing it left a station
  // that failed once stuck for the session — it could not be picked, and
  // Rename and Remove act on the picked station, so it could not be renamed or
  // removed either.
  const chooseSource = (index: number) => {
    const source = fmSources[index];
    if (!source) return;
    setHighlightedSource(index);
    onFmSource(source.value);
    setSourceOpen(false);
    sourceTriggerRef.current?.focus();
  };

  const moveSource = (event: KeyboardEvent<HTMLButtonElement>) => {
    // ESCAPE IS THE LIST'S ONLY WHILE THERE IS A LIST. The dialog answers
    // Escape from App's listener on window, so stopping it here stops it
    // reaching the dialog at all — and focus comes back to this trigger after
    // every pick, add, rename and remove, so a closed picker swallowing it
    // made "Close (Esc)" dead in the place focus most often is.
    if (isEscapeKey(event.key)) {
      if (!sourceOpen) return;
      event.preventDefault();
      event.stopPropagation();
      setSourceOpen(false);
      return;
    }
    // Tab leaves with the list closed rather than into it. The list scrolls,
    // so the dialog's trap and the browser both count it as a stop of its own,
    // and focus parked there has no options it can move between.
    if (event.key === "Tab") {
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

  // FOCUS GOES BACK TO THE STATION PICKER after every step that takes the
  // focused control away — the form's own submit button on Add, Remove on
  // Remove, Save and Cancel on a rename. Left alone, focus fell to <body>
  // behind the modal, and the picker is where the result of each step reads:
  // the station just added, the name just saved, Claude FM after a removal.
  const backToPicker = () => sourceTriggerRef.current?.focus();

  const addStation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Each refusal puts focus in the field it is about. The message is read out
    // as an alert, and the field is where the fix is typed — left on Add, the
    // keyboard had to go and find it.
    if (!stationName.trim()) {
      setStationError(NAME_MISSING);
      stationNameRef.current?.focus();
      return;
    }
    const station = newCustomFmStation(stationName, stationUrl);
    if (!station) {
      setStationError(LINK_UNUSABLE);
      stationUrlRef.current?.focus();
      return;
    }
    onAddFmStation(station);
    onFmSource(customFmSelection(station.id));
    setStationName("");
    setStationUrl("");
    setStationError("");
    setAddingStation(false);
    backToPicker();
  };

  // A blank name is said, not ignored: Save on an empty field used to do
  // nothing at all, which reads as a dead button. It gets the add form's own
  // sentence, and focus stays in the field.
  const saveRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeCustomId) return;
    if (!renameValue.trim()) {
      setRenameError(NAME_MISSING);
      renameInputRef.current?.focus();
      return;
    }
    onRenameFmStation(activeCustomId, renameValue);
    setRenamingStation(false);
    backToPicker();
  };

  const sourceOption = (index: number) => {
    const source = fmSources[index];
    const unavailable = "unavailable" in source && source.unavailable;
    return (
      <div
        key={source.value}
        className="appearance-source-option"
        role="option"
        id={`appearance-fm-option-${index}`}
        aria-selected={fmSource === source.value}
        data-highlighted={highlightedSource === index || undefined}
        data-unavailable={unavailable || undefined}
        onMouseEnter={() => setHighlightedSource(index)}
        onClick={() => chooseSource(index)}
      >
        <span>{source.label}</span>
        {fmSource === source.value && <span aria-hidden>✓</span>}
      </div>
    );
  };

  return (
    <>
      <section className="settings-group" aria-labelledby="appearance-fm-caption">
        <div className="settings-caption">
          <div>
            <h3 id="appearance-fm-caption">Claude FM</h3>
            <p className="settings-caption-note">Music for the character to play while you work.</p>
          </div>
        </div>
        <div className="appearance-controls">
          <div className="appearance-source-row">
            <label htmlFor="appearance-fm-source">Station</label>
            <div className={`appearance-source-picker${sourceOpen ? " is-open" : ""}`} onBlur={closeOnLeave}>
            <button
              ref={sourceTriggerRef}
              type="button"
              id="appearance-fm-source"
              className="appearance-source-trigger"
              role="combobox"
              aria-haspopup="listbox"
              aria-expanded={sourceOpen}
              aria-controls={sourceOpen ? "appearance-fm-source-list" : undefined}
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
                {/* A group is a role="group" named by its header, the APG's
                    grouped listbox: the header alone, as a presentation row,
                    was a word a screen reader never tied to what is under it. */}
                {sourceRuns.map((run, runIndex) => run.group ? (
                  <div key={`group-${runIndex}`} role="group" aria-labelledby={`appearance-fm-group-${runIndex}`}>
                    <div id={`appearance-fm-group-${runIndex}`} className="appearance-source-group" role="presentation">{run.group}</div>
                    {run.indexes.map(sourceOption)}
                  </div>
                ) : run.indexes.map(sourceOption))}
              </div>
            )}
            </div>
          </div>
          <span id="appearance-fm-source-note" className="vis-hidden">
            Changing station starts live playback automatically.
          </span>
          {/* Mounted whether or not there is anything to say, so the words are
              announced when they arrive (#372). */}
          <p className="appearance-fm-status" role="status">
            {chosenUnavailable ? fmUnavailableNote(customFmId(fmSource) !== null) : ""}
          </p>
          {/* Custom stations are rows in the list above, not a second picker:
              these only add one, and rename or remove the one that is chosen.
              The deck's own buttons and the accounts panel's text field, both
              already swept for edge contrast, focus ring and press. */}
          <div className="appearance-station-manage">
            <button type="button" className="btn appearance-station-action" aria-expanded={addingStation} onClick={() => { setAddingStation(open => !open); setStationError(""); }}>
              {addingStation ? "Cancel" : "+ Add station"}
            </button>
            {activeCustomStation && !renamingStation && (
              <span className="appearance-station-edit">
                <button type="button" className="btn appearance-station-action" onClick={() => { setRenameValue(activeCustomStation.name); setRenameError(""); setRenamingStation(true); }}>Rename</button>
                <button type="button" className="btn danger appearance-station-action" onClick={() => { onRemoveFmStation(activeCustomStation.id); backToPicker(); }}>Remove</button>
              </span>
            )}
          </div>
          {/* Each field is named by words that stay on screen. The name field
              used to carry its name as a placeholder, which is gone the moment
              anything is typed — so a half-filled form no longer said which
              box was which. A <label> round each one names it to a reader too,
              so no field needs an aria-label of its own. */}
          {addingStation && (
            <form className="appearance-station-form" onSubmit={addStation} noValidate>
              <label className="appearance-station-field">
                <span>Station name</span>
                <input
                  ref={stationNameRef}
                  className="ap-manage-input"
                  value={stationName}
                  onChange={event => setStationName(event.target.value)}
                  aria-invalid={stationError === NAME_MISSING || undefined}
                  aria-describedby={stationError === NAME_MISSING ? "appearance-station-error" : undefined}
                  maxLength={STATION_NAME_MAX}
                  autoFocus
                />
              </label>
              <label className="appearance-station-field">
                <span>Link</span>
                <input
                  ref={stationUrlRef}
                  className="ap-manage-input"
                  value={stationUrl}
                  onChange={event => setStationUrl(event.target.value)}
                  placeholder="https://…"
                  aria-invalid={(stationError !== "" && stationError !== NAME_MISSING) || undefined}
                  aria-describedby={stationError && stationError !== NAME_MISSING ? "appearance-station-error" : undefined}
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={STATION_URL_MAX}
                />
              </label>
              <button type="submit" className="btn primary">Add</button>
              {/* After the button, so the grid keeps Add beside the link and the
                  message takes a row of its own under both. */}
              {stationError && <p id="appearance-station-error" className="appearance-station-error" role="alert">{stationError}</p>}
            </form>
          )}
          {activeCustomStation && renamingStation && (
            <form className="appearance-station-form is-rename" onSubmit={saveRename} noValidate>
              <label className="appearance-station-field">
                <span>Station name</span>
                <input
                  ref={renameInputRef}
                  className="ap-manage-input"
                  value={renameValue}
                  onChange={event => setRenameValue(event.target.value)}
                  aria-invalid={renameError !== "" || undefined}
                  aria-describedby={renameError ? "appearance-rename-error" : undefined}
                  maxLength={STATION_NAME_MAX}
                  autoFocus
                />
              </label>
              <button type="submit" className="btn primary">Save</button>
              <button type="button" className="btn" onClick={() => { setRenamingStation(false); backToPicker(); }}>Cancel</button>
              {renameError && <p id="appearance-rename-error" className="appearance-station-error" role="alert">{renameError}</p>}
            </form>
          )}
          {/* The sound section's own volume row, borrowed rather than
              respelled: VolumeRow is what each tone's section draws, and the
              range in it stays native for the reasons that file argues. */}
          <VolumeRow
            id="appearance-fm-volume"
            value={fmVolume}
            aria-describedby="appearance-fm-volume-note"
            onLevel={onFmVolume}
          />
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

      {/* THE CHARACTER, IN ITS OWN GROUP. It was a row under "Music source",
          where it read as a music setting; it is the thing the music plays
          through, which is what its note now says on screen rather than only
          to a reader. Under the hairline every second subject in a Settings
          section stands under, and unboxed, as Claude FM's controls are.
          THE WHOLE ROW IS THE TARGET, and still one control. A <label> hands a
          press anywhere in it to the switch exactly once — a press on the
          switch itself is the switch's own and the label does not repeat it —
          so there is one tab stop and no second toggle. */}
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
      </section>
    </>
  );
}
