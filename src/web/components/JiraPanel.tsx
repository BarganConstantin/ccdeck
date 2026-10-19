// The Jira panel (#2178): a replica of Jira's Backlog page, the screen the
// owner reads, under the host's header (IntegrationModal) — a board picker,
// the filters Jira's own page has, the board's groups and their issues, and
// one issue in full beside them.
//
// WHAT IT REMEMBERS, per connection (the host's `prefs`): the board on show,
// "Only my issues" (on the first time, then as left), "Hide done", the board's
// quick filters that were on, and which groups were open. The search box is
// for the moment, and starts empty.
//
// WHEN IT READS: when it opens on a board read more than five minutes ago, and
// when Refresh is pressed. Never on a timer (use-jira-board.ts).
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { connectionHost, type IntegrationFailure } from "../integrations/client";
import type { IntegrationPanelProps } from "../integrations/types";
import { readBoards, type JiraBoardSummary } from "../jira-api";
import { agoLabel, type GroupDef } from "../jira-board";
import { modalStack } from "../modal-dismiss";
import { failureOf, useJiraBoard } from "../use-jira-board";
import AnchoredPopover from "./AnchoredPopover";
import IntegrationSplit from "./IntegrationSplit";
import JiraBacklog from "./JiraBacklog";
import JiraIssueDetail from "./JiraIssueDetail";
import { Chevron, FailureNote, RefreshGlyph, SearchGlyph } from "./JiraParts";

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 40;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isFlags = (v: unknown): v is Record<string, boolean> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every(x => typeof x === "boolean");
const isQuick = (v: unknown): v is { board: string; ids: string[] } =>
  Boolean(v) && typeof v === "object" && typeof (v as { board?: unknown }).board === "string"
  && Array.isArray((v as { ids?: unknown }).ids) && (v as { ids: unknown[] }).ids.every(x => typeof x === "string");

function useNow(everyMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
}

// ── the board picker ────────────────────────────────────────────────────────

interface BoardPage { boards: JiraBoardSummary[]; isLast: boolean; total: number | null; loading: boolean; error: IntegrationFailure | null }

function BoardPicker({ api, current, anchorId, onPick, onClose }: {
  api: IntegrationPanelProps["api"];
  current: string | null;
  anchorId: string;
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
    <AnchoredPopover anchorId={anchorId} portalRootId="integration-jira-modal" id="jira-board-picker" className="jr-board-pop" role="dialog"
      labelledBy="jira-board-picker-title" focusRef={searchRef} onClose={onClose}>
      <div className="jr-board-pop-inner" onKeyDown={onKeyDown}>
        <p className="jr-board-pop-title" id="jira-board-picker-title">Boards</p>
        <label className="jr-search jr-board-search">
          <SearchGlyph />
          <input ref={searchRef} type="search" placeholder="Find a board by name" aria-label="Find a board by name" value={query}
            onChange={e => setQuery(e.target.value)} />
        </label>
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

export default function JiraPanel({ connection: conn, api, assetUrl, prefs, narrow, onReconnect }: IntegrationPanelProps) {
  const [board, setBoardState] = useState<string | null>(() => prefs.read("board", isString) ?? null);
  const [boardName, setBoardName] = useState<string>(() => prefs.read("boardName", (v): v is string => typeof v === "string") ?? "");
  const [mine, setMine] = useState(() => prefs.read("mine", isBool) ?? true);
  const [hideDone, setHideDone] = useState(() => prefs.read("hideDone", isBool) ?? false);
  const [quick, setQuick] = useState<string[]>(() => {
    const saved = prefs.read("quick", isQuick);
    return saved && saved.board === board ? saved.ids : [];
  });
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => prefs.read("expanded", isFlags) ?? {});
  const [search, setSearch] = useState("");
  const [picker, setPicker] = useState(false);
  const [trail, setTrail] = useState<string[]>([]);
  const [boardsError, setBoardsError] = useState<IntegrationFailure | null>(null);
  const [noBoards, setNoBoards] = useState(false);
  const now = useNow(30_000);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { prefs.write("mine", mine); }, [prefs, mine]);
  useEffect(() => { prefs.write("hideDone", hideDone); }, [prefs, hideDone]);
  useEffect(() => { if (board) prefs.write("quick", { board, ids: quick }); }, [prefs, board, quick]);
  useEffect(() => { prefs.write("expanded", expanded); }, [prefs, expanded]);

  const chooseBoard = useCallback((b: Pick<JiraBoardSummary, "id" | "name">) => {
    const id = String(b.id);
    setBoardState(id);
    setBoardName(b.name);
    prefs.write("board", id);
    prefs.write("boardName", b.name);
    setQuick([]);
    setTrail([]);
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
  const filtered = mine || hideDone || quick.length > 0 || search.trim() !== "";
  const clearFilters = () => { setMine(false); setHideDone(false); setQuick([]); setSearch(""); };
  const rowFilter = useMemo(() => ({ search, hideDone }), [search, hideDone]);

  // ── the detail, and the way back from it ──
  const open = trail.length > 0;
  const openIssue = (key: string) => {
    setTrail([key]);
    if (narrow) requestAnimationFrame(() => document.getElementById("jira-detail-title")?.focus());
  };
  const back = useCallback(() => {
    const key = trail[0];
    setTrail([]);
    requestAnimationFrame(() => {
      const row = key ? document.querySelector<HTMLElement>(`.jr-row-main[data-key="${CSS.escape(key)}"]`) : null;
      row?.focus();
    });
  }, [trail]);
  const backRef = useRef(back);
  backRef.current = back;
  // On a narrow screen the detail is a screen of its own, so Escape leaves it
  // before it closes the modal.
  useEffect(() => {
    if (!narrow || !open) return;
    return modalStack.push(() => backRef.current(), 0, "popover");
  }, [narrow, open]);

  // Escape in a search box with something in it empties it, before it
  // leaves the detail or closes the modal: one more entry on the same stack.
  const [searchFocused, setSearchFocused] = useState(false);
  const searching = searchFocused && search !== "";
  useEffect(() => {
    if (!searching) return;
    return modalStack.push(() => setSearch(""), 0, "popover");
  }, [searching]);

  const host = connectionHost(conn);
  const updated = snap.loadedAt ? agoLabel(snap.loadedAt, now) : "";
  const blocking = !overview ? (error ?? boardsError) : null;

  const list = (() => {
    if (noBoards) {
      return (
        <div className="jr-state">
          <h3>No boards here</h3>
          <p>This account cannot see any board on {host}. A board appears here once you are given access to one in Jira.</p>
          <p><a className="jr-open" href={`${conn.baseUrl}/secure/ManageRapidViews.jspa`} target="_blank" rel="noreferrer noopener">Open boards in Jira</a></p>
        </div>
      );
    }
    if (blocking) {
      return (
        <div className="jr-state">
          <FailureNote error={blocking} conn={conn} onRetry={board ? jira.refresh : firstBoard} onReconnect={onReconnect} />
          {blocking.kind === "not-found" && board && (
            <p><button type="button" className="btn" onClick={() => setPicker(true)}>Choose another board</button></p>
          )}
        </div>
      );
    }
    if (!overview) {
      return <div className="jr-skeleton jr-skeleton-board" role="status" aria-label="Reading the board"><i /><i /><i /><i /><i /><i /></div>;
    }
    return (
      <>
        {error && <FailureNote error={error} conn={conn} stale onRetry={jira.refresh} onReconnect={onReconnect} compact />}
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
      onOpen={(key, how) => setTrail(t => (how === "push" ? [...t.filter(k => k !== key), key] : [key]))}
      onTrail={index => setTrail(t => t.slice(0, index + 1))}
      onReconnect={onReconnect}
    />
  ) : null;

  return (
    <div className="jr-panel" data-deployment={conn.meta?.deployment === "cloud" ? "cloud" : "server"}>
      <div className="jr-toolbar">
        <div className="jr-toolbar-row">
          <button type="button" id="jira-board-button" className="btn jr-board-btn" aria-haspopup="dialog" aria-expanded={picker}
            aria-controls={picker ? "jira-board-picker" : undefined} onClick={() => setPicker(p => !p)}>
            <span className="jr-board-btn-label">Board</span>
            <span className="jr-board-btn-name">{overview?.board.name || boardName || (board ? `Board ${board}` : "Choose a board")}</span>
            <Chevron open={picker} />
          </button>
          {overview?.board.projectName && <span className="jr-board-project">{overview.board.projectName}</span>}
          <span className="jr-fresh" role="status" aria-live="polite">
            {loading ? (snap.loadedAt ? "Updating…" : "Reading…") : updated ? `Updated ${updated}` : ""}
          </span>
          <button type="button" className="glyph-btn jr-refresh" aria-label="Refresh the board" title="Refresh"
            aria-busy={loading || undefined} data-loading={loading || undefined} disabled={!board}
            onClick={() => { if (board) jira.refresh(); else firstBoard(); }}>
            <RefreshGlyph />
          </button>
        </div>
        <div className="jr-filters" role="group" aria-label="Filters">
          <label className="jr-search">
            <SearchGlyph />
            <input ref={searchRef} type="search" placeholder="Search key or summary" aria-label="Search issues by key or summary"
              value={search} onChange={e => setSearch(e.target.value)} onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} />
          </label>
          <button type="button" className="btn jr-chip" aria-pressed={mine} onClick={() => setMine(m => !m)}>Only my issues</button>
          <button type="button" className="btn jr-chip" aria-pressed={hideDone} onClick={() => setHideDone(h => !h)}>Hide done</button>
          {(overview?.quickFilters ?? []).map(q => (
            <button key={q.id} type="button" className="btn jr-chip" aria-pressed={quick.includes(q.id)} title={q.description || undefined}
              onClick={() => setQuick(list => (list.includes(q.id) ? list.filter(x => x !== q.id) : [...list, q.id]))}>
              {q.name}
            </button>
          ))}
          {filtered && <button type="button" className="jr-link-btn jr-clear" onClick={clearFilters}>Clear filters</button>}
        </div>
      </div>

      <IntegrationSplit
        storageKey="jira"
        list={<div className="jr-list-scroll">{list}</div>}
        detail={detail}
        onBack={back}
        backLabel="Back to the board"
      />

      {picker && (
        <BoardPicker api={api} current={board} anchorId="jira-board-button"
          onPick={b => { chooseBoard(b); setPicker(false); document.getElementById("jira-board-button")?.focus(); }}
          onClose={() => setPicker(false)} />
      )}
    </div>
  );
}
