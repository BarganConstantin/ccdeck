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
// only the frame, the nav and the search above it (SettingsSearch.tsx).
import { useMediaQuery } from "../use-media-query";
import SessionRecoverySettings from "./SessionRecoverySettings";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Providers } from "../providers";
import { focusedTabToFollow, isFindChord, sectionsDrawn, type SettingsDoors, type SettingsSection } from "../settings";
import { indexFor, isSectionEntry, searchSettings, type SettingsEntry } from "../settings-search";
import { tabStripMove } from "../tablist-keys";
import type { useAppearance } from "../use-appearance";
import type { useAutoRestart } from "../use-auto-restart";
import type { useDesktopUpdate } from "../use-desktop-update";
import type { useCustomTones } from "../use-custom-tones";
import type { useOsNotifications } from "../use-os-notifications";
import type { useSoundSwitch } from "../use-sound-switch";
import type { useTonePrefs } from "../use-tone-prefs";
import type { useVersionCheck } from "../use-version-check";
import { setSingleKeyShortcuts } from "../single-key-shortcuts";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import BoardSection from "./BoardSection";
import ElsewhereSection from "./ElsewhereSection";
import KeyboardSection from "./KeyboardSection";
import NotificationsSection from "./NotificationsSection";
import SettingsSectionGlyph from "./SettingsSectionGlyph";
import SoundsSection from "./SoundsSection";
import RadarSettings from "./RadarSettings";
import ToolAuditSettings from "./ToolAuditSettings";
import IntegrationsSection, { type SettingsLeaveGuard } from "./IntegrationsSection";
import { integrationsReach, offeredKinds, useIntegrations } from "../integrations/client";
import ThemeSection from "./ThemeSection";
import ReadingSection, { ReadingReset } from "./ReadingSection";
import AboutSection from "./AboutSection";
import UpdatesSection from "./UpdatesSection";
import CharacterSection from "./CharacterSection";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { SettingsSearchField, SettingsSearchResults, SettingsSearchStatus } from "./SettingsSearch";
import { useSettingsJump } from "./use-settings-jump";

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
  const leaveGuardRef = useRef<SettingsLeaveGuard | null>(null);
  const registerLeaveGuard = useCallback((guard: SettingsLeaveGuard | null) => { leaveGuardRef.current = guard; }, []);
  function requestLeave(action: () => void, back = false) {
    if (leaveGuardRef.current) {
      changeQuery(""); leaveGuardRef.current(action, back);
      requestAnimationFrame(() => selectedTabRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" }));
    }
    else action();
  }
  const dismissSettings = () => requestLeave(onClose, true);
  const selectedTabRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useModalDismiss(dismissSettings, { focusRef: selectedTabRef });
  const scrimPress = useScrimDismiss(() => requestLeave(onClose));
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // THE SECTIONS THIS DECK DRAWS (sectionsDrawn, settings.ts): every one, but
  // Integrations only where the deck offers a kind or still holds a stranded
  // connection, or while it is the section on show. The nav, its arrows and
  // the pane's head all walk this list, so here it takes the table's name.
  const integrations = useIntegrations();
  const integrationsReachHere = integrationsReach(integrations);
  const SETTINGS_SECTIONS = sectionsDrawn(integrationsReachHere, section);
  const at = Math.max(0, SETTINGS_SECTIONS.findIndex(s => s.id === section));

  // THE SEARCH. While the field holds a query the pane shows what matches it
  // in place of the section; the section stays mounted under it, hidden, so a
  // half-filled field in it — Keyboard's filter, a voice's words — is where it
  // was when the query is cleared. Not kept across opening and closing: an
  // open dialog is a thing being done.
  const narrowNav = useMediaQuery("(max-width: 640px)");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const searching = query.trim() !== "";
  const results = useMemo(() => searchSettings(query, indexFor(providers.claude, integrationsReachHere, offeredKinds(integrations))), [query, providers.claude, integrationsReachHere, integrations]);
  const jumpTo = useSettingsJump(paneRef, !searching, section);
  const changeQuery = (next: string) => { setQuery(next); setActive(0); };

  // A section chosen in the nav ends the search: a press on a tab is "take me
  // there", and the results would otherwise stand over the page it asked for.
  const chooseSection = (next: SettingsSection) => {
    requestLeave(() => {
      changeQuery(""); onSection(next);
      requestAnimationFrame(() => document.getElementById(`settings-tab-${next}`)?.focus());
    });
  };

  // A result opens its section, and lands on its row once the section is
  // drawn (use-settings-jump.ts). A section's own result only opens it.
  const openResult = (entry: SettingsEntry) => {
    requestLeave(() => {
      changeQuery(""); onSection(entry.section);
      if (!isSectionEntry(entry)) jumpTo(entry.id);
    });
  };

  // Cmd/Ctrl+F goes to the field, and the browser's find bar does not open:
  // over a modal it would find words on the canvas behind the scrim. On window
  // and not on the dialog, because focus is not always inside it — a press on
  // a paragraph drops it on <body> (use-modal-dismiss.ts) — and only for a
  // keystroke from the dialog or from nowhere, never one aimed at something
  // else on the page.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!isFindChord(event)) return;
      const dialog = dialogRef.current;
      const from = event.target as Node | null;
      if (!dialog || !(from === document.body || from === document.documentElement || (from && dialog.contains(from)))) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialogRef]);

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
    // An arrow that chooses a section ends the search, as a press does.
    requestLeave(() => {
      changeQuery(""); onSection(SETTINGS_SECTIONS[move.index].id);
      tabRefs.current[move.index]?.focus();
    });
  };

  // THE DIALOG'S OWN KEY, answered here and stopped here.
  // Space belongs to the control it is pressed on. React Flow reads Space on
  // the document as its pan key and cancels it wherever focus is, so a Space on
  // a switch never pressed it; stopped at this edge, the way AnchoredPopover
  // stops its keys, it reaches the control.
  // T, which Appearance's theme caption advertises, is not answered here any
  // more: the deck's handler takes it through every dialog, this one included,
  // under the same gates this one kept (use-deck-shortcuts.ts, keepsThemeKey).
  const onDialogKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === " ") event.stopPropagation();
  };

  const { soundOn, toggleSound } = sound;
  const { tonePrefs, previewTone, changeTone } = tones;
  const { customSelections, customAssets, clearCustomOnly, selectCustomTone, importNotificationAudio,
          createNotificationVoice, renameCustomAsset, deleteCustomAsset, previewCustomAsset } = customTones;
  const { notifyPermission, notifyOn, notifyVetoed, toggleNotify, notifySupported, askForNotifications,
          accountNotify, toggleAccountNotify } = notify;

  const pane = (() => {
    switch (section) {
      case "radar":
        return <RadarSettings onOpen={doors.radar} />;
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
      case "integrations":
        return <IntegrationsSection onBeforeLeaveChange={registerLeaveGuard} />;
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
            <SessionRecoverySettings provider="Codex" />
            {providers.claude && <SessionRecoverySettings provider="Claude" />}
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
    : section === "integrations" && integrations.connections !== null
      ? <span className="ig-total">{integrations.connections.length} saved connection{integrations.connections.length === 1 ? "" : "s"}</span>
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
              onClick={() => requestLeave(onClose)}
              aria-label="Close settings"
              title="Close (Esc)"
            >×</button>
          </div>
        </header>
        <div className="settings-body">
          {/* The nav's column: the search field, then the tab strip. Two
              elements, because a tablist holds tabs and nothing else — a
              field inside it would be a stop the arrows walk past and a
              screen reader counts as a tab that is not one. */}
          <div className="settings-side">
            <SettingsSearchField
              inputRef={searchRef}
              query={query}
              onQuery={changeQuery}
              results={results}
              active={active}
              onActive={setActive}
              onOpen={openResult}
            />
            <SettingsSearchStatus query={query} count={results.length} />
            {/* The nav is a tab strip, and pays for the role (tablist-keys.ts):
                one stop in the tab order, the arrows walk it, and every tab
                points at the one pane it swaps. Down the side, so Up and Down
                walk it; a row at a phone's width, where Left and Right do too. */}
            <div
              className="settings-nav"
              role="tablist"
              aria-label="Settings sections"
              aria-orientation={narrowNav ? "horizontal" : "vertical"}
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
                  onClick={() => chooseSection(choice.id)}
                >
                  <SettingsSectionGlyph section={choice.id} />
                  <span className="settings-tab-label">{choice.label}</span>
                </button>
              ))}
            </div>
          </div>
          {/* Keyed by the section, so a section opens at its top rather than
              at the scroll the last one was left at. Headed by its own name:
              the dialog is one height now, and a short section under a title
              reads as a page that ends rather than a box left half-filled. It
              is also the rank the groups' h3 captions were missing.
              HIDDEN, NOT UNMOUNTED, while search results stand in its place:
              every tab's aria-controls keeps a panel to name, and the section
              keeps what was typed into it. */}
          <div
            key={section}
            ref={paneRef}
            className="settings-pane"
            role="tabpanel"
            id="settings-pane"
            aria-labelledby={`settings-tab-${section}`}
            hidden={searching || undefined}
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
          {searching && <SettingsSearchResults query={query} results={results} active={active} onOpen={openResult} />}
        </div>
      </div>
    </div>
  );
}
