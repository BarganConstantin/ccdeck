// Which tab of the Inspector was last open, and whether its Details were. The
// keys that move between the tabs are tablist-keys.ts's, shared by every strip
// in the deck.
//
// Both are preferences of this browser and nothing else: they go through
// storage.ts, which swallows a store that throws, so a blocked store costs the
// next load its memory of them and never this render. The Time tab reads the
// session's turn from the server (inspector-time.ts), so it is only asked for
// while it is the tab shown.
import { readStored, writeStored } from "./storage";
import { t } from "./i18n";

export const INSPECTOR_TABS = ["agents", "time", "context"] as const;
export type InspectorTab = typeof INSPECTOR_TABS[number];

export const INSPECTOR_TAB_KEY = "agent-dag.inspector-tab";

/** Each read gives the label in the language on show. */
export const INSPECTOR_TAB_LABEL: Record<InspectorTab, string> = {
  get agents() { return t("board.inspector.tabAgents"); },
  get time() { return t("board.inspector.tabTime"); },
  get context() { return t("board.inspector.tabContext"); },
};

/** The remembered tab, Agents when there is none or it is not one of ours. */
export function loadInspectorTab(): InspectorTab {
  const stored = readStored(INSPECTOR_TAB_KEY);
  return INSPECTOR_TABS.find(t => t === stored) ?? "agents";
}

export function saveInspectorTab(tab: InspectorTab): void {
  writeStored(INSPECTOR_TAB_KEY, tab);
}

/** The Agents tab's Details (the spend split, the identity and the tool calls)
 *  are shut until someone opens them, and stay as that viewer last left them:
 *  across the sessions they select and across reloads. */
export const INSPECTOR_DETAILS_KEY = "agent-dag.inspector-details";

/** Open only when this browser last left them open. */
export function loadInspectorDetailsOpen(): boolean {
  return readStored(INSPECTOR_DETAILS_KEY) === "1";
}

export function saveInspectorDetailsOpen(open: boolean): void {
  writeStored(INSPECTOR_DETAILS_KEY, open ? "1" : "0");
}
