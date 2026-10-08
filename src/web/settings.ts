// The deck's one Settings surface: what its sections are, the chord that opens
// it, and which section a door opens it at — apart from React, so a plain-node
// test can hold each rule.
//
// Before it, the deck's preferences lived in a speaker popover and a sliders
// modal side by side, with different shapes, and on a machine with no Claude
// Code the speaker was not drawn, so the notification switches inside it could
// not be reached at all. One modal, opened by a gear that is always on the bar
// and by Cmd/Ctrl+, the way every desktop app opens its settings, holds them
// now. The speaker kept a quick popover for the things pressed often until it
// left the topbar (2026-10-07); V opens this at Sounds instead.

import { isApplePlatform } from "./platform";

/** A section of Settings, in nav order. */
export type SettingsSection = "general" | "notifications" | "sounds" | "music";

/** The nav, in the order it is drawn and walked. */
export const SETTINGS_SECTIONS: readonly { id: SettingsSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "notifications", label: "Notifications" },
  { id: "sounds", label: "Sounds" },
  { id: "music", label: "Music & character" },
];

/** Where a section sits in the nav; General for anything that is not one. */
export function sectionIndex(section: SettingsSection): number {
  return Math.max(0, SETTINGS_SECTIONS.findIndex(s => s.id === section));
}

const TAB_ID_PREFIX = "settings-tab-";

/** The section whose tab should hold focus now that `selected` is on show, or
 *  null when focus is not on a nav tab (a field in the pane, the ×, nothing) or
 *  is already on the right one. Two tabs must never read as chosen at once: the
 *  selected fill on one, the focus ring on another. */
export function focusedTabToFollow(focusedId: string | null | undefined, selected: SettingsSection): SettingsSection | null {
  if (!focusedId?.startsWith(TAB_ID_PREFIX)) return null;
  return focusedId === `${TAB_ID_PREFIX}${selected}` ? null : selected;
}

/** Whether Settings is up, and the section it shows — or showed last, while it
 *  is closed, so a door that names none opens it where the reader left it. Not
 *  persisted: an open dialog is a thing being done, not a thing that is set. */
export interface SettingsDoor {
  open: boolean;
  section: SettingsSection;
}

export const SETTINGS_CLOSED: SettingsDoor = { open: false, section: "general" };

/** Settings opened through a door. A door that names a section — V names
 *  Sounds — opens it there; the gear and the chord name none, and get the
 *  section last shown. */
export function openedAt(door: SettingsDoor, section?: SettingsSection): SettingsDoor {
  return { open: true, section: section ?? door.section };
}

/** The modifiers a keystroke carries, structural so a test can pass an object. */
export interface SettingsChordKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Cmd+, on a Mac and Ctrl+, everywhere else — and either on any of them,
 *  because a build cannot know which keyboard is in front of it, the same
 *  reason isBrowserChord counts both. Alt and Shift are someone else's chord. */
export function isSettingsChord(e: SettingsChordKey): boolean {
  return e.key === "," && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

/** The chord as the keys in front of the reader spell it, for a tooltip. */
export function settingsChordLabel(platform: string): string {
  return isApplePlatform(platform) ? "⌘," : "Ctrl+,";
}
