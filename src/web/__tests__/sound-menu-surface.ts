// The sound menu as one text, for the assertions that say what it does NOT do —
// the popover and every file lifted out of it, Settings' two sound sections
// included.
//
// SoundMenu.tsx is being taken apart one concern at a time, and the pieces land
// in the files listed below. A positive assertion reads the file that owns the
// code. A negative, a count or a list cannot: "nothing in the menu is
// disabled", asked of SoundMenu.tsx alone, passes vacuously the moment the
// controls move out of it. So those read this instead — the menu and every file
// lifted out of it, in one string — for the reason accounts-surface.ts gives.
//
// Raw rather than comment-stripped, as the other surfaces are: the tests that
// read the menu each strip it their own way. Joined by a newline and nothing
// else, which is what clientText does, so a line-anchored pattern cannot span
// two files.
import { readFileSync } from "node:fs";

import { WEB_DIR } from "./client-source";

/** The menu and what was lifted out of it, relative to `src/web`, the menu
 *  first. A file extracted from SoundMenu.tsx, or from a file lifted out of
 *  it, is added here in the same change. */
export const SOUND_MENU_FILES = [
  "components/SoundMenu.tsx",
  // Settings › Sounds and Settings › Notifications are the menu's two halves,
  // lifted out whole when Settings took everything but the quick things; the
  // switch both the popover and Sounds draw is its own file.
  "components/SoundsSection.tsx",
  "components/NotificationsSection.tsx",
  "components/SoundSwitch.tsx",
  "components/ToneSection.tsx",
  "components/VolumeRow.tsx",
  "components/CustomSoundsSection.tsx",
  "components/SpokenVoiceForm.tsx",
  "use-clip-recorder.ts",
  "tone-option.ts",
  // Shared with AnchoredPopover, which is why it lives beside the hooks.
  "components/use-outside-press.ts",
] as const;

let joined: string | null = null;

/** Every file in SOUND_MENU_FILES, raw, joined by a newline. */
export function soundMenuSurface(): string {
  joined ??= SOUND_MENU_FILES.map(rel => readFileSync(`${WEB_DIR}${rel}`, "utf8")).join("\n");
  return joined;
}
