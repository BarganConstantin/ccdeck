// What the GitHub and GitLab panels are drawn from (#2179).
//
// Both forges are read on the server — src/server/github-api.mjs and
// src/server/gitlab-api.mjs, over the shared transport in forge-http.mjs — and
// each answers in THESE shapes, so one panel draws either. The panel copies the
// screens the owner already works in on their GitLab: the project's
// Branches page, the Merge requests dashboard, and the merge request's own page
// (Overview · Commits · Pipelines · Changes). GitHub's pull request, branch and
// Actions pages carry the same facts, so they fill the same shapes.
//
// ONE WORD FOR BOTH. A GitHub pull request and a GitLab merge request are a
// "change" here, a workflow run and a pipeline are a "pipeline", a check run
// and a CI job are a "job". The panel says the forge's own word on screen
// (forgeWords below); the data does not care which one it came from.
//
// TIMES ARE EPOCH MS. Every `…At` is a number or null, never a string, so the
// page sorts and formats without parsing.
//
// HTML IS THE FORGE'S. `descriptionHtml`, `bodyHtml` and `titleHtml` are what
// GitHub (bodyHTML) and GitLab (descriptionHtml) rendered — their own Markdown
// flavour, references, Jira links and emoji included — and they are NOT safe
// to insert as they come. The page sanitises them before drawing.

export type ForgeKind = "github" | "gitlab";

/** The failures a panel has words and a recovery for. The first seven are the
 *  shared integrations core's (#2178); the last two are the forge clients'
 *  own: an item that is gone or hidden, and a forge that answered with an
 *  error of its own (5xx, an unreadable body). */
export type ForgeErrorKind =
  | "auth" | "expired" | "permission" | "unreachable" | "tls" | "rate-limit" | "incompatible"
  | "not-found" | "upstream";

export interface ForgeErrorInfo {
  kind: ForgeErrorKind;
  /** Diagnostic words for the details line — never a token, never a header. */
  message: string;
  status?: number;
  /** Seconds until a rate limit lifts, when the forge said. */
  retryAfter?: number;
}

export interface ForgeUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  webUrl: string | null;
}

export interface ForgeAccount extends ForgeUser {
  id: string;
}

/** What validating a connection learns, kept on the connection (not secret). */
export interface ForgeValidation {
  account: ForgeAccount;
  meta: {
    /** Classic GitHub tokens and GitLab tokens list theirs; fine-grained
     *  GitHub tokens do not, and this is then absent rather than empty. */
    scopes?: string[];
    serverVersion?: string;
    /** Sentences for the connection card: a scope missing, a version old. */
    warnings?: string[];
  };
}

/** A GitHub repository or a GitLab project. */
export interface ForgeRepo {
  id: string;
  /** `owner/repo`, or `group/subgroup/project` — the key everything else takes. */
  path: string;
  name: string;
  webUrl: string;
  defaultBranch: string | null;
  lastActivityAt: number | null;
  archived: boolean;
}

/** One state for a pipeline, a job, a check or a commit's combined status. */
export type CiState =
  | "success" | "failed" | "running" | "pending" | "canceled" | "skipped" | "manual" | "none";

export interface CiSummary {
  state: CiState;
  webUrl: string | null;
}

export type ChangeState = "open" | "merged" | "closed";

/** The open change a branch is the source of — the `!5093` badge on GitLab's
 *  Branches page. */
export interface ChangeRef {
  number: number;
  /** `owner/repo#12` on GitHub, `group/project!12` on GitLab. */
  key: string;
  state: ChangeState;
  draft: boolean;
  approved: boolean;
  webUrl: string;
}

/** A row of the Branches tab. */
export interface ForgeBranch {
  name: string;
  webUrl: string;
  isDefault: boolean;
  protected: boolean;
  commit: {
    sha: string;
    shortSha: string;
    title: string;
    committedAt: number | null;
    authorName: string | null;
    webUrl: string | null;
  };
  /** Commits ahead of / behind the default branch; null when not worked out
   *  (the default branch itself, or a forge that would need a call per branch
   *  for a branch the page has not shown yet). */
  ahead: number | null;
  behind: number | null;
  ci: CiSummary | null;
  change: ChangeRef | null;
  /** Last commit older than 90 days — GitLab's own line between the page's
   *  "Active branches" and "Stale branches". */
  stale: boolean;
}

export interface ForgeLabel {
  name: string;
  /** `#rrggbb` as the forge has it, or null. Drawn as data, never as a theme. */
  color: string | null;
}

export type ReviewerState = "approved" | "changes_requested" | "commented" | "pending";

export interface ForgeReviewer extends ForgeUser {
  state: ReviewerState;
}

/** A row of the Merge requests / Pull requests tab. */
export interface ForgeChange {
  kind: ForgeKind;
  key: string;
  number: number;
  repo: string;
  title: string;
  /** The forge's rendering of the title, with its Jira or issue links. */
  titleHtml: string | null;
  state: ChangeState;
  draft: boolean;
  webUrl: string;
  author: ForgeUser | null;
  assignees: ForgeUser[];
  reviewers: ForgeReviewer[];
  sourceBranch: string;
  targetBranch: string;
  createdAt: number | null;
  updatedAt: number | null;
  mergedAt: number | null;
  closedAt: number | null;
  /** User comments, system notes left out. */
  comments: number;
  unresolvedThreads: number | null;
  approved: boolean;
  approvedByMe: boolean;
  approvalsRequired: number | null;
  approvalsLeft: number | null;
  ci: CiSummary | null;
  labels: ForgeLabel[];
}

export interface ForgeComment {
  id: string;
  author: ForgeUser | null;
  bodyHtml: string;
  createdAt: number | null;
  webUrl: string | null;
}

/** An inline review thread, or a resolvable discussion. */
export interface ReviewThread {
  id: string;
  resolvable: boolean;
  resolved: boolean;
  /** The file and line it is on; null for a discussion not on a line. */
  path: string | null;
  line: number | null;
  outdated: boolean;
  comments: ForgeComment[];
  webUrl: string | null;
}

/** The merge request page's Overview, plus its tab counts. */
export interface ChangeDetail extends ForgeChange {
  descriptionHtml: string;
  milestone: { title: string; webUrl: string | null } | null;
  participants: ForgeUser[];
  approvedBy: ForgeUser[];
  counts: { discussions: number; commits: number; pipelines: number; files: number };
  threads: ReviewThread[];
  generalComments: ForgeComment[];
}

export interface ForgeCommit {
  sha: string;
  shortSha: string;
  title: string;
  authorName: string | null;
  authoredAt: number | null;
  webUrl: string | null;
}

export interface ChangedFile {
  path: string;
  /** The old path of a rename; null otherwise. */
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  webUrl: string | null;
}

/** A GitLab pipeline, or a GitHub Actions workflow run. */
export interface ForgePipeline {
  id: string;
  repo: string;
  ref: string;
  sha: string;
  shortSha: string;
  /** The commit's title on GitLab; the workflow's name and run title on GitHub. */
  title: string | null;
  state: CiState;
  /** push, merge_request_event, schedule, pull_request, workflow_dispatch… */
  source: string | null;
  triggeredBy: ForgeUser | null;
  createdAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  durationSec: number | null;
  webUrl: string;
}

export interface JobAnnotation {
  path: string | null;
  line: number | null;
  level: "failure" | "warning" | "notice";
  title: string | null;
  message: string;
}

/** A GitLab job, or a GitHub check run. */
export interface ForgeJob {
  id: string;
  name: string;
  stage: string | null;
  state: CiState;
  allowFailure: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  durationSec: number | null;
  webUrl: string | null;
  /** GitLab's failure_reason, or a GitHub check's own summary line. */
  failureReason: string | null;
  annotations: JobAnnotation[];
  /** Whether jobLogTail can read this job's log (GitHub: Actions jobs only). */
  logAvailable: boolean;
}

export interface PipelineDetail extends ForgePipeline {
  jobs: ForgeJob[];
}

/** The end of a job's log, cleaned of colour codes and section markers. */
export interface LogTail {
  lines: string[];
  /** More came before these lines. */
  truncated: boolean;
  webUrl: string | null;
}

/** A branch that is not the source of an open change: its latest pipeline and
 *  the commits it has that the default branch does not. */
export interface BranchDetail {
  branch: ForgeBranch;
  pipeline: PipelineDetail | null;
  commitsAhead: ForgeCommit[];
}

export interface IssueRef {
  key: string;
  number: number;
  repo: string;
  title: string;
  state: "open" | "closed";
  webUrl: string;
  /** GitLab's work item type (Task, Issue…), when it has one. */
  type: string | null;
}

export interface ForgeIssue {
  kind: ForgeKind;
  key: string;
  number: number;
  repo: string;
  title: string;
  titleHtml: string | null;
  state: "open" | "closed";
  /** completed / not_planned / duplicate on GitHub; null when not said. */
  stateReason: string | null;
  webUrl: string;
  author: ForgeUser | null;
  assignees: ForgeUser[];
  labels: ForgeLabel[];
  milestone: { title: string; webUrl: string | null } | null;
  createdAt: number | null;
  updatedAt: number | null;
  closedAt: number | null;
  comments: number;
  /** Sub-issues (GitHub) or child tasks (GitLab); null when it has none. */
  children: { total: number; completed: number } | null;
  parent: IssueRef | null;
}

export interface IssueDetail extends ForgeIssue {
  descriptionHtml: string;
  childItems: IssueRef[];
}

/** A page of a list. `next` is an opaque cursor for the next page, or null
 *  at the end; `total` is the forge's own count when it gives one. */
export interface Page<T> {
  items: T[];
  next: string | null;
  total: number | null;
}

/** The counts on the Open / Merged / Closed tabs. */
export interface ChangeCounts {
  open: number | null;
  merged: number | null;
  closed: number | null;
}

/** Which changes a list is: the dashboard's All, the user's own, or the ones
 *  waiting on the user's review. */
export type ChangeFilter = "all" | "mine" | "review";

/** A pasted URL or key, read: what it points at. */
export interface ForgeRefTarget {
  type: "change" | "issue";
  repo: string;
  number: number;
}

/** The forge's own words for the same things. */
export const forgeWords: Record<ForgeKind, {
  name: string; change: string; changes: string; changeSigil: string; pipeline: string; pipelines: string; repo: string;
}> = {
  github: {
    name: "GitHub", change: "Pull request", changes: "Pull requests", changeSigil: "#",
    pipeline: "Workflow run", pipelines: "Actions", repo: "Repository",
  },
  gitlab: {
    name: "GitLab", change: "Merge request", changes: "Merge requests", changeSigil: "!",
    pipeline: "Pipeline", pipelines: "Pipelines", repo: "Project",
  },
};
