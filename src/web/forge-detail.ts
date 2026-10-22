// What the GitHub and GitLab item pages know besides the drawing (#2179).
//
// The detail side of the panel copies the forge's own pages: a merge request
// (Overview · Commits · Pipelines · Changes, with the side column), a branch,
// a pipeline with its jobs by stage and a job's log, an issue. This file is the
// part of that which is rules rather than layout — how a merge request's
// discussions split into the three groups GitLab shows, how jobs group into
// stages and which stage starts folded, what a pipeline's ref says about the
// change it ran for, how far a log tail grows, what each word on screen is —
// so the components stay drawing and the rules stay testable.
import type {
  ChangeDetail, ChangedFile, CiState, ForgeComment, ForgeJob, ForgeKind, ForgeUser, JobAnnotation, ReviewThread,
} from "./forge-types";
import { forgeWords } from "./forge-types";
import { changeBadge, type Mark } from "./forge-panel";
import type { ForgeNode } from "./forge-html";

// ── references ───────────────────────────────────────────────────────────

/** `group/project!12` or `owner/repo#12`: how the forge itself writes a change. */
export function changeReference(kind: ForgeKind, repo: string, number: number): string {
  return `${repo}${forgeWords[kind].changeSigil}${number}`;
}

/** The change a pipeline ran for, read from its ref: GitLab's merge request
 *  pipelines run on `refs/merge-requests/<iid>/head` (or `/merge`, `/train`),
 *  GitHub's pull request runs on `refs/pull/<n>/merge`. Null for a branch or a tag. */
export function changeFromRef(ref: string | null | undefined): number | null {
  const m = /^refs\/(?:merge-requests|pull)\/(\d{1,12})\/(?:head|merge|train)$/.exec(ref ?? "");
  return m ? Number(m[1]) : null;
}

/** A ref as a person reads it: a branch or a tag by its name, a change's
 *  pipeline ref as the change (`!12`, `#12`). The full ref stays on hover. */
export function shortRef(kind: ForgeKind, ref: string): string {
  const change = changeFromRef(ref);
  if (change != null) return `${forgeWords[kind].changeSigil}${change}`;
  return ref.replace(/^refs\/(?:heads|tags)\//, "");
}

/** A pipeline's id from its page's address, when the address carries one —
 *  GitLab's `/-/pipelines/<id>`, GitHub's `/actions/runs/<id>`. A pull
 *  request's combined checks page (`/pull/<n>/checks`) has none. */
export function pipelineIdFromUrl(url: string | null | undefined): string | null {
  const m = /\/(?:-\/pipelines|actions\/runs)\/(\d{1,15})(?:[/?#]|$)/.exec(url ?? "");
  return m ? m[1] : null;
}

/** The forge's page for opening a change from this branch. */
export function newChangeUrl(kind: ForgeKind, baseUrl: string, repo: string, branch: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = repo.split("/").map(encodeURIComponent).join("/");
  if (kind === "github") return `${base}/${path}/compare/${branch.split("/").map(encodeURIComponent).join("/")}?expand=1`;
  return `${base}/${path}/-/merge_requests/new?${new URLSearchParams({ "merge_request[source_branch]": branch })}`;
}

// ── a change's page ──────────────────────────────────────────────────────

export type ChangeSection = "overview" | "commits" | "pipelines" | "changes";

export const CHANGE_SECTIONS: readonly ChangeSection[] = ["overview", "commits", "pipelines", "changes"];

/** The merge request page's tabs in the forge's own words, each with the
 *  count the forge gives for it. */
export function changeSections(kind: ForgeKind, counts: ChangeDetail["counts"]): { id: ChangeSection; label: string; count: number }[] {
  const github = kind === "github";
  return [
    { id: "overview", label: github ? "Conversation" : "Overview", count: counts.discussions },
    { id: "commits", label: "Commits", count: counts.commits },
    { id: "pipelines", label: forgeWords[kind].pipelines, count: counts.pipelines },
    { id: "changes", label: github ? "Files changed" : "Changes", count: counts.files },
  ];
}

/** The state badge beside the byline: Open, Draft, Merged or Closed. Approval
 *  has a line of its own under it, so it is not folded into the badge here. */
export function changeStateMark(c: { state: ChangeDetail["state"]; draft: boolean }): Mark {
  return changeBadge({ state: c.state, draft: c.draft, approved: false });
}

// ── a change's title ─────────────────────────────────────────────────────

const DRAFT_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:|\[wip\]|wip:)\s*/i;

/** A draft's title without the "Draft:" GitLab writes into it — the page
 *  says Draft in the state badge instead, so it is not said twice. */
export function withoutDraftPrefix(title: string): string {
  const out = title.replace(DRAFT_PREFIX, "");
  return out || title;
}

/** The same, for the forge's rendered title: only a prefix in the first text
 *  node is the forge's draft marker; one inside a link is the author's words. */
export function nodesWithoutDraftPrefix(nodes: ForgeNode[]): ForgeNode[] {
  const first = nodes[0];
  if (!first || first.t !== "text" || !DRAFT_PREFIX.test(first.text)) return nodes;
  const text = first.text.replace(DRAFT_PREFIX, "");
  return text ? [{ t: "text", text }, ...nodes.slice(1)] : nodes.slice(1);
}

// ── discussions ──────────────────────────────────────────────────────────

export interface Discussions {
  /** Open review threads, in the forge's order — GitLab's "Unresolved threads". */
  unresolved: ReviewThread[];
  resolved: ReviewThread[];
  /** Comments not on a resolvable thread, oldest first, each as a thread of its own. */
  general: ReviewThread[];
}

function commentAsThread(c: ForgeComment): ReviewThread {
  return { id: `comment:${c.id}`, resolvable: false, resolved: false, path: null, line: null, outdated: false, comments: [c], webUrl: c.webUrl };
}

const firstAt = (t: ReviewThread) => t.comments[0]?.createdAt ?? Number.MAX_SAFE_INTEGER;

/** A change's discussions as the merge request page groups them. */
export function splitDiscussions(detail: Pick<ChangeDetail, "threads" | "generalComments">): Discussions {
  const unresolved: ReviewThread[] = [];
  const resolved: ReviewThread[] = [];
  const general: ReviewThread[] = [];
  for (const t of detail.threads) {
    if (!t.comments.length) continue;
    if (!t.resolvable) general.push(t);
    else (t.resolved ? resolved : unresolved).push(t);
  }
  for (const c of detail.generalComments) general.push(commentAsThread(c));
  general.sort((a, b) => firstAt(a) - firstAt(b));
  return { unresolved, resolved, general };
}

/** A path drawn as its folder (quiet) and its file name (read first). */
export function pathParts(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { dir: "", name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/** `path:line`, the way a thread says where it is. */
export function threadPlace(t: Pick<ReviewThread, "path" | "line">): string | null {
  if (!t.path) return null;
  return t.line != null ? `${t.path}:${t.line}` : t.path;
}

// ── people and words ─────────────────────────────────────────────────────

export function personName(u: ForgeUser): string {
  return u.name || u.login;
}

/** "Alice", "Alice and Bob", "Alice, Bob and Carol". */
export function namesWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The approvals line under a change's title: who approved it, or how many
 *  approvals it still needs; null when the forge says neither. */
export function approvalWords(c: Pick<ChangeDetail, "approvedBy" | "approvalsLeft">): { mark: Mark; text: string } | null {
  if (c.approvedBy.length) return { mark: { mark: "✓", word: "approved", tone: "ok" }, text: `Approved by ${namesWords(c.approvedBy.map(personName))}` };
  if (c.approvalsLeft != null && c.approvalsLeft > 0) {
    return {
      mark: { mark: "◌", word: "approval required", tone: "idle" },
      text: `Requires ${c.approvalsLeft} more approval${c.approvalsLeft === 1 ? "" : "s"}`,
    };
  }
  return null;
}

/** A changed file's word beside its path; a plain modification has none. */
export function fileStatusWord(status: ChangedFile["status"]): string | null {
  switch (status) {
    case "added": return "new";
    case "deleted": return "deleted";
    case "renamed": return "renamed";
    default: return null;
  }
}

/** A GitLab scoped label (`priority::high`) as its scope and value. */
export function labelParts(name: string): { scope: string | null; value: string } {
  const cut = name.lastIndexOf("::");
  return cut > 0 && cut < name.length - 2 ? { scope: name.slice(0, cut), value: name.slice(cut + 2) } : { scope: null, value: name };
}

/** A label's colour, only when it is one: it is drawn as a swatch, from data. */
export function labelColor(color: string | null | undefined): string | null {
  return color && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : null;
}

/** An issue's state as a mark and a word, GitHub's reason included. */
export function issueMark(state: "open" | "closed", reason?: string | null): Mark {
  if (state === "open") return { mark: "●", word: "Open", tone: "busy" };
  if (reason === "not_planned") return { mark: "⊘", word: "Closed · not planned", tone: "idle" };
  if (reason === "duplicate") return { mark: "⊘", word: "Closed · duplicate", tone: "idle" };
  return { mark: "✓", word: "Closed", tone: "idle" };
}

/** What started a pipeline, in words. */
export function sourceWords(source: string | null | undefined): string | null {
  if (!source) return null;
  const known: Record<string, string> = {
    push: "push",
    merge_request_event: "merge request",
    pull_request: "pull request",
    pull_request_target: "pull request",
    schedule: "schedule",
    workflow_dispatch: "manual run",
    web: "run from the web",
    api: "API",
    trigger: "trigger",
    pipeline: "parent pipeline",
    parent_pipeline: "parent pipeline",
    dynamic: "dynamic",
  };
  return known[source] ?? source.replace(/_/g, " ");
}

// ── jobs ─────────────────────────────────────────────────────────────────

export interface Stage {
  /** The stage's name; null for a forge without stages (GitHub's check runs). */
  name: string | null;
  jobs: ForgeJob[];
  state: CiState;
}

/** A stage's state the way GitLab sums one: a failure that was not allowed
 *  decides it, then anything still going, then success. */
export function stageState(jobs: ForgeJob[]): CiState {
  if (!jobs.length) return "none";
  const states = jobs.map(j => (j.state === "failed" && j.allowFailure ? "success" : j.state));
  if (states.includes("failed")) return "failed";
  if (states.includes("running")) return "running";
  if (states.includes("pending")) return "pending";
  if (states.every(s => s === "skipped")) return "skipped";
  if (states.every(s => s === "manual" || s === "skipped")) return "manual";
  if (states.includes("canceled")) return "canceled";
  return "success";
}

/** Jobs grouped by stage, stages in the order the pipeline runs them. */
export function stagesOf(jobs: ForgeJob[]): Stage[] {
  const order: (string | null)[] = [];
  const by = new Map<string | null, ForgeJob[]>();
  for (const j of jobs) {
    const key = j.stage || null;
    if (!by.has(key)) {
      by.set(key, []);
      order.push(key);
    }
    by.get(key)!.push(j);
  }
  return order.map(name => {
    const list = by.get(name)!;
    return { name, jobs: list, state: stageState(list) };
  });
}

/** Past this many jobs a pipeline folds its quiet stages. */
export const MANY_JOBS = 8;

/** Whether a stage starts open: a failed stage always, every stage while the
 *  pipeline is short enough to read whole. */
export function stageStartsOpen(stage: Stage, totalJobs: number): boolean {
  return stage.state === "failed" || totalJobs <= MANY_JOBS;
}

/** Whether a job starts with its details shown: a failure that counts. */
export function jobStartsOpen(job: ForgeJob): boolean {
  return job.state === "failed" && !job.allowFailure;
}

/** An annotation's level as a mark and a word. */
export function annotationMark(level: JobAnnotation["level"]): Mark {
  switch (level) {
    case "failure": return { mark: "✕", word: "failure", tone: "bad" };
    case "warning": return { mark: "!", word: "warning", tone: "busy" };
    default: return { mark: "i", word: "notice", tone: "idle" };
  }
}

// ── a job's log ──────────────────────────────────────────────────────────

/** How far a log tail grows: 80 lines first, then 200, then 500 — the deck's
 *  ceiling. Null when there is no further step. */
export const LOG_STEPS = [80, 200, 500] as const;

export function nextLogLines(current: number | null): number | null {
  if (current == null) return LOG_STEPS[0];
  return LOG_STEPS.find(n => n > current) ?? null;
}

/** A log line worth seeing first: an error or a warning the runner printed. */
export function logLineTone(line: string): "err" | "warn" | null {
  if (/^\s*(?:::error\b|error\b|fatal\b|ERROR:|FAILED\b|✕|×)/i.test(line) || /\bJob failed\b/.test(line)) return "err";
  if (/^\s*(?:::warning\b|warning\b|warn\b)/i.test(line)) return "warn";
  return null;
}
