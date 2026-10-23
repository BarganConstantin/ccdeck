// The controls the deck's chrome carries, each defined once, and the edge and
// the group each one lives in. components/EdgeRails.tsx draws them; this says
// what they are: the word, the key, the hint, the state and what a press does.
//
// One definition for three surfaces — the edge stripes, the phone's dock and
// the two utilities left on the topbar — so a name, a key or an accessible
// label cannot drift between them. The keys are the ones the deck has always
// answered (use-deck-shortcuts.ts); moving a button moved none of them.
//
// ONE RULE FOR BOTH STRIPES (2026-10-23, after a user called the deck "not
// organized"). Thirteen doors had grown in two runs grouped by two different
// rules — the left by topic, the right by what opens — so where a button sat
// said nothing about it. Now each stripe is groups that answer one question
// each, three doors at most, between the same rules, and each group has a name
// a screen reader says on the way in:
//
//   left   Claude accounts   Accounts · Account capacity · Reset calendar
//          Session list
//          the connected trackers, then Explore integrations at the foot
//   right  Usage and machine Usage · Machine
//          Activity history  Usage history · Tool activity · Skill activity
//          Watchers          Browser watch · Telemetry Radar
//          Radio, by the character
//
// Every door stayed, in the owner's order (2026-10-22): only the rules
// between them moved.
import type { Dispatch, SetStateAction } from "react";
import type { Providers } from "./providers";
import type { PanelToggles } from "./use-panel-return";
import { platformName } from "./platform";
import { settingsChordLabel, type SettingsSection } from "./settings";
import type { RailItem } from "./components/EdgeRails";
import type { IntegrationWebDef } from "./integrations/types";
import type { CapacityView } from "./components/AccountsUsageReport";
import {
  AccountsGlyph, BrowserWatchGlyph, CapacityGlyph, FeedbackGlyph, HistoryGlyph, IntegrationsGlyph, MachineGlyph, ResetCalendarGlyph,
  SessionListGlyph, SettingsGlyph, UsageGlyph, TrafficRadarGlyph, RadioGlyph, ToolActivityGlyph, SkillActivityGlyph,
} from "./components/rail-glyphs";
import type { ToolActivityView } from "./components/ToolAuditModal";

type Toggle = Dispatch<SetStateAction<boolean>>;

export interface RailItems {
  /** The left column's two, Accounts first: they share it, and opening one
   *  closes the other. */
  left: RailItem[];
  /** The left stripe's groups, top to bottom: Accounts with the two doors into
   *  its Account capacity report, then Session list. */
  leftStripe: RailItem[][];
  /** Account capacity and Reset calendar, each one press from the stripe and
   *  their only door. On a phone they are rows under More, so the dock keeps
   *  its five slots. Empty without Claude Code. */
  capacity: RailItem[];
  /** The right stripe's groups: its two panels, the activity records, the
   *  watchers, then Radio. */
  right: RailItem[][];
  /** Settings and Feedback, in the topbar's corner. */
  utilities: RailItem[];
  /** One per connected tracker kind (#2178) — Jira — under the left column's
   *  two, after a divider; on a phone, under More. Empty until a connection
   *  of that kind exists. */
  integrations: RailItem[];
  /** Permanent discovery action, separate from connected provider shortcuts. */
  explore: RailItem[];
}

/** A tracker kind with at least one connection, and the press that opens its
 *  panel. */
export interface IntegrationRail {
  provider: Pick<IntegrationWebDef, "kind" | "label" | "Glyph" | "shortcut" | "detail">;
  onPress: () => void;
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

/** A run of doors on a stripe that answer one question, named for the group a
 *  screen reader announces (EdgeRails.tsx). A door alone in its run needs no
 *  name beyond its own. */
function named(group: string, items: RailItem[]): RailItem[] {
  return items.map(item => ({ ...item, group }));
}

export function railItems({
  providers, sessionListOpen, toggleSessionList, accountsPanelOpen, toggleAccountsPanel,
  usagePanelOpen, setUsagePanelOpen, machinePanelOpen, setMachinePanelOpen, setUsageHistoryOpen,
  watchOn, watchUnseen, setBrowserWatchOpen, setTrafficRadarOpen, setRadioOpen, openToolActivity, openSettings, onFeedback, toggles,
  openCapacity, integrations = [], openExploreIntegrations,
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
  setTrafficRadarOpen?: Toggle;
  setRadioOpen?: Toggle;
  /** Open Tool activity on one of its two views — each has its own door. */
  openToolActivity?: (view: ToolActivityView) => void;
  /** The one door into Settings (use-settings-menus.ts). */
  openSettings: (section?: SettingsSection) => void;
  onFeedback: () => void;
  /** Where a panel's own close hands keyboard focus back (use-panel-return.ts). */
  toggles: PanelToggles;
  /** Open the Account capacity report on one of its two views. */
  openCapacity?: (view: CapacityView) => void;
  /** The connected tracker kinds, in the registry's order (#2178). */
  integrations?: IntegrationRail[];
  openExploreIntegrations?: () => void;
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
  // ACCOUNT CAPACITY AND RESET CALENDAR, ON THE STRIPE. Both lived behind the
  // gauge in the accounts panel's header, the calendar a tab inside its dialog,
  // and users said they could not find them. The gauge and the tabs are gone:
  // each door opens its own view, over whatever is open, and the left column
  // is not touched.
  const capacity: RailItem[] = openCapacity ? [{
    id: "account-capacity", label: "Account capacity", short: "Capacity", ariaLabel: "Account capacity",
    detail: "How many accounts are ready, and what the 5h and 7d windows have left",
    glyph: <CapacityGlyph />, kind: "dialog", onPress: () => openCapacity("accounts"),
  }, {
    id: "reset-calendar", label: "Reset calendar", short: "Calendar", ariaLabel: "Reset calendar",
    detail: "When each account's 5h and 7d windows come back",
    glyph: <ResetCalendarGlyph />, kind: "dialog", onPress: () => openCapacity("calendar"),
  }] : [];
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
  // TOOLS AND SKILLS, ONE DOOR EACH. Skills were a tab inside Tool activity,
  // and users said they could not find them. Each door opens its own view,
  // titled for itself, the way Account capacity and Reset calendar do; the
  // tabs between them are gone.
  const activity: RailItem[] = openToolActivity ? [{
    id: "tool-activity", label: "Tool activity", short: "Tools", ariaLabel: "Tool activity",
    glyph: <ToolActivityGlyph />, kind: "dialog",
    detail: "Which tools your agents run, how long they take and what fails", onPress: () => openToolActivity("tools"),
  }, {
    id: "skill-activity", label: "Skill activity", short: "Skills", ariaLabel: "Skill activity",
    glyph: <SkillActivityGlyph />, kind: "dialog",
    detail: "Which skills your agents use, whether you typed them or the agent called them", onPress: () => openToolActivity("skills"),
  }] : [];
  const radar: RailItem[] = setTrafficRadarOpen ? [{
    id: "traffic-radar", label: "Telemetry Radar", short: "Radar", ariaLabel: "Telemetry Radar",
    glyph: <TrafficRadarGlyph />, kind: "dialog",
    detail: "Claude telemetry configuration and observed connections", onPress: () => setTrafficRadarOpen(true),
  }] : [];
  // A dialog, like the doors above it: the explorer is a modal over the deck
  // (RadioPanel.tsx), so the button says it opens one rather than claiming a
  // panel beside the canvas that is never there.
  const radio: RailItem[] = setRadioOpen ? [{
    id: "radio", label: "Radio", short: "Radio", ariaLabel: "Radio",
    glyph: <RadioGlyph />, kind: "dialog",
    detail: "Explore stations around the world", onPress: () => setRadioOpen(true),
  }] : [];
  return {
    // Accounts first, at the top of the stripe and the start of the dock: the
    // owner's call (2026-10-08), the panel a first run opens and the one read
    // before choosing where to start a session.
    left: providers.claude ? [accounts, sessionList] : [sessionList],
    // The owner's order (2026-10-22): Claude accounts, Account capacity,
    // Reset calendar, Session list — the first three one group, since all
    // three are about the accounts.
    leftStripe: providers.claude ? [named("Claude accounts", [accounts, ...capacity]), [sessionList]] : [[sessionList]],
    capacity: providers.claude ? capacity : [],
    right: [
      named("Usage and machine", [usage, machine]),
      named("Activity history", [history, ...activity]),
      named("Watchers", [browserWatch, ...radar]),
      radio,
    ].filter(group => group.length > 0),
    utilities: [settings, feedback],
    explore: openExploreIntegrations ? [{
      id: "explore-integrations", label: "Explore integrations", short: "Integrations",
      ariaLabel: "Explore integrations", glyph: <IntegrationsGlyph />, kind: "dialog", onPress: openExploreIntegrations,
    }] : [],
    // Each opens its large modal, so a dialog: aria-haspopup and no state.
    integrations: integrations.map(({ provider, onPress }): RailItem => ({
      id: `integration-${provider.kind}`, label: provider.label, short: provider.label,
      ariaLabel: provider.label, detail: provider.detail,
      key: provider.shortcut ? { cap: provider.shortcut.toUpperCase(), aria: provider.shortcut.toUpperCase(), single: true } : undefined,
      glyph: <provider.Glyph />, kind: "dialog", onPress,
    })),
  };
}
