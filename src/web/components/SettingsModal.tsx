// Settings: the deck's preferences in one dialog, a section at a time.
//
// The preferences used to live in two places of two different shapes — a
// popover under the speaker and a modal under a sliders button — and on a
// machine with no Claude Code the speaker was not drawn, so the notification
// switches inside its popover could not be reached at all. This is the one
// home familiar apps give them, and since the speaker left the topbar
// (2026-10-07) the only one: a gear that is always on the bar, Cmd/Ctrl+,
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
import { useEffect, useRef, type KeyboardEvent } from "react";
import type { Providers } from "../providers";
import { focusedTabToFollow, sectionIndex, SETTINGS_SECTIONS, type SettingsDoors, type SettingsSection } from "../settings";
import { isTypingTarget } from "../shortcuts";
import { tabStripMove } from "../tablist-keys";
import type { useAppearance } from "../use-appearance";
import type { useAutoRestart } from "../use-auto-restart";
import type { useDesktopUpdate } from "../use-desktop-update";
import type { useCustomTones } from "../use-custom-tones";
import type { useOsNotifications } from "../use-os-notifications";
import type { useSoundSwitch } from "../use-sound-switch";
import type { useTonePrefs } from "../use-tone-prefs";
import type { useVersionCheck } from "../use-version-check";
import { characterKeyMuted, setSingleKeyShortcuts } from "../single-key-shortcuts";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import BoardSection from "./BoardSection";
import ElsewhereSection from "./ElsewhereSection";
import KeyboardSection from "./KeyboardSection";
import NotificationsSection from "./NotificationsSection";
import SettingsSectionGlyph from "./SettingsSectionGlyph";
import SoundsSection from "./SoundsSection";
import ToolAuditSettings from "./ToolAuditSettings";
import ThemeSection from "./ThemeSection";
import ReadingSection, { ReadingReset } from "./ReadingSection";
import AboutSection from "./AboutSection";
import UpdatesSection from "./UpdatesSection";
import CharacterSection from "./CharacterSection";
import { nextTheme } from "../theme";
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
  /** Which version the deck runs and what is waiting to replace it — the
   *  version chip's own state, read by About and by General's Updates. */
  versionCheck: ReturnType<typeof useVersionCheck>;
  /** The desktop app's verified update and its press, which About offers as
   *  the topbar does. */
  desktopUpdate: ReturnType<typeof useDesktopUpdate>;
  /** The auto-update switch, the update banner's own (#2176). */
  restart: ReturnType<typeof useAutoRestart>;
  /** Where About and General send the reader, each closing this first. */
  doors: SettingsDoors;
}

export default function SettingsModal({
  section, onSection, onClose, providers, sound, tones, customTones, notify, appearance,
  versionCheck, desktopUpdate, restart, doors,
}: SettingsModalProps) {
  // Focus starts on the section's own tab, not on the ×: the nav is what this
  // dialog is walked by, and a door that opened it at Sounds lands the reader
  // on "Sounds", which says where they are.
  const selectedTabRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: selectedTabRef });
  const scrimPress = useScrimDismiss(onClose);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = sectionIndex(section);

  useEffect(() => {
    if (focusedTabToFollow(document.activeElement?.id, section)) selectedTabRef.current?.focus();
    // At a phone's width the nav is one row that scrolls sideways, and a door
    // that opened Settings at Sounds would otherwise show a row of tabs with
    // the chosen one off its end. "nearest" moves nothing that is in view.
    selectedTabRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [section]);

  const { theme, setTheme, characterEnabled, setCharacterEnabled, character, setCharacter } = appearance;
  const singleKeys = useSingleKeyShortcuts();

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
  // T is the key Appearance's theme caption advertises. App answers it anywhere on the
  // deck, but not past an open dialog, so the hint would have named a dead key
  // in the one place it is shown. A field somebody is typing into keeps every
  // letter, and so does a <select>, whose letters pick an option. And T is a
  // single-key shortcut like the deck's others, so the switch in Keyboard
  // silences it here too (WCAG 2.1.4).
  const onDialogKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === " ") { event.stopPropagation(); return; }
    if (characterKeyMuted(event.key, singleKeys)) return;
    const target = event.target as HTMLElement;
    if (isTypingTarget(target) || target.tagName === "SELECT") return;
    if ((event.key !== "t" && event.key !== "T") || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    const next = nextTheme((target.dataset.themeChoice as typeof theme | undefined) ?? theme);
    setTheme(nextTheme);
    if (target.getAttribute("role") === "radio") {
      event.currentTarget.querySelector<HTMLButtonElement>(`[role="radio"][data-theme-choice="${next}"]`)?.focus();
    }
  };

  const { soundOn, toggleSound } = sound;
  const { tonePrefs, previewTone, changeTone } = tones;
  const { customSelections, customAssets, clearCustomOnly, selectCustomTone, importNotificationAudio,
          createNotificationVoice, renameCustomAsset, deleteCustomAsset, previewCustomAsset } = customTones;
  const { notifyPermission, notifyOn, notifyVetoed, toggleNotify, notifySupported, askForNotifications,
          accountNotify, toggleAccountNotify } = notify;

  const pane = (() => {
    switch (section) {
      case "appearance":
        return (
          <>
            <ThemeSection theme={theme} onTheme={setTheme} singleKeys={singleKeys} />
            <CharacterSection
              characterEnabled={characterEnabled}
              character={character}
              onCharacter={setCharacter}
              onToggleCharacter={() => setCharacterEnabled(enabled => !enabled)}
            />
          </>
        );
      case "reading":
        return <ReadingSection textSize={appearance.textSize} density={appearance.density} onTextSize={appearance.setTextSize} onDensity={appearance.setDensity} />;
      case "keyboard":
        return <KeyboardSection singleKeys={singleKeys} onToggleSingleKeys={() => setSingleKeyShortcuts(!singleKeys)} />;
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
      case "data":
        return <ToolAuditSettings />;
      case "about":
        return (
          <AboutSection
            version={versionCheck.version}
            notice={versionCheck.notice}
            readyAppUpdate={desktopUpdate.readyAppUpdate}
            updateRestarting={desktopUpdate.desktopUpdateRestarting}
            updateFailure={desktopUpdate.desktopUpdateFailure}
            onUpdateRestart={version => { void desktopUpdate.askDesktopUpdateRestart(version); }}
            doors={doors}
          />
        );
      default:
        // General: how the board behaves, how the deck updates itself, and
        // the preferences that live in a panel of their own (#2176).
        return (
          <>
            <BoardSection />
            <UpdatesSection autoRestart={restart.autoRestart} onToggleAutoRestart={restart.toggleAutoRestart} version={versionCheck.version} />
            <ElsewhereSection claudeHere={providers.claude} singleKeys={singleKeys} doors={doors} />
          </>
        );
    }
  })();

  // The pane's own action, beside its name: Text & density's Reset, which
  // undoes the whole section and so belongs to its head, not to a group.
  const paneAction = section === "reading"
    ? <ReadingReset textSize={appearance.textSize} density={appearance.density} onTextSize={appearance.setTextSize} onDensity={appearance.setDensity} />
    : null;

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
                <SettingsSectionGlyph section={choice.id} />
                <span className="settings-tab-label">{choice.label}</span>
              </button>
            ))}
          </div>
          {/* Keyed by the section, so a section opens at its top rather than
              at the scroll the last one was left at. Headed by its own name:
              the dialog is one height now, and a short section under a title
              reads as a page that ends rather than a box left half-filled. It
              is also the rank the groups' h3 captions were missing. */}
          <div
            key={section}
            className="settings-pane"
            role="tabpanel"
            id="settings-pane"
            aria-labelledby={`settings-tab-${section}`}
          >
            {/* The section's name, and one line saying what it holds, before
                anything in it is read (#2176) — the line a Windows settings
                page and a Raycast preference pane open on. */}
            <div className="settings-pane-head">
              <div className="settings-pane-heading">
                <h2 className="settings-pane-title">{SETTINGS_SECTIONS[at].label}</h2>
                <p className="settings-pane-note">{SETTINGS_SECTIONS[at].note}</p>
              </div>
              {paneAction}
            </div>
            {pane}
          </div>
        </div>
      </div>
    </div>
  );
}
