// The door into the deck's Settings dialog: whether it is open, which section
// it shows, and the one function every way in goes through — the topbar's gear,
// Cmd/Ctrl+, and V (use-deck-shortcuts.ts).
//
// The state is not the topbar run's own because the keyboard opens Settings
// too, and because Settings is mounted from DeckDialogs.tsx at the top of the
// tree, not from the button.
//
// It also held the speaker's quick popover (#711) until that button left the
// topbar (2026-10-07): everything the popover carried is in Settings › Sounds.
import { useCallback, useState } from "react";
import { openedAt, SETTINGS_CLOSED, type SettingsDoor, type SettingsSection } from "./settings";

export function useSettingsMenus() {
  /** Settings, and the section it shows — kept while it is closed, so the gear
   *  reopens it where the reader left it. Not persisted: an open dialog is a
   *  thing you are doing, not a thing you have set, and a deck that reloaded
   *  with it hanging open would be reporting a gesture nobody made. */
  const [settings, setSettings] = useState<SettingsDoor>(SETTINGS_CLOSED);

  /** The one door into Settings. A section deep-links to it; none opens it at
   *  the last one shown. */
  const openSettings = useCallback((section?: SettingsSection) => {
    setSettings(door => openedAt(door, section));
  }, []);
  const closeSettings = useCallback(() => setSettings(door => ({ ...door, open: false })), []);
  const showSection = useCallback((section: SettingsSection) => setSettings(door => ({ ...door, section })), []);

  return {
    settingsOpen: settings.open, settingsSection: settings.section, openSettings, closeSettings, showSection,
  };
}
