// Which tab of the Inspector was last open. The keys that move between the tabs
// are tablist-keys.ts's, shared by every strip in the deck.
//
// The tab is a preference of this browser and nothing else: it goes through
// storage.ts, which swallows a store that throws, so a blocked store costs the
// next load its memory of the tab and never this render. The Time tab reads the
// session's turn from the server (inspector-time.ts), so it is only asked for
// while it is the tab shown.
import { readStored, writeStored } from "./storage";

export const INSPECTOR_TABS = ["agents", "time", "context"] as const;
export type InspectorTab = typeof INSPECTOR_TABS[number];

export const INSPECTOR_TAB_KEY = "agent-dag.inspector-tab";

export const INSPECTOR_TAB_LABEL: Record<InspectorTab, string> = { agents: "Agents", time: "Time", context: "Context" };

/** The remembered tab, Agents when there is none or it is not one of ours. */
export function loadInspectorTab(): InspectorTab {
  const stored = readStored(INSPECTOR_TAB_KEY);
  return INSPECTOR_TABS.find(t => t === stored) ?? "agents";
}

export function saveInspectorTab(tab: InspectorTab): void {
  writeStored(INSPECTOR_TAB_KEY, tab);
}
