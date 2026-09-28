// The topbar's two settings popovers, Sound (#711) and Appearance: whether each
// is open, the button each opens from, and the rule that opening Sound closes
// Appearance. The other half of that rule — Appearance closing Sound — is the
// Appearance button's own click, in SettingsRun (components/TopbarRuns.tsx).
//
// Moved out of App.tsx unchanged, and called there where the state was. The
// state is not the run's own because V opens Sound from the keyboard
// (use-deck-shortcuts.ts), through setSoundMenuOpen.
import { useEffect, useRef, useState } from "react";

export function useSettingsMenus() {
  /** The menu the topbar button opens (#711). Not persisted: a popover is a
   *  thing you are doing, not a thing you have set, and a deck that reloaded
   *  with a menu hanging open would be reporting a gesture nobody made. */
  const [soundMenuOpen, setSoundMenuOpen] = useState(false);
  /** The button itself, so the menu's outside-press rule can leave it alone —
   *  its own onClick already toggles, and both running would close the menu and
   *  reopen it in the same gesture. */
  const soundButtonRef = useRef<HTMLButtonElement | null>(null);
  const [appearanceMenuOpen, setAppearanceMenuOpen] = useState(false);
  const appearanceButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (soundMenuOpen) setAppearanceMenuOpen(false); }, [soundMenuOpen]);
  return { soundMenuOpen, setSoundMenuOpen, soundButtonRef, appearanceMenuOpen, setAppearanceMenuOpen, appearanceButtonRef };
}
