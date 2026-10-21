// The Jira panel's rules, apart from React (#2178): which groups a board has
// and in what order, how a group's issues become rows — subtasks under their
// parent, a parent nobody asked for drawn as context, no issue twice — what a
// group's header counts, and how Jira writes a duration.
//
// It is a replica of Jira's Backlog page, which is the screen the owner reads
// "99% of the time": every active sprint open, the future sprints and the
// backlog folded below them, closed sprints on demand, issues in Rank order.

import type { JiraBoardOverview, JiraIssue, JiraParent, JiraPerson, JiraSprint, StatusCategory, TimeTracking } from "./jira-api";

// ── groups ──────────────────────────────────────────────────────────────────

export type GroupKind = "active" | "future" | "closed" | "backlog" | "column";
export type KanbanColumn = "todo" | "progress" | "done";

export interface GroupDef {
  id: string;
  kind: GroupKind;
  title: string;
  sprint?: JiraSprint;
  column?: KanbanColumn;
  /** Open on a first visit, before the reader has said otherwise. */
  defaultOpen: boolean;
  /** Read a page at a time, with a Show more, rather than whole. */
  paged: boolean;
}

export const sprintGroupId = (sprint: Pick<JiraSprint, "id">) => `sprint:${sprint.id}`;

/** A board's groups, in the Backlog page's order. Kanban boards, which have no
 *  sprints, get Jira's three status categories — Done only for the last 14
 *  days — and the backlog when the board shows one. */
export function groupsFor(overview: JiraBoardOverview, closed: JiraSprint[] = []): GroupDef[] {
  const out: GroupDef[] = [];
  if (overview.hasSprints) {
    for (const sprint of overview.sprints.active) out.push({ id: sprintGroupId(sprint), kind: "active", title: sprint.name, sprint, defaultOpen: true, paged: false });
    for (const sprint of overview.sprints.future) out.push({ id: sprintGroupId(sprint), kind: "future", title: sprint.name, sprint, defaultOpen: false, paged: false });
    if (overview.hasBacklog) out.push({ id: "backlog", kind: "backlog", title: "Backlog", defaultOpen: false, paged: true });
    for (const sprint of closed) out.push({ id: sprintGroupId(sprint), kind: "closed", title: sprint.name, sprint, defaultOpen: false, paged: false });
    return out;
  }
  out.push({ id: "column:todo", kind: "column", column: "todo", title: "To Do", defaultOpen: true, paged: false });
  out.push({ id: "column:progress", kind: "column", column: "progress", title: "In Progress", defaultOpen: true, paged: false });
  out.push({ id: "column:done", kind: "column", column: "done", title: "Done in the last 14 days", defaultOpen: false, paged: false });
  if (overview.hasBacklog) out.push({ id: "backlog", kind: "backlog", title: "Backlog", defaultOpen: false, paged: true });
  return out;
}

/** Whether a group is open: what the reader chose for this group, or its
 *  default. Keyed by sprint id, so a sprint that has just become active has
 *  no choice recorded and opens — a new sprint is never hidden by an old
 *  preference. */
export function groupOpen(group: GroupDef, expanded: Record<string, boolean>): boolean {
  return Object.hasOwn(expanded, group.id) ? expanded[group.id] : group.defaultOpen;
}

// ── rows ────────────────────────────────────────────────────────────────────

export interface IssueRow {
  kind: "issue";
  issue: JiraIssue;
  /** Subtasks of this issue that are in the group's own results — under
   *  "Only my issues", the ones that are yours. */
  matched: JiraIssue[];
}

/** A parent drawn for the sake of its subtasks: under "Only my issues", the
 *  story your subtask belongs to when the story is somebody else's. */
export interface ContextRow {
  kind: "context";
  parent: JiraParent;
  matched: JiraIssue[];
}

export type Row = IssueRow | ContextRow;

export const rowKey = (row: Row) => (row.kind === "issue" ? row.issue.key : row.parent.key);

/**
 * A group's issues, in Rank order, as rows. A subtask goes under its parent
 * when the parent is in the same results, and under a context row for the
 * parent when it is not; an issue already drawn in an earlier group (`seen`)
 * is not drawn again. `seen` is added to.
 */
export function buildRows(issues: readonly JiraIssue[], seen: Set<string> = new Set()): Row[] {
  const here = new Map<string, JiraIssue>();
  for (const issue of issues) if (!seen.has(issue.key) && !here.has(issue.key)) here.set(issue.key, issue);
  const rows: Row[] = [];
  const byParent = new Map<string, Row>();
  for (const issue of here.values()) {
    const parentKey = issue.type.subtask && issue.parent ? issue.parent.key : null;
    if (parentKey && parentKey !== issue.key) {
      let row = byParent.get(parentKey);
      if (!row) {
        const parent = here.get(parentKey);
        if (parent && !seen.has(parentKey)) {
          // The parent is in these results but comes later in rank: its row
          // is drawn where the parent ranks, so make it now and place it then.
          row = { kind: "issue", issue: parent, matched: [] };
        } else {
          row = { kind: "context", parent: issue.parent!, matched: [] };
          rows.push(row);
        }
        byParent.set(parentKey, row);
      }
      row.matched.push(issue);
      continue;
    }
    let row = byParent.get(issue.key);
    if (!row) {
      row = { kind: "issue", issue, matched: [] };
      byParent.set(issue.key, row);
    }
    rows.push(row);
  }
  for (const key of here.keys()) seen.add(key);
  return rows;
}

export interface RowFilter {
  /** Lower-case text to find in a key or a summary; empty for none. */
  search: string;
  hideDone: boolean;
}

const isDone = (issue: { status: { category: StatusCategory } }) => issue.status.category === "done";

export function issueMatches(issue: { key: string; summary: string }, search: string): boolean {
  if (!search) return true;
  return issue.key.toLowerCase().includes(search) || issue.summary.toLowerCase().includes(search);
}

/** The rows the reader's search and Hide done leave, each with only the
 *  subtasks they leave. A parent stays while a subtask under it does. */
export function filterRows(rows: readonly Row[], filter: RowFilter, subtasks?: (key: string) => readonly JiraIssue[] | undefined): Row[] {
  const search = filter.search.trim().toLowerCase();
  if (!search && !filter.hideDone) return rows.slice();
  const keep = (issue: JiraIssue) => (!filter.hideDone || !isDone(issue)) && issueMatches(issue, search);
  const out: Row[] = [];
  for (const row of rows) {
    const matched = row.matched.filter(keep);
    const all = subtasks?.(rowKey(row)) ?? [];
    const anyChild = matched.length > 0 || all.some(keep);
    if (row.kind === "issue") {
      const self = keep(row.issue);
      if (self || anyChild) out.push({ ...row, matched });
    } else if (anyChild) {
      out.push({ ...row, matched });
    }
  }
  return out;
}

// ── what a header counts ────────────────────────────────────────────────────

export interface GroupStats {
  /** The issues the group counts: top-level rows, and subtasks drawn under
   *  context rows — never a context row itself. Jira's own count is of the
   *  sprint's issues without their subtasks, which this matches when nothing
   *  is filtered. */
  count: number;
  /** Estimate sums by status category, in seconds, story points or issues as
   *  the board estimates. */
  totals: Record<StatusCategory, number>;
  /** Everyone with a counted issue, most issues first. */
  assignees: JiraPerson[];
  /** Of the counted issues, how many are the reader's, and how many of those
   *  are done. */
  mine: number;
  mineDone: number;
}

export function countedIssues(rows: readonly Row[]): JiraIssue[] {
  return rows.flatMap(row => (row.kind === "issue" ? [row.issue] : row.matched));
}

export function groupStats(rows: readonly Row[], estimation: "time" | "points" | "count"): GroupStats {
  const issues = countedIssues(rows);
  const totals: Record<StatusCategory, number> = { new: 0, indeterminate: 0, done: 0 };
  const people = new Map<string, { person: JiraPerson; n: number }>();
  let mine = 0;
  let mineDone = 0;
  for (const issue of issues) {
    const value = estimation === "count" ? 1 : estimation === "points" ? issue.points ?? 0 : issue.estimate ?? 0;
    totals[issue.status.category] += value;
    if (issue.assignee) {
      const at = people.get(issue.assignee.id);
      if (at) at.n++; else people.set(issue.assignee.id, { person: issue.assignee, n: 1 });
    }
    if (issue.mine) {
      mine++;
      if (isDone(issue)) mineDone++;
    }
  }
  const assignees = [...people.values()].sort((a, b) => b.n - a.n || a.person.name.localeCompare(b.person.name)).map(p => p.person);
  return { count: issues.length, totals, assignees, mine, mineDone };
}

// ── durations and dates ─────────────────────────────────────────────────────

/** Seconds as Jira writes them — "1w 2d 3h 30m" — on the instance's own
 *  working day and week, 8 hours and 5 days unless it says otherwise. */
export function jiraDuration(totalSeconds: number | null | undefined, time: TimeTracking = { hoursPerDay: 8, daysPerWeek: 5 }): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return "";
  let minutes = Math.round(totalSeconds / 60);
  if (minutes <= 0) return "0m";
  const hour = 60;
  const day = Math.round(time.hoursPerDay * hour);
  const week = Math.round(day * time.daysPerWeek);
  const parts: string[] = [];
  for (const [size, unit] of [[week, "w"], [day, "d"], [hour, "h"], [1, "m"]] as const) {
    if (size <= 0) continue;
    const n = Math.floor(minutes / size);
    if (n > 0) { parts.push(`${n}${unit}`); minutes -= n * size; }
  }
  return parts.join(" ");
}

/** A total as its header chip says it. */
export function totalLabel(value: number, estimation: "time" | "points" | "count", time: TimeTracking): string {
  if (estimation === "time") return jiraDuration(value, time) || "0m";
  if (estimation === "points") return `${Number.isInteger(value) ? value : value.toFixed(1)}`;
  return String(value);
}

/** "14 Oct" — a sprint's start or end, in the reader's own calendar. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Jira's timestamps (`2026-10-14T09:12:33.000+0300`) as a readable date. */
export function jiraDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "";
  // Older Safari will not parse a +0300 offset without its colon.
  const at = new Date(String(iso).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (Number.isNaN(at.getTime())) return String(iso);
  return withTime
    ? at.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "5m ago" — how old the panel's data is. */
export function agoLabel(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** Bytes as a file list says them. */
export function fileSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
