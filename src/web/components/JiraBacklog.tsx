// The Jira panel's list (#2178): a board's groups the way Jira's Backlog page
// draws them — each sprint's header with its count, dates, the people on it
// and its three estimate totals, then its issues in Rank order, one dense row
// each. A row's chevron opens every sub-task under it, the reader's own
// marked; a sub-task of the reader's whose parent is somebody else's is drawn
// under that parent, greyed and labelled, so it is never an orphan.
//
// THE KEYBOARD walks it as one list: Up and Down move between the group
// headers and the rows, Right opens (a group, a row's sub-tasks) and Left
// closes or goes to the parent, Enter opens the issue, Home and End go to the
// ends. One row at a time is a Tab stop, so Tab leaves the list in one press.
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { IntegrationConnection as Connection } from "../integrations/types";
import type { JiraBoardOverview, JiraIssue } from "../jira-api";
import {
  buildRows, filterRows, groupOpen, groupStats, rowKey, shortDate, subtaskShown, totalLabel,
  type GroupDef, type Row, type RowFilter,
} from "../jira-board";
import type { BoardSnapshot, GroupData } from "../use-jira-board";
import { connectionHost } from "../integrations/client";
import IntegrationAvatar, { IntegrationAvatarStack, UnassignedAvatar } from "./IntegrationAvatar";
import IntegrationFailureNote from "./IntegrationFailureNote";
import IntegrationSkeleton from "./IntegrationSkeleton";
import { Chevron, EpicChip, Estimate, FlagGlyph, PriorityIcon, StatusLozenge, TypeIcon } from "./JiraParts";

export interface JiraBacklogProps {
  conn: Connection;
  overview: JiraBoardOverview;
  groups: GroupDef[];
  snap: BoardSnapshot;
  expanded: Record<string, boolean>;
  onToggleGroup: (group: GroupDef, open: boolean) => void;
  filter: RowFilter;
  /** "Only my issues" is on: a parent drawn for a sub-task is somebody else's. */
  mine: boolean;
  /** Any filter is on, so a group's own list is not all of it. */
  filtered: boolean;
  selected: string | null;
  onOpen: (key: string) => void;
  onRetryGroup: (group: GroupDef) => void;
  onMore: (group: GroupDef) => void;
  onShowClosed: (shown: boolean) => void;
  onMoreClosed: () => void;
  loadSubtasks: (key: string) => void;
  onReconnect: () => void;
}

const TOTAL_LABELS = { new: "To Do", indeterminate: "In Progress", done: "Done" } as const;

/** A row's own label for a screen reader: what it is, not everything on it. */
function rowLabel(issue: JiraIssue, extra = ""): string {
  const who = issue.assignee ? `${issue.assignee.name}${issue.mine ? ", assigned to you" : ""}` : "unassigned";
  return `${issue.key}: ${issue.summary}. ${issue.type.name}, ${issue.status.name}, ${who}${issue.flagged ? ", flagged" : ""}${extra}`;
}

/**
 * One issue's row, in the order Jira's backlog reads it: type and priority,
 * the key, the summary, then the facts at the end — flag, fix versions, epic,
 * the estimate — its status, and who has it.
 *
 * The status sits in a cell as wide as the board's longest status name, next
 * to the avatar, so the states line up down the list and can be read as a
 * column. The cell is the row's grid item, not the lozenge, so a short status
 * keeps a short lozenge. Narrow lists move the pieces between lines
 * (jira.css, "narrow").
 */
function IssueLine({ issue, estimation, time }: { issue: JiraIssue; estimation: JiraBoardOverview["estimation"]["kind"]; time: JiraBoardOverview["timeTracking"] }) {
  const done = issue.status.category === "done";
  return (
    <>
      <TypeIcon type={issue.type} />
      <PriorityIcon priority={issue.priority} />
      <span className="jr-key" data-done={done || undefined}>{issue.key}</span>
      <span className="jr-summary">{issue.summary}</span>
      <span className="jr-facts">
        <span className="jr-meta">
          {issue.flagged && <span className="jr-flagged" title="Flagged"><FlagGlyph /></span>}
          {issue.fixVersions.slice(0, 2).map(v => <span key={v} className="jr-version">{v}</span>)}
          {issue.fixVersions.length > 2 && <span className="jr-version" title={issue.fixVersions.slice(2).join(", ")}>+{issue.fixVersions.length - 2}</span>}
          {issue.epic && <EpicChip epic={issue.epic} />}
        </span>
        <Estimate issue={issue} estimation={estimation} time={time} />
        <span className="jr-status-cell"><StatusLozenge status={issue.status} /></span>
      </span>
      {/* The reader's own issues: their face ringed in the accent, and
          "assigned to you" in the row's label. */}
      <span className="jr-assignee" title={issue.assignee ? `${issue.assignee.name}${issue.mine ? " (you)" : ""}` : "Unassigned"}>
        {issue.assignee
          ? <IntegrationAvatar src={issue.assignee.avatar} name={issue.assignee.name} size={20} you={issue.mine} />
          : <UnassignedAvatar size={20} />}
      </span>
    </>
  );
}

/** How wide the status cell is, in characters of the lozenge's own type: the
 *  longest status name on the board, up to the lozenge's own cap (16). */
function statusWidth(snap: BoardSnapshot): number {
  let longest = 4;
  const look = (name: string) => { if (name.length > longest) longest = name.length; };
  for (const group of Object.values(snap.groups)) {
    for (const issue of group.issues) {
      look(issue.status.name);
      if (issue.parent) look(issue.parent.status.name);
    }
  }
  for (const sub of Object.values(snap.subtasks)) for (const issue of sub.issues) look(issue.status.name);
  return Math.min(16, longest);
}

export default function JiraBacklog(props: JiraBacklogProps) {
  const { conn, overview, groups, snap, expanded, onToggleGroup, filter, mine, filtered, selected, onOpen, onRetryGroup, onMore,
    onShowClosed, onMoreClosed, loadSubtasks, onReconnect } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const [rowsOpen, setRowsOpen] = useState<Record<string, boolean>>({});
  const [current, setCurrent] = useState<string | null>(null);
  const estimation = overview.estimation.kind;
  const time = overview.timeTracking;

  // Rows, group by group, each issue drawn once: in the first group it is in.
  const built = useMemo(() => {
    const seen = new Set<string>();
    return groups.map(def => {
      const data: GroupData | undefined = snap.groups[def.id];
      const rows = buildRows(data?.issues ?? [], seen);
      const shown = filterRows(rows, filter, key => snap.subtasks[key]?.issues);
      return { def, data, rows: shown, stats: groupStats(shown, estimation) };
    });
  }, [groups, snap.groups, snap.subtasks, filter, estimation]);

  const isRowOpen = (row: Row) => rowsOpen[rowKey(row)] ?? row.kind === "context";

  // A row opened with no sub-tasks read yet reads them; a context row, open
  // from the start, reads them as soon as it is drawn.
  useEffect(() => {
    for (const { def, rows } of built) {
      if (!groupOpen(def, expanded)) continue;
      for (const row of rows) {
        if (!isRowOpen(row)) continue;
        const key = rowKey(row);
        if (snap.subtasks[key]) continue;
        if (row.kind === "issue") {
          const want = row.issue.subtaskKeys;
          // Every sub-task already in hand, and no filter hiding any: no read.
          if (!filtered && want.length > 0 && want.every(k => row.matched.some(m => m.key === k))) continue;
          if (want.length === 0) continue;
        }
        loadSubtasks(key);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built, rowsOpen, expanded]);

  const toggleRow = (key: string, open: boolean) => setRowsOpen(state => ({ ...state, [key]: open }));

  // ── keyboard ──────────────────────────────────────────────────────────────
  const navItems = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-nav]") ?? []);
  const focusNav = (el: HTMLElement | undefined) => { if (el) { el.focus(); el.scrollIntoView?.({ block: "nearest" }); } };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!target.dataset.nav || e.altKey || e.ctrlKey || e.metaKey) return;
    const items = navItems();
    const at = items.indexOf(target);
    const expandedNow = target.getAttribute("data-expanded");
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); focusNav(items[Math.min(items.length - 1, at + 1)]); return;
      case "ArrowUp": e.preventDefault(); focusNav(items[Math.max(0, at - 1)]); return;
      case "Home": e.preventDefault(); focusNav(items[0]); return;
      case "End": e.preventDefault(); focusNav(items[items.length - 1]); return;
      case "ArrowRight":
        if (expandedNow === "false") { e.preventDefault(); document.getElementById(target.dataset.toggle ?? "")?.click(); }
        else if (expandedNow === "true") { e.preventDefault(); focusNav(items[at + 1]); }
        return;
      case "ArrowLeft":
        if (expandedNow === "true") { e.preventDefault(); document.getElementById(target.dataset.toggle ?? "")?.click(); }
        else if (target.dataset.parent) { e.preventDefault(); focusNav(items.find(el => el.dataset.nav === target.dataset.parent)); }
        return;
      default:
    }
  };
  // One item is in the Tab order, a sprint's header or a row: the last one
  // focused, or, before any has been, the first row drawn, or the first
  // header when no row is. An item filtered away or folded hands the stop
  // back to the first.
  const firstRow = useMemo(() => {
    for (const { def, rows } of built) if (groupOpen(def, expanded) && rows.length > 0) return `${def.id}/${rowKey(rows[0])}`;
    return built.length ? `g:${built[0].def.id}` : null;
  }, [built, expanded]);
  useEffect(() => {
    if (current && !listRef.current?.querySelector(`[data-nav="${CSS.escape(current)}"]`)) setCurrent(null);
  });
  const tabStop = (nav: string) => (nav === (current ?? firstRow) ? 0 : -1);

  const renderRow = (row: Row, group: GroupDef, depth: 0 | 1, parentNav?: string) => {
    const key = rowKey(row);
    const nav = `${group.id}/${key}${depth ? `/${parentNav}` : ""}`;
    const open = isRowOpen(row);
    const all = snap.subtasks[key];
    const subtasksKnown = row.kind === "issue" ? row.issue.subtaskKeys.length : 0;
    const expandable = depth === 0 && (subtasksKnown > 0 || row.matched.length > 0 || row.kind === "context");
    const toggleId = `jr-toggle-${group.id.replace(/[^a-z0-9]/gi, "-")}-${key}`;
    const childList = all?.status === "ready"
      ? all.issues.filter(sub => subtaskShown(sub, filter))
      : row.matched;
    const mineCount = (all?.status === "ready" ? all.issues : row.matched).filter(s => s.mine).length;
    const label = row.kind === "issue"
      ? rowLabel(row.issue, expandable ? `, ${subtasksKnown || row.matched.length} sub-tasks${mineCount ? `, ${mineCount} yours` : ""}` : "")
      : `${row.parent.key}: ${row.parent.summary}. ${mine ? "Not assigned to you" : "Parent not in this list"}; shown for ${row.matched.length} sub-task${row.matched.length === 1 ? "" : "s"}`;
    const issue = row.kind === "issue" ? row.issue : null;
    return (
      <li key={key} className="jr-item" data-context={row.kind === "context" || undefined}>
        <div className="jr-row ig-row" data-selected={selected === key || undefined} data-done={issue?.status.category === "done" || undefined}
          data-mine={issue?.mine || undefined}>
          {expandable ? (
            <button type="button" id={toggleId} className="jr-toggle" tabIndex={-1} aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} sub-tasks of ${key}`} onClick={() => toggleRow(key, !open)}>
              <Chevron open={open} />
            </button>
          ) : <span className="jr-toggle-space" aria-hidden />}
          <button type="button" className="jr-row-main" data-nav={nav} data-key={key} data-parent={parentNav} data-toggle={expandable ? toggleId : undefined}
            data-expanded={expandable ? String(open) : undefined} tabIndex={tabStop(nav)} aria-current={selected === key || undefined}
            aria-label={label} onFocus={() => setCurrent(nav)} onClick={() => onOpen(key)}>
            {issue ? <IssueLine issue={issue} estimation={estimation} time={time} /> : row.kind === "context" && (
              <>
                <TypeIcon type={row.parent.type} />
                <PriorityIcon priority={row.parent.priority} />
                <span className="jr-key" data-done={row.parent.status.category === "done" || undefined}>{row.parent.key}</span>
                <span className="jr-summary">{row.parent.summary}</span>
                <span className="jr-facts">
                  <span className="jr-meta"><span className="jr-context-tag">{mine ? "not assigned to you" : "parent not in this list"}</span></span>
                  <span className="jr-status-cell"><StatusLozenge status={row.parent.status} /></span>
                </span>
              </>
            )}
          </button>
        </div>
        {expandable && open && (
          <ul className="jr-subrows" role="list" aria-label={`Sub-tasks of ${key}`}>
            {all?.status === "loading" && childList.length === 0 && <li className="jr-subnote" role="status">Reading sub-tasks…</li>}
            {all?.status === "error" && (
              <li className="jr-subnote" role="alert">Sub-tasks could not be read. <button type="button" className="jr-link-btn" onClick={() => loadSubtasks(key)}>Try again</button></li>
            )}
            {childList.map(sub => {
              const subNav = `${group.id}/${sub.key}/${nav}`;
              return (
                <li key={sub.key} className="jr-item">
                  <div className="jr-row jr-subrow ig-row" data-selected={selected === sub.key || undefined} data-done={sub.status.category === "done" || undefined}
                    data-mine={sub.mine || undefined}>
                    <span className="jr-toggle-space" aria-hidden />
                    <button type="button" className="jr-row-main" data-nav={subNav} data-key={sub.key} data-parent={nav} tabIndex={tabStop(subNav)}
                      aria-current={selected === sub.key || undefined} aria-label={rowLabel(sub)}
                      onFocus={() => setCurrent(subNav)} onClick={() => onOpen(sub.key)}>
                      <IssueLine issue={sub} estimation={estimation} time={time} />
                    </button>
                  </div>
                </li>
              );
            })}
            {all?.status === "ready" && childList.length === 0 && <li className="jr-subnote">{filter.attention ? "No sub-task needs attention." : filter.hideDone ? "Every sub-task is done." : "No sub-tasks."}</li>}
          </ul>
        )}
      </li>
    );
  };

  const anySprint = overview.hasSprints;
  const noActive = anySprint && overview.sprints.active.length === 0;
  const closedState = snap.closed;
  const firstClosed = built.findIndex(b => b.def.kind === "closed");

  const statusCh = useMemo(() => statusWidth(snap), [snap]);

  return (
    <div className="jr-board" ref={listRef} onKeyDown={onKeyDown} style={{ "--jr-status-ch": statusCh } as CSSProperties}>
      {noActive && <p className="jr-board-note">No sprint is active on this board. The future sprints and the backlog are below.</p>}
      {built.map(({ def, data, rows, stats }, index) => {
        const open = groupOpen(def, expanded);
        const bodyId = `jr-group-${def.id.replace(/[^a-z0-9]/gi, "-")}`;
        const nav = `g:${def.id}`;
        const sprint = def.sprint;
        const dates = sprint && (sprint.startDate || sprint.endDate)
          ? `${shortDate(sprint.startDate) || "?"} – ${shortDate(sprint.completeDate ?? sprint.endDate) || "?"}`
          : "";
        const loaded = data?.status === "ready" || (data?.issues.length ?? 0) > 0;
        const totalKnown = data?.total != null && def.paged && data.total > stats.count && !filter.search && !filter.hideDone && !filter.attention;
        const countText = !loaded ? (data?.status === "error" ? "" : "…")
          : totalKnown ? `${stats.count} of ${data!.total}` : `${stats.count}`;
        const people = stats.assignees;
        return (
          <Fragment key={def.id}>
          {index === firstClosed && <h3 className="jr-closed-title">Closed sprints</h3>}
          <section className="jr-group" data-kind={def.kind} aria-labelledby={`${bodyId}-title`}>
            <div className="jr-group-head">
              <h3 className="jr-group-title" id={`${bodyId}-title`}>
                <button type="button" id={`${bodyId}-toggle`} className="jr-group-toggle" data-nav={nav} data-toggle={`${bodyId}-toggle`}
                  data-expanded={String(open)} aria-expanded={open} aria-controls={bodyId} tabIndex={tabStop(nav)}
                  onFocus={() => setCurrent(nav)} onClick={() => onToggleGroup(def, !open)}>
                  <Chevron open={open} />
                  <span className="jr-group-name">{def.title}</span>
                  {def.kind === "active" && <span className="jr-badge">Active</span>}
                  {dates && <span className="jr-group-dates">{dates}</span>}
                  <span className="jr-group-count">{countText} {loaded ? (stats.count === 1 && !totalKnown ? "issue" : "issues") : <span className="vis-hidden">issues, not read yet</span>}</span>
                </button>
              </h3>
              {loaded && (
                <div className="jr-group-facts">
                  {stats.mine > 0 && !mine && <span className="jr-mine" title="Yours, and how many of those are done">Mine {stats.mineDone}/{stats.mine}</span>}
                  {stats.mine > 0 && mine && <span className="jr-mine" title="How many of yours are done">{stats.mineDone}/{stats.mine} done</span>}
                  <IntegrationAvatarStack label="Assigned to"
                    people={people.map(p => ({ key: p.id, name: p.name, src: p.avatar, you: p.id === stats.youId }))} />
                  <span className="jr-totals">
                    {(["new", "indeterminate", "done"] as const).map(c => (
                      <span key={c} className="jr-total" data-cat={c} title={`${TOTAL_LABELS[c]}: ${totalLabel(stats.totals[c], estimation, time)}`}>
                        <span className="vis-hidden">{TOTAL_LABELS[c]} </span>{totalLabel(stats.totals[c], estimation, time)}
                      </span>
                    ))}
                  </span>
                </div>
              )}
            </div>
            {sprint?.goal && open && <p className="jr-goal">{sprint.goal}</p>}
            {open && (
              <div id={bodyId} className="jr-group-body">
                {data?.status === "error" && data.error && (
                  <IntegrationFailureNote error={data.error} provider="Jira" host={connectionHost(conn)} stale={data.issues.length > 0}
                    onRetry={() => onRetryGroup(def)} onReconnect={onReconnect} />
                )}
                {(!data || data.status === "idle" || (data.status === "loading" && data.issues.length === 0)) && (
                  <IntegrationSkeleton label={`Reading ${def.title}`} rows={3} />
                )}
                {loaded && rows.length === 0 && (
                  <p className="jr-empty-group">
                    {(data?.issues.length ?? 0) > 0 ? "Nothing here matches the filters." : mine ? "None of your issues are here." : filtered ? "Nothing here matches the filters." : "No issues."}
                  </p>
                )}
                {rows.length > 0 && <ul className="jr-rows">{rows.map(row => renderRow(row, def, 0))}</ul>}
                {data?.capped && <p className="jr-board-note">The first 600 issues are shown. Open the sprint in Jira for the rest.</p>}
                {def.paged && data?.next && (
                  <button type="button" className="btn jr-more" aria-busy={data.more || undefined} onClick={() => onMore(def)}>
                    {data.more ? "Reading…" : data.total != null ? `Show more (${data.issues.length} of ${data.total})` : "Show more"}
                  </button>
                )}
              </div>
            )}
          </section>
          </Fragment>
        );
      })}

      {anySprint && (
        <div className="jr-closed-foot">
          {closedState.error && <p className="jr-subnote" role="alert">Closed sprints could not be read: {closedState.error.message}</p>}
          {!closedState.shown ? (
            <button type="button" className="btn" aria-busy={closedState.loading || undefined} onClick={() => onShowClosed(true)}>
              {closedState.loading ? "Reading closed sprints…" : "Show closed sprints"}
            </button>
          ) : (
            <>
              {closedState.sprints.length === 0 && !closedState.loading && <p className="jr-subnote">No closed sprints on this board.</p>}
              {!closedState.isLast && closedState.sprints.length > 0 && (
                <button type="button" className="btn" aria-busy={closedState.loading || undefined} onClick={onMoreClosed}>
                  {closedState.loading ? "Reading…" : `Show older sprints (${closedState.sprints.length} of ${closedState.total})`}
                </button>
              )}
              <button type="button" className="btn" onClick={() => onShowClosed(false)}>Hide closed sprints</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
