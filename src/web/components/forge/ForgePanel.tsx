// The GitHub and GitLab panel (#2179).
//
// Drawn inside the integrations host's large modal (#2178), below its header
// (the forge's glyph and name, the connection selector, Close). Everything
// under that is here: a toolbar with the project or repository, how fresh the
// list is and Refresh; the four tabs the owner works through on GitLab —
// Branches, Merge requests, Pipelines, Issues (Pull requests and Actions on
// GitHub); a search over what is loaded that also opens a pasted link; and on
// the right, the selected item the way the forge's own page shows it. The host's
// split draws list and detail side by side, or the detail as its own screen
// with Back on a narrow window.
//
// The view — project, tab, filters, which groups are unfolded — is remembered
// per connection through the host's prefs, so reopening the panel lands where
// the user left it.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { ForgeKind, ForgeRefTarget, Page, ForgeRepo } from "../../forge-types";
import { forgeWords } from "../../forge-types";
import {
  fetchForge, forgeReadPath, ForgeReadError, loadForgeView, looksLikeRef, saveForgeView, tabAllowsAllProjects,
  type ForgeApi, type ForgePrefs, type ForgeTab, type ForgeView,
} from "../../forge-panel";
import { selfPressAccepted, selfPressProps } from "../../panel-press";
import { tabStripMove } from "../../tablist-keys";
import { useForgeRead } from "../../use-forge-read";
import { RefreshGlyph } from "../action-glyphs";
import { ForgeProvider, type ForgeConnectionInfo, type ForgeContextValue, type ForgeSelection, type Freshness } from "./ForgeContext";
import { Ago, ReadFailure } from "./ForgeParts";
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

export default function ForgePanel({ kind, connection, api, assetUrl, prefs, narrow, onReconnect, Split }: ForgePanelProps) {
  const scope = `${kind}:${connection.id}`;
  const [view, setViewState] = useState<ForgeView>(() => loadForgeView(prefs));
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<ForgeSelection | null>(null);
  const [query, setQuery] = useState("");
  const [fresh, setFresh] = useState<Freshness>({ loadedAt: null, loading: false, stale: false });
  const [resolving, setResolving] = useState(false);
  // Open stays pressable while it resolves (#620); Enter in the field and a
  // second press are refused here, off a ref, not by disabling the button.
  const resolvingRef = useRef(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const uid = useId();
  const tabDomId = (tab: ForgeTab) => `${uid}-tab-${tab}`;
  const panelDomId = (tab: ForgeTab) => `${uid}-panel-${tab}`;

  // Another connection is another place: its own view, nothing selected.
  useEffect(() => {
    setViewState(loadForgeView(prefs));
    setSelected(null);
    setQuery("");
  }, [scope, prefs]);

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

  const ctx = useMemo<ForgeContextValue>(() => ({
    kind, connection, scope, api,
    asset: (url: string) => assetUrl(url),
    refresh,
    selected,
    select: setSelected,
    isOpen: (group: string) => view.open.includes(group),
    toggle,
    reportFreshness: setFresh,
    onReconnect,
    narrow,
  }), [kind, connection, scope, api, assetUrl, refresh, selected, view.open, toggle, onReconnect, narrow]);

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
      else setSelected(target.type === "change" ? { type: "change", repo: target.repo, number: target.number } : { type: "issue", repo: target.repo, number: target.number });
    } catch (err) {
      setResolveError(err instanceof ForgeReadError ? err.info.message : "Could not open it.");
    } finally {
      resolvingRef.current = false;
      setResolving(false);
    }
  };

  const chooseTab = (tab: ForgeTab) => { setView({ tab }); setQuery(""); };

  const words = forgeWords[kind];
  const tabProps: ForgeTabProps = { view, setView, query };
  const freshness = fresh.loading
    ? (fresh.loadedAt ? "Updating…" : "Loading…")
    : fresh.loadedAt
      ? <>{fresh.stale ? "Not updated · last answer " : "Updated "}<Ago at={fresh.loadedAt} /></>
      : null;

  const list = (
    <div className="fg-list">
      <div className="fg-toolbar">
        <RepoPicker value={view.repo} allowAll={allowsAll} onChange={repo => setView({ repo })} />
        <span className="fg-fresh" role="status" data-stale={fresh.stale || undefined}>{freshness}</span>
        <button
          type="button"
          className="glyph-btn fg-refresh"
          aria-label={`Refresh ${words.name}`}
          title="Refresh"
          data-loading={fresh.loading || undefined}
          aria-busy={fresh.loading}
          onClick={() => setRefresh(n => n + 1)}
        >
          <RefreshGlyph />
        </button>
      </div>
      {/* One tab stop for the strip, the arrows between its tabs (#581). */}
      <div
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
        <label className="fg-search">
          <span className="fg-sr">Search the list, or paste a link</span>
          <input
            type="search"
            placeholder={view.tab === "branches" ? "Filter by branch name" : `Search by title or number, or paste a ${words.name} link`}
            value={query}
            onChange={e => { setQuery(e.target.value); setResolveError(null); }}
            onKeyDown={e => { if (e.key === "Enter" && looksLikeRef(query)) void openRef(); }}
          />
        </label>
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
      <div className="fg-panel" data-kind={kind}>
        <Split list={list} detail={detail} onBack={() => setSelected(null)} backLabel={backLabel(kind, view.tab)} storageKey={kind} />
      </div>
    </ForgeProvider>
  );
}
