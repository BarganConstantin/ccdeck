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
export type SettingsSection =
  | "general" | "appearance" | "reading" | "keyboard" | "notifications" | "sounds" | "data" | "radar" | "account" | "about";

/** One section's nav entry: the word on its tab, and the line under its name
 *  at the head of the pane, saying what the section holds before anything in
 *  it is read. */
export interface SettingsSectionEntry {
  id: SettingsSection;
  label: string;
  note: string;
}

/** The nav, in the order it is drawn and walked.
 *
 *  ONE SUBJECT A SECTION (#2176). General used to hold the twelve themes, the
 *  character, the board, the keyboard switch and tool history — five subjects
 *  and a pane twice the window's height — while the theme's neighbours, text
 *  size and density, were a section of their own. Each subject has its own
 *  section now, in the order a reader reaches for them: how the deck behaves,
 *  how it looks, how it is driven, how it reaches you, what it keeps, and
 *  what it is. About comes last and stands at the foot of the nav, as it does
 *  in the desktop settings windows this dialog is modelled on. */
export const SETTINGS_SECTIONS: readonly SettingsSectionEntry[] = [
  { id: "general", label: "General", note: "The board, updates, and the settings that live in their own panels." },
  { id: "appearance", label: "Appearance", note: "The colour theme and the character on the canvas." },
  { id: "reading", label: "Text & density", note: "Make the deck comfortable to read. Changes apply immediately and stay separate from canvas zoom." },
  { id: "keyboard", label: "Keyboard", note: "Every shortcut, and whether single keys answer." },
  { id: "notifications", label: "Notifications", note: "How the deck reaches you while you are not looking at it." },
  { id: "sounds", label: "Sounds", note: "What plays when a turn finishes and when Claude asks." },
  { id: "data", label: "Data", note: "What the deck keeps on this device." },
  { id: "radar", label: "Radar", note: "Background monitoring of Claude telemetry sent to its collectors." },
  { id: "about", label: "About", note: "The version you are running, and where to say what you think of it." },
];

/** Settings › Account, while the ccdeck account is hidden: drawn only on a
 *  deck that has it switched on (or was asked for it and vetoed at launch),
 *  and never in the list above, so no search, test or reader of the nav finds
 *  a section for a feature that is not released. */
export const ACCOUNT_SECTION: SettingsSectionEntry = {
  id: "account", label: "Account", note: "Connect this deck to your ccdeck account, and keep its settings in step with your other machines.",
};

/** The nav this deck draws: the released sections, and Account before About when the
 *  account is on. About stays last, at the foot of the nav. */
export function settingsSections({ account = false }: { account?: boolean } = {}): readonly SettingsSectionEntry[] {
  if (!account) return SETTINGS_SECTIONS;
  const about = SETTINGS_SECTIONS.length - 1;
  return [...SETTINGS_SECTIONS.slice(0, about), ACCOUNT_SECTION, SETTINGS_SECTIONS[about]];
}

/** Where a section sits in the nav; General for anything that is not one. */
export function sectionIndex(section: SettingsSection, sections: readonly SettingsSectionEntry[] = SETTINGS_SECTIONS): number {
  return Math.max(0, sections.findIndex(s => s.id === section));
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

/** The doors out of Settings into the rest of the deck (#2176): what About
 *  and General's "Elsewhere on the deck" press. Each is a way the deck already
 *  had — the version chip's, the shortcuts sheet's, the topbar's Feedback, a
 *  panel's own toggle — and none is a second copy of what it opens. */
export interface SettingsDoors {
  /** The release notes, as the version chip opens them. */
  whatsNew: () => void;
  /** The chip's action while it is lit for a version on disk or on npm: the
   *  release notes, and the update banner put back. */
  update: () => void;
  tour: () => void;
  feedback: () => void;
  accounts: () => void;
  /** The accounts panel, at its Local network view. */
  localNetwork: () => void;
  browserWatch: () => void;
  /** Radar, as its toolbar button opens it. */
  radar: () => void;
}

/** A door out of Settings: close it, then open what the door names.
 *
 *  ONE DIALOG AT A TIME. Settings is a modal, and what most doors open is one
 *  too; opened over it, the second would trap the keyboard inside a dialog
 *  painted over a dialog, and Escape would close them in an order nobody
 *  chose. Closed first, the way the shortcuts sheet hands over to Settings
 *  (DeckDialogs.tsx), both changes land in one render, so nothing is ever
 *  drawn with neither up — and a panel opened this way is beside the canvas
 *  with no scrim left over it. */
export function doorOut(close: () => void, open: () => void): () => void {
  return () => { close(); open(); };
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

/** Cmd+F or Ctrl+F, which inside Settings goes to its search field rather than
 *  the browser's find bar: the page under the dialog is the canvas, and a find
 *  bar over a modal finds words the reader cannot reach. Either modifier on any
 *  platform, as above. The letter is read off the key, so a Dvorak or AZERTY
 *  layout gets the key marked F; a layout with no Latin letters (Russian,
 *  Greek) types something else there, and is read by the key's position. */
export function isFindChord(e: SettingsChordKey & { code?: string }): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
  const key = e.key.toLowerCase();
  return key === "f" || (!/^[a-z]$/.test(key) && e.code === "KeyF");
}
