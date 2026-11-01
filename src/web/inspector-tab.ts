// Which tab of the Inspector was last open. The keys that move between the tabs
// are tablist-keys.ts's, shared by every strip in the deck.
//
// The tab is a preference of this browser and nothing else: it goes through
// storage.ts, which swallows a store that throws, so a blocked store costs the
// next load its memory of the tab and never this render. There is no Time tab:
// the deck holds no per-turn waiting or thinking time to draw one from (the
// reducer keeps only the block a session is in now), so the tabs are the two
// the data can fill.
import { readStored, writeStored } from "./storage";

export const INSPECTOR_TABS = ["agents", "context"] as const;
export type InspectorTab = typeof INSPECTOR_TABS[number];

export const INSPECTOR_TAB_KEY = "agent-dag.inspector-tab";

export const INSPECTOR_TAB_LABEL: Record<InspectorTab, string> = { agents: "Agents", context: "Context" };

/** The remembered tab, Agents when there is none or it is not one of ours. */
export function loadInspectorTab(): InspectorTab {
  const stored = readStored(INSPECTOR_TAB_KEY);
  return INSPECTOR_TABS.find(t => t === stored) ?? "agents";
}

export function saveInspectorTab(tab: InspectorTab): void {
  writeStored(INSPECTOR_TAB_KEY, tab);
}
