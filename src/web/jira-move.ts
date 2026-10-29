// A move names explicit issues and a known sprint/backlog destination.
// DOM drag payloads never become API paths or arbitrary Jira requests.
import type { JiraIssue } from "./jira-api";
import type { GroupDef } from "./jira-board";

export type JiraMove = {
  target: { kind: "sprint"; sprintId: number } | { kind: "backlog" };
  beforeIssue?: string;
  afterIssue?: string;
} & ({ issueKey: string; issueKeys?: never } | { issueKey?: never; issueKeys: string[] });

export interface JiraMoveItem { issue: JiraIssue; group: GroupDef }
export const moveKeys = (move: JiraMove): string[] => move.issueKeys ?? [move.issueKey];

/** Selection uses visible order, never click order or a hidden filtered row. */
export function selectIssue(current: ReadonlySet<string>, visible: readonly string[], key: string, anchor: string | null,
  mode: "replace" | "toggle" | "range" | "add-range"): Set<string> {
  if (!visible.includes(key)) return new Set(current);
  if (mode === "replace") return new Set([key]);
  if (mode === "toggle") {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  }
  const start = anchor ? visible.indexOf(anchor) : -1;
  const end = visible.indexOf(key);
  const range = start < 0 ? [key] : visible.slice(Math.min(start, end), Math.max(start, end) + 1);
  return new Set([...(mode === "add-range" ? current : []), ...range]);
}

export function moveDestination(group: GroupDef): JiraMove["target"] | null {
  if (group.kind === "backlog") return { kind: "backlog" };
  if ((group.kind === "active" || group.kind === "future") && group.sprint
    && (group.sprint.state === "active" || group.sprint.state === "future")) {
    return { kind: "sprint", sprintId: group.sprint.id };
  }
  return null;
}

export function movableIssue(issue: JiraIssue, group: GroupDef): boolean {
  return issueMoveBlocker({ issue, group }) === null;
}

export function issueMoveBlocker({ issue, group }: JiraMoveItem): string | null {
  if (issue.type.subtask) return "is a subtask";
  if (issue.type.epic) return "is an epic";
  if (group.kind === "closed") return "is in a closed sprint";
  if (!moveDestination(group)) return "is not in an active/future sprint or the backlog";
  return null;
}

/** Name the actual blockers instead of making the reader inspect the batch. */
export function moveSelectionProblem(items: readonly JiraMoveItem[]): string {
  const blocked = items.filter(i => issueMoveBlocker(i));
  if (blocked.length) return `${blocked.slice(0, 2).map(i => `${i.issue.key} ${issueMoveBlocker(i)}`).join("; ")}${blocked.length > 2 ? `; ${blocked.length - 2} more blocked` : ""}. Remove blocked issues to move the rest.`;
  return items.length > 50 ? "Move up to 50 issues at a time." : "";
}

/** No unanchored same-group drop: that would look like a reorder but do none. */
export function issueMove(issue: JiraIssue, from: GroupDef, to: GroupDef, anchor?: { key: string; side: "before" | "after" }): JiraMove | null {
  return issuesMove([{ issue, group: from }], to, anchor);
}

export function issuesMove(items: readonly JiraMoveItem[], to: GroupDef, anchor?: { key: string; side: "before" | "after" }): JiraMove | null {
  const target = moveDestination(to);
  const keys = items.map(i => i.issue.key);
  if (!items.length || items.length > 50 || new Set(keys).size !== keys.length || !target
    || items.some(i => !movableIssue(i.issue, i.group)) || (anchor && keys.includes(anchor.key))
    || (items.every(i => i.group.id === to.id) && !anchor)) return null;
  return { ...(keys.length === 1 ? { issueKey: keys[0] } : { issueKeys: keys }), target,
    ...(anchor ? anchor.side === "before" ? { beforeIssue: anchor.key } : { afterIssue: anchor.key } : {}) };
}
