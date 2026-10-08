// The eight controls the deck's chrome carries, each defined once, and the
// edge each one lives on. components/EdgeRails.tsx draws them; this says what
// they are: the word, the key, the hint, the state and what a press does.
//
// One definition for three surfaces — the edge stripes, the phone's dock and
// the two utilities left on the topbar — so a name, a key or an accessible
// label cannot drift between them. The keys are the ones the deck has always
// answered (use-deck-shortcuts.ts); moving a button moved none of them.
import type { Dispatch, SetStateAction } from "react";
import type { Providers } from "./providers";
import type { PanelToggles } from "./use-panel-return";
import { platformName } from "./platform";
import { settingsChordLabel, type SettingsSection } from "./settings";
import type { RailItem } from "./components/EdgeRails";
import {
  AccountsGlyph, BrowserWatchGlyph, FeedbackGlyph, HistoryGlyph, MachineGlyph,
  SessionListGlyph, SettingsGlyph, UsageGlyph,
} from "./components/rail-glyphs";

type Toggle = Dispatch<SetStateAction<boolean>>;

export interface RailItems {
  /** The left column's two, Accounts first: they share it, and opening one
   *  closes the other. */
  left: RailItem[];
  /** The right stripe's two panels, then the two records that open as dialogs. */
  right: RailItem[][];
  /** Settings and Feedback, in the topbar's corner. */
  utilities: RailItem[];
}

/** What Browser watch's hint adds under its name: whether it is watching, and
 *  what is unread. The glyph says the first as a pupil or a slash and the
 *  stripe's badge the second as a number; this says both in words. */
export function browserWatchDetail(watchOn: boolean | null, unread: number): string {
  const state = watchOn
    ? "Watching — the deck keeps its own copy of the history"
    : "Not watching — reads the browser's history when opened";
  return unread > 0 ? `${state}\n${unread} unread` : state;
}

export function railItems({
  providers, sessionListOpen, toggleSessionList, accountsPanelOpen, toggleAccountsPanel,
  usagePanelOpen, setUsagePanelOpen, machinePanelOpen, setMachinePanelOpen, setUsageHistoryOpen,
  watchOn, watchUnseen, setBrowserWatchOpen, openSettings, onFeedback, toggles,
}: {
  providers: Providers;
  sessionListOpen: boolean;
  toggleSessionList: () => void;
  accountsPanelOpen: boolean;
  toggleAccountsPanel: () => void;
  usagePanelOpen: boolean;
  setUsagePanelOpen: Toggle;
  machinePanelOpen: boolean;
  setMachinePanelOpen: Toggle;
  setUsageHistoryOpen: Toggle;
  /** Whether Browser Watch reads in the background; null until known. */
  watchOn: boolean | null;
  /** Findings nobody has looked at yet. */
  watchUnseen: number;
  setBrowserWatchOpen: Toggle;
  /** The one door into Settings (use-settings-menus.ts). */
  openSettings: (section?: SettingsSection) => void;
  onFeedback: () => void;
  /** Where a panel's own close hands keyboard focus back (use-panel-return.ts). */
  toggles: PanelToggles;
}): RailItems {
  const settingsCap = settingsChordLabel(platformName());
  // aria-expanded, not aria-pressed, on the four panels: each shows and
  // hides a region beside the canvas and leaves focus where it was — the
  // disclosure pattern. aria-controls only while the region is mounted: an
  // IDREF that resolves to nothing is a dangling pointer, and closed is
  // exactly when there is nothing to point at.
  const sessionList: RailItem = {
    id: "session-list", label: "Session list", short: "Sessions", key: { cap: "L", aria: "L", single: true },
    ariaLabel: "Session list", glyph: <SessionListGlyph />, kind: "panel",
    open: sessionListOpen, controls: "session-list", onPress: toggleSessionList, buttonRef: toggles.sessionList,
  };
  // Gone without Claude Code rather than present and inert: every account in
  // the panel is a Claude account, and a Codex-only machine has none to show.
  const accounts: RailItem = {
    id: "accounts", label: "Accounts", short: "Accounts", key: { cap: "A", aria: "A", single: true },
    ariaLabel: "Accounts", hint: "Claude accounts", glyph: <AccountsGlyph />, kind: "panel",
    open: accountsPanelOpen, controls: "accounts-panel", onPress: toggleAccountsPanel, buttonRef: toggles.accounts,
  };
  const usage: RailItem = {
    id: "usage", label: "Usage", short: "Usage", key: { cap: "U", aria: "U", single: true },
    ariaLabel: "Usage", glyph: <UsageGlyph />, kind: "panel",
    open: usagePanelOpen, controls: "usage-panel", onPress: () => setUsagePanelOpen(o => !o), buttonRef: toggles.usage,
  };
  const machine: RailItem = {
    id: "machine", label: "Machine", short: "Machine", key: { cap: "S", aria: "S", single: true },
    ariaLabel: "Machine", hint: "This machine", glyph: <MachineGlyph />, kind: "panel",
    open: machinePanelOpen, controls: "system-panel", onPress: () => setMachinePanelOpen(o => !o), buttonRef: toggles.machine,
  };
  // The four below open a modal: aria-haspopup="dialog" and no state, since
  // while the dialog is up its scrim covers the button and aria-modal takes
  // it out of the tree — a `true` no reader could ever reach.
  const history: RailItem = {
    // "Usage history" whole on the stripe: "History" alone, over Browser watch,
    // read as the browser's.
    id: "history", label: "Usage history", short: "History", key: { cap: "H", aria: "H", single: true },
    ariaLabel: "Usage history", glyph: <HistoryGlyph />, kind: "dialog",
    onPress: () => setUsageHistoryOpen(o => !o),
  };
  const browserWatch: RailItem = {
    id: "browser-watch", label: "Browser watch", short: "Watch", key: { cap: "B", aria: "B", single: true },
    ariaLabel: `Browser watch, ${watchOn ? "watching" : "not watching"}${watchUnseen > 0 ? `, ${watchUnseen} unread` : ""}`,
    detail: browserWatchDetail(watchOn, watchUnseen),
    glyph: <BrowserWatchGlyph watching={watchOn === true || watchUnseen > 0} />, kind: "dialog",
    onPress: () => setBrowserWatchOpen(o => !o), badge: watchUnseen,
  };
  // A chord, not a single key: it stays in the hint and in
  // aria-keyshortcuts whichever way the single-key switch is set.
  const settings: RailItem = {
    id: "settings", label: "Settings", short: "Settings", key: { cap: settingsCap, aria: "Control+, Meta+,", single: false },
    ariaLabel: "Settings", glyph: <SettingsGlyph />, kind: "dialog", onPress: () => openSettings(),
  };
  const feedback: RailItem = {
    id: "feedback", label: "Feedback", short: "Feedback", menu: "Send feedback",
    ariaLabel: "Send feedback", glyph: <FeedbackGlyph />, kind: "dialog", onPress: onFeedback,
  };
  return {
    // Accounts first, at the top of the stripe and the start of the dock: the
    // owner's call (2026-10-08), the panel a first run opens and the one read
    // before choosing where to start a session.
    left: providers.claude ? [accounts, sessionList] : [sessionList],
    right: [[usage, machine], [history, browserWatch]],
    utilities: [settings, feedback],
  };
}
