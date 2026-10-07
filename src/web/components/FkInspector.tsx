// The Fork look's inspector: the tab bar under the history (Commit, Changes,
// and File Tree once its reads exist) and the body of the tab on show. The bar
// stays when the inspector is folded away; the history then takes its room.
//
// Tabs follow the WAI-ARIA tabs pattern: one Tab stop on the tab on show, the
// arrows walk the bar and switch as they go, as a press does. 1, 2 and 3 pick a
// tab from anywhere in the view (git-view-keys.ts).
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import type { GitInspectorTab } from "../git-view-types";
import { tabStripMove } from "../tablist-keys";

/** The tabs the inspector draws, in bar order: 1, 2, 3. A tab whose reads do
 *  not exist yet is left out, never drawn dead. */
export const FK_TABS: ReadonlyArray<{ id: GitInspectorTab; label: string }> = [
  { id: "commit", label: "Commit" },
  { id: "changes", label: "Changes" },
];

/** The tab on show for a remembered one: a tab not drawn opens on Changes. */
export const shownTab = (tab: GitInspectorTab): GitInspectorTab => (FK_TABS.some(t => t.id === tab) ? tab : "changes");

export default function FkInspector({ tab, onTab, collapsed, onToggleCollapsed, children }: {
  tab: GitInspectorTab;
  onTab: (tab: GitInspectorTab) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  children: ReactNode;
}) {
  const uid = useId();
  const on = shownTab(tab);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const move = tabStripMove(e, FK_TABS.findIndex(t => t.id === on), FK_TABS.length);
    if (move.kind === "pass") return;
    e.preventDefault();
    onTab(FK_TABS[move.index].id);
    tabRefs.current[move.index]?.focus();
  };
  return (
    <section className="fk-inspector" aria-label="Inspector" data-collapsed={collapsed ? "" : undefined}>
      <div className="fk-tabbar">
        <div className="fk-tabs" role="tablist" aria-label="Inspector" onKeyDown={onKey}>
          {FK_TABS.map((t, i) => (
            <button
              key={t.id} ref={el => { tabRefs.current[i] = el; }} type="button" role="tab" className="fk-tab" id={`${uid}-tab-${t.id}`}
              aria-selected={t.id === on} aria-controls={`${uid}-panel`} tabIndex={t.id === on ? 0 : -1}
              aria-keyshortcuts={String(i + 1)}
              onClick={() => { onTab(t.id); if (collapsed) onToggleCollapsed(); }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button" className="fk-tabbar-tool" aria-pressed={!collapsed}
          title={collapsed ? "Show the inspector" : "Hide the inspector"}
          aria-label={collapsed ? "Show the inspector" : "Hide the inspector"}
          onClick={onToggleCollapsed}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
            <rect x="0.6" y="0.6" width="10.8" height="10.8" rx="2" />
            <path d="M0.6 7.4h10.8" />
            {!collapsed && <path d="M1.6 8.4h8.8v2H1.6z" fill="currentColor" stroke="none" />}
          </svg>
        </button>
      </div>
      {/* Kept while folded, so every tab still controls a panel; what it
          holds is drawn only while it shows. */}
      <div className="fk-inspector-body" role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${on}`} hidden={collapsed}>
        {!collapsed && children}
      </div>
    </section>
  );
}
