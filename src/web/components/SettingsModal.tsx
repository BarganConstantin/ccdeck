// Settings: the deck's preferences in one dialog, a section at a time.
//
// The preferences used to live in two places of two different shapes — a
// popover under the speaker and a modal under a sliders button — and on a
// machine with no Claude Code the speaker is not drawn, so the notification
// switches inside its popover could not be reached at all. This is the one
// home familiar apps give them: a gear that is always on the bar, Cmd/Ctrl+,
// from anywhere, a nav down the side, and every control applying the moment it
// moves, with nothing to save.
//
// Built from the deck's own modal parts: the `.modal` shell over a
// `.modal-backdrop`, useModalDismiss for Escape, the Tab trap and the focus
// hand-back, useScrimDismiss for a press of the scrim. Mounted from
// DeckDialogs.tsx, the top of the tree, so no panel lays out its backdrop and
// no portal is needed (panel-modal-portal.test.ts). Each section is its own
// component, lifted whole out of the menu it used to live in; this file is
// only the frame and the nav.
import { useRef, type KeyboardEvent } from "react";
import type { Providers } from "../providers";
import { sectionIndex, SETTINGS_SECTIONS, type SettingsSection } from "../settings";
import { isTypingTarget } from "../shortcuts";
import { tabStripMove } from "../tablist-keys";
import type { useAppearance } from "../use-appearance";
import type { useClaudeFm } from "../use-claude-fm";
import type { useCustomTones } from "../use-custom-tones";
import type { useOsNotifications } from "../use-os-notifications";
import type { useSoundSwitch } from "../use-sound-switch";
import type { useTonePrefs } from "../use-tone-prefs";
import MusicSection from "./MusicSection";
import NotificationsSection from "./NotificationsSection";
import SoundsSection from "./SoundsSection";
import ThemeSection from "./ThemeSection";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";

export interface SettingsModalProps {
  /** The section on show; the nav and the door that opened this both set it. */
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
  providers: Providers;
  sound: ReturnType<typeof useSoundSwitch>;
  tones: ReturnType<typeof useTonePrefs>;
  customTones: ReturnType<typeof useCustomTones>;
  notify: ReturnType<typeof useOsNotifications>;
  appearance: ReturnType<typeof useAppearance>;
  fm: ReturnType<typeof useClaudeFm>;
}

export default function SettingsModal({
  section, onSection, onClose, providers, sound, tones, customTones, notify, appearance, fm,
}: SettingsModalProps) {
  // Focus starts on the section's own tab, not on the ×: the nav is what this
  // dialog is walked by, and a door that opened it at Sounds lands the reader
  // on "Sounds", which says where they are.
  const selectedTabRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: selectedTabRef });
  const scrimPress = useScrimDismiss(onClose);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = sectionIndex(section);

  const { theme, setTheme, characterEnabled, setCharacterEnabled } = appearance;

  const moveSection = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = tabStripMove(event, at, SETTINGS_SECTIONS.length, "vertical");
    if (move.kind === "pass") return;
    event.preventDefault();
    onSection(SETTINGS_SECTIONS[move.index].id);
    tabRefs.current[move.index]?.focus();
  };

  // THE DIALOG'S OWN KEYS, answered here and stopped here.
  // Space belongs to the control it is pressed on. React Flow reads Space on
  // the document as its pan key and cancels it wherever focus is, so a Space on
  // a switch never pressed it; stopped at this edge, the way AnchoredPopover
  // stops its keys, it reaches the control.
  // T is the key General's caption advertises. App answers it anywhere on the
  // deck, but not past an open dialog, so the hint would have named a dead key
  // in the one place it is shown. A field somebody is typing into keeps every
  // letter, and so does a <select>, whose letters pick an option.
  const onDialogKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === " ") { event.stopPropagation(); return; }
    const target = event.target as HTMLElement;
    if (isTypingTarget(target) || target.tagName === "SELECT") return;
    if ((event.key !== "t" && event.key !== "T") || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    if (target.getAttribute("role") === "radio") {
      event.currentTarget.querySelector<HTMLButtonElement>(`[role="radio"][aria-checked="false"]`)?.focus();
    }
  };

  const { soundOn, toggleSound } = sound;
  const { tonePrefs, previewTone, changeTone } = tones;
  const { customSelections, customAssets, clearCustomOnly, selectCustomTone, importNotificationAudio,
          createNotificationVoice, renameCustomAsset, deleteCustomAsset, previewCustomAsset } = customTones;
  const { notifyPermission, notifyOn, notifyVetoed, toggleNotify, notifySupported, askForNotifications,
          accountNotify, toggleAccountNotify } = notify;
  const { fmVolume, setFmVolume, fmMuted, setFmMuted, fmSource, customFmStations, unavailableFmStations,
          addFmStation, renameFmStation, removeFmStation, pickFmSource } = fm;

  const pane = (() => {
    switch (section) {
      case "notifications":
        return (
          <NotificationsSection
            notifyOn={notifyOn}
            onToggleNotify={toggleNotify}
            notifyVetoed={notifyVetoed}
            notifyPermission={notifySupported ? notifyPermission : "unsupported"}
            onAskNotify={askForNotifications}
            accountNotify={accountNotify}
            onToggleAccountNotify={toggleAccountNotify}
          />
        );
      case "sounds":
        return (
          <SoundsSection
            soundOn={soundOn === true}
            onToggleSound={toggleSound}
            prefs={tonePrefs}
            claudeHere={providers.claude}
            onLevel={(chime, level) => changeTone(chime, { level })}
            onFigure={(chime, figure) => changeTone(chime, { figure })}
            onPreview={chime => previewTone(chime)}
            customAssets={customAssets}
            customSelections={customSelections}
            onBuiltInSelected={clearCustomOnly}
            onCustomSelected={selectCustomTone}
            onImportCustom={importNotificationAudio}
            onCreateVoice={createNotificationVoice}
            onRenameCustom={renameCustomAsset}
            onPreviewCustom={previewCustomAsset}
            onDeleteCustom={deleteCustomAsset}
          />
        );
      case "music":
        return (
          <MusicSection
            characterEnabled={characterEnabled}
            onToggleCharacter={() => setCharacterEnabled(enabled => !enabled)}
            fmVolume={fmVolume}
            onFmVolume={setFmVolume}
            fmMuted={fmMuted}
            onFmMuted={() => setFmMuted(muted => !muted)}
            fmSource={fmSource}
            onFmSource={pickFmSource}
            customFmStations={customFmStations}
            unavailableFmStations={unavailableFmStations}
            onAddFmStation={addFmStation}
            onRenameFmStation={renameFmStation}
            onRemoveFmStation={removeFmStation}
          />
        );
      default:
        return <ThemeSection theme={theme} onTheme={setTheme} />;
    }
  })();

  return (
    <div className="modal-backdrop" {...scrimPress} role="presentation">
      <div
        ref={dialogRef}
        id="settings"
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={event => event.stopPropagation()}
        onKeyDown={onDialogKey}
      >
        <header className="modal-head">
          <div className="modal-title">
            <span id="settings-title" className="modal-tool-name">Settings</span>
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="glyph-btn"
              onClick={onClose}
              aria-label="Close settings"
              title="Close (Esc)"
            >×</button>
          </div>
        </header>
        <div className="settings-body">
          {/* The nav is a tab strip, and pays for the role (tablist-keys.ts):
              one stop in the tab order, the arrows walk it, and every tab
              points at the one pane it swaps. Down the side, so Up and Down
              walk it; a row at a phone's width, where Left and Right do too. */}
          <div
            className="settings-nav"
            role="tablist"
            aria-label="Settings sections"
            aria-orientation="vertical"
            onKeyDown={moveSection}
          >
            {SETTINGS_SECTIONS.map((choice, index) => (
              <button
                key={choice.id}
                ref={el => {
                  tabRefs.current[index] = el;
                  if (choice.id === section) selectedTabRef.current = el;
                }}
                type="button"
                role="tab"
                id={`settings-tab-${choice.id}`}
                className="settings-tab"
                aria-selected={choice.id === section}
                aria-controls="settings-pane"
                tabIndex={choice.id === section ? 0 : -1}
                onClick={() => onSection(choice.id)}
              >
                {choice.label}
              </button>
            ))}
          </div>
          {/* Keyed by the section, so a section opens at its top rather than
              at the scroll the last one was left at. */}
          <div
            key={section}
            className="settings-pane"
            role="tabpanel"
            id="settings-pane"
            aria-labelledby={`settings-tab-${section}`}
          >
            {pane}
          </div>
        </div>
      </div>
    </div>
  );
}
