// What the GitHub panel asks GitHub, and how the answers become the shapes in
// src/web/forge-types.ts (#2179).
//
// READ-ONLY. Every REST call here is a GET and every GraphQL document is a
// query; nothing in this file can change a repository, a pull request or a
// run. Posting reviews, re-running workflows and merging are follow-ups with
// their own issue, and they will not arrive by accident through this file.
//
// GRAPHQL FIRST, ONE QUERY PER SCREEN. A pull request row needs its reviews,
// its review requests, its threads, its labels and its head commit's checks;
// over REST that is five calls a row. GraphQL search answers a whole page of
// rows in one request that costs one rate-limit point. REST is used only where
// GraphQL has nothing: the token's scopes (a header on GET /user), a pull
// request's files with their old paths, Actions runs, and a job's log.
//
// GITHUB'S QUIRKS, MET LIVE AND KEPT HERE SO THE PANEL NEVER SEES THEM:
//   - Branches cannot be ordered by their last commit. `refs(orderBy:
//     TAG_COMMIT_DATE)` only orders tags; for branches it silently falls back
//     to reverse-alphabetical. So the branch list is read whole (names and
//     commit dates only, 100 a call), sorted here, and only the page shown is
//     asked for its ahead/behind, checks and open pull request.
//   - `Ref.compare(headRef)` takes the ref it is called on as the BASE. Asked
//     on a branch against the default branch, `aheadBy` is how far the DEFAULT
//     branch is ahead — the branch's "behind". Both directions are used below
//     and each says which way round it is.
//   - A failed job's steps can stay "in progress" until the whole run ends, on
//     both REST and GraphQL, so the step a job died in is the failed one or,
//     failing that, the one left running.
//   - Asking every check run of every suite for its steps and annotations in
//     one query made GitHub answer 502. Those are asked for separately, and
//     only for the runs that failed — the only ones the panel explains.
//   - A job's log is a 302 to a signed blob-storage URL; the transport follows
//     it without the token. Its lines start with an ISO timestamp and carry
//     the runner's `##[group]` markers, which are not what anyone reads.
//
// Newer GraphQL fields an older GitHub Enterprise Server lacks (sub-issues,
// issue types, state reasons) are asked for, and when the server says the
// field does not exist the same query is asked again without them — a panel
// without the hierarchy beats no panel. Every other failure is the
// transport's ForgeError and leaves as it came, so the panel picks its
// recovery from `kind`.
import { createHash } from "node:crypto";
import { cleanLogLine, createForgeTransport, epoch, ForgeError, graphqlError, mapLimit, nextLink } from "./forge-http.mjs";

// The REST API version these shapes were read against.
const API_VERSION = "2022-11-28";

const PAGE_SIZE = 20;
const REPO_PAGE_SIZE = 30;
// A repository search filters the viewer's list here (GraphQL has no filter on
// it): this many pages of 100 are read at most per call before answering.
const REPO_SCAN_PAGES = 10;
const COMMENT_PAGE_SIZE = 30;
const FILE_PAGE_SIZE = 30;
// GitLab's own line between "Active" and "Stale" branches.
const STALE_MS = 90 * 24 * 60 * 60 * 1000;
const COMMITS_AHEAD_CAP = 50;
// "All repositories" on the Actions tab: the runs of this many of the viewer's
// most recently pushed repositories, merged by time. One call each.
const RUN_REPOS = 10;
// Branches read to sort a repository's list. Past this many, only the first
// ones in GitHub's alphabetical order are sorted — a repository with more
// branches than this is not one anyone browses by page.
const BRANCH_SCAN_MAX = 2000;
// A later page of branches reuses the sorted list the first page read, so the
// pages agree with each other. The first page always reads it afresh.
const BRANCH_SCAN_TTL_MS = 5 * 60_000;
const BRANCH_SCAN_KEEP = 20;

const ACTOR = "login avatarUrl url ... on User { name }";
const USER = "login name avatarUrl url";
const COMMENT = `id url createdAt bodyHTML author { ${ACTOR} }`;

// What every pull request row shows, list or detail.
const PR_CORE = `
  number title titleHTML state isDraft url
  repository { nameWithOwner }
  author { ${ACTOR} }
  assignees(first: 10) { nodes { ${USER} } }
  reviewRequests(first: 20) { nodes { requestedReviewer {
    __typename
    ... on User { ${USER} }
    ... on Team { name combinedSlug avatarUrl url }
    ... on Bot { login avatarUrl url }
    ... on Mannequin { login avatarUrl url }
  } } }
  latestReviews(first: 30) { nodes { state viewerDidAuthor author { ${ACTOR} } } }
  headRefName baseRefName createdAt updatedAt mergedAt closedAt
  reviewDecision
  labels(first: 20) { nodes { name color } }`;

// A row also counts its comments and open threads, and reads the head
// commit's combined check state.
const PR_ROW = `${PR_CORE}
  comments { totalCount }
  reviewThreads(first: 100) { totalCount nodes { isResolved comments { totalCount } } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }`;

// The Overview: the same row with the threads and comments themselves, and
// what the tab counts are made of.
const PR_DETAIL = `${PR_CORE}
  bodyHTML
  milestone { title url }
  participants(first: 50) { nodes { ${USER} } }
  changedFiles
  comments(last: 100) { totalCount nodes { ${COMMENT} } }
  reviews(last: 100) { nodes { id state body bodyHTML submittedAt url author { ${ACTOR} } } }
  reviewThreads(first: 100) { totalCount nodes {
    id isResolved isOutdated path line originalLine
    comments(first: 50) { totalCount nodes { ${COMMENT} } }
  } }
  commits(last: 1) { totalCount nodes { commit {
    oid statusCheckRollup { state }
    status { contexts { state } }
    checkSuites(first: 50) { nodes { checkRuns { totalCount } } }
  } } }`;

const COMMIT = "oid abbreviatedOid messageHeadline authoredDate author { name } url";

// A branch row, without its ahead/behind: the list and the detail ask for that
// in opposite directions (see the header).
const BRANCH = `
  name
  branchProtectionRule { id }
  rules(first: 1) { totalCount }
  target { ... on Commit { oid abbreviatedOid messageHeadline committedDate author { name } url statusCheckRollup { state } } }
  associatedPullRequests(first: 1, states: [OPEN], orderBy: { field: UPDATED_AT, direction: DESC }) {
    nodes { number isDraft url reviewDecision latestReviews(first: 30) { nodes { state } } repository { nameWithOwner } }
  }`;

const CHECK_RUN = "id databaseId name status conclusion startedAt completedAt detailsUrl url title summary";
const CHECK_SUITE = `
  databaseId status conclusion createdAt url
  app { name slug }
  branch { name }
  commit { oid abbreviatedOid messageHeadline }
  workflowRun { databaseId event url createdAt workflow { name } }
  checkRuns(first: 50, filterBy: { checkType: LATEST }) { totalCount nodes { ${CHECK_RUN} } }`;
// Asked only for the runs that failed (see the header).
const CHECK_RUN_DETAIL = `
  id
  steps(first: 100) { nodes { name status conclusion } }
  annotations(first: 50) { nodes { path annotationLevel title message location { start { line } } } }`;

const ISSUE_REF = "number title state url repository { nameWithOwner }";
const ISSUE_BASE = `
  number title titleHTML state url
  repository { nameWithOwner }
  author { ${ACTOR} }
  assignees(first: 10) { nodes { ${USER} } }
  labels(first: 20) { nodes { name color } }
  milestone { title url }
  createdAt updatedAt closedAt
  comments { totalCount }`;
// The fields an older Enterprise server may not have; see `withNewerFields`.
const ISSUE_NEWER = `
  stateReason
  issueType { name }
  subIssuesSummary { total completed }
  parent { ${ISSUE_REF} issueType { name } }`;
const issueFields = (newer) => newer ? `${ISSUE_BASE} ${ISSUE_NEWER}` : ISSUE_BASE;
const MISSING_FIELD = /doesn't exist on type/i;

// ─── CI states ───────────────────────────────────────────────────────────────

// A check run's or an Actions run's verdict once it is done. Neutral is GitHub's
// grey "nothing to say", drawn like a skip and never a failure; stale is a run
// GitHub gave up waiting for; action_required needs a person, as a manual job
// does on GitLab.
const CHECK_CONCLUSION = {
  success: "success",
  failure: "failed",
  timed_out: "failed",
  startup_failure: "failed",
  cancelled: "canceled",
  stale: "canceled",
  skipped: "skipped",
  neutral: "skipped",
  action_required: "manual",
};
// …and while it is not done. `waiting` is a deployment waiting for a reviewer.
const CHECK_STATUS = {
  queued: "pending",
  requested: "pending",
  pending: "pending",
  waiting: "manual",
  in_progress: "running",
};
// The head commit's combined state (statusCheckRollup) and a legacy commit
// status. EXPECTED is a required check that has not reported yet.
const ROLLUP = {
  success: "success",
  failure: "failed",
  error: "failed",
  pending: "pending",
  expected: "pending",
};

/**
 * A check run's, check suite's or Actions run's status and conclusion as one
 * CiState. Takes GraphQL's UPPER and REST's lower case alike.
 * @param {string|null|undefined} status
 * @param {string|null|undefined} conclusion
 * @returns {import("../web/forge-types").CiState}
 */
export function githubCheckState(status, conclusion) {
  const s = String(status ?? "").toLowerCase();
  const c = String(conclusion ?? "").toLowerCase();
  if (s === "completed" || (!s && c)) return CHECK_CONCLUSION[c] ?? "none";
  return CHECK_STATUS[s] ?? "none";
}

/**
 * A commit's combined state (statusCheckRollup) or a commit status as a CiState.
 * @param {string|null|undefined} state
 */
export function githubRollupState(state) {
  return ROLLUP[String(state ?? "").toLowerCase()] ?? "none";
}

/**
 * One raw line of an Actions job log as a person reads it: without the ISO
 * timestamp the runner stamps every line with, without `##[group]`, and with
 * `##[error]` and its kin said the way GitHub's own log view says them. An
 * `##[endgroup]` line is only a marker and comes back as null, to be dropped.
 * @param {string} line
 * @returns {string|null}
 */
export function cleanGithubLogLine(line) {
  let s = String(line ?? "").replace(/^\uFEFF/, "").replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/, "");
  if (/^##\[endgroup\]/.test(s)) return null;
  s = s
    .replace(/^##\[group\]/, "")
    .replace(/^##\[(error|warning|notice)\]/, (_, level) => `${level[0].toUpperCase()}${level.slice(1)}: `)
    .replace(/^##\[(?:debug|section|command)\]/, "")
    .replace(/^\[command\]/, "");
  return cleanLogLine(s);
}

// ─── Small mappings ──────────────────────────────────────────────────────────

function user(a) {
  if (!a?.login) return null;
  return { login: a.login, name: a.name || null, avatarUrl: a.avatarUrl ?? null, webUrl: a.url ?? null };
}

function restUser(u) {
  if (!u?.login) return null;
  return { login: u.login, name: u.name || null, avatarUrl: u.avatar_url ?? null, webUrl: u.html_url ?? null };
}

function label(l) {
  return { name: l.name, color: l.color ? `#${l.color}` : null };
}

function nodes(conn) {
  return (conn?.nodes ?? []).filter(Boolean);
}

function seconds(fromMs, toMs) {
  return fromMs != null && toMs != null && toMs >= fromMs ? Math.round((toMs - fromMs) / 1000) : null;
}

function firstLine(text) {
  const line = String(text ?? "").split("\n").map(l => l.trim()).find(Boolean);
  return line ? line.slice(0, 200) : null;
}

function pageNumber(cursor) {
  const n = Number.parseInt(String(cursor ?? ""), 10);
  return Number.isFinite(n) && n > 1 ? n : 1;
}

/** `owner/name`, checked, with its REST prefix. */
function splitRepo(repo) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(String(repo ?? "").trim());
  if (!m) throw new ForgeError("not-found", `not a repository path: ${String(repo ?? "").slice(0, 100)}`);
  return {
    owner: m[1],
    name: m[2],
    path: `${m[1]}/${m[2]}`,
    rest: `/repos/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`,
  };
}

/** The value GraphQL answered, or the error it gave for its absence: a
 *  repository or item that is gone answers `null` with a NOT_FOUND beside it. */
function need(value, errors, what) {
  if (value) return value;
  if (errors?.length) throw graphqlError(errors);
  throw new ForgeError("not-found", `${what} not found`);
}

const CHANGE_STATE = { OPEN: "open", MERGED: "merged", CLOSED: "closed" };
const REVIEW_STATE = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  // A dismissed review no longer counts, but its author did take part.
  DISMISSED: "commented",
};
const STATE_REASON = { COMPLETED: "completed", NOT_PLANNED: "not_planned", DUPLICATE: "duplicate" };
const ANNOTATION_LEVEL = { FAILURE: "failure", WARNING: "warning", NOTICE: "notice" };

/** Whether a pull request reads as approved. With a review rule on the base
 *  branch GitHub decides (reviewDecision); without one it decides nothing, and
 *  the reviews are read the way its own list reads them: someone approved and
 *  nobody's latest word is "changes requested". */
function isApproved(decision, latestReviews) {
  if (decision === "APPROVED") return true;
  if (decision) return false;
  const states = latestReviews.map(r => r.state);
  return states.includes("APPROVED") && !states.includes("CHANGES_REQUESTED");
}

/** Everyone asked to review and everyone who did, one entry each. A review
 *  request outranks an earlier verdict: re-requested is waiting again. The
 *  author's own reviews are not in latestReviews, and an unsubmitted (PENDING)
 *  review is nobody's verdict yet. */
function reviewersOf(pr) {
  const byLogin = new Map();
  for (const r of nodes(pr.latestReviews)) {
    const u = user(r.author);
    if (!u || r.state === "PENDING") continue;
    byLogin.set(u.login, { ...u, state: REVIEW_STATE[r.state] ?? "commented" });
  }
  for (const req of nodes(pr.reviewRequests)) {
    const who = req.requestedReviewer;
    if (!who) continue;
    const u = who.__typename === "Team"
      ? { login: who.combinedSlug, name: who.name ?? null, avatarUrl: who.avatarUrl ?? null, webUrl: who.url ?? null }
      : user(who);
    if (u?.login) byLogin.set(u.login, { ...u, state: "pending" });
  }
  return [...byLogin.values()];
}

function changeRow(pr) {
  const repo = pr.repository.nameWithOwner;
  const latest = nodes(pr.latestReviews);
  const threads = nodes(pr.reviewThreads);
  const head = nodes(pr.commits)[0]?.commit;
  const rollup = head?.statusCheckRollup?.state;
  return {
    kind: "github",
    key: `${repo}#${pr.number}`,
    number: pr.number,
    repo,
    title: pr.title,
    titleHtml: pr.titleHTML ?? null,
    state: CHANGE_STATE[pr.state] ?? "open",
    draft: !!pr.isDraft,
    webUrl: pr.url,
    author: user(pr.author),
    assignees: nodes(pr.assignees).map(user).filter(Boolean),
    reviewers: reviewersOf(pr),
    sourceBranch: pr.headRefName,
    targetBranch: pr.baseRefName,
    createdAt: epoch(pr.createdAt),
    updatedAt: epoch(pr.updatedAt),
    mergedAt: epoch(pr.mergedAt),
    closedAt: epoch(pr.closedAt),
    // The conversation's comments and the comments in review threads; review
    // summaries and timeline events are not comments.
    comments: (pr.comments?.totalCount ?? 0) + threads.reduce((n, t) => n + (t.comments?.totalCount ?? 0), 0),
    unresolvedThreads: threads.filter(t => !t.isResolved).length,
    approved: isApproved(pr.reviewDecision, latest),
    approvedByMe: latest.some(r => r.viewerDidAuthor && r.state === "APPROVED"),
    // GitHub has required approvals per branch rule, not per pull request, and
    // does not say how many are left.
    approvalsRequired: null,
    approvalsLeft: null,
    ci: rollup ? { state: githubRollupState(rollup), webUrl: `${pr.url}/checks` } : null,
    labels: nodes(pr.labels).map(label),
  };
}

function comment(c) {
  return {
    id: String(c.id),
    author: user(c.author),
    bodyHtml: c.bodyHTML ?? "",
    createdAt: epoch(c.createdAt),
    webUrl: c.url ?? null,
  };
}

function commitOf(c) {
  return {
    sha: c.oid,
    shortSha: c.abbreviatedOid ?? c.oid.slice(0, 7),
    title: c.messageHeadline ?? "",
    authorName: c.author?.name ?? null,
    authoredAt: epoch(c.authoredDate),
    webUrl: c.url ?? null,
  };
}

function issueRef(i) {
  const repo = i.repository.nameWithOwner;
  return {
    key: `${repo}#${i.number}`,
    number: i.number,
    repo,
    title: i.title,
    state: i.state === "CLOSED" ? "closed" : "open",
    webUrl: i.url,
    type: i.issueType?.name ?? null,
  };
}

function issueRow(i) {
  const repo = i.repository.nameWithOwner;
  const summary = i.subIssuesSummary;
  return {
    kind: "github",
    key: `${repo}#${i.number}`,
    number: i.number,
    repo,
    title: i.title,
    titleHtml: i.titleHTML ?? null,
    state: i.state === "CLOSED" ? "closed" : "open",
    // REOPENED is not a reason an issue is in the state it is in.
    stateReason: STATE_REASON[i.stateReason] ?? null,
    webUrl: i.url,
    author: user(i.author),
    assignees: nodes(i.assignees).map(user).filter(Boolean),
    labels: nodes(i.labels).map(label),
    milestone: i.milestone ? { title: i.milestone.title, webUrl: i.milestone.url ?? null } : null,
    createdAt: epoch(i.createdAt),
    updatedAt: epoch(i.updatedAt),
    closedAt: epoch(i.closedAt),
    comments: i.comments?.totalCount ?? 0,
    children: summary?.total > 0 ? { total: summary.total, completed: summary.completed ?? 0 } : null,
    parent: i.parent ? issueRef(i.parent) : null,
  };
}

function repoRow(r) {
  return {
    id: String(r.databaseId ?? r.id),
    path: r.nameWithOwner,
    name: r.name,
    webUrl: r.url,
    defaultBranch: r.defaultBranchRef?.name ?? null,
    lastActivityAt: epoch(r.pushedAt),
    archived: !!r.isArchived,
  };
}

function annotation(a) {
  // The runner's own annotations ("Process completed with exit code 1.") are
  // filed under the path `.github` with a LOG line number, not a file's.
  const runnerOwn = !a.path || a.path === ".github";
  return {
    path: runnerOwn ? null : a.path,
    line: runnerOwn ? null : a.location?.start?.line ?? null,
    level: ANNOTATION_LEVEL[a.annotationLevel] ?? "notice",
    title: a.title || null,
    message: a.message ?? "",
  };
}

/** Why a failed check run failed, in a line: the step it died in, or what
 *  the check said about itself. A failed job's steps can still read "in
 *  progress" while the rest of the run goes on; the one left running is the
 *  one it died in. */
function failureReason(run, detail) {
  const steps = nodes(detail?.steps);
  const step = steps.find(s => githubCheckState("completed", s.conclusion) === "failed")
    ?? steps.find(s => String(s.status ?? "").toLowerCase() === "in_progress");
  if (step?.name) return `Step “${step.name}” failed`;
  return firstLine(run.title) ?? firstLine(run.summary);
}

function checkRunJob(run, detail, actions) {
  const state = githubCheckState(run.status, run.conclusion);
  const failed = state === "failed";
  const startedAt = epoch(run.startedAt);
  const finishedAt = epoch(run.completedAt);
  return {
    id: String(run.databaseId),
    name: run.name,
    stage: null,
    state,
    allowFailure: false,
    startedAt,
    finishedAt,
    durationSec: seconds(startedAt, finishedAt),
    webUrl: run.detailsUrl ?? run.url ?? null,
    failureReason: failed ? failureReason(run, detail) : null,
    annotations: failed ? nodes(detail?.annotations).map(annotation) : [],
    // An Actions check run's id is its job's id, which has a log; another
    // app's check run has only the page it links to.
    logAvailable: actions,
  };
}

// ─── The client ─────────────────────────────────────────────────────────────

/**
 * A read-only GitHub client for one connection.
 *
 * @param {object} opts
 * @param {string} [opts.baseUrl]  https://github.com, or a GitHub Enterprise Server's address
 * @param {string} opts.token
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]
 */
export function createGithubClient({ baseUrl = "https://github.com", token, fetchImpl, now = () => Date.now() } = {}) {
  const typed = String(baseUrl || "https://github.com").trim().replace(/\/+$/, "");
  const host = new URL(typed).host.toLowerCase();
  const dotcom = host === "github.com" || host === "www.github.com";
  const web = dotcom ? "https://github.com" : typed;
  const webHost = new URL(web).host.toLowerCase();
  const api = dotcom ? "https://api.github.com" : `${web}/api/v3`;
  const graphqlUrl = dotcom ? "https://api.github.com/graphql" : `${web}/api/graphql`;
  // The token goes to the API and nowhere else — not even to github.com's web
  // pages, which this client never asks for.
  const allowedOrigins = [new URL(api).origin];
  const transport = createForgeTransport({
    token,
    authHeaders: (tok) => ({ authorization: `Bearer ${tok}`, "x-github-api-version": API_VERSION }),
    allowedOrigins,
    fetchImpl,
    now,
  });

  /** GET a REST path with query parameters; empty ones are left out. */
  function rest(path, params = {}) {
    const url = new URL(`${api}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== "") url.searchParams.set(k, String(v));
    }
    return transport.json(url.toString());
  }

  function gql(query, variables = {}) {
    return transport.graphql(graphqlUrl, query, variables);
  }

  // Avatars and the images in descriptions come from GitHub's image hosts —
  // a pasted screenshot from github.com/user-attachments by way of a signed
  // private-user-images address — never from the API, so none of them is
  // sent the token. An Enterprise Server serves them from its own host or a
  // subdomain of it; its own host is also its API's, and the token goes there
  // as it does for every read.
  const IMAGE_HOSTS = new Set(["avatars.githubusercontent.com", "private-user-images.githubusercontent.com", "user-images.githubusercontent.com", "camo.githubusercontent.com"]);
  function imageHost(u) {
    if (u.protocol !== "https:" && u.protocol !== new URL(web).protocol) return false;
    const h = u.host.toLowerCase();
    return h === webHost || (dotcom ? IMAGE_HOSTS.has(h) : h.endsWith(`.${webHost}`));
  }

  /** An image at one of GitHub's image hosts, for the deck to pass on. */
  function fetchAsset(url) {
    return transport.asset(url, { allow: imageHost });
  }

  /** Run a query with the newer issue fields, and again without them when the
   *  server says one does not exist (an older Enterprise Server). */
  async function withNewerFields(run) {
    try {
      return await run(true);
    } catch (err) {
      if (err instanceof ForgeError && MISSING_FIELD.test(err.message)) return run(false);
      throw err;
    }
  }

  // ── Connection ──

  /** @returns {Promise<import("../web/forge-types").ForgeValidation>} */
  async function validate() {
    const { data, headers } = await rest("/user");
    // Classic tokens list their scopes; fine-grained tokens and app tokens
    // send no header at all, and then nothing is said about scopes.
    const header = headers?.get?.("x-oauth-scopes");
    const scopes = header == null ? undefined : header.split(",").map(s => s.trim()).filter(Boolean);
    const warnings = [];
    if (scopes) {
      if (!scopes.includes("repo")) {
        warnings.push("The token has no repo scope, so private repositories are hidden.");
      }
      if (!scopes.some(s => s === "read:org" || s === "write:org" || s === "admin:org")) {
        warnings.push("The token has no read:org scope, so organization repositories and team review requests may be missing.");
      }
    }
    const serverVersion = headers?.get?.("x-github-enterprise-version") ?? undefined;
    return {
      account: {
        id: String(data.id),
        login: data.login,
        name: data.name || null,
        avatarUrl: data.avatar_url ?? null,
        webUrl: data.html_url ?? null,
      },
      meta: {
        ...(scopes ? { scopes } : {}),
        ...(serverVersion ? { serverVersion } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    };
  }

  // ── Repositories ──

  const VIEWER_REPOS = `query($first: Int!, $after: String) { viewer { repositories(
    first: $first, after: $after,
    orderBy: { field: PUSHED_AT, direction: DESC },
    ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
    affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
  ) { totalCount pageInfo { hasNextPage endCursor } nodes { databaseId nameWithOwner name url defaultBranchRef { name } pushedAt isArchived } } } }`;

  /**
   * The viewer's repositories — owned, collaborated on, or in their
   * organizations — most recently pushed first. `search` keeps the ones whose
   * path contains it; GitHub cannot filter this list, so pages of 100 are read
   * until a page's worth matched, and the cursor continues after the last page
   * read.
   */
  async function listRepos({ search, cursor } = {}) {
    const needle = String(search ?? "").trim().toLowerCase();
    if (!needle) {
      const { data } = await gql(VIEWER_REPOS, { first: REPO_PAGE_SIZE, after: cursor || null });
      const conn = data.viewer.repositories;
      return {
        items: nodes(conn).map(repoRow),
        next: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null,
        total: conn.totalCount ?? null,
      };
    }
    const items = [];
    let after = cursor || null;
    let more = true;
    for (let i = 0; i < REPO_SCAN_PAGES && more && items.length < REPO_PAGE_SIZE; i++) {
      const { data } = await gql(VIEWER_REPOS, { first: 100, after });
      const conn = data.viewer.repositories;
      for (const r of nodes(conn)) if (r.nameWithOwner.toLowerCase().includes(needle)) items.push(repoRow(r));
      more = !!conn.pageInfo.hasNextPage;
      after = conn.pageInfo.endCursor;
    }
    return { items, next: more ? after : null, total: null };
  }

  // ── Branches ──

  // repo → { at, defaultBranch, totalCount, list: [{ name, at }] }
  const branchScans = new Map();

  /** Every branch's name and last commit time, newest first. */
  async function scanBranches(r) {
    const list = [];
    let after = null;
    let defaultBranch = null;
    let totalCount = null;
    for (;;) {
      const { data, errors } = await gql(`query($owner: String!, $name: String!, $after: String) {
        repository(owner: $owner, name: $name) {
          defaultBranchRef { name }
          refs(refPrefix: "refs/heads/", first: 100, after: $after) {
            totalCount pageInfo { hasNextPage endCursor }
            nodes { name target { ... on Commit { committedDate } } }
          }
        } }`, { owner: r.owner, name: r.name, after });
      const repo = need(data.repository, errors, `repository ${r.path}`);
      defaultBranch = repo.defaultBranchRef?.name ?? null;
      totalCount = repo.refs.totalCount ?? null;
      for (const n of nodes(repo.refs)) list.push({ name: n.name, at: epoch(n.target?.committedDate) ?? 0 });
      if (!repo.refs.pageInfo.hasNextPage || list.length >= BRANCH_SCAN_MAX) break;
      after = repo.refs.pageInfo.endCursor;
    }
    list.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
    const scan = { at: now(), defaultBranch, totalCount, list };
    branchScans.delete(r.path);
    branchScans.set(r.path, scan);
    while (branchScans.size > BRANCH_SCAN_KEEP) branchScans.delete(branchScans.keys().next().value);
    return scan;
  }

  function branchRow(r, ref, defaultBranch, aheadBehind) {
    const c = ref.target ?? {};
    const isDefault = ref.name === defaultBranch;
    const committedAt = epoch(c.committedDate);
    const pr = nodes(ref.associatedPullRequests)[0];
    const prRepo = pr?.repository?.nameWithOwner ?? r.path;
    return {
      name: ref.name,
      webUrl: `${web}/${r.path}/tree/${ref.name.split("/").map(encodeURIComponent).join("/")}`,
      isDefault,
      // A classic branch protection rule or an active ruleset; a disabled
      // ruleset applies no rules and does not count.
      protected: !!ref.branchProtectionRule || (ref.rules?.totalCount ?? 0) > 0,
      commit: {
        sha: c.oid ?? "",
        shortSha: c.abbreviatedOid ?? String(c.oid ?? "").slice(0, 7),
        title: c.messageHeadline ?? "",
        committedAt,
        authorName: c.author?.name ?? null,
        webUrl: c.url ?? null,
      },
      ahead: isDefault ? null : aheadBehind?.ahead ?? null,
      behind: isDefault ? null : aheadBehind?.behind ?? null,
      ci: c.statusCheckRollup ? { state: githubRollupState(c.statusCheckRollup.state), webUrl: c.url ? `${c.url}/checks` : null } : null,
      change: pr ? {
        number: pr.number,
        key: `${prRepo}#${pr.number}`,
        state: "open",
        draft: !!pr.isDraft,
        approved: isApproved(pr.reviewDecision, nodes(pr.latestReviews)),
        webUrl: pr.url,
      } : null,
      stale: committedAt != null && now() - committedAt > STALE_MS,
    };
  }

  /**
   * A page of the repository's branches, most recent commit first, each with
   * its ahead/behind against the default branch, its head's checks, the open
   * pull request it is the source of, and whether it is protected or stale.
   */
  async function listBranches(repo, { cursor } = {}) {
    const r = splitRepo(repo);
    const offset = Math.max(0, Number.parseInt(String(cursor ?? "0"), 10) || 0);
    const cached = branchScans.get(r.path);
    const scan = offset > 0 && cached && now() - cached.at < BRANCH_SCAN_TTL_MS ? cached : await scanBranches(r);
    const page = scan.list.slice(offset, offset + PAGE_SIZE);
    const next = offset + PAGE_SIZE < scan.list.length ? String(offset + PAGE_SIZE) : null;
    if (!page.length) return { items: [], next: null, total: scan.totalCount };

    const vars = { owner: r.owner, name: r.name, base: scan.defaultBranch ?? "HEAD" };
    const aliases = page.map((b, i) => {
      vars[`q${i}`] = `refs/heads/${b.name}`;
      return `b${i}: ref(qualifiedName: $q${i}) { ...Branch compare(headRef: $base) { aheadBy behindBy } }`;
    });
    const { data, errors } = await gql(`query($owner: String!, $name: String!, $base: String!, ${page.map((_, i) => `$q${i}: String!`).join(", ")}) {
      repository(owner: $owner, name: $name) { ${aliases.join("\n")} } }
      fragment Branch on Ref { ${BRANCH} }`, vars);
    const found = need(data.repository, errors, `repository ${r.path}`);
    const items = [];
    page.forEach((_, i) => {
      const ref = found[`b${i}`];
      // Deleted between the scan and now.
      if (!ref) return;
      // Asked on the BRANCH against the default branch, so the branch is the
      // base: GitHub's aheadBy is the default branch's lead, i.e. how far the
      // branch is behind, and behindBy is how far the branch is ahead.
      const cmp = ref.compare;
      items.push(branchRow(r, ref, scan.defaultBranch, cmp ? { ahead: cmp.behindBy, behind: cmp.aheadBy } : null));
    });
    return { items, next, total: scan.totalCount };
  }

  /**
   * One branch: its row, its head's latest workflow run with jobs, and the
   * commits it has that the default branch does not (the newest 50, newest
   * first).
   */
  async function getBranch(repo, name) {
    const r = splitRepo(repo);
    const { data, errors } = await gql(`query($owner: String!, $name: String!, $qualified: String!, $branch: String!) {
      repository(owner: $owner, name: $name) {
        defaultBranchRef { name compare(headRef: $branch) {
          aheadBy behindBy
          commits(last: ${COMMITS_AHEAD_CAP}) { nodes { ${COMMIT} } }
        } }
        ref(qualifiedName: $qualified) { ${BRANCH} }
      } }`, { owner: r.owner, name: r.name, qualified: `refs/heads/${name}`, branch: name });
    const found = need(data.repository, errors, `repository ${r.path}`);
    const ref = found.ref;
    if (!ref) throw new ForgeError("not-found", `no branch ${name} in ${r.path}`);
    const defaultBranch = found.defaultBranchRef?.name ?? null;
    // Asked on the DEFAULT branch with this branch as head: aheadBy is this
    // branch's lead, as it reads.
    const cmp = found.defaultBranchRef?.compare;
    const branch = branchRow(r, ref, defaultBranch, cmp ? { ahead: cmp.aheadBy, behind: cmp.behindBy } : null);
    const commitsAhead = branch.isDefault ? [] : nodes(cmp?.commits).map(commitOf).reverse();

    let pipeline = null;
    if (branch.commit.sha) {
      const { data: runs } = await rest(`${r.rest}/actions/runs`, { head_sha: branch.commit.sha, per_page: 1, exclude_pull_requests: true });
      const run = runs?.workflow_runs?.[0];
      if (run) pipeline = await runDetail(r, run);
    }
    return { branch, pipeline, commitsAhead };
  }

  // ── Pull requests ──

  function changeSearch({ repo, filter = "all", state = "open", sort }) {
    const q = ["is:pr", "archived:false"];
    if (repo) q.push(`repo:${splitRepo(repo).path}`);
    if (filter === "mine") q.push("author:@me");
    else if (filter === "review") q.push("user-review-requested:@me");
    // "All" across every repository is everything the viewer is part of.
    else if (!repo) q.push("involves:@me");
    if (state === "merged") q.push("is:merged");
    else if (state === "closed") q.push("is:closed", "is:unmerged");
    else q.push("is:open");
    if (sort) q.push(sort === "updated" ? "sort:updated-desc" : "sort:created-desc");
    return q.join(" ");
  }

  /** A page of pull requests: all of a repository's (or everything the viewer
   *  is part of), the viewer's own, or the ones waiting on the viewer's review. */
  async function listChanges({ repo = null, filter = "all", state = "open", sort = "created", cursor } = {}) {
    const { data } = await gql(`query($q: String!, $first: Int!, $after: String) {
      search(query: $q, type: ISSUE, first: $first, after: $after) {
        issueCount pageInfo { hasNextPage endCursor }
        nodes { ... on PullRequest { ${PR_ROW} } }
      } }`, { q: changeSearch({ repo, filter, state, sort }), first: PAGE_SIZE, after: cursor || null });
    const s = data.search;
    return {
      // A result the token may not read (an SSO-protected organization) comes
      // back empty, with its error beside it.
      items: nodes(s).filter(n => n.number != null && n.repository).map(changeRow),
      next: s.pageInfo.hasNextPage ? s.pageInfo.endCursor : null,
      total: s.issueCount ?? null,
    };
  }

  /** The Open / Merged / Closed tab counts, in one query. */
  async function countChanges({ repo = null, filter = "all" } = {}) {
    const q = (state) => changeSearch({ repo, filter, state });
    const { data } = await gql(`query($open: String!, $merged: String!, $closed: String!) {
      open: search(query: $open, type: ISSUE, first: 0) { issueCount }
      merged: search(query: $merged, type: ISSUE, first: 0) { issueCount }
      closed: search(query: $closed, type: ISSUE, first: 0) { issueCount }
    }`, { open: q("open"), merged: q("merged"), closed: q("closed") });
    return {
      open: data.open?.issueCount ?? null,
      merged: data.merged?.issueCount ?? null,
      closed: data.closed?.issueCount ?? null,
    };
  }

  /** The pull request's Overview: its row, description, threads, the
   *  conversation, and the tab counts. */
  async function getChange(repo, number) {
    const r = splitRepo(repo);
    const { data, errors } = await gql(`query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_DETAIL} } } }`,
    { owner: r.owner, name: r.name, number: Number(number) });
    const pr = need(need(data.repository, errors, `repository ${r.path}`).pullRequest, errors, `pull request ${r.path}#${number}`);
    const row = changeRow(pr);
    const latest = nodes(pr.latestReviews);
    // A review's summary is part of the conversation; an empty one (a review
    // that only left line comments) is not, and a PENDING one is unsent.
    const summaries = nodes(pr.reviews).filter(v => v.state !== "PENDING" && String(v.body ?? "").trim());
    const generalComments = [
      ...nodes(pr.comments).map(comment),
      ...summaries.map(v => comment({ ...v, createdAt: v.submittedAt })),
    ].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const threads = nodes(pr.reviewThreads).map(t => {
      const cs = nodes(t.comments).map(comment);
      return {
        id: t.id,
        resolvable: true,
        resolved: !!t.isResolved,
        path: t.path ?? null,
        // An outdated thread has no line in the current diff; it keeps the
        // one it was written on.
        line: t.line ?? t.originalLine ?? null,
        outdated: !!t.isOutdated,
        comments: cs,
        webUrl: cs[0]?.webUrl ?? null,
      };
    });
    const commits = pr.commits;
    const head = nodes(commits)[0]?.commit;
    const suites = nodes(head?.checkSuites).filter(s => (s.checkRuns?.totalCount ?? 0) > 0).length;
    const statuses = (head?.status?.contexts ?? []).length > 0 ? 1 : 0;
    return {
      ...row,
      descriptionHtml: pr.bodyHTML ?? "",
      milestone: pr.milestone ? { title: pr.milestone.title, webUrl: pr.milestone.url ?? null } : null,
      participants: nodes(pr.participants).map(user).filter(Boolean),
      approvedBy: latest.filter(v => v.state === "APPROVED").map(v => user(v.author)).filter(Boolean),
      counts: {
        discussions: (pr.comments?.totalCount ?? 0) + summaries.length + (pr.reviewThreads?.totalCount ?? 0),
        commits: commits?.totalCount ?? 0,
        pipelines: suites + statuses,
        files: pr.changedFiles ?? 0,
      },
      threads,
      generalComments,
    };
  }

  /** The pull request's commits, newest first (GitLab's order; GitHub's own
   *  tab is oldest first), read backwards from the head. */
  async function listChangeCommits(repo, number, { cursor } = {}) {
    const r = splitRepo(repo);
    const { data, errors } = await gql(`query($owner: String!, $name: String!, $number: Int!, $before: String) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) {
        commits(last: ${PAGE_SIZE}, before: $before) {
          totalCount pageInfo { hasPreviousPage startCursor }
          nodes { commit { ${COMMIT} } }
        } } } }`, { owner: r.owner, name: r.name, number: Number(number), before: cursor || null });
    const pr = need(need(data.repository, errors, `repository ${r.path}`).pullRequest, errors, `pull request ${r.path}#${number}`);
    const conn = pr.commits;
    return {
      items: nodes(conn).map(n => commitOf(n.commit)).reverse(),
      next: conn.pageInfo.hasPreviousPage ? conn.pageInfo.startCursor : null,
      total: conn.totalCount ?? null,
    };
  }

  /** Steps and annotations for the check runs that failed, by node id. */
  async function failedRunDetails(runs) {
    const ids = runs.filter(run => githubCheckState(run.status, run.conclusion) === "failed" && run.id).map(run => run.id);
    if (!ids.length) return new Map();
    const { data } = await gql(`query($ids: [ID!]!) { nodes(ids: $ids) { ... on CheckRun { ${CHECK_RUN_DETAIL} } } }`, { ids: ids.slice(0, 100) });
    return new Map((data.nodes ?? []).filter(n => n?.id).map(n => [n.id, n]));
  }

  /** A check suite as a pipeline: an Actions workflow run, or another app's
   *  suite (`suite:<id>`, which getPipeline also reads). */
  function suitePipeline(r, suite, details, fallbackRef) {
    const wf = suite.workflowRun;
    const actions = !!wf;
    const jobs = nodes(suite.checkRuns).map(run => checkRunJob(run, details.get(run.id), actions));
    const starts = jobs.map(j => j.startedAt).filter(t => t != null);
    const ends = jobs.map(j => j.finishedAt).filter(t => t != null);
    const state = githubCheckState(suite.status, suite.conclusion);
    const done = String(suite.status ?? "").toLowerCase() === "completed";
    const startedAt = starts.length ? Math.min(...starts) : null;
    const finishedAt = done && ends.length ? Math.max(...ends) : null;
    const sha = suite.commit?.oid ?? "";
    return {
      id: actions ? String(wf.databaseId) : `suite:${suite.databaseId}`,
      repo: r.path,
      ref: suite.branch?.name ?? fallbackRef ?? "",
      sha,
      shortSha: suite.commit?.abbreviatedOid ?? sha.slice(0, 7),
      title: actions
        ? [wf.workflow?.name, suite.commit?.messageHeadline].filter(Boolean).join(" · ") || null
        : suite.app?.name ?? null,
      state,
      source: wf?.event ?? null,
      triggeredBy: null,
      createdAt: epoch(wf?.createdAt ?? suite.createdAt),
      startedAt,
      finishedAt,
      durationSec: seconds(startedAt, finishedAt),
      webUrl: wf?.url ?? suite.url ?? `${web}/${r.path}/commit/${sha}/checks`,
      jobs,
    };
  }

  /** A commit's legacy statuses (from CI services that post statuses rather
   *  than checks) as one pseudo-pipeline, `status:<sha>`. */
  function statusPipeline(r, commit, ref) {
    const contexts = commit?.status?.contexts ?? [];
    if (!contexts.length) return null;
    const jobs = contexts.map(c => {
      const state = githubRollupState(c.state);
      const at = epoch(c.createdAt);
      return {
        id: String(c.id ?? c.context),
        name: c.context,
        stage: null,
        state,
        allowFailure: false,
        startedAt: at,
        finishedAt: state === "pending" ? null : at,
        durationSec: null,
        webUrl: c.targetUrl || null,
        failureReason: state === "failed" ? c.description || null : null,
        annotations: [],
        logAvailable: false,
      };
    });
    const times = jobs.map(j => j.startedAt).filter(t => t != null);
    const createdAt = times.length ? Math.min(...times) : null;
    return {
      id: `status:${commit.oid}`,
      repo: r.path,
      ref: ref ?? "",
      sha: commit.oid,
      shortSha: commit.abbreviatedOid ?? commit.oid.slice(0, 7),
      title: "Commit statuses",
      state: githubRollupState(commit.status.state),
      source: null,
      triggeredBy: null,
      createdAt,
      startedAt: createdAt,
      finishedAt: null,
      durationSec: null,
      webUrl: `${web}/${r.path}/commit/${commit.oid}`,
      jobs,
    };
  }

  const STATUS = "status { state contexts { id context state description targetUrl createdAt } }";

  /** The head commit's checks: each check suite with runs is a pipeline (an
   *  Actions workflow run, or another app's suite), and its legacy commit
   *  statuses are one more, "Commit statuses". */
  async function listChangePipelines(repo, number) {
    const r = splitRepo(repo);
    const { data, errors } = await gql(`query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) {
        headRefName
        commits(last: 1) { nodes { commit {
          oid abbreviatedOid
          ${STATUS}
          checkSuites(first: 30) { nodes { ${CHECK_SUITE} } }
        } } }
      } } }`, { owner: r.owner, name: r.name, number: Number(number) });
    const pr = need(need(data.repository, errors, `repository ${r.path}`).pullRequest, errors, `pull request ${r.path}#${number}`);
    const head = nodes(pr.commits)[0]?.commit;
    if (!head) return [];
    // A suite with no runs is an app that was told about the push and did
    // nothing; GitHub's own checks tab does not show it either.
    const suites = nodes(head.checkSuites).filter(s => (s.checkRuns?.totalCount ?? 0) > 0);
    const details = await failedRunDetails(suites.flatMap(s => nodes(s.checkRuns)));
    const pipelines = suites.map(s => suitePipeline(r, s, details, pr.headRefName));
    const statuses = statusPipeline(r, head, pr.headRefName);
    if (statuses) pipelines.push(statuses);
    return pipelines;
  }

  const FILE_STATUS = {
    added: "added",
    removed: "deleted",
    modified: "modified",
    renamed: "renamed",
    copied: "added",
    changed: "modified",
    unchanged: "modified",
  };

  /** The pull request's files. REST, because GraphQL does not say what a
   *  renamed file was called before. Each links to its place on the files
   *  tab, which GitHub anchors by the SHA-256 of the path. */
  async function listChangeFiles(repo, number, { cursor } = {}) {
    const r = splitRepo(repo);
    const page = pageNumber(cursor);
    const { data, headers } = await rest(`${r.rest}/pulls/${Number(number)}/files`, { per_page: FILE_PAGE_SIZE, page });
    const filesTab = `${web}/${r.path}/pull/${Number(number)}/files`;
    return {
      items: (Array.isArray(data) ? data : []).map(f => ({
        path: f.filename,
        oldPath: f.previous_filename ?? null,
        status: FILE_STATUS[f.status] ?? "modified",
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        webUrl: `${filesTab}#diff-${createHash("sha256").update(f.filename).digest("hex")}`,
      })),
      next: nextLink(headers) ? String(page + 1) : null,
      total: null,
    };
  }

  // ── Actions ──

  /** An Actions workflow run (REST) as a pipeline row. */
  function runRow(run, repoPath) {
    const createdAt = epoch(run.created_at);
    const startedAt = epoch(run.run_started_at) ?? createdAt;
    const finishedAt = String(run.status ?? "").toLowerCase() === "completed" ? epoch(run.updated_at) : null;
    const sha = run.head_sha ?? "";
    return {
      id: String(run.id),
      repo: run.repository?.full_name ?? repoPath,
      ref: run.head_branch ?? "",
      sha,
      shortSha: sha.slice(0, 7),
      title: [run.name, run.display_title].filter(Boolean).join(" · ") || null,
      state: githubCheckState(run.status, run.conclusion),
      source: run.event ?? null,
      triggeredBy: restUser(run.triggering_actor ?? run.actor),
      createdAt,
      startedAt,
      finishedAt,
      durationSec: seconds(startedAt, finishedAt),
      webUrl: run.html_url,
    };
  }

  /** A workflow run with its jobs: the run from REST, its jobs from its check
   *  suite (one GraphQL query, the same mapping the pull request's checks use). */
  async function runDetail(r, run) {
    const row = runRow(run, r.path);
    let jobs = [];
    if (run.check_suite_node_id) {
      const { data } = await gql(`query($id: ID!) { node(id: $id) { ... on CheckSuite { ${CHECK_SUITE} } } }`, { id: run.check_suite_node_id });
      if (data.node) {
        const runs = nodes(data.node.checkRuns);
        jobs = suitePipeline(r, data.node, await failedRunDetails(runs), row.ref).jobs;
      }
    }
    return { ...row, jobs };
  }

  /** Errors that mean "this one repository's runs are not readable" — Actions
   *  off, an SSO-protected organization — skip that repository in a merged
   *  list; everything else (auth, rate limit, network) is the list's failure. */
  const SKIPPABLE = new Set(["not-found", "permission"]);

  /**
   * Actions workflow runs, newest first: one repository's, or the latest of
   * the viewer's ten most recently pushed repositories merged by time. The
   * merged list's cursor is the creation time of its last run and the ids of
   * the runs at exactly that time, so the next page neither repeats nor skips
   * the runs that started in the same second.
   */
  async function listPipelines({ repo = null, cursor } = {}) {
    if (repo) {
      const r = splitRepo(repo);
      const page = pageNumber(cursor);
      const { data, headers } = await rest(`${r.rest}/actions/runs`, { per_page: PAGE_SIZE, page, exclude_pull_requests: true });
      return {
        items: (data.workflow_runs ?? []).map(run => runRow(run, r.path)),
        next: nextLink(headers) ? String(page + 1) : null,
        total: data.total_count ?? null,
      };
    }
    const [before, seenIds] = String(cursor ?? "").split("~");
    const seen = new Set((seenIds ?? "").split(".").filter(Boolean));
    const { data } = await gql(VIEWER_REPOS, { first: RUN_REPOS, after: null });
    const repos = nodes(data.viewer.repositories).map(n => splitRepo(n.nameWithOwner));
    let more = false;
    const perRepo = await mapLimit(repos, 5, async (r) => {
      try {
        const { data: d } = await rest(`${r.rest}/actions/runs`, {
          per_page: PAGE_SIZE,
          exclude_pull_requests: true,
          created: before ? `<=${before}` : null,
        });
        const runs = d.workflow_runs ?? [];
        if ((d.total_count ?? 0) > runs.length) more = true;
        return runs.map(run => runRow(run, r.path));
      } catch (err) {
        if (err instanceof ForgeError && SKIPPABLE.has(err.kind)) return [];
        throw err;
      }
    });
    const all = perRepo.flat()
      .filter(p => !seen.has(p.id))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const items = all.slice(0, PAGE_SIZE);
    if (all.length > PAGE_SIZE) more = true;
    let next = null;
    const last = items[items.length - 1];
    if (more && last?.createdAt != null) {
      const iso = new Date(last.createdAt).toISOString().replace(/\.\d{3}Z$/, "Z");
      const atLast = items.filter(p => p.createdAt === last.createdAt).map(p => p.id);
      // The runs at the boundary second the previous page already showed too.
      if (before === iso) atLast.push(...seen);
      next = `${iso}~${[...new Set(atLast)].join(".")}`;
    }
    return { items, next, total: null };
  }

  /**
   * One pipeline with its jobs: an Actions run by its id, another app's check
   * suite (`suite:<id>`), or a commit's statuses (`status:<sha>`) — the ids
   * listChangePipelines hands out.
   */
  async function getPipeline(repo, id) {
    const r = splitRepo(repo);
    const key = String(id);
    if (key.startsWith("status:")) {
      const sha = key.slice("status:".length);
      const { data, errors } = await gql(`query($owner: String!, $name: String!, $sha: GitObjectID!) {
        repository(owner: $owner, name: $name) { object(oid: $sha) { ... on Commit { oid abbreviatedOid ${STATUS} } } } }`,
      { owner: r.owner, name: r.name, sha });
      const commit = need(need(data.repository, errors, `repository ${r.path}`).object, errors, `commit ${sha}`);
      const p = statusPipeline(r, commit, null);
      if (!p) throw new ForgeError("not-found", `commit ${sha.slice(0, 7)} has no statuses`);
      return p;
    }
    if (key.startsWith("suite:")) {
      const { data: suiteRest } = await rest(`${r.rest}/check-suites/${encodeURIComponent(key.slice("suite:".length))}`);
      const { data, errors } = await gql(`query($id: ID!) { node(id: $id) { ... on CheckSuite { ${CHECK_SUITE} } } }`, { id: suiteRest.node_id });
      const suite = need(data.node, errors, `check suite ${key}`);
      return suitePipeline(r, suite, await failedRunDetails(nodes(suite.checkRuns)), suiteRest.head_branch);
    }
    const { data: run } = await rest(`${r.rest}/actions/runs/${encodeURIComponent(key)}`);
    return runDetail(r, run);
  }

  /**
   * The end of an Actions job's log. The API answers with a redirect to a
   * signed blob URL, which the transport follows without the token.
   *
   * A job's log ends with the runner's own housekeeping — every action's
   * "Post job cleanup." (checkout removing its credentials, and so on) and
   * "Cleaning up orphan processes" — which comes AFTER the step that failed,
   * and on a failed job is thirty-odd lines between the reader and the error.
   * That housekeeping is cut, so the last lines shown are the job's own.
   */
  async function jobLogTail(repo, jobId, { lines = 80 } = {}) {
    const r = splitRepo(repo);
    const id = encodeURIComponent(String(jobId));
    // More than asked: `##[endgroup]` lines and the housekeeping are dropped
    // after, and the suffix read is the same 256 KB either way.
    const t = await transport.tail(`${api}${r.rest}/actions/jobs/${id}/logs`, { lines: lines + 200, clean: cleanGithubLogLine });
    let out = t.lines.filter(l => l != null);
    const cleanup = out.indexOf("Post job cleanup.");
    if (cleanup > 0) out = out.slice(0, cleanup);
    else if (out[out.length - 1] === "Cleaning up orphan processes") out.pop();
    while (out.length && out[out.length - 1] === "") out.pop();
    let truncated = t.truncated;
    if (out.length > lines) {
      out = out.slice(-lines);
      truncated = true;
    }
    // A check run's page, which GitHub sends on to the job's own page.
    return { lines: out, truncated, webUrl: `${web}/${r.path}/runs/${id}` };
  }

  // ── Issues ──

  /**
   * A page of issues, newest first: ALL of a repository's (pull requests are
   * not issues here), or, across repositories, every issue the viewer is part
   * of (author, assignee, mentioned or commenter).
   */
  async function listIssues({ repo = null, state = "open", cursor } = {}) {
    const closed = state === "closed";
    if (repo) {
      const r = splitRepo(repo);
      return withNewerFields(async (newer) => {
        const { data, errors } = await gql(`query($owner: String!, $name: String!, $states: [IssueState!], $first: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            issues(states: $states, first: $first, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
              totalCount pageInfo { hasNextPage endCursor }
              nodes { ${issueFields(newer)} }
            } } }`, { owner: r.owner, name: r.name, states: [closed ? "CLOSED" : "OPEN"], first: PAGE_SIZE, after: cursor || null });
        const conn = need(data.repository, errors, `repository ${r.path}`).issues;
        return {
          items: nodes(conn).map(issueRow),
          next: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null,
          total: conn.totalCount ?? null,
        };
      });
    }
    const q = `is:issue involves:@me archived:false ${closed ? "is:closed" : "is:open"} sort:created-desc`;
    return withNewerFields(async (newer) => {
      const { data } = await gql(`query($q: String!, $first: Int!, $after: String) {
        search(query: $q, type: ISSUE, first: $first, after: $after) {
          issueCount pageInfo { hasNextPage endCursor }
          nodes { ... on Issue { ${issueFields(newer)} } }
        } }`, { q, first: PAGE_SIZE, after: cursor || null });
      const s = data.search;
      return {
        items: nodes(s).filter(n => n.number != null && n.repository).map(issueRow),
        next: s.pageInfo.hasNextPage ? s.pageInfo.endCursor : null,
        total: s.issueCount ?? null,
      };
    });
  }

  /** One issue: its row, description, parent and sub-issues. */
  async function getIssue(repo, number) {
    const r = splitRepo(repo);
    return withNewerFields(async (newer) => {
      const { data, errors } = await gql(`query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { issue(number: $number) {
          ${issueFields(newer)}
          bodyHTML
          ${newer ? `subIssues(first: 50) { nodes { ${ISSUE_REF} issueType { name } } }` : ""}
        } } }`, { owner: r.owner, name: r.name, number: Number(number) });
      const issue = need(need(data.repository, errors, `repository ${r.path}`).issue, errors, `issue ${r.path}#${number}`);
      return {
        ...issueRow(issue),
        descriptionHtml: issue.bodyHTML ?? "",
        childItems: nodes(issue.subIssues).filter(i => i.repository).map(issueRef),
      };
    });
  }

  /** An issue's comments, oldest first, as GitHub shows them. A pull
   *  request's number answers its conversation's comments the same way. */
  async function listIssueComments(repo, number, { cursor } = {}) {
    const r = splitRepo(repo);
    const page = `comments(first: ${COMMENT_PAGE_SIZE}, after: $after) { totalCount pageInfo { hasNextPage endCursor } nodes { ${COMMENT} } }`;
    const { data, errors } = await gql(`query($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) {
        ... on Issue { ${page} }
        ... on PullRequest { ${page} }
      } } }`, { owner: r.owner, name: r.name, number: Number(number), after: cursor || null });
    const item = need(need(data.repository, errors, `repository ${r.path}`).issueOrPullRequest, errors, `issue ${r.path}#${number}`);
    const conn = item.comments;
    return {
      items: nodes(conn).map(comment),
      next: conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null,
      total: conn?.totalCount ?? null,
    };
  }

  // ── Pasted references ──

  /**
   * What a pasted URL or key points at: `https://github.com/o/r/pull/12`,
   * `…/issues/12`, or `o/r#12` — which GitHub numbers in one sequence for
   * issues and pull requests alike, so a key is asked about. Null for what is
   * not this host's, not a reference, or not there.
   */
  async function resolveRef(input) {
    const text = String(input ?? "").trim();
    if (!text) return null;
    const k = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(text);
    if (!k) {
      // A URL, with or without its scheme ("github.com/o/r/pull/1").
      const asUrl = /^https?:\/\//i.test(text) ? text : /^[^\s/#]+\.[^\s/#]+\//.test(text) ? `https://${text}` : null;
      if (!asUrl) return null;
      let u;
      try {
        u = new URL(asUrl);
      } catch {
        return null;
      }
      if (u.host.toLowerCase().replace(/^www\./, "") !== webHost.replace(/^www\./, "")) return null;
      const m = /^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)(?:\/|$)/.exec(u.pathname);
      if (!m) return null;
      return { type: m[3] === "issues" ? "issue" : "change", repo: `${m[1]}/${m[2]}`, number: Number(m[4]) };
    }
    const { data } = await gql(`query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) { __typename } } }`,
    { owner: k[1], name: k[2], number: Number(k[3]) }).catch((err) => {
      // Not there (or not visible to this token) is "nothing to open", not
      // a failure of the panel.
      if (err instanceof ForgeError && err.kind === "not-found") return { data: null };
      throw err;
    });
    const kind = data?.repository?.issueOrPullRequest?.__typename;
    if (kind === "PullRequest") return { type: "change", repo: `${k[1]}/${k[2]}`, number: Number(k[3]) };
    if (kind === "Issue") return { type: "issue", repo: `${k[1]}/${k[2]}`, number: Number(k[3]) };
    return null;
  }

  return {
    allowedOrigins,
    validate,
    listRepos,
    listBranches,
    getBranch,
    listChanges,
    countChanges,
    getChange,
    listChangeCommits,
    listChangePipelines,
    listChangeFiles,
    listPipelines,
    getPipeline,
    jobLogTail,
    listIssues,
    getIssue,
    listIssueComments,
    resolveRef,
    fetchAsset,
  };
}
