// The GitHub and GitLab panel (#2179).
//
// Drawn inside the integrations host's large modal (#2178), below its header
// (the forge's glyph and name, the connection selector, Close). Everything
// under that is here: a toolbar with the project or repository, how fresh the
// list is and Refresh; the four tabs a GitLab user works through —
// Branches, Merge requests, Pipelines, Issues (Pull requests and Actions on
// GitHub); a search over what is loaded that also opens a pasted link; and on
// the right, the selected item the way the forge's own page shows it. The host's
// split draws list and detail side by side, or the detail as its own screen
// with Back on a narrow window, and closes an open item on Escape at every
// width before the modal; the panel registers no Escape of its own for it.
//
// The view — project, tab, filters, which groups are unfolded — is remembered
// per connection through the host's prefs, so reopening the panel lands where
// the user left it. For the page's life it also keeps the search, and each
// project and tab keeps the item open there and both scrolls
// (integrations/view-memory.ts): reopening the panel, or coming back to a tab,
// puts that item back when it is still in the list, and opens the first row
// beside the list when there is none to put back.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { ForgeKind, ForgeRefTarget, Page, ForgeRepo } from "../../forge-types";
import { forgeWords } from "../../forge-types";
import {
  fetchForge, focusAfterSelect, forgeReadPath, ForgeReadError, loadForgeView, looksLikeRef, saveForgeView, tabAllowsAllProjects,
  type ForgeApi, type ForgePrefs, type ForgeTab, type ForgeView,
} from "../../forge-panel";
import { selfPressAccepted, selfPressProps } from "../../panel-press";
import { tabStripMove } from "../../tablist-keys";
import { useForgeRead } from "../../use-forge-read";
import { useListView } from "../../integrations/use-list-view";
import { keepList, keepSearch, listKey as listKeyOf, recallList, recallSearch, type Drawn } from "../../integrations/view-memory";
import IntegrationFreshness from "../IntegrationFreshness";
import IntegrationSearch from "../IntegrationSearch";
import {
  ForgeProvider, sameSelection, selectionKey, type ForgeConnectionInfo, type ForgeContextValue, type ForgeRows, type ForgeSelection, type Freshness,
} from "./ForgeContext";
import { ReadFailure, useChosenInView, useRovingRows } from "./ForgeParts";
import RepoPicker from "./RepoPicker";
import BranchesTab from "./BranchesTab";
import ChangesTab from "./ChangesTab";
import PipelinesTab from "./PipelinesTab";
import IssuesTab from "./IssuesTab";
import ChangeDetail from "./ChangeDetail";
import BranchDetail from "./BranchDetail";
import PipelineDetail from "./PipelineDetail";
import IssueDetail from "./IssueDetail";

/** The host's split (IntegrationSplit, #2178): list and detail side by side,
 *  or the detail as a screen of its own with Back below ~900px. */
export interface ForgeSplitProps {
  list: ReactNode;
  detail: ReactNode | null;
  onBack: () => void;
  backLabel: string;
  storageKey: string;
  /** Which item the detail shows, so the host can mark a new one arriving. */
  detailKey?: string;
}

export interface ForgePanelProps {
  kind: ForgeKind;
  connection: ForgeConnectionInfo;
  api: ForgeApi;
  assetUrl: (url: string) => string;
  prefs: ForgePrefs;
  narrow: boolean;
  onReconnect: () => void;
  Split: ComponentType<ForgeSplitProps>;
}

/** What every tab is given. */
export interface ForgeTabProps {
  view: ForgeView;
  setView: (patch: Partial<ForgeView>) => void;
  /** The search box's text: each tab keeps the loaded rows that match it. */
  query: string;
}

const TAB_ORDER: ForgeTab[] = ["branches", "changes", "pipelines", "issues"];

function tabLabel(kind: ForgeKind, tab: ForgeTab): string {
  switch (tab) {
    case "branches": return "Branches";
    case "changes": return forgeWords[kind].changes;
    case "pipelines": return forgeWords[kind].pipelines;
    case "issues": return "Issues";
  }
}

/** What the drill-in screen's Back returns to: "Back to merge requests". */
function backLabel(kind: ForgeKind, tab: ForgeTab): string {
  const label = tabLabel(kind, tab);
  return `Back to ${label === "Actions" ? label : label.toLowerCase()}`;
}

/** The list's scroller: the chosen tab's body. */
const LIST_SCROLLER = ".fg-tab-body:not([hidden])";

export default function ForgePanel({ kind, connection, api, assetUrl, prefs, narrow, onReconnect, Split }: ForgePanelProps) {
  const scope = `${kind}:${connection.id}`;
  const [view, setViewState] = useState<ForgeView>(() => loadForgeView(prefs));
  const [refresh, setRefresh] = useState(0);
  const [query, setQueryState] = useState(() => recallSearch(scope));
  const setQuery = useCallback((text: string) => { setQueryState(text); keepSearch(scope, text); }, [scope]);
  const [fresh, setFresh] = useState<Freshness>({ loadedAt: null, loading: false, stale: false });
  const [resolving, setResolving] = useState(false);
  // Open stays pressable while it resolves (#620); Enter in the field and a
  // second press are refused here, off a ref, not by disabling the button.
  const resolvingRef = useRef(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The rows are one Tab stop, walked with the arrow keys.
  useRovingRows(listRef);
  // The row a page was opened from. The split keeps the list mounted under the
  // drill-in screen, so Back and Close can hand focus back to it.
  const opener = useRef<HTMLElement | null>(null);
  const uid = useId();
  const tabDomId = (tab: ForgeTab) => `${uid}-tab-${tab}`;
  const panelDomId = (tab: ForgeTab) => `${uid}-panel-${tab}`;

  // Another connection is another place: its own view and its own search.
  // What is open is the list's, whose key names the connection.
  const place = useRef(scope);
  useEffect(() => {
    if (place.current === scope) return;
    place.current = scope;
    setViewState(loadForgeView(prefs));
    setQueryState(recallSearch(scope));
  }, [scope, prefs]);

  // The item open beside the list, kept per project and tab. The tab on show
  // says which rows it drew (useReportRows): a remembered item still among
  // them is put back, else the first row opens. Quietly: no focus moves.
  const listKey = listKeyOf(scope, view.repo, view.tab);
  const [rows, setRows] = useState<ForgeRows | null>(null);
  const drawn = useMemo<Drawn<ForgeSelection> | null>(() => (rows && rows.key === listKey ? {
    complete: rows.complete,
    has: item => rows.items.some(row => sameSelection(row, item)),
    first: rows.items[0] ?? null,
  } : null), [rows, listKey]);
  const shown = useListView<ForgeSelection>({ listKey, drawn, same: sameSelection, sideBySide: !narrow, root: panelRef, listScroller: LIST_SCROLLER });
  const { choose } = shown;
  const selected = shown.selection;

  const setView = useCallback((patch: Partial<ForgeView>) => {
    setViewState(v => {
      const next = { ...v, ...patch };
      saveForgeView(prefs, next);
      return next;
    });
  }, [prefs]);

  const toggle = useCallback((group: string) => {
    setViewState(v => {
      const open = v.open.includes(group) ? v.open.filter(g => g !== group) : [...v.open, group].slice(-20);
      const next = { ...v, open };
      saveForgeView(prefs, next);
      return next;
    });
  }, [prefs]);

  const select = useCallback((next: ForgeSelection | null) => {
    const active = document.activeElement;
    const fromList = active instanceof HTMLElement && active.closest(".ig-list") != null;
    if (next && fromList) opener.current = active;
    choose(next);
    const target = focusAfterSelect(next != null, fromList, narrow);
    requestAnimationFrame(() => {
      if (target === "opener" && opener.current?.isConnected) opener.current.focus();
      else if (target === "page") panelRef.current?.querySelector<HTMLElement>(".ig-detail .fd")?.focus();
    });
  }, [narrow, choose]);

  const recallSection = useCallback(() => recallList<ForgeSelection>(listKey)?.section ?? null, [listKey]);
  const keepSection = useCallback((section: string) => keepList<ForgeSelection>(listKey, { section }), [listKey]);

  const ctx = useMemo<ForgeContextValue>(() => ({
    kind, connection, scope, api,
    asset: (url: string) => assetUrl(url),
    refresh,
    selected,
    select,
    isOpen: (group: string) => view.open.includes(group),
    toggle,
    reportFreshness: setFresh,
    onReconnect,
    narrow,
    listKey,
    reportRows: setRows,
    recallSection,
    keepSection,
  }), [kind, connection, scope, api, assetUrl, refresh, selected, select, view.open, toggle, onReconnect, narrow, listKey, recallSection, keepSection]);

  // A tab that reads one project needs one: the most recently active, until
  // the user picks another.
  const allowsAll = tabAllowsAllProjects(kind, view.tab);
  const needsRepo = !allowsAll && !view.repo;
  const repos = useForgeRead<Page<ForgeRepo>>(api, scope, needsRepo ? "repos" : null, {}, refresh);
  useEffect(() => {
    const first = repos.data?.items[0];
    if (needsRepo && first) setView({ repo: first.path });
  }, [needsRepo, repos.data, setView]);

  const openRef = async () => {
    if (!selfPressAccepted(resolvingRef.current)) return;
    resolvingRef.current = true;
    setResolving(true);
    setResolveError(null);
    try {
      const target = await fetchForge<ForgeRefTarget | null>(api, forgeReadPath("resolve", { q: query.trim() }));
      if (!target) setResolveError("Nothing to open at that address.");
      else select(target.type === "change" ? { type: "change", repo: target.repo, number: target.number } : { type: "issue", repo: target.repo, number: target.number });
    } catch (err) {
      setResolveError(err instanceof ForgeReadError ? err.info.message : "Could not open it.");
    } finally {
      resolvingRef.current = false;
      setResolving(false);
    }
  };

  // Each tab is a list of its own, with its own item open; the search is
  // for the list it was typed over, so a new tab starts without it.
  const chooseTab = (tab: ForgeTab) => { setView({ tab }); setQuery(""); };
  useChosenInView(tabsRef, view.tab);

  const words = forgeWords[kind];
  const tabProps: ForgeTabProps = { view, setView, query };

  const list = (
    <div ref={listRef} className="fg-list">
      <div className="fg-toolbar">
        <RepoPicker value={view.repo} allowAll={allowsAll} onChange={repo => setView({ repo })} />
        <IntegrationFreshness loadedAt={fresh.loadedAt} loading={fresh.loading} stale={fresh.stale}
          onRefresh={() => setRefresh(n => n + 1)} label={`Refresh ${words.name}`} />
      </div>
      {/* One tab stop for the strip, the arrows between its tabs (#581). */}
      <div
        ref={tabsRef}
        className="uh-range fg-tabs"
        role="tablist"
        aria-label={`${words.name} views`}
        onKeyDown={event => {
          const move = tabStripMove(event, TAB_ORDER.indexOf(view.tab), TAB_ORDER.length);
          if (move.kind === "pass") return;
          event.preventDefault();
          event.stopPropagation();
          chooseTab(TAB_ORDER[move.index]);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[move.index]?.focus();
        }}
      >
        {TAB_ORDER.map(tab => (
          <button
            key={tab}
            id={tabDomId(tab)}
            type="button"
            role="tab"
            className="uh-range-btn"
            aria-selected={view.tab === tab}
            aria-controls={panelDomId(tab)}
            tabIndex={view.tab === tab ? 0 : -1}
            onClick={() => chooseTab(tab)}
          >
            {tabLabel(kind, tab)}
          </button>
        ))}
      </div>
      <div className="fg-searchbar">
        {/* The integrations' shared field: Escape empties it before it closes
            anything. A phone gets the short hint; the name says it all. */}
        <IntegrationSearch
          value={query}
          onChange={v => { setQuery(v); setResolveError(null); }}
          label={view.tab === "branches" ? "Filter by branch name" : `Search by title or number, or paste a ${words.name} link`}
          placeholder={view.tab === "branches" ? "Filter by branch name" : narrow ? `Search, or paste a ${words.name} link` : `Search by title or number, or paste a ${words.name} link`}
          onKeyDown={e => { if (e.key === "Enter" && looksLikeRef(query)) void openRef(); }}
        />
        {looksLikeRef(query) && (
          <button type="button" className="btn fg-resolve" onClick={() => void openRef()} {...selfPressProps(resolving)}>
            {resolving ? "Opening…" : "Open"}
          </button>
        )}
      </div>
      {resolveError && <p className="fg-note" role="status">{resolveError}</p>}
      {/* A panel per tab, so each tab names the one it controls; only the
          chosen tab's is drawn, and it alone reads. */}
      {TAB_ORDER.map(tab => (
        <div key={tab} className="fg-tab-body" id={panelDomId(tab)} role="tabpanel" aria-labelledby={tabDomId(tab)} hidden={view.tab !== tab}>
          {view.tab !== tab ? null
            : needsRepo
              ? repos.error
                ? <ReadFailure error={repos.error} onRetry={repos.reload} />
                : repos.data && !repos.data.items.length
                  ? <p className="fg-empty">This token can see no {words.repo.toLowerCase()} yet.</p>
                  : <p className="fg-note">Finding your most recent {words.repo.toLowerCase()}…</p>
              : tab === "branches" ? <BranchesTab {...tabProps} />
              : tab === "changes" ? <ChangesTab {...tabProps} />
              : tab === "pipelines" ? <PipelinesTab {...tabProps} />
              : <IssuesTab {...tabProps} />}
        </div>
      ))}
    </div>
  );

  const detail = !selected ? null
    : selected.type === "change" ? <ChangeDetail key={`${selected.repo}!${selected.number}`} selection={selected} />
    : selected.type === "branch" ? <BranchDetail key={`${selected.repo}@${selected.name}`} selection={selected} />
    : selected.type === "pipeline" ? <PipelineDetail key={`${selected.repo}/p/${selected.id}`} selection={selected} />
    : <IssueDetail key={`${selected.repo}#${selected.number}`} selection={selected} />;

  return (
    <ForgeProvider value={ctx}>
      <div ref={panelRef} className="fg-panel" data-kind={kind}>
        <Split list={list} detail={detail} onBack={() => select(null)} backLabel={backLabel(kind, view.tab)} storageKey={kind} detailKey={selected ? selectionKey(selected) : undefined} />
      </div>
    </ForgeProvider>
  );
}
