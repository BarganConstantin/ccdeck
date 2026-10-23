// What the deck's Jira routes answer (#2178) — the shapes src/server/integrations/jira.mjs
// normalises Cloud's and Server's answers into, so one panel draws both — and
// the reads themselves, each a GET under /api/integrations/jira/<connId>/.

import { queryOf, readThrough } from "./integrations/client";
import type { IntegrationConnection } from "./integrations/types";

export type StatusCategory = "new" | "indeterminate" | "done";

export interface JiraPerson { id: string; name: string; avatar: string | null }
export interface JiraType { name: string; icon: string | null; subtask: boolean; epic: boolean }
export interface JiraStatus { name: string; category: StatusCategory }
export interface JiraPriority { name: string; icon: string | null }
export interface JiraEpic { key: string; name: string; color: number | null }

export interface JiraParent {
  key: string;
  summary: string;
  type: JiraType;
  status: JiraStatus;
  priority: JiraPriority | null;
}

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  url: string;
  type: JiraType;
  status: JiraStatus;
  priority: JiraPriority | null;
  assignee: JiraPerson | null;
  mine: boolean;
  parent: JiraParent | null;
  subtaskKeys: string[];
  epic: JiraEpic | null;
  fixVersions: string[];
  /** Original estimate, in seconds. */
  estimate: number | null;
  /** Remaining estimate, in seconds. */
  remaining: number | null;
  points: number | null;
  flagged: boolean;
  updated: string;
}

export interface JiraSprint {
  id: number;
  name: string;
  state: string;
  startDate: string | null;
  endDate: string | null;
  completeDate: string | null;
  goal: string;
}

export interface JiraBoardSummary {
  id: number;
  name: string;
  type: string;
  projectKey: string;
  projectName: string;
  avatar: string | null;
}

export interface JiraEstimation { kind: "time" | "points" | "count"; fieldId: string | null; label: string }

export interface JiraBoardOverview {
  board: { id: number; name: string; type: string; projectKey: string; projectName: string };
  estimation: JiraEstimation;
  quickFilters: { id: string; name: string; description: string }[];
  sprints: { active: JiraSprint[]; future: JiraSprint[] };
  hasSprints: boolean;
  hasBacklog: boolean;
  timeTracking: TimeTracking;
}

export interface TimeTracking { hoursPerDay: number; daysPerWeek: number }

export interface JiraIssuePage {
  issues: JiraIssue[];
  /** Null when Jira will not say (Cloud's token-paged backlog with no count). */
  total: number | null;
  /** The cursor for the backlog's next page; "" on the last. */
  next: string;
  /** A sprint or column longer than the deck reads whole. */
  capped: boolean;
}

export interface JiraComment { id: string; author: JiraPerson | null; created: string; updated: string; html: string }
export interface JiraAttachment { id: string; filename: string; size: number | null; mimeType: string; created: string; url: string | null }

export interface JiraIssueDetail {
  issue: JiraIssue & {
    project: { key: string; name: string; avatar: string | null };
    reporter: JiraPerson | null;
    labels: string[];
    components: string[];
    dueDate: string | null;
    created: string;
    resolution: string | null;
    timeSpent: number | null;
    sprint: { name: string; state: string } | null;
    descriptionHtml: string;
  };
  comments: { total: number; items: JiraComment[] };
  attachments: JiraAttachment[];
  subtasks: JiraIssue[];
}

/** The host's `api`: a request under this connection's prefix. */
export type JiraApi = (path: string, init?: RequestInit) => Promise<Response>;

const read = <T,>(api: JiraApi, path: string, params: Record<string, string | number | boolean | undefined> = {}, signal?: AbortSignal) =>
  readThrough<T>(api, `${path}${queryOf(params)}`, { signal });

export const readBoards = (api: JiraApi, startAt: number, name: string, signal?: AbortSignal) =>
  read<{ boards: JiraBoardSummary[]; startAt: number; total: number | null; isLast: boolean }>(api, "boards", { startAt: startAt || undefined, name }, signal);

export const readBoard = (api: JiraApi, boardId: string, signal?: AbortSignal) =>
  read<JiraBoardOverview>(api, `board/${encodeURIComponent(boardId)}`, {}, signal);

export const readClosedSprints = (api: JiraApi, boardId: string, startAt: number, signal?: AbortSignal) =>
  read<{ sprints: JiraSprint[]; startAt: number; total: number; isLast: boolean }>(api, `board/${encodeURIComponent(boardId)}/closed-sprints`, { startAt: startAt || undefined }, signal);

export interface IssueQuery {
  source: "sprint" | "backlog" | "kanban";
  sprint?: number;
  column?: "todo" | "progress" | "done";
  /** The backlog page to read: the `next` the last one answered. */
  cursor?: string;
  /** A kanban board's backlog is on, so To Do leaves its issues to it. */
  backlog?: boolean;
  mine: boolean;
  quick: string[];
}

export const readIssues = (api: JiraApi, boardId: string, q: IssueQuery, signal?: AbortSignal) =>
  read<JiraIssuePage>(api, `board/${encodeURIComponent(boardId)}/issues`, {
    source: q.source, sprint: q.sprint, column: q.column, cursor: q.cursor || undefined, backlog: q.backlog,
    mine: q.mine, quick: q.quick.join(",") || undefined,
  }, signal);

export const readSubtasks = (api: JiraApi, key: string, signal?: AbortSignal) =>
  read<{ issues: JiraIssue[] }>(api, `issue/${encodeURIComponent(key)}/subtasks`, {}, signal);

export const readIssue = (api: JiraApi, key: string, signal?: AbortSignal) =>
  read<JiraIssueDetail>(api, `issue/${encodeURIComponent(key)}`, {}, signal);

/**
 * The deck's address for an image inside an issue's HTML: always the asset
 * route (null for what it never serves, an SVG or a non-https address — the
 * sanitiser then draws a link instead). A scoped Cloud token is refused on
 * the site itself, so the images api.atlassian.com serves too are asked for
 * there, as the server does for icons and avatars
 * (src/server/integrations/jira.mjs imageUrl).
 */
export function jiraImage(conn: Pick<IntegrationConnection, "baseUrl" | "allowedOrigins" | "meta">, assetUrl: (url: string) => string, absoluteUrl: string): string | null {
  let u: URL;
  try { u = new URL(absoluteUrl); } catch { return null; }
  const apiBase = typeof conn.meta?.apiBase === "string" ? conn.meta.apiBase : "";
  let site = "";
  try { site = new URL(conn.baseUrl).origin; } catch { /* no site */ }
  if (apiBase && u.origin === site && /^\/(rest|images)\//.test(u.pathname)) {
    try { u = new URL(`${apiBase}${u.pathname}${u.search}`); } catch { return null; }
  }
  // Every image goes through the asset route, which reads it with the token
  // on the connection's own origins and without it on Jira's public image
  // hosts, and refuses (an empty 403) anything else: a picture linked from
  // some other site in a description falls back to its link.
  if (/\.svg$/i.test(u.pathname)) return null;
  const local = u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) && conn.allowedOrigins.includes(u.origin);
  if (u.protocol !== "https:" && !local) return null;
  return assetUrl(u.href);
}
