// The topbar's two ways into the deck's settings: the speaker's quick popover
// (#711) and the Settings dialog behind the gear. Whether each is open, the
// button the popover opens from, which section Settings shows, and the rule
// that opening Settings closes the popover — through whichever door it opens:
// the gear, Cmd/Ctrl+, (use-deck-shortcuts.ts) or the popover's own "All sound
// settings…".
//
// The state is not the topbar run's own because V opens the popover and
// Cmd/Ctrl+, opens Settings from the keyboard, and because Settings is mounted
// from DeckDialogs.tsx at the top of the tree, not from the button.
import { useCallback, useRef, useState } from "react";
import { openedAt, SETTINGS_CLOSED, type SettingsDoor, type SettingsSection } from "./settings";

export function useSettingsMenus() {
  /** The popover the speaker opens (#711). Not persisted: a popover is a thing
   *  you are doing, not a thing you have set, and a deck that reloaded with a
   *  menu hanging open would be reporting a gesture nobody made. */
  const [soundMenuOpen, setSoundMenuOpen] = useState(false);
  /** The button itself, so the popover's outside-press rule can leave it alone
   *  — its own onClick already toggles, and both running would close the
   *  popover and reopen it in the same gesture. */
  const soundButtonRef = useRef<HTMLButtonElement | null>(null);
  /** Settings, and the section it shows — kept while it is closed, so the gear
   *  reopens it where the reader left it. Not persisted, for the popover's
   *  reason. */
  const [settings, setSettings] = useState<SettingsDoor>(SETTINGS_CLOSED);

  /** The one door into Settings. A section deep-links to it; none opens it at
   *  the last one shown. The popover goes, because Settings covers the bar it
   *  hangs from and holds everything it does. */
  const openSettings = useCallback((section?: SettingsSection) => {
    setSoundMenuOpen(false);
    setSettings(door => openedAt(door, section));
  }, []);
  const closeSettings = useCallback(() => setSettings(door => ({ ...door, open: false })), []);
  const showSection = useCallback((section: SettingsSection) => setSettings(door => ({ ...door, section })), []);

  return {
    soundMenuOpen, setSoundMenuOpen, soundButtonRef,
    settingsOpen: settings.open, settingsSection: settings.section, openSettings, closeSettings, showSection,
  };
}
