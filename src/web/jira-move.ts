// A move is always one explicit issue and a known sprint/backlog destination.
// DOM drag payloads never become API paths or arbitrary Jira requests.
import type { JiraIssue } from "./jira-api";
import type { GroupDef } from "./jira-board";

export interface JiraMove {
  issueKey: string;
  target: { kind: "sprint"; sprintId: number } | { kind: "backlog" };
  beforeIssue?: string;
  afterIssue?: string;
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
  return !issue.type.subtask && !issue.type.epic && issue.status.category !== "done" && moveDestination(group) !== null;
}

/** No unanchored same-group drop: that would look like a reorder but do none. */
export function issueMove(issue: JiraIssue, from: GroupDef, to: GroupDef, anchor?: { key: string; side: "before" | "after" }): JiraMove | null {
  const target = moveDestination(to);
  if (!movableIssue(issue, from) || !target || anchor?.key === issue.key || (from.id === to.id && !anchor)) return null;
  return { issueKey: issue.key, target, ...(anchor ? anchor.side === "before" ? { beforeIssue: anchor.key } : { afterIssue: anchor.key } : {}) };
}
