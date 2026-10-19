// What the GitHub and GitLab panel's four lists know besides the drawing
// (#2179): Branches, Merge requests / Pull requests, Pipelines / Actions and
// Issues, and the project picker above them.
//
// The tabs copy GitLab's own list screens, and most of what makes a row read
// like GitLab's is wording — `!12` inside a project and `group/project!12`
// across all of them, "updated 3h ago" turning into "merged 3h ago" once a
// change is merged, a sentence that says WHICH list is empty — so that lives
// here, where a plain-node test can hold it, and the components stay drawing.
//
// EVERY LIST ENDS IN ONE OF FIVE PHASES (listPhase): still loading, failed with
// nothing to show, empty, emptied by the search box, or rows. A tab draws the
// phase; it never works the phase out from the read's fields itself.
import { useEffect } from "react";
import type {
  ChangeFilter, ChangeState, ForgeBranch, ForgeChange, ForgeKind,
} from "./forge-types";
import { forgeWords } from "./forge-types";
import type { Mark } from "./forge-panel";
import type { Freshness } from "./components/forge/ForgeContext";

// ── projects ─────────────────────────────────────────────────────────────

/** "projects" on GitLab, "repositories" on GitHub. */
export function repoNounPlural(kind: ForgeKind): string {
  const noun = forgeWords[kind].repo.toLowerCase();
  return noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`;
}

/** The picker's "every project" choice. */
export function allReposLabel(kind: ForgeKind): string {
  return `All ${repoNounPlural(kind)}`;
}

/** A path as the picker draws it: the group quiet, the project's own name
 *  last and never cut. `group/sub/` and `project`. */
export function splitRepoPath(path: string): { group: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { group: "", name: path } : { group: path.slice(0, i + 1), name: path.slice(i + 1) };
}

// ── rows ─────────────────────────────────────────────────────────────────

/** How a change or an issue is named in a list: `!12` (or `#12`) inside one
 *  project, the full key across all of them, so a row from another project
 *  says which. */
export function itemLabel(sigil: string, item: { key: string; number: number }, acrossRepos: boolean): string {
  return acrossRepos ? item.key : `${sigil}${item.number}`;
}

const DRAFT_PREFIX = /^\s*(?:\[(?:draft|wip)\]|\((?:draft|wip)\)|(?:draft|wip)\s*:)\s*/i;

/** A draft's title without the "Draft:" GitLab writes into it — the row draws
 *  a Draft badge instead, so both forges mark a draft the same way. */
export function draftTitle(title: string, draft: boolean): string {
  if (!draft) return title;
  const bare = title.replace(DRAFT_PREFIX, "");
  return bare || title;
}

/** The moment a change row ends on: when it was merged or closed, if it was,
 *  otherwise when anything last happened to it. */
export function changeMoment(c: Pick<ForgeChange, "state" | "updatedAt" | "mergedAt" | "closedAt">): { verb: string; at: number | null } {
  if (c.state === "merged" && c.mergedAt != null) return { verb: "merged", at: c.mergedAt };
  if (c.state === "closed" && c.closedAt != null) return { verb: "closed", at: c.closedAt };
  return { verb: "updated", at: c.updatedAt };
}

/** Why a closed issue was closed, when the forge says it was not done:
 *  GitHub's "not planned" and "duplicate". A plain close needs no badge —
 *  the Closed tab already says it. */
export function issueClosedMark(i: { state: "open" | "closed"; stateReason: string | null }): Mark | null {
  if (i.state !== "closed") return null;
  if (i.stateReason === "not_planned") return { mark: "⊘", word: "Not planned", tone: "idle" };
  if (i.stateReason === "duplicate") return { mark: "⊘", word: "Duplicate", tone: "idle" };
  return null;
}

/** The default branch first, as GitLab's Branches page has it; the rest in
 *  the order the forge gave. */
export function defaultFirst<T extends { isDefault: boolean }>(branches: T[]): T[] {
  const i = branches.findIndex(b => b.isDefault);
  return i <= 0 ? branches : [branches[i], ...branches.slice(0, i), ...branches.slice(i + 1)];
}

/** A count on a state chip, or nothing when the forge did not say. */
export function countWords(n: number | null | undefined): string | null {
  return n == null || !Number.isFinite(n) || n < 0 ? null : n.toLocaleString("en-US");
}

/** A label's colour, kept only when it is a plain hex colour: it is the
 *  forge's data, and nothing but a colour may reach a style. */
export function labelColor(color: string | null | undefined): string | null {
  return typeof color === "string" && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : null;
}

/** Behind | ahead as a sentence, for the hover and for a screen reader. */
export function divergeWords(behind: number | null, ahead: number | null, defaultBranch: string | null): string | null {
  if (behind == null || ahead == null) return null;
  const target = defaultBranch ? `“${defaultBranch}”` : "the default branch";
  const n = (count: number) => (count >= 1000 ? "999+" : String(count));
  return `${n(behind)} ${behind === 1 ? "commit" : "commits"} behind, ${n(ahead)} ahead of ${target}`;
}

/**
 * Where "Create merge request ↗" goes for a branch with no open change: the
 * forge's own form with the branch filled in. ForgeBranch carries the
 * branch's page and not that form, so it is made from the branch page's
 * address — only when that address ends the way the clients write it — and
 * falls back to the branch page otherwise.
 */
export function newChangeUrl(kind: ForgeKind, branch: Pick<ForgeBranch, "name" | "webUrl">): string {
  const encoded = branch.name.split("/").map(encodeURIComponent).join("/");
  const marker = kind === "gitlab" ? "/-/tree/" : "/tree/";
  for (const tail of new Set([encoded, branch.name])) {
    const suffix = `${marker}${tail}`;
    if (!branch.webUrl.endsWith(suffix)) continue;
    const base = branch.webUrl.slice(0, -suffix.length);
    if (!/^https?:\/\/[^/]+\/\S+$/.test(base)) break;
    return kind === "gitlab"
      ? `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch.name)}`
      : `${base}/compare/${encoded}?expand=1`;
  }
  return branch.webUrl;
}

/** A pipeline row's title. GitHub's run title arrives as "workflow · run
 *  title" (github-api.mjs); the run's own title leads and the workflow goes
 *  to the line under it. GitLab's is the commit's title as it is. */
export function pipelineTitle(kind: ForgeKind, title: string | null): { workflow: string | null; title: string | null } {
  if (!title) return { workflow: null, title: null };
  if (kind !== "github") return { workflow: null, title };
  const i = title.indexOf(" · ");
  return i > 0 && i < title.length - 3
    ? { workflow: title.slice(0, i), title: title.slice(i + 3) }
    : { workflow: null, title };
}

const SOURCES: Record<string, string> = {
  push: "push",
  merge_request_event: "merge request",
  pull_request: "pull request",
  pull_request_target: "pull request",
  merge_group: "merge queue",
  schedule: "schedule",
  workflow_dispatch: "manual",
  web: "manual",
  api: "API",
  trigger: "trigger",
  pipeline: "multi-project",
  parent_pipeline: "child pipeline",
  release: "release",
  external: "external",
  chat: "chat",
  ondemand_dast_scan: "DAST scan",
  security_orchestration_policy: "security policy",
};

/** What started a pipeline or a workflow run, in words. */
export function pipelineSourceWords(source: string | null | undefined): string | null {
  if (!source) return null;
  return SOURCES[source] ?? source.replace(/_/g, " ");
}

// ── what a list says ─────────────────────────────────────────────────────

export type ListPhase = "loading" | "failed" | "empty" | "no-match" | "rows";

/** Which of its five states a list is in: `loaded` rows came from the forge,
 *  `shown` of them survive the search box. */
export function listPhase(read: { data: unknown; error: unknown }, loaded: number, shown: number): ListPhase {
  if (read.data == null) return read.error ? "failed" : "loading";
  if (loaded === 0) return "empty";
  if (shown === 0) return "no-match";
  return "rows";
}

/** The sentence for a search that hid every loaded row. */
export function noMatchWords(nounPlural: string, query: string): string {
  return `No ${nounPlural} match “${query.trim()}”.`;
}

/** The Load more button's words: how many are on screen of how many. */
export function moreLabel(shown: number, total: number | null): string {
  return total != null && total > shown ? `Load more · ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}` : "Load more";
}

/** What an empty Merge requests / Pull requests list is, in a sentence. */
export function emptyChangesWords(kind: ForgeKind, o: { state: ChangeState; filter: ChangeFilter; acrossRepos: boolean }): string {
  const noun = forgeWords[kind].changes.toLowerCase();
  const where = o.acrossRepos ? "" : ` in this ${forgeWords[kind].repo.toLowerCase()}`;
  if (o.filter === "mine") return `You have no ${o.state} ${noun}${where}.`;
  if (o.filter === "review") {
    return o.state === "open"
      ? `Nothing is waiting for your review${where}.`
      : `No ${o.state} ${noun} asked for your review${where}.`;
  }
  return `No ${o.state} ${noun}${where}.`;
}

/** What an empty Pipelines / Actions list is. */
export function emptyPipelinesWords(kind: ForgeKind, acrossRepos: boolean): string {
  const noun = `${forgeWords[kind].pipeline.toLowerCase()}s`;
  return acrossRepos
    ? `No ${noun} in your most recently active ${repoNounPlural(kind)}.`
    : `No ${noun} in this ${forgeWords[kind].repo.toLowerCase()} yet.`;
}

/** What an empty Issues list is: GitLab's is the issues assigned to the
 *  user, GitHub's a repository's issues. */
export function emptyIssuesWords(kind: ForgeKind, state: "open" | "closed", acrossRepos: boolean): string {
  const repo = forgeWords[kind].repo.toLowerCase();
  if (kind === "github") return `This ${repo} has no ${state} issues.`;
  const where = acrossRepos ? "" : ` in this ${repo}`;
  return state === "open" ? `No open issues are assigned to you${where}.` : `No closed issues were assigned to you${where}.`;
}

// ── the toolbar's "updated" line ─────────────────────────────────────────

/** Tells the toolbar how fresh the tab's main list is, whenever that changes. */
export function useReportFreshness(report: (f: Freshness) => void, read: Freshness): void {
  const { loadedAt, loading, stale } = read;
  useEffect(() => { report({ loadedAt, loading, stale }); }, [report, loadedAt, loading, stale]);
}
