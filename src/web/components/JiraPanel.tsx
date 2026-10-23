// The Jira panel (#2178): a replica of Jira's Backlog page, the screen a Jira
// user reads most, under the host's header (IntegrationModal) — a board
// picker, the filters Jira's own page has, the board's groups and their
// issues, and one issue in full beside them.
//
// WHAT IT REMEMBERS, per connection (the host's `prefs`): the board on show,
// "Only my issues" (on the first time, then as left), "Hide done", the board's
// quick filters that were on, and which groups were open. For the page's life
// (integrations/view-memory.ts) it also keeps the search, and each board keeps
// the issue open beside it with its breadcrumb, the rows whose sub-tasks are
// shown, and both scrolls: reopening the panel, or going back to a board,
// puts that issue back when it is still on the board as drawn.
//
// WHEN IT READS: when it opens on a board read more than five minutes ago, and
// when Refresh is pressed. Never on a timer (use-jira-board.ts).
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { connectionHost, type IntegrationFailure } from "../integrations/client";
import type { IntegrationPanelProps } from "../integrations/types";
import { readBoards, type JiraBoardSummary } from "../jira-api";
import { boardRows, drawnIssues, shownQuickFilters, type GroupDef } from "../jira-board";
import { useListView } from "../integrations/use-list-view";
import { keepList, keepSearch, listKey as listKeyOf, recallList, recallSearch, type Drawn } from "../integrations/view-memory";
import { failureOf, useJiraBoard } from "../use-jira-board";
import { ExternalLinkGlyph } from "./action-glyphs";
import AnchoredPopover from "./AnchoredPopover";
import IntegrationFreshness from "./IntegrationFreshness";
import IntegrationSearch from "./IntegrationSearch";
import IntegrationSkeleton from "./IntegrationSkeleton";
import IntegrationSplit from "./IntegrationSplit";
import JiraBacklog from "./JiraBacklog";
import JiraIssueDetail from "./JiraIssueDetail";
import IntegrationFailureNote from "./IntegrationFailureNote";
import { Chevron } from "./JiraParts";

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 40;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isFlags = (v: unknown): v is Record<string, boolean> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every(x => typeof x === "boolean");
const isQuick = (v: unknown): v is { board: string; ids: string[] } =>
  Boolean(v) && typeof v === "object" && typeof (v as { board?: unknown }).board === "string"
  && Array.isArray((v as { ids?: unknown }).ids) && (v as { ids: unknown[] }).ids.every(x => typeof x === "string");

// ── the board picker ────────────────────────────────────────────────────────

interface BoardPage { boards: JiraBoardSummary[]; isLast: boolean; total: number | null; loading: boolean; error: IntegrationFailure | null }

function BoardPicker({ api, current, layerId, onPick, onClose }: {
  api: IntegrationPanelProps["api"];
  current: string | null;
  /** The span the picker is drawn in and hangs off: the popover's width,
   *  with the board button at its start (see the toolbar). */
  layerId: string;
  onPick: (board: JiraBoardSummary) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<BoardPage>({ boards: [], isLast: false, total: null, loading: true, error: null });
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const reqRef = useRef(0);

  const load = useCallback((name: string, startAt: number) => {
    const mine = ++reqRef.current;
    setPage(p => ({ ...p, loading: true, error: null, ...(startAt === 0 ? { boards: [] } : {}) }));
    readBoards(api, startAt, name)
      .then(answer => {
        if (mine !== reqRef.current) return;
        setPage(p => ({
          boards: startAt === 0 ? answer.boards : [...p.boards, ...answer.boards.filter(b => !p.boards.some(x => x.id === b.id))],
          isLast: answer.isLast, total: answer.total, loading: false, error: null,
        }));
      })
      .catch(err => { if (mine === reqRef.current) setPage(p => ({ ...p, loading: false, error: failureOf(err) })); });
  }, [api]);

  // Searching is Jira's: by board name, a quarter of a second after typing stops.
  useEffect(() => {
    const t = window.setTimeout(() => load(query.trim(), 0), query ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [query, load]);

  const items = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-board]") ?? []);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const list = items();
    if (!list.length) return;
    e.preventDefault();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (at < 0 ? 0 : Math.min(list.length - 1, at + 1)) : at <= 0 ? -1 : at - 1;
    if (next < 0) searchRef.current?.focus(); else list[next].focus();
  };

  return (
    <AnchoredPopover anchorId={layerId} portalRootId={layerId} id="jira-board-picker" className="jr-board-pop" role="dialog"
      labelledBy="jira-board-picker-title" focusRef={searchRef} onClose={onClose}>
      <div className="jr-board-pop-inner" onKeyDown={onKeyDown}>
        <p className="jr-board-pop-title" id="jira-board-picker-title">Boards</p>
        <IntegrationSearch value={query} onChange={setQuery} label="Find a board by name" placeholder="Find a board by name" inputRef={searchRef} />
        <ul className="jr-board-list" role="list" ref={listRef} aria-label="Boards" aria-busy={page.loading || undefined}>
          {page.boards.map(b => (
            <li key={b.id}>
              <button type="button" data-board={b.id} className="jr-board-item" aria-current={String(b.id) === current || undefined}
                onClick={() => onPick(b)}>
                <span className="jr-board-item-name">{b.name}</span>
                <span className="jr-board-item-meta">{[b.type, b.projectName || b.projectKey].filter(Boolean).join(" · ")}</span>
              </button>
            </li>
          ))}
        </ul>
        {page.loading && <p className="jr-board-pop-note" role="status">Reading boards…</p>}
        {!page.loading && page.error && <p className="jr-board-pop-note" role="alert">{page.error.message}</p>}
        {!page.loading && !page.error && page.boards.length === 0 && <p className="jr-board-pop-note">{query ? "No board by that name." : "No boards this account can see."}</p>}
        {!page.loading && !page.isLast && page.boards.length > 0 && (
          <button type="button" className="btn jr-board-more" onClick={() => load(query.trim(), page.boards.length)}>
            Show more boards{page.total != null ? ` (${page.boards.length} of ${page.total})` : ""}
          </button>
        )}
      </div>
    </AnchoredPopover>
  );
}

// ── the panel ───────────────────────────────────────────────────────────────

/** The panel's selection is the trail: the issues opened on the way to the
 *  one on show, which is the last. Two are the same when they show it. */
const sameIssue = (a: string[], b: string[]) => a[a.length - 1] === b[b.length - 1];

export default function JiraPanel({ connection: conn, api, assetUrl, prefs, narrow, onReconnect }: IntegrationPanelProps) {
  const scope = `jira:${conn.id}`;
  const [board, setBoardState] = useState<string | null>(() => prefs.read("board", isString) ?? null);
  const [boardName, setBoardName] = useState<string>(() => prefs.read("boardName", (v): v is string => typeof v === "string") ?? "");
  const [mine, setMine] = useState(() => prefs.read("mine", isBool) ?? true);
  const [hideDone, setHideDone] = useState(() => prefs.read("hideDone", isBool) ?? false);
  const [attention, setAttention] = useState(() => prefs.read("attention", isBool) ?? false);
  const [quick, setQuick] = useState<string[]>(() => {
    const saved = prefs.read("quick", isQuick);
    return saved && saved.board === board ? saved.ids : [];
  });
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => prefs.read("expanded", isFlags) ?? {});
  const [search, setSearchState] = useState(() => recallSearch(scope));
  const setSearch = (text: string) => { setSearchState(text); keepSearch(scope, text); };
  const [picker, setPicker] = useState(false);
  const [boardsError, setBoardsError] = useState<IntegrationFailure | null>(null);
  const [noBoards, setNoBoards] = useState(false);

  useEffect(() => { prefs.write("mine", mine); }, [prefs, mine]);
  useEffect(() => { prefs.write("hideDone", hideDone); }, [prefs, hideDone]);
  useEffect(() => { prefs.write("attention", attention); }, [prefs, attention]);
  useEffect(() => { if (board) prefs.write("quick", { board, ids: quick }); }, [prefs, board, quick]);
  useEffect(() => { prefs.write("expanded", expanded); }, [prefs, expanded]);

  const chooseBoard = useCallback((b: Pick<JiraBoardSummary, "id" | "name">) => {
    const id = String(b.id);
    setBoardState(id);
    setBoardName(b.name);
    prefs.write("board", id);
    prefs.write("boardName", b.name);
    setQuick([]);
  }, [prefs]);

  // No board remembered: the first one this account can see.
  const firstBoard = useCallback(() => {
    setBoardsError(null);
    setNoBoards(false);
    readBoards(api, 0, "")
      .then(answer => { if (answer.boards[0]) chooseBoard(answer.boards[0]); else setNoBoards(true); })
      .catch(err => setBoardsError(failureOf(err)));
  }, [api, chooseBoard]);
  useEffect(() => { if (!board) firstBoard(); }, [board, firstBoard]);

  const filters = useMemo(() => ({ mine, quick }), [mine, quick]);
  const jira = useJiraBoard(api, conn.id, board, filters);
  const { snap, groups, loading, error } = jira;
  const overview = snap.overview && String(snap.overview.board.id) === board ? snap.overview : null;
  useEffect(() => {
    if (overview && overview.board.name && overview.board.name !== boardName) {
      setBoardName(overview.board.name);
      prefs.write("boardName", overview.board.name);
    }
  }, [overview, boardName, prefs]);

  // Closed sprints, once shown, are read as they are opened.
  const { ensureGroup } = jira;
  useEffect(() => {
    for (const g of groups) if (g.kind === "closed" && expanded[g.id]) ensureGroup(g);
  }, [groups, expanded, ensureGroup]);

  const toggleGroup = (group: GroupDef, open: boolean) => setExpanded(state => ({ ...state, [group.id]: open }));
  const filtered = mine || hideDone || attention || quick.length > 0 || search.trim() !== "";
  const clearFilters = () => { setMine(false); setHideDone(false); setAttention(false); setQuick([]); setSearch(""); };
  const rowFilter = useMemo(() => ({ search, hideDone, attention }), [search, hideDone, attention]);

  // The board's own quick filters, less its "Only My Issues" (the panel's
  // chip does that). A saved choice the board no longer draws, that one
  // included, is dropped rather than left filtering out of sight.
  const quickFilters = useMemo(() => shownQuickFilters(overview?.quickFilters ?? []), [overview]);
  useEffect(() => {
    if (!overview) return;
    const drawn = new Set(quickFilters.map(q => q.id));
    setQuick(ids => (ids.every(id => drawn.has(id)) ? ids : ids.filter(id => drawn.has(id))));
  }, [overview, quickFilters]);

  // ── what is open, per board ──
  // The rows whose sub-tasks are shown, kept with the board, and read back
  // while rendering when the board changes, so the issues they draw are
  // there when the board says what it has drawn.
  const listKey = listKeyOf(scope, board);
  const [rows, setRows] = useState(() => ({ key: listKey, open: recallList<string[]>(listKey)?.rows ?? {} }));
  let rowsOpen = rows.open;
  if (rows.key !== listKey) {
    rowsOpen = recallList<string[]>(listKey)?.rows ?? {};
    setRows({ key: listKey, open: rowsOpen });
  }
  const toggleRow = (key: string, open: boolean) => {
    const next = { ...rowsOpen, [key]: open };
    setRows({ key: listKey, open: next });
    keepList<string[]>(listKey, { rows: next });
  };

  const built = useMemo(() => (overview ? boardRows(groups, snap.groups, key => snap.subtasks[key]?.issues, rowFilter) : []),
    [overview, groups, snap.groups, snap.subtasks, rowFilter]);
  const drawn = useMemo<Drawn<string[]> | null>(() => {
    if (!overview) return null;
    const { complete, keys } = drawnIssues(built, expanded, rowsOpen, snap.subtasks, rowFilter, filtered);
    // The issue opened from the list is the trail's first.
    return { complete, has: trail => keys.has(trail[0]) };
  }, [overview, built, expanded, rowsOpen, snap.subtasks, rowFilter, filtered]);
  const rootRef = useRef<HTMLDivElement>(null);
  const view = useListView<string[]>({ listKey, drawn, same: sameIssue, root: rootRef, listScroller: ".jr-list-scroll" });
  const { choose } = view;
  const trail = useMemo(() => view.selection ?? [], [view.selection]);

  // ── the detail, and the way back from it ──
  const open = trail.length > 0;
  const openIssue = (key: string) => {
    choose([key]);
    // On a narrow screen the row goes with the list: focus goes to the issue's
    // name, or to Back until the name is read (JiraIssueDetail moves it on).
    if (narrow) {
      requestAnimationFrame(() => (document.getElementById("jira-detail-title")
        ?? document.querySelector<HTMLElement>(".ig-detail [data-ig-back]"))?.focus());
    }
  };
  // Back and Escape both come here (the split puts an open issue on the
  // deck's dismiss stack, at every width): focus goes back to the issue's row.
  const back = useCallback(() => {
    const key = trail[0];
    choose(null);
    requestAnimationFrame(() => {
      const row = key ? document.querySelector<HTMLElement>(`.jr-row-main[data-key="${CSS.escape(key)}"]`) : null;
      row?.focus();
    });
  }, [trail, choose]);

  const host = connectionHost(conn);
  const blocking = !overview ? (error ?? boardsError) : null;

  const list = (() => {
    if (noBoards) {
      return (
        <div className="jr-state">
          <h3>No boards here</h3>
          <p>This account cannot see any board on {host}. A board appears here once you are given access to one in Jira.</p>
          <p><a className="ig-open" href={`${conn.baseUrl}/secure/ManageRapidViews.jspa`} target="_blank" rel="noreferrer noopener">Open boards in Jira<ExternalLinkGlyph /></a></p>
        </div>
      );
    }
    if (blocking) {
      return (
        <div className="jr-state">
          <IntegrationFailureNote error={blocking} provider="Jira" host={host} onRetry={board ? jira.refresh : firstBoard} onReconnect={onReconnect} />
          {blocking.kind === "not-found" && board && (
            <p><button type="button" className="btn" onClick={() => setPicker(true)}>Choose another board</button></p>
          )}
        </div>
      );
    }
    if (!overview) {
      return <IntegrationSkeleton label="Reading the board" rows={6} />;
    }
    return (
      <>
        {error && <IntegrationFailureNote error={error} provider="Jira" host={host} stale onRetry={jira.refresh} onReconnect={onReconnect} />}
        <JiraBacklog
          conn={conn}
          overview={overview}
          groups={groups}
          snap={snap}
          expanded={expanded}
          onToggleGroup={toggleGroup}
          filter={rowFilter}
          mine={mine}
          filtered={filtered}
          selected={trail[trail.length - 1] ?? null}
          onOpen={openIssue}
          rowsOpen={rowsOpen}
          onToggleRow={toggleRow}
          onRetryGroup={g => jira.ensureGroup(g, true)}
          onMore={jira.loadMore}
          onShowClosed={jira.showClosed}
          onMoreClosed={jira.moreClosed}
          loadSubtasks={jira.loadSubtasks}
          onReconnect={onReconnect}
        />
      </>
    );
  })();

  const detail = open && overview ? (
    <JiraIssueDetail
      conn={conn}
      api={api}
      assetUrl={assetUrl}
      trail={trail}
      estimation={overview.estimation.kind}
      time={overview.timeTracking}
      onOpen={(key, how) => choose(how === "push" ? [...trail.filter(k => k !== key), key] : [key])}
      onTrail={index => choose(trail.slice(0, index + 1))}
      onReconnect={onReconnect}
      narrow={narrow}
      auto={view.auto}
      onClose={back}
    />
  ) : null;

  return (
    <div ref={rootRef} className="jr-panel" data-deployment={conn.meta?.deployment === "cloud" ? "cloud" : "server"}>
      {/* On a narrow screen an open issue is a screen of its own, and the
          board, search and filters are the list's: they wait behind Back. */}
      <div className="jr-toolbar" hidden={narrow && open}>
        <div className="jr-toolbar-row">
          {/* The board picker is drawn inside this span and hangs off it, the
              way the forges' project picker does: the deck's popovers line up
              with their anchor's end, and the span is the popover's width with
              the button at its start, so the list opens under the button
              instead of running out past the panel's left edge. Being inside
              the integration dialog keeps it within the dialog's modal
              boundary too. */}
          <span id="jira-board-layer" className="jr-board-layer">
            <button type="button" id="jira-board-button" className="btn jr-board-btn" aria-haspopup="dialog" aria-expanded={picker}
              aria-controls={picker ? "jira-board-picker" : undefined} onClick={() => setPicker(p => !p)}>
              <span className="jr-board-btn-label">Board</span>
              <span className="jr-board-btn-name">{overview?.board.name || boardName || (board ? `Board ${board}` : "Choose a board")}</span>
              <Chevron open={picker} />
            </button>
            {overview?.board.projectName && <span className="jr-board-project">{overview.board.projectName}</span>}
          </span>
          {/* After a refresh that failed the rows on screen are the last
              answer, and the line says "Not updated", never "Updated". */}
          <IntegrationFreshness loadedAt={snap.loadedAt || null} loading={loading} stale={Boolean(error)}
            onRefresh={() => { if (board) jira.refresh(); else firstBoard(); }} label="Refresh the board" disabled={!board} />
        </div>
        <div className="jr-filters" role="group" aria-label="Filters">
          {/* Escape empties it first (the shared field's own entry on the
              dismiss stack), then leaves the issue, then closes the panel. */}
          <IntegrationSearch value={search} onChange={setSearch} label="Search issues by key or summary" placeholder="Search key or summary" />
          {/* One row that scrolls sideways on a phone, rather than three rows
              of chips over the board. */}
          <div className="jr-filter-chips">
            <button type="button" className="btn jr-chip" aria-pressed={mine} onClick={() => setMine(m => !m)}>Only my issues</button>
            <button type="button" className="btn jr-chip" aria-pressed={hideDone} onClick={() => setHideDone(h => !h)}>Hide done</button>
            <button type="button" className="btn jr-chip" aria-pressed={attention} title="Flagged, or Highest, Blocker or Critical priority, and not done"
              onClick={() => setAttention(a => !a)}>Needs attention</button>
            {quickFilters.map(q => (
              <button key={q.id} type="button" className="btn jr-chip" aria-pressed={quick.includes(q.id)} title={q.description || undefined}
                onClick={() => setQuick(list => (list.includes(q.id) ? list.filter(x => x !== q.id) : [...list, q.id]))}>
                {q.name}
              </button>
            ))}
            {filtered && <button type="button" className="jr-link-btn jr-clear" onClick={clearFilters}>Clear filters</button>}
          </div>
        </div>
      </div>

      <IntegrationSplit
        storageKey="jira"
        list={<div className="jr-list-scroll">{list}</div>}
        detail={detail}
        onBack={back}
        backLabel="Back to the board"
        detailKey={trail[trail.length - 1]}
      />

      {picker && (
        <BoardPicker api={api} current={board} layerId="jira-board-layer"
          onPick={b => { chooseBoard(b); setPicker(false); document.getElementById("jira-board-button")?.focus(); }}
          onClose={() => {
            // Escape, or a Tab out: focus was in the picker, so it goes back
            // to the button that opened it. A press elsewhere keeps its own.
            const inside = document.getElementById("jira-board-picker")?.contains(document.activeElement);
            setPicker(false);
            if (inside) document.getElementById("jira-board-button")?.focus();
          }} />
      )}
    </div>
  );
}
