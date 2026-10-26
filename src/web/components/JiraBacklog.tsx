// The Jira panel's list (#2178): a board's groups the way Jira's Backlog page
// draws them — each sprint's header with its count, dates, the people on it,
// what in it is the reader's or needs attention, and its estimate totals in
// words, then its issues in Rank order, one dense row each. A row's chevron
// opens every sub-task under it, the reader's own marked; a sub-task of the
// reader's whose parent is somebody else's is drawn under that parent, greyed
// and labelled, so it is never an orphan.
//
// THE KEYBOARD walks it as one list: Up and Down move between the group
// headers and the rows, Right opens (a group, a row's sub-tasks) and Left
// closes or goes to the parent, Enter opens the issue, Home and End go to the
// ends. One row at a time is a Tab stop, so Tab leaves the list in one press.
import { Fragment, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type DragEvent } from "react";
import type { IntegrationConnection as Connection } from "../integrations/types";
import type { JiraBoardOverview, JiraIssue, TimeTracking } from "../jira-api";
import {
  boardRows, groupOpen, groupStats, readsSubtasks, rowKey, rowOpen, shortDate, subtaskRows, totalLabel,
  type GroupDef, type GroupStats, type Row, type RowFilter,
} from "../jira-board";
import type { BoardSnapshot, GroupData } from "../use-jira-board";
import { connectionHost } from "../integrations/client";
import IntegrationAvatar, { IntegrationAvatarStack, UnassignedAvatar } from "./IntegrationAvatar";
import IntegrationFailureNote from "./IntegrationFailureNote";
import IntegrationSkeleton from "./IntegrationSkeleton";
import { Chevron, EpicChip, Estimate, FlagGlyph, PriorityIcon, StatusLozenge, TypeIcon } from "./JiraParts";
import { issuesMove, movableIssue, moveDestination, moveKeys, selectIssue, type JiraMove, type JiraMoveItem } from "../jira-move";
import JiraMovePopover from "./JiraMovePopover";

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
  /** The rows whose sub-tasks are shown, by key: the panel keeps them, per
   *  board, so they are open again when the panel is. */
  rowsOpen: Record<string, boolean>;
  onToggleRow: (key: string, open: boolean) => void;
  onRetryGroup: (group: GroupDef) => void;
  onMore: (group: GroupDef) => void;
  onShowClosed: (shown: boolean) => void;
  onMoreClosed: () => void;
  loadSubtasks: (key: string) => void;
  onReconnect: () => void;
  onMove?: (move: JiraMove) => Promise<{ notice?: string }>;
  moveBusy?: boolean;
  scrollBoundaryId?: string;
}

const TOTAL_LABELS = { new: "To do", indeterminate: "In progress", done: "Done" } as const;
const CATEGORIES = ["new", "indeterminate", "done"] as const;

/** Rows the reader opens fade in, once, as they mount (120ms, jira.css). A
 *  longer list appears at once: thirty rows fading in reads as a slow list. */
const fades = (rows: number) => rows <= 30;

/** A group's estimate totals, each named in words ("To do 3d") and drawn
 *  only when there is something in it. A kanban column holds one status
 *  already, so it has one total; a board that counts issues has its count in
 *  the header, so it has none. */
function Totals({ def, totals, estimation, time }: {
  def: GroupDef; totals: GroupStats["totals"]; estimation: "time" | "points" | "count"; time: TimeTracking;
}) {
  if (estimation === "count") return null;
  const unit = estimation === "points" ? "story points" : "estimated";
  if (def.kind === "column") {
    const sum = totals.new + totals.indeterminate + totals.done;
    if (sum <= 0) return null;
    const value = totalLabel(sum, estimation, time);
    return <span className="jr-totals"><span className="jr-total" title={`Total: ${value} ${unit}`}>Total {value}</span></span>;
  }
  const shown = CATEGORIES.filter(c => totals[c] > 0);
  if (shown.length === 0) return null;
  return (
    <span className="jr-totals">
      {shown.map(c => {
        const value = totalLabel(totals[c], estimation, time);
        return <span key={c} className="jr-total" data-cat={c} title={`${TOTAL_LABELS[c]}: ${value} ${unit}`}>{TOTAL_LABELS[c]} {value}</span>;
      })}
    </span>
  );
}

/** What a group holds that a reader looks for first, in words and only when
 *  it is there: "3 yours · 1 flagged · 1 highest". With Only my issues on,
 *  every issue is the reader's, so theirs reads as how many are done. */
function Tally({ stats, mine }: { stats: GroupStats; mine: boolean }) {
  const parts: { key: string; text: string; title: string }[] = [];
  if (stats.mine > 0) {
    parts.push(mine
      ? { key: "mine", text: `${stats.mineDone} of ${stats.mine} done`, title: `${stats.mineDone} of your ${stats.mine} done` }
      : { key: "mine", text: `${stats.mine} yours`, title: `${stats.mineDone} of ${stats.mine} yours done` });
  }
  if (stats.flagged > 0) parts.push({ key: "flagged", text: `${stats.flagged} flagged`, title: "Flagged and not done" });
  if (stats.highest > 0) parts.push({ key: "highest", text: `${stats.highest} highest`, title: "Highest priority (or Blocker, Critical) and not done" });
  if (parts.length === 0) return null;
  return (
    <span className="jr-tally">
      {parts.map((part, i) => (
        <Fragment key={part.key}>{i > 0 && <span aria-hidden> · </span>}<span title={part.title}>{part.text}</span></Fragment>
      ))}
    </span>
  );
}

/** A row's own label for a screen reader: what it is, not everything on it. */
function rowLabel(issue: JiraIssue, extra = ""): string {
  const who = issue.assignee ? `${issue.assignee.name}${issue.mine ? ", assigned to you" : ""}` : "unassigned";
  return `${issue.key}: ${issue.summary}. ${issue.type.name}, ${issue.status.name}, ${who}${issue.priority ? `, priority ${issue.priority.name}` : ""}${issue.flagged ? ", flagged" : ""}${extra}`;
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
  const { conn, overview, groups, snap, expanded, onToggleGroup, filter, mine, filtered, selected, onOpen, rowsOpen, onToggleRow,
    onRetryGroup, onMore, onShowClosed, onMoreClosed, loadSubtasks, onReconnect, onMove, moveBusy = false } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const boardId = useId();
  const drag = useRef<{ items: JiraMoveItem[] } | null>(null);
  const [dragKeys, setDragKeys] = useState<string[]>([]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const selectionAnchor = useRef<string | null>(null);
  const selectionVersion = useRef(0);
  const [dropAt, setDropAt] = useState<{ group: string; key?: string; side?: "before" | "after" } | null>(null);
  const [moveMenu, setMoveMenu] = useState<{ issue: JiraIssue; items: JiraMoveItem[]; anchorId: string; keyboard: boolean } | null>(null);
  const menuSerial = useRef(0);
  const [moveError, setMoveError] = useState("");
  const [moveNotice, setMoveNotice] = useState("");
  const submitting = useRef(false);
  const canMove = overview.moves?.enabled === true && Boolean(onMove);
  const openMoveMenu = (issue: JiraIssue, from: GroupDef, anchorId: string, keyboard = false) => {
    const items = picked.has(issue.key) ? selectedItems : [{ issue, group: from }];
    if (items.length > 50 || items.some(i => !movableIssue(i.issue, i.group))) {
      setMoveError(items.length > 50 ? "Move up to 50 issues at a time." : "Only unfinished top-level issues can be moved. Adjust the selection first.");
      return;
    }
    menuSerial.current++;
    setMoveError("");
    setMoveMenu({ issue, items, anchorId, keyboard });
  };
  const closeMoveMenu = () => {
    const menu = moveMenu;
    // A successful refresh removes a cross-group source anchor before the
    // move promise resolves. That automatic close still owns restoration;
    // Cancel, Escape and outside presses on a present anchor relinquish it.
    const anchorRemovedDuringMove = submitting.current && menu && !document.getElementById(menu.anchorId);
    if (!anchorRemovedDuringMove) menuSerial.current++;
    setMoveMenu(null);
    if (menu?.keyboard) requestAnimationFrame(() => {
      // Escape's shared popover primitive first returns to its anchor. A
      // keyboard-opened Move returns one step further, to the navigable row.
      if (document.activeElement === document.getElementById(menu.anchorId)) {
        Array.from(listRef.current?.querySelectorAll<HTMLElement>(".jr-row-main[data-key]") ?? []).find(el => el.dataset.key === menu.issue.key)?.focus();
      }
    });
  };
  const finishDrag = () => { drag.current = null; setDragKeys([]); setDropAt(null); };
  const saveMove = async (move: JiraMove, destination: GroupDef): Promise<boolean> => {
    if (!onMove || moveBusy || submitting.current) return false;
    const serial = menuSerial.current;
    const selectionAtStart = selectionVersion.current;
    const keys = moveKeys(move);
    const label = keys.length === 1 ? keys[0] : `${keys.length} issues`;
    const opener = document.activeElement;
    const popup = opener?.closest(".jr-move-pop");
    submitting.current = true;
    setMoveError("");
    setMoveNotice(`Moving ${label}…`);
    try {
      const result = await onMove(move);
      setMoveNotice(result.notice || `${label} moved to ${destination.title}.`);
      if (selectionAtStart === selectionVersion.current) setPicked(new Set(keys));
      const stillOwnsFocus = serial === menuSerial.current && (document.activeElement === opener
        || Boolean(popup?.contains(document.activeElement))
        || (document.activeElement === document.body && (!opener?.isConnected || popup?.isConnected)));
      if (serial === menuSerial.current) setMoveMenu(null);
      // Reveal the destination, including a previously folded/empty sprint.
      onToggleGroup(destination, true);
      if (stillOwnsFocus) requestAnimationFrame(() => {
        const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>(".jr-row-main[data-key]") ?? []).find(el => el.dataset.key === keys[0] && el.dataset.nav?.startsWith(`${destination.id}/`));
        (row ?? document.getElementById(`jr-group-${destination.id.replace(/[^a-z0-9]/gi, "-")}-toggle`))?.focus();
      });
      return true;
    } catch (error) {
      setMoveNotice("");
      setMoveError(error instanceof Error ? error.message : "The move could not be confirmed. Refresh before trying again.");
      return false;
    } finally { submitting.current = false; }
  };
  const overGroup = (event: DragEvent, group: GroupDef) => {
    if (!drag.current || !canMove || moveBusy || !moveDestination(group)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropAt({ group: group.id });
  };
  const dropGroup = (event: DragEvent, group: GroupDef) => {
    const source = drag.current;
    if (!source || !canMove || moveBusy) return;
    event.preventDefault();
    const move = issuesMove(source.items, group);
    finishDrag();
    if (move) void saveMove(move, group);
  };
  // The groups and rows the reader has opened here, whose rows fade in as
  // they mount. One open from the start, or from a choice kept from before,
  // is simply there.
  const [openedHere, setOpenedHere] = useState<ReadonlySet<string>>(() => new Set());
  const [rowsOpenedHere, setRowsOpenedHere] = useState<ReadonlySet<string>>(() => new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const estimation = overview.estimation.kind;
  const time = overview.timeTracking;

  // Rows, group by group, each issue drawn once: in the first group it is in.
  const built = useMemo(() => boardRows<GroupData>(groups, snap.groups, key => snap.subtasks[key]?.issues, filter)
    .map(group => ({ ...group, stats: groupStats(group.rows, estimation) })), [groups, snap.groups, snap.subtasks, filter, estimation]);

  const isRowOpen = (row: Row) => rowOpen(row, rowsOpen);
  const visibleItems = useMemo<JiraMoveItem[]>(() => {
    const items: JiraMoveItem[] = [];
    const seen = new Set<string>();
    const add = (issue: JiraIssue, group: GroupDef) => { if (!seen.has(issue.key)) { seen.add(issue.key); items.push({ issue, group }); } };
    for (const { def, rows } of built) {
      if (!groupOpen(def, expanded)) continue;
      for (const row of rows) {
        if (row.kind === "issue") add(row.issue, def);
        if (rowOpen(row, rowsOpen)) for (const sub of subtaskRows(row, snap.subtasks[rowKey(row)], filter)) add(sub, def);
      }
    }
    return items;
  }, [built, expanded, rowsOpen, snap.subtasks, filter]);
  const visibleKeys = visibleItems.map(i => i.issue.key);
  const selectedItems = visibleItems.filter(i => picked.has(i.issue.key));
  const selectionProblem = selectedItems.length > 50 ? "Move up to 50 issues at a time."
    : selectedItems.some(i => !movableIssue(i.issue, i.group)) ? "Only unfinished top-level issues can be moved." : "";
  useEffect(() => {
    const visible = new Set(visibleItems.map(i => i.issue.key));
    setPicked(previous => [...previous].every(key => visible.has(key)) ? previous : new Set([...previous].filter(key => visible.has(key))));
    if (selectionAnchor.current && !visible.has(selectionAnchor.current)) selectionAnchor.current = null;
  }, [visibleItems]);
  const pick = (key: string, modifiers: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, toggle = false) => {
    const additive = modifiers.ctrlKey || modifiers.metaKey;
    const modified = additive || modifiers.shiftKey || toggle;
    const anchor = selectionAnchor.current;
    selectionVersion.current++;
    setPicked(previous => selectIssue(previous, visibleKeys, key, anchor,
      modifiers.shiftKey ? additive ? "add-range" : "range" : additive || toggle ? "toggle" : "replace"));
    if (!modifiers.shiftKey) selectionAnchor.current = key;
    setSelectionMode(modified);
    if (!modified) onOpen(key);
  };

  // A row opened with no sub-tasks read yet reads them; a context row, open
  // from the start, reads them as soon as it is drawn.
  useEffect(() => {
    for (const { def, rows } of built) {
      if (!groupOpen(def, expanded)) continue;
      for (const row of rows) {
        if (!isRowOpen(row)) continue;
        const key = rowKey(row);
        // Every sub-task already in hand, and no filter hiding any: no read.
        if (snap.subtasks[key] || !readsSubtasks(row, filtered)) continue;
        loadSubtasks(key);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built, rowsOpen, expanded]);

  const toggleRow = (key: string, open: boolean) => {
    if (open) setRowsOpenedHere(keys => new Set(keys).add(key));
    onToggleRow(key, open);
  };

  // ── keyboard ──────────────────────────────────────────────────────────────
  const navItems = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-nav]") ?? []);
  const focusNav = (el: HTMLElement | undefined) => { if (el) { el.focus(); el.scrollIntoView?.({ block: "nearest" }); } };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.dataset.key && e.key === " " && !e.altKey) {
      e.preventDefault();
      if (!e.repeat) pick(target.dataset.key, e, true);
      return;
    }
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
    const childList = subtaskRows(row, all, filter);
    const mineCount = (all?.status === "ready" ? all.issues : row.matched).filter(s => s.mine).length;
    const label = row.kind === "issue"
      ? rowLabel(row.issue, expandable ? `, ${subtasksKnown || row.matched.length} sub-tasks${mineCount ? `, ${mineCount} yours` : ""}` : "")
      : `${row.parent.key}: ${row.parent.summary}. ${mine ? "Not assigned to you" : "Parent not in this list"}; shown for ${row.matched.length} sub-task${row.matched.length === 1 ? "" : "s"}`;
    const issue = row.kind === "issue" ? row.issue : null;
    const movable = canMove && issue && movableIssue(issue, group) && depth === 0;
    const moveId = `${boardId}-move-${group.id}-${key}`;
    return (
      <li key={key} className="jr-item" data-context={row.kind === "context" || undefined}>
        <div className="jr-row ig-row" data-selected={(picked.size || selectionMode ? picked.has(key) : selected === key) || undefined} data-picked={picked.has(key) || undefined} data-done={issue?.status.category === "done" || undefined}
          data-mine={issue?.mine || undefined} data-dragging={dragKeys.includes(key) || undefined}
          data-drop={dropAt?.group === group.id && dropAt.key === key ? dropAt.side : undefined}
          draggable={Boolean(movable && !moveBusy)}
          onDragStart={event => {
            if (!movable || moveBusy || !issue) { event.preventDefault(); return; }
            const items = picked.has(key) ? selectedItems : [{ issue, group }];
            if (items.length > 50 || items.some(i => !movableIssue(i.issue, i.group))) {
              event.preventDefault();
              setMoveError(items.length > 50 ? "Move up to 50 issues at a time." : "Only unfinished top-level issues can be moved. Adjust the selection first.");
              return;
            }
            if (!picked.has(key)) { selectionVersion.current++; setPicked(new Set([key])); setSelectionMode(false); }
            drag.current = { items };
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", items.map(i => i.issue.key).join("\n"));
            setDragKeys(items.map(i => i.issue.key));
            setMoveMenu(null);
          }} onDragEnd={finishDrag}
          onDragOver={event => {
            if (!drag.current || !canMove || moveBusy || !issue || issue.type.subtask || !moveDestination(group)) return;
            event.stopPropagation();
            if (drag.current.items.some(i => i.issue.key === key)) { setDropAt(null); return; }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const box = event.currentTarget.getBoundingClientRect();
            setDropAt({ group: group.id, key, side: event.clientY < box.top + box.height / 2 ? "before" : "after" });
          }} onDrop={event => {
            const source = drag.current;
            if (!source || !canMove || moveBusy || !issue || issue.type.subtask) return;
            event.preventDefault(); event.stopPropagation();
            const box = event.currentTarget.getBoundingClientRect();
            const side = event.clientY < box.top + box.height / 2 ? "before" : "after";
            const move = issuesMove(source.items, group, { key, side });
            finishDrag();
            if (move) void saveMove(move, group);
          }}>
          {expandable ? (
            <button type="button" id={toggleId} className="jr-toggle" tabIndex={-1} aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} sub-tasks of ${key}`} onClick={() => toggleRow(key, !open)}>
              <Chevron open={open} />
            </button>
          ) : <span className="jr-toggle-space" aria-hidden />}
          <button type="button" className="jr-row-main" data-nav={nav} data-key={key} data-parent={parentNav} data-toggle={expandable ? toggleId : undefined}
            data-expanded={expandable ? String(open) : undefined} aria-expanded={expandable ? open : undefined}
            aria-controls={expandable && open ? `${toggleId}-children` : undefined}
            aria-describedby={`${boardId}-instructions`} tabIndex={tabStop(nav)} aria-current={selected === key || undefined}
            onKeyDown={event => {
              if (movable && !moveBusy && event.altKey && !event.ctrlKey && !event.metaKey && (event.code === "KeyM" || event.key.toLowerCase() === "m") && issue) {
                event.preventDefault(); event.stopPropagation(); openMoveMenu(issue, group, moveId, true);
              }
            }}
            aria-label={`${label}${picked.has(key) ? ". Selected" : ""}`} onFocus={() => setCurrent(nav)} onClick={event => {
              if (issue) { event.preventDefault(); pick(key, event); }
              else if (!event.ctrlKey && !event.metaKey && !event.shiftKey) { setPicked(new Set()); setSelectionMode(false); onOpen(key); }
            }} onContextMenu={event => {
              // macOS delivers Control-click as contextmenu rather than click.
              // Reserve that chord for selection; ordinary right-click stays native.
              if (issue && event.ctrlKey) { event.preventDefault(); event.currentTarget.focus(); pick(key, event); }
            }}>
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
          {movable && <button id={moveId} type="button" className="jr-move-button" disabled={moveBusy}
            aria-label={`Move ${key}`} title={`Move ${key} (Alt+M)`} aria-haspopup="dialog"
            aria-expanded={moveMenu?.anchorId === moveId} tabIndex={tabStop(nav)}
            onClick={() => openMoveMenu(issue, group, moveId)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 4h8M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4" />
            </svg>
          </button>}
        </div>
        {expandable && open && (
          <ul id={`${toggleId}-children`} className="jr-subrows" role="list" aria-label={`Sub-tasks of ${key}`} data-fade={(rowsOpenedHere.has(key) && fades(childList.length)) || undefined}>
            {all?.status === "loading" && childList.length === 0 && <li className="jr-subnote" role="status">Reading sub-tasks…</li>}
            {all?.status === "error" && (
              <li className="jr-subnote" role="alert">Sub-tasks could not be read. <button type="button" className="jr-link-btn" onClick={() => loadSubtasks(key)}>Try again</button></li>
            )}
            {childList.map(sub => {
              const subNav = `${group.id}/${sub.key}/${nav}`;
              return (
                <li key={sub.key} className="jr-item">
                  <div className="jr-row jr-subrow ig-row" data-selected={(picked.size || selectionMode ? picked.has(sub.key) : selected === sub.key) || undefined} data-picked={picked.has(sub.key) || undefined} data-done={sub.status.category === "done" || undefined}
                    data-mine={sub.mine || undefined}>
                    <span className="jr-toggle-space" aria-hidden />
                    <button type="button" className="jr-row-main" data-nav={subNav} data-key={sub.key} data-parent={nav} tabIndex={tabStop(subNav)}
                      aria-current={selected === sub.key || undefined} aria-label={`${rowLabel(sub)}${picked.has(sub.key) ? ". Selected" : ""}`}
                      aria-describedby={`${boardId}-instructions`}
                      onFocus={() => setCurrent(subNav)} onClick={event => { event.preventDefault(); pick(sub.key, event); }}
                      onContextMenu={event => { if (event.ctrlKey) { event.preventDefault(); event.currentTarget.focus(); pick(sub.key, event); } }}>
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
    <div className="jr-board" id={boardId} ref={listRef} onKeyDown={onKeyDown} style={{ "--jr-status-ch": statusCh } as CSSProperties}>
      <p className="vis-hidden" id={`${boardId}-instructions`}>Use Up and Down to navigate, Right to expand and Left to collapse. Enter opens the issue. Ctrl or Command click toggles selection; Shift click selects a range. Space toggles the focused issue.{canMove ? " Drag selected issues to reorder or change sprint. Alt+M opens Move." : ""}</p>
      {selectionMode && selectedItems.length > 0 && <div className="jr-selection" role="group" aria-label="Selected issues">
        <span role="status">{selectedItems.length} selected</span>
        {canMove && <button type="button" className="btn" id={`${boardId}-move-selected`} disabled={moveBusy || Boolean(selectionProblem)}
          aria-haspopup="dialog" aria-expanded={moveMenu?.anchorId === `${boardId}-move-selected`}
          onClick={() => openMoveMenu(selectedItems[0].issue, selectedItems[0].group, `${boardId}-move-selected`)}>Move selected</button>}
        <button type="button" className="btn" aria-label="Clear selection" onClick={() => {
          selectionVersion.current++; setPicked(new Set()); setSelectionMode(true); selectionAnchor.current = null;
        }}>Clear</button>
        {selectionProblem && canMove && <span className="jr-selection-note">{selectionProblem}</span>}
      </div>}
      <p className="jr-move-status" role="status" aria-live="polite">{moveNotice}</p>
      {moveError && !moveMenu && <p className="jr-move-error" role="alert">{moveError}</p>}
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
        // A closed sprint is read when it is opened, so until then there is
        // no count to give, and nothing is on its way either.
        const onDemand = def.kind === "closed" && (!data || data.status === "idle");
        const countText = !loaded ? (data?.status === "error" ? "" : "…")
          : totalKnown ? `${stats.count} of ${data!.total}` : `${stats.count}`;
        const people = stats.assignees;
        return (
          <Fragment key={def.id}>
          {index === firstClosed && <h3 className="jr-closed-title">Closed sprints</h3>}
          <section className="jr-group" data-kind={def.kind} aria-labelledby={`${bodyId}-title`}
            data-drop-group={dropAt?.group === def.id && !dropAt.key || undefined}
            onDragOver={event => overGroup(event, def)} onDrop={event => dropGroup(event, def)}>
            <div className="jr-group-head">
              <h3 className="jr-group-title" id={`${bodyId}-title`}>
                <button type="button" id={`${bodyId}-toggle`} className="jr-group-toggle" data-nav={nav} data-toggle={`${bodyId}-toggle`}
                  data-expanded={String(open)} aria-expanded={open} aria-controls={bodyId} tabIndex={tabStop(nav)}
                  onFocus={() => setCurrent(nav)} onClick={() => {
                    if (!open) setOpenedHere(ids => new Set(ids).add(def.id));
                    onToggleGroup(def, !open);
                  }}>
                  <Chevron open={open} />
                  <span className="jr-group-name">{def.title}</span>
                  {def.kind === "active" && <span className="jr-badge">Active</span>}
                  {dates && <span className="jr-group-dates">{dates}</span>}
                  {onDemand ? (
                    <span className="jr-group-count" title="Counted when you open it"><span aria-hidden>—</span><span className="vis-hidden">issues counted when opened</span></span>
                  ) : (
                    <span className="jr-group-count">{countText} {loaded ? (stats.count === 1 && !totalKnown ? "issue" : "issues") : <span className="vis-hidden">issues, not read yet</span>}</span>
                  )}
                </button>
              </h3>
              {loaded && (
                <div className="jr-group-facts">
                  <Tally stats={stats} mine={mine} />
                  <IntegrationAvatarStack label="Assigned to"
                    people={people.map(p => ({ key: p.id, name: p.name, src: p.avatar, you: p.id === stats.youId }))} />
                  <Totals def={def} totals={stats.totals} estimation={estimation} time={time} />
                </div>
              )}
            </div>
            {sprint?.goal && open && <p className="jr-goal">{sprint.goal}</p>}
            {open && (
              <div id={bodyId} className="jr-group-body" data-fade={(openedHere.has(def.id) && fades(rows.length)) || undefined}>
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
                  <button type="button" className="btn jr-more" disabled={moveBusy} aria-busy={data.more || undefined} onClick={() => onMore(def)}>
                    {data.more ? "Reading…" : data.total != null ? `Show more (${data.issues.length} of ${data.total})` : "Show more"}
                  </button>
                )}
              </div>
            )}
          </section>
          </Fragment>
        );
      })}

      {moveMenu && <JiraMovePopover key={moveMenu.anchorId} items={moveMenu.items} groups={groups} snap={snap}
        anchorId={moveMenu.anchorId} portalId={boardId} boundaryId={props.scrollBoundaryId} busy={moveBusy} error={moveError}
        onMove={saveMove} onClose={closeMoveMenu} />}

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
