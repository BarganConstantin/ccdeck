// GitLab, read for the GitHub and GitLab panels (#2179). READ-ONLY: every
// call here is a REST GET or a GraphQL query — nothing is ever written.
//
// The panel copies the screens the owner works in on a GitLab instance (the
// project's Branches page, the Merge requests dashboard, the merge request's
// own page, Pipelines and Issues) and this file answers in forge-types.ts's
// shapes. The transport (forge-http.mjs) keeps the token on the instance's
// origin and names every failure; this file says WHAT to ask.
//
// REST FOR LISTS, ONE GRAPHQL QUERY TO FILL THEM. The dashboard's lists come
// from REST (its filters, its order, its x-total counts). REST lacks what the
// rows show beside the title — approvals, each reviewer's state, the head
// pipeline, unresolved threads, the rendered title — so a page is completed
// with ONE GraphQL query through `projects(fullPaths:)`, whose cost does not
// grow with the number of projects on the page (aliases per project would hit
// GitLab's complexity limit of 250 by the fifth project). If that query
// fails, the rows still draw from REST alone.
//
// THE SCHEMA IS ASKED, NOT ASSUMED. Approval rules (approvalsRequired/Left)
// exist only on GitLab EE, and a reviewer's reviewState only on newer
// versions; a query naming a field the instance lacks fails whole. The client
// reads the MergeRequest and reviewer-interaction field lists once (cached)
// and asks only for what is there. Work items (a task's parent and children)
// are experimental fields hidden from introspection, so those queries are
// tried, and retried without the work-item part when the instance refuses it.
//
// AHEAD / BEHIND. GitLab has no public bulk endpoint (the Branches page's
// diverging_commit_counts is a web route that does not take an API token),
// and the compare API sends every diff (seconds for an old branch). The count
// is read from the commits API over a revision range (`default..branch` and
// `branch..default`, by SHA), which lists without diffs: one page of 100
// answers most branches exactly; past 100, nine one-commit probes at offsets
// 200…1000 find the hundred and one more page the exact number; 1000 is the
// cap (GitLab's own 999+). Only non-stale, non-default branches of the page
// shown are counted, at most four branches and eight requests at once, and a
// count is cached by the pair of SHAs, which never changes.
import { createHash } from "node:crypto";
import { createForgeTransport, epoch, ForgeError, mapLimit } from "./forge-http.mjs";

const PAGE = 20;
const COMMIT_PAGE = 50;
const FILE_PAGE = 30;
const COMMENT_PAGE = 50;
const STALE_MS = 90 * 24 * 60 * 60 * 1000;
const DIVERGE_CAP = 1000;
const DIVERGE_REQUESTS = 8;
const DIVERGE_BRANCHES = 4;
const DIVERGE_CACHE_MAX = 2000;
const PROJECT_TTL_MS = 5 * 60_000;
const CAPS_TTL_MS = 10 * 60_000;
// A project's pipelines page with commit and user costs ~36 of the 250.
const PIPELINE_ALIASES_PER_QUERY = 6;
const RECENT_PROJECTS = 10;
const CHANGE_PIPELINES = 10;
const MAX_JOB_PAGES = 5;
const MAX_DISCUSSION_PAGES = 10;

/** Failures that leave a screen drawable without the optional part. A token
 *  or network problem is not one of them: the main call would fail too. */
const SOFT_KINDS = new Set(["upstream", "not-found", "permission", "incompatible"]);
const isSoft = (err) => err instanceof ForgeError && SOFT_KINDS.has(err.kind);

/** A GraphQL query naming a field or argument this instance does not have. */
const SCHEMA_ERROR = /doesn't exist on type|unknown argument|doesn't accept argument|isn't a defined input type|unknown type/i;

const MR = "MergeRequest";
const IX = "UserMergeRequestInteraction";
/** What a GitLab of 15+ is taken to have when the schema could not be read. */
const ASSUMED = {
  [MR]: new Set(["approved", "resolvableDiscussionsCount", "resolvedDiscussionsCount"]),
  [IX]: new Set(["approved"]),
};

const CI = {
  success: "success",
  failed: "failed",
  running: "running",
  pending: "pending",
  created: "pending",
  waiting_for_resource: "pending",
  preparing: "pending",
  waiting_for_callback: "pending",
  // A delayed job runs on its own when its timer ends — waiting, not manual.
  scheduled: "pending",
  canceled: "canceled",
  canceling: "canceled",
  skipped: "skipped",
  manual: "manual",
};

/** A GitLab pipeline or job status (REST lower case, GraphQL upper case) as
 *  the panel's CiState. */
export function gitlabCiState(status) {
  return CI[String(status ?? "").toLowerCase()] ?? "none";
}

const ACRONYMS = { api: "API", ci: "CI", ssh: "SSH", url: "URL", id: "ID" };

/** GitLab's failure_reason as words: script_failure → "Script failure". */
export function humanFailureReason(reason) {
  if (typeof reason !== "string" || !reason.trim()) return null;
  const words = reason.trim().split(/_+/).filter(Boolean).map(w => ACRONYMS[w.toLowerCase()] ?? w.toLowerCase());
  if (!words.length) return null;
  const s = words.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** `group/sub/project!12`, `…#12` or an epic's `group&12`, split. */
function splitRef(ref) {
  const m = /^([^!#&\s]+)([!#&])(\d+)$/.exec(String(ref ?? "").trim());
  return m ? { repo: m[1], sigil: m[2], number: Number(m[3]) } : null;
}

const gidTail = (gid) => String(gid ?? "").split("/").pop();
const roundOrNull = (n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null);
const hexColor = (c) => (typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c) ? c : null);
const nodesOf = (conn) => (Array.isArray(conn) ? conn : Array.isArray(conn?.nodes) ? conn.nodes : []).filter(Boolean);
const keyOf = (repo, sigil, number) => `${String(repo).toLowerCase()}${sigil}${number}`;
const isFailedJob = (j) => String(j?.status ?? "").toLowerCase() === "failed";
const isBridge = (j) => /\/Ci::Bridge\//.test(String(j?.id ?? ""));
const sha1 = (s) => createHash("sha1").update(s).digest("hex");

/** At most `n` of the calls given to it running at once. */
function limiter(n) {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    if (active < n) active++;
    else await new Promise(resolve => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

const USER = "username name avatarUrl webUrl";
const PIPE = `id iid status source ref sha createdAt startedAt finishedAt duration path commit { title } user { ${USER} }`;
const JOB = "id name status allowFailure startedAt finishedAt duration webPath stage { name }";
const PIPE_WITH_JOBS = `${PIPE} stages { nodes { name } } jobs(retried: false, first: 100) { pageInfo { hasNextPage endCursor } nodes { ${JOB} } }`;
const NOTE = `id system bodyHtml createdAt url author { ${USER} }`;
const DISCUSSION = `id resolvable resolved notes { nodes { ${NOTE} position { filePath newLine oldLine diffRefs { baseSha headSha } } } }`;
const ISSUE_REF = "iid title state webUrl reference(full: true) workItemType { name }";

/**
 * A client for one GitLab connection.
 *
 * @param {object} opts
 * @param {string} [opts.baseUrl]  the instance, with its path when GitLab is installed under one
 * @param {string} opts.token
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]
 */
export function createGitlabClient({ baseUrl = "https://gitlab.com", token, fetchImpl, now = () => Date.now() } = {}) {
  const baseParsed = new URL(String(baseUrl));
  const origin = baseParsed.origin;
  const prefix = baseParsed.pathname.replace(/\/+$/, "");
  const base = `${origin}${prefix}`;
  const api = `${base}/api/v4`;
  const graphqlUrl = `${base}/api/graphql`;
  const allowedOrigins = [origin];
  const t = createForgeTransport({
    token,
    // Bearer is what GitLab takes from both a personal access token and an
    // OAuth token, so one header serves either.
    authHeaders: (tok) => ({ authorization: `Bearer ${tok}` }),
    allowedOrigins,
    ...(fetchImpl ? { fetchImpl } : {}),
    now,
  });

  // ── transport ──────────────────────────────────────────────────────────

  const enc = (repo) => encodeURIComponent(repo);

  function qs(params = {}) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === "") continue;
      if (Array.isArray(v)) for (const x of v) sp.append(`${k}[]`, String(x));
      else sp.append(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : "";
  }

  const rest = (path, params) => t.json(`${api}${path}${qs(params)}`);
  const gql = (query, variables) => t.graphql(graphqlUrl, query, variables);

  /** The first of `queries` this instance accepts: a later one is tried only
   *  when an earlier one names a field or argument the schema lacks. */
  async function gqlFirst(queries, variables) {
    for (let i = 0; ; i++) {
      try {
        return await gql(queries[i], variables);
      } catch (err) {
        if (i >= queries.length - 1 || !(err instanceof ForgeError) || !SCHEMA_ERROR.test(err.message)) throw err;
      }
    }
  }

  async function optional(promise) {
    try {
      return await promise;
    } catch (err) {
      if (isSoft(err)) return null;
      throw err;
    }
  }

  /** Next page and count from GitLab's x-next-page / x-total. GitLab leaves
   *  x-total out past 10,000 rows, and the count is then unknown (null). */
  function pageInfo(headers) {
    const next = headers?.get?.("x-next-page");
    const total = headers?.get?.("x-total");
    const n = total == null || total === "" ? NaN : Number(total);
    return { next: next ? String(next) : null, total: Number.isFinite(n) ? n : null };
  }

  function pageParam(cursor) {
    if (cursor == null || cursor === "") return 1;
    if (!/^\d{1,6}$/.test(String(cursor))) throw new ForgeError("upstream", "that cursor is not a page of this list");
    return Number(cursor);
  }

  // ── shared reads, remembered ──────────────────────────────────────────

  let meMemo = null;
  function me() {
    if (!meMemo) {
      meMemo = rest("/user").then(r => r.data);
      meMemo.catch(() => { meMemo = null; });
    }
    return meMemo;
  }

  const projectMemo = new Map();
  function projectInfo(repo) {
    const hit = projectMemo.get(repo);
    if (hit && now() - hit.at < PROJECT_TTL_MS) return hit.promise;
    const entry = { at: now(), promise: rest(`/projects/${enc(repo)}`).then(r => r.data) };
    entry.promise.catch(() => { if (projectMemo.get(repo) === entry) projectMemo.delete(repo); });
    projectMemo.set(repo, entry);
    return entry.promise;
  }

  let capsMemo = null;
  /** The optional fields this instance has, or null when its schema could
   *  not be read (ASSUMED is used then). Never rejects: it is asked for
   *  beside a screen's main call, and that call reports a failure. A failure
   *  that is not about the schema is not remembered. */
  function caps() {
    if (capsMemo && now() - capsMemo.at < CAPS_TTL_MS) return capsMemo.promise;
    const entry = { at: now(), promise: null };
    const names = (type) => new Set((type?.fields ?? []).map(f => f?.name).filter(Boolean));
    entry.promise = gql(`query { mr: __type(name: "${MR}") { fields { name } } ix: __type(name: "${IX}") { fields { name } } }`)
      .then(({ data }) => ({ [MR]: names(data?.mr), [IX]: names(data?.ix) }), (err) => {
        if (!isSoft(err) && capsMemo === entry) capsMemo = null;
        return null;
      });
    capsMemo = entry;
    return entry.promise;
  }
  const has = (c, type, field) => (c ? c[type]?.has(field) : ASSUMED[type]?.has(field)) ?? false;

  // ── mapping ─────────────────────────────────────────────────────────────

  /** A URL GitLab gave as a path (avatars, webPath) made absolute. Paths of
   *  an instance under a prefix already carry the prefix. */
  function abs(u) {
    if (typeof u !== "string" || !u) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
    if (u.startsWith("//")) return `${baseParsed.protocol}${u}`;
    if (u.startsWith("/")) return prefix && (u === prefix || u.startsWith(`${prefix}/`)) ? `${origin}${u}` : `${base}${u}`;
    return `${base}/${u}`;
  }

  /** The project path out of an item's web URL, when it has no reference. */
  function repoFromWebUrl(url) {
    if (typeof url !== "string") return null;
    let path;
    try {
      const u = new URL(url);
      if (u.origin !== origin) return null;
      path = decodeURIComponent(u.pathname);
    } catch {
      return null;
    }
    if (prefix) {
      if (!path.startsWith(`${prefix}/`)) return null;
      path = path.slice(prefix.length);
    }
    const m = /^\/(.+?)\/-\//.exec(path);
    return m ? m[1] : null;
  }

  function toUser(u) {
    if (!u || typeof u !== "object") return null;
    const login = u.username ?? u.login;
    if (!login) return null;
    return {
      login,
      name: u.name ?? null,
      avatarUrl: abs(u.avatar_url ?? u.avatarUrl),
      webUrl: abs(u.web_url ?? u.webUrl) ?? `${base}/${login}`,
    };
  }
  const users = (list) => nodesOf(list).map(toUser).filter(Boolean);

  function toLabels(list) {
    return nodesOf(list)
      .map(l => (typeof l === "string" ? { name: l, color: null } : { name: l.name ?? l.title ?? "", color: hexColor(l.color) }))
      .filter(l => l.name);
  }

  const changeState = (s) => {
    const v = String(s ?? "").toLowerCase();
    return v === "merged" ? "merged" : v === "closed" ? "closed" : "open";
  };

  function reviewerState(ix, approved) {
    if (approved || ix?.approved) return "approved";
    switch (ix?.reviewState) {
      case "APPROVED": return "approved";
      case "REQUESTED_CHANGES": return "changes_requested";
      case "REVIEWED": return "commented";
      default: return ix?.reviewed ? "commented" : "pending";
    }
  }

  /**
   * What GraphQL adds to a change: the rendered title, approvals, each
   * reviewer's state, threads and the head pipeline. GitLab does not move a
   * reviewer's reviewState when they approve without being asked to review
   * again, so an approval from approvedBy decides "approved" too.
   */
  function graphExtras(g, meName) {
    const approvedBy = users(g?.approvedBy);
    const approvedNames = new Set(approvedBy.map(u => u.login));
    const ix = new Map(nodesOf(g?.reviewers).map(r => [r.username, r.mergeRequestInteraction ?? null]));
    const resolvable = g?.resolvableDiscussionsCount;
    const resolved = g?.resolvedDiscussionsCount;
    return {
      approvedBy,
      titleHtml: g?.titleHtml ?? null,
      approved: g ? (typeof g.approved === "boolean" ? g.approved : approvedBy.length > 0) : false,
      approvedByMe: !!meName && approvedNames.has(meName),
      approvalsRequired: typeof g?.approvalsRequired === "number" ? g.approvalsRequired : null,
      approvalsLeft: typeof g?.approvalsLeft === "number" ? g.approvalsLeft : null,
      unresolvedThreads: typeof resolvable === "number" && typeof resolved === "number" ? Math.max(0, resolvable - resolved) : null,
      ci: g?.headPipeline ? { state: gitlabCiState(g.headPipeline.status), webUrl: abs(g.headPipeline.path) } : null,
      reviewer: (u) => ({ ...u, state: reviewerState(ix.get(u.login), approvedNames.has(u.login)) }),
    };
  }

  /** A merge request row: REST `mr`, completed by GraphQL `g` when it came. */
  function toChange(mr, repo, g, meName) {
    const x = graphExtras(g, meName);
    return {
      kind: "gitlab",
      key: `${repo}!${mr.iid}`,
      number: Number(mr.iid),
      repo,
      title: mr.title ?? "",
      titleHtml: x.titleHtml,
      state: changeState(mr.state),
      draft: !!(mr.draft ?? mr.work_in_progress),
      webUrl: mr.web_url ?? `${base}/${repo}/-/merge_requests/${mr.iid}`,
      author: toUser(mr.author),
      assignees: users(mr.assignees),
      reviewers: users(mr.reviewers).map(x.reviewer),
      sourceBranch: mr.source_branch ?? "",
      targetBranch: mr.target_branch ?? "",
      createdAt: epoch(mr.created_at),
      updatedAt: epoch(mr.updated_at),
      mergedAt: epoch(mr.merged_at),
      closedAt: epoch(mr.closed_at),
      comments: mr.user_notes_count ?? 0,
      unresolvedThreads: x.unresolvedThreads,
      approved: x.approved,
      approvedByMe: x.approvedByMe,
      approvalsRequired: x.approvalsRequired,
      approvalsLeft: x.approvalsLeft,
      ci: x.ci,
      labels: toLabels(mr.labels),
    };
  }

  function toComment(n) {
    return {
      id: gidTail(n.id),
      author: toUser(n.author),
      bodyHtml: n.bodyHtml ?? "",
      createdAt: epoch(n.createdAt),
      webUrl: abs(n.url),
    };
  }

  function toCommit(c, repo) {
    const sha = c?.id ?? "";
    return {
      sha,
      shortSha: c?.short_id ?? sha.slice(0, 8),
      title: c?.title ?? "",
      authorName: c?.author_name ?? null,
      authoredAt: epoch(c?.authored_date),
      webUrl: c?.web_url ?? (sha ? `${base}/${repo}/-/commit/${sha}` : null),
    };
  }

  function toPipeline(n, repo) {
    const id = gidTail(n.id);
    const sha = n.sha ?? "";
    return {
      id,
      repo,
      ref: n.ref ?? "",
      sha,
      shortSha: sha.slice(0, 8),
      title: n.commit?.title ?? null,
      state: gitlabCiState(n.status),
      source: n.source ?? null,
      triggeredBy: toUser(n.user),
      createdAt: epoch(n.createdAt),
      startedAt: epoch(n.startedAt),
      finishedAt: epoch(n.finishedAt),
      durationSec: roundOrNull(n.duration),
      webUrl: abs(n.path) ?? `${base}/${repo}/-/pipelines/${id}`,
    };
  }

  function toJob(j, reasons) {
    const id = gidTail(j.id);
    const failed = isFailedJob(j);
    return {
      id,
      name: j.name ?? "",
      stage: j.stage?.name ?? null,
      state: gitlabCiState(j.status),
      allowFailure: !!j.allowFailure,
      startedAt: epoch(j.startedAt),
      finishedAt: epoch(j.finishedAt),
      durationSec: roundOrNull(j.duration),
      webUrl: abs(j.webPath),
      failureReason: failed ? humanFailureReason(reasons.get(id)) : null,
      annotations: [],
      // A bridge triggers a downstream pipeline and has no log of its own.
      logAvailable: !isBridge(j),
    };
  }

  function toIssueRef(n) {
    const ref = splitRef(n?.reference);
    return {
      key: n?.reference ?? `#${n?.iid}`,
      number: Number(n?.iid),
      repo: ref?.repo ?? "",
      title: n?.title ?? "",
      state: String(n?.state ?? "").toUpperCase() === "CLOSED" ? "closed" : "open",
      webUrl: abs(n?.webUrl) ?? "",
      type: n?.workItemType?.name ?? null,
    };
  }

  /** A work item's parent and child tasks, from its HIERARCHY widget. */
  function hierarchyOf(wi) {
    const w = (wi?.widgets ?? []).find(x => x && (x.type === "HIERARCHY" || "children" in x || "parent" in x));
    const nodes = nodesOf(w?.children);
    const total = typeof w?.children?.count === "number" ? w.children.count : nodes.length;
    return {
      parent: w?.parent ? toIssueRef(w.parent) : null,
      children: total > 0
        ? { total, completed: nodes.filter(n => String(n.state ?? "").toUpperCase() === "CLOSED").length }
        : null,
      childItems: nodes.filter(n => n.iid != null && n.title != null).map(toIssueRef),
    };
  }

  function toIssue(i, repo, g, wi) {
    const h = hierarchyOf(wi);
    return {
      kind: "gitlab",
      key: `${repo}#${i.iid}`,
      number: Number(i.iid),
      repo,
      title: i.title ?? "",
      titleHtml: g?.titleHtml ?? null,
      state: i.state === "closed" ? "closed" : "open",
      stateReason: i._links?.closed_as_duplicate_of ? "duplicate" : null,
      webUrl: i.web_url ?? `${base}/${repo}/-/issues/${i.iid}`,
      author: toUser(i.author),
      assignees: users(i.assignees),
      labels: toLabels(i.labels),
      milestone: i.milestone ? { title: i.milestone.title ?? "", webUrl: abs(i.milestone.web_url) } : null,
      createdAt: epoch(i.created_at),
      updatedAt: epoch(i.updated_at),
      closedAt: epoch(i.closed_at),
      comments: i.user_notes_count ?? 0,
      children: h.children,
      parent: h.parent,
    };
  }

  const rowRepo = (item, sigil, fallback) => {
    const ref = splitRef(item?.references?.full);
    return (ref && ref.sigil === sigil ? ref.repo : null) ?? repoFromWebUrl(item?.web_url) ?? fallback ?? "";
  };

  // ── merge requests ──────────────────────────────────────────────────────

  /** The GraphQL fields a change row is completed with, as far as this
   *  instance has them. */
  function changeFields(c) {
    const ix = ["approved", "reviewed", "reviewState"].filter(f => has(c, IX, f));
    return [
      has(c, MR, "approved") && "approved",
      `approvedBy { nodes { ${USER} } }`,
      `reviewers { nodes { ${USER}${ix.length ? ` mergeRequestInteraction { ${ix.join(" ")} }` : ""} } }`,
      "headPipeline { status path }",
      ...["resolvableDiscussionsCount", "resolvedDiscussionsCount", "approvalsRequired", "approvalsLeft"].filter(f => has(c, MR, f)),
    ].filter(Boolean).join(" ");
  }

  /** One GraphQL query for a page of merge requests from any projects. Every
   *  project is asked for the page's iids and the answer is matched by
   *  project and iid, so a project answering for an iid it shares with
   *  another is harmless. */
  async function enrichChanges(rows, capsPromise) {
    const byKey = new Map();
    if (!rows.length) return { byKey, meName: null };
    const c = await capsPromise;
    const paths = [...new Set(rows.map(r => r.repo))];
    const iids = [...new Set(rows.map(r => String(r.number)))];
    const res = await optional(gql(
      `query($paths: [String!], $iids: [String!], $n: Int) { currentUser { username } projects(fullPaths: $paths, first: $n) { nodes { fullPath mergeRequests(iids: $iids, first: 100) { nodes { iid titleHtml ${changeFields(c)} } } } } }`,
      { paths, iids, n: paths.length },
    ));
    for (const p of nodesOf(res?.data?.projects)) {
      for (const m of nodesOf(p.mergeRequests)) byKey.set(keyOf(p.fullPath, "!", m.iid), m);
    }
    return { byKey, meName: res?.data?.currentUser?.username ?? null };
  }

  async function filterParams(filter) {
    if (filter === "mine") return { scope: "all", author_username: (await me()).username };
    if (filter === "review") return { scope: "all", reviewer_username: (await me()).username };
    return { scope: "all" };
  }

  const STATE_PARAM = { open: "opened", merged: "merged", closed: "closed" };
  const changesPath = (repo) => (repo ? `/projects/${enc(repo)}/merge_requests` : "/merge_requests");

  async function listChanges({ repo = null, filter = "all", state = "open", sort = "created", cursor } = {}) {
    const page = pageParam(cursor);
    const capsPromise = caps();
    const params = {
      ...(await filterParams(filter)),
      state: STATE_PARAM[state] ?? "opened",
      order_by: sort === "updated" ? "updated_at" : "created_at",
      sort: "desc",
      with_labels_details: true,
      per_page: PAGE,
      page,
    };
    const { data, headers } = await rest(changesPath(repo), params);
    const rows = (Array.isArray(data) ? data : []).map(mr => ({ mr, repo: rowRepo(mr, "!", repo), number: mr.iid }));
    const { byKey, meName } = await enrichChanges(rows, capsPromise);
    return {
      items: rows.map(r => toChange(r.mr, r.repo, byKey.get(keyOf(r.repo, "!", r.number)), meName)),
      ...pageInfo(headers),
    };
  }

  async function countChanges({ repo = null, filter = "all" } = {}) {
    const params = await filterParams(filter);
    const count = (state) => rest(changesPath(repo), { ...params, state, per_page: 1 }).then(r => pageInfo(r.headers).total);
    const [open, merged, closed] = await Promise.all([count("opened"), count("merged"), count("closed")]);
    return { open, merged, closed };
  }

  async function getChange(repo, number) {
    const c = await caps();
    const detail = `iid title titleHtml descriptionHtml state draft webUrl sourceBranch targetBranch
      createdAt updatedAt mergedAt closedAt userNotesCount commitCount diffRefs { baseSha headSha }
      author { ${USER} } assignees { nodes { ${USER} } } participants(first: 100) { nodes { ${USER} } }
      labels(first: 100) { nodes { title color } } milestone { title webPath }
      pipelines { count } diffStatsSummary { fileCount } ${changeFields(c)}`;
    const { data } = await gql(
      `query($p: ID!, $iid: String!) { currentUser { username } project(fullPath: $p) { fullPath mergeRequest(iid: $iid) { ${detail} discussions(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${DISCUSSION} } } } } }`,
      { p: repo, iid: String(number) },
    );
    const mr = data?.project?.mergeRequest;
    if (!mr) throw new ForgeError("not-found", `merge request ${repo}!${number} was not found`);
    const path = data.project.fullPath ?? repo;

    let discussions = nodesOf(mr.discussions);
    let info = mr.discussions?.pageInfo;
    for (let i = 1; info?.hasNextPage && info.endCursor && i < MAX_DISCUSSION_PAGES; i++) {
      const more = await gql(
        `query($p: ID!, $iid: String!, $after: String) { project(fullPath: $p) { mergeRequest(iid: $iid) { discussions(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${DISCUSSION} } } } } }`,
        { p: repo, iid: String(number), after: info.endCursor },
      );
      const conn = more.data?.project?.mergeRequest?.discussions;
      if (!conn) break;
      discussions = discussions.concat(nodesOf(conn));
      info = conn.pageInfo;
    }

    const refs = mr.diffRefs;
    const outdated = (pos) => !!(pos?.diffRefs?.headSha && refs?.headSha
      && (pos.diffRefs.headSha !== refs.headSha || (pos.diffRefs.baseSha && refs.baseSha && pos.diffRefs.baseSha !== refs.baseSha)));
    const threads = [];
    const generalComments = [];
    for (const d of discussions) {
      const notes = nodesOf(d.notes).filter(n => !n.system);
      if (!notes.length) continue;
      const pos = notes.find(n => n.position)?.position ?? null;
      if (d.resolvable || pos) {
        threads.push({
          id: gidTail(d.id),
          resolvable: !!d.resolvable,
          resolved: !!d.resolved,
          path: pos?.filePath ?? null,
          line: pos ? (pos.newLine ?? pos.oldLine ?? null) : null,
          outdated: outdated(pos),
          comments: notes.map(toComment),
          webUrl: abs(notes[0].url),
        });
      } else {
        generalComments.push(...notes.map(toComment));
      }
    }

    const x = graphExtras(mr, data?.currentUser?.username ?? null);
    return {
      kind: "gitlab",
      key: `${path}!${mr.iid}`,
      number: Number(mr.iid),
      repo: path,
      title: mr.title ?? "",
      titleHtml: x.titleHtml,
      state: changeState(mr.state),
      draft: !!mr.draft,
      webUrl: abs(mr.webUrl) ?? `${base}/${path}/-/merge_requests/${mr.iid}`,
      author: toUser(mr.author),
      assignees: users(mr.assignees),
      reviewers: users(mr.reviewers).map(x.reviewer),
      sourceBranch: mr.sourceBranch ?? "",
      targetBranch: mr.targetBranch ?? "",
      createdAt: epoch(mr.createdAt),
      updatedAt: epoch(mr.updatedAt),
      mergedAt: epoch(mr.mergedAt),
      closedAt: epoch(mr.closedAt),
      comments: mr.userNotesCount ?? 0,
      unresolvedThreads: x.unresolvedThreads,
      approved: x.approved,
      approvedByMe: x.approvedByMe,
      approvalsRequired: x.approvalsRequired,
      approvalsLeft: x.approvalsLeft,
      ci: x.ci,
      labels: toLabels(mr.labels),
      descriptionHtml: mr.descriptionHtml ?? "",
      milestone: mr.milestone ? { title: mr.milestone.title ?? "", webUrl: abs(mr.milestone.webPath) } : null,
      participants: users(mr.participants),
      approvedBy: x.approvedBy,
      // The Overview tab's own number is the user notes count.
      counts: {
        discussions: mr.userNotesCount ?? 0,
        commits: mr.commitCount ?? 0,
        pipelines: mr.pipelines?.count ?? 0,
        files: mr.diffStatsSummary?.fileCount ?? 0,
      },
      threads,
      generalComments,
    };
  }

  async function listChangeCommits(repo, number, { cursor } = {}) {
    const { data, headers } = await rest(`/projects/${enc(repo)}/merge_requests/${number}/commits`, {
      per_page: COMMIT_PAGE, page: pageParam(cursor),
    });
    return { items: (Array.isArray(data) ? data : []).map(c => toCommit(c, repo)), ...pageInfo(headers) };
  }

  /**
   * The Changes tab without its diff: the file list from REST /diffs (which
   * says new, renamed, deleted) with the line counts from GraphQL diffStats.
   * A file's link is GitLab's own anchor on the diffs page: the SHA-1 of the
   * file's path (Gitlab::Diff::File#file_hash).
   */
  async function listChangeFiles(repo, number, { cursor } = {}) {
    const page = pageParam(cursor);
    const mrUrl = `${base}/${repo}/-/merge_requests/${number}`;
    const statsPromise = optional(gql(
      "query($p: ID!, $iid: String!) { project(fullPath: $p) { mergeRequest(iid: $iid) { diffStats { path additions deletions } } } }",
      { p: repo, iid: String(number) },
    ));
    const file = (path, oldPath, status, s) => ({
      path,
      oldPath,
      status,
      additions: s?.additions ?? 0,
      deletions: s?.deletions ?? 0,
      webUrl: `${mrUrl}/diffs#${sha1(path)}`,
    });
    let res;
    try {
      res = await rest(`/projects/${enc(repo)}/merge_requests/${number}/diffs`, { per_page: FILE_PAGE, page });
    } catch (err) {
      // GitLab before 15.7 has no /diffs: list the files from diffStats alone.
      const list = (await statsPromise)?.data?.project?.mergeRequest?.diffStats;
      if (!(err instanceof ForgeError && err.kind === "not-found" && Array.isArray(list))) throw err;
      const slice = list.slice((page - 1) * FILE_PAGE, page * FILE_PAGE);
      return {
        items: slice.map(s => file(s.path, null, "modified", s)),
        next: page * FILE_PAGE < list.length ? String(page + 1) : null,
        total: list.length,
      };
    }
    const stats = new Map(((await statsPromise)?.data?.project?.mergeRequest?.diffStats ?? []).map(s => [s.path, s]));
    const items = (Array.isArray(res.data) ? res.data : []).map(d => {
      const path = d.new_path || d.old_path || "";
      const status = d.new_file ? "added" : d.deleted_file ? "deleted" : d.renamed_file ? "renamed" : "modified";
      return file(path, d.renamed_file ? d.old_path ?? null : null, status, stats.get(path) ?? stats.get(d.old_path));
    });
    return { items, ...pageInfo(res.headers) };
  }

  // ── pipelines ───────────────────────────────────────────────────────────

  /** A pipeline node with its jobs as PipelineDetail. GraphQL gives the jobs
   *  in their stages; only REST says why a job failed (failure_reason), so a
   *  pipeline with failed jobs asks REST for those. */
  async function pipelineDetail(repo, node) {
    let jobs = nodesOf(node.jobs);
    let info = node.jobs?.pageInfo;
    for (let i = 1; info?.hasNextPage && info.endCursor && i < MAX_JOB_PAGES; i++) {
      const more = await gql(
        `query($p: ID!, $id: CiPipelineID!, $after: String) { project(fullPath: $p) { pipeline(id: $id) { jobs(retried: false, first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${JOB} } } } } }`,
        { p: repo, id: node.id, after: info.endCursor },
      );
      const conn = more.data?.project?.pipeline?.jobs;
      if (!conn) break;
      jobs = jobs.concat(nodesOf(conn));
      info = conn.pageInfo;
    }
    const pid = gidTail(node.id);
    const asks = [];
    if (jobs.some(j => isFailedJob(j) && !isBridge(j))) asks.push(`/projects/${enc(repo)}/pipelines/${pid}/jobs`);
    if (jobs.some(j => isFailedJob(j) && isBridge(j))) asks.push(`/projects/${enc(repo)}/pipelines/${pid}/bridges`);
    const reasons = new Map();
    for (const r of await Promise.all(asks.map(p => optional(rest(p, { scope: ["failed"], per_page: 100 }))))) {
      for (const j of Array.isArray(r?.data) ? r.data : []) if (j?.failure_reason) reasons.set(String(j.id), j.failure_reason);
    }
    const order = new Map(nodesOf(node.stages).map((s, i) => [s.name, i]));
    const at = (j) => order.get(j.stage?.name) ?? Number.MAX_SAFE_INTEGER;
    jobs.sort((a, b) => at(a) - at(b) || String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { numeric: true }));
    return { ...toPipeline(node, repo), jobs: jobs.map(j => toJob(j, reasons)) };
  }

  async function getPipeline(repo, id) {
    const { data } = await gql(
      `query($p: ID!, $id: CiPipelineID!) { project(fullPath: $p) { pipeline(id: $id) { ${PIPE_WITH_JOBS} } } }`,
      { p: repo, id: `gid://gitlab/Ci::Pipeline/${id}` },
    );
    const node = data?.project?.pipeline;
    if (!node) throw new ForgeError("not-found", `pipeline ${id} was not found in ${repo}`);
    return pipelineDetail(repo, node);
  }

  async function listChangePipelines(repo, number) {
    const { data } = await gql(
      `query($p: ID!, $iid: String!) { project(fullPath: $p) { mergeRequest(iid: $iid) { pipelines(first: ${CHANGE_PIPELINES}) { nodes { ${PIPE_WITH_JOBS} } } } } }`,
      { p: repo, iid: String(number) },
    );
    const mr = data?.project?.mergeRequest;
    if (!mr) throw new ForgeError("not-found", `merge request ${repo}!${number} was not found`);
    return mapLimit(nodesOf(mr.pipelines), 4, n => pipelineDetail(repo, n));
  }

  /** One project's pipelines: GraphQL, which has the commit's title, who ran
   *  it and how long it took in the one call REST would need three for. */
  async function listProjectPipelines(repo, cursor) {
    const { data } = await gql(
      `query($p: ID!, $after: String) { project(fullPath: $p) { pipelines(first: ${PAGE}, after: $after) { count pageInfo { hasNextPage endCursor } nodes { ${PIPE} } } } }`,
      { p: repo, after: cursor ?? null },
    );
    const project = data?.project;
    if (!project) throw new ForgeError("not-found", `project ${repo} was not found`);
    const conn = project.pipelines;
    return {
      items: nodesOf(conn).map(n => toPipeline(n, repo)),
      next: conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor ?? null : null,
      total: typeof conn?.count === "number" ? conn.count : null,
    };
  }

  // The "all projects" cursor: `m` then, per project still able to give
  // more, `:<project id>.<its GraphQL cursor, empty when from the start>`.
  // Project ids, not paths, keep it inside the 512 characters a route takes.
  function encodeMergedCursor(entries) {
    return entries.length ? `m${entries.map(e => `:${e.id}.${e.after ?? ""}`).join("")}` : null;
  }
  function decodeMergedCursor(cursor) {
    const parts = String(cursor).split(":");
    if (parts[0] !== "m") throw new ForgeError("upstream", "that cursor is not one of this list");
    return parts.slice(1).map(p => {
      const dot = p.indexOf(".");
      const id = dot < 0 ? p : p.slice(0, dot);
      if (!/^\d+$/.test(id)) throw new ForgeError("upstream", "that cursor is not one of this list");
      return { id, after: dot < 0 ? null : p.slice(dot + 1) || null };
    });
  }

  /**
   * The latest pipelines of the user's most recently active projects, merged
   * by time. Each project is read a page at a time after its own cursor and
   * the pages are merged newest first; a page is only as long as every
   * project still able to give more has rows left to compare, so the order
   * holds across pages.
   */
  async function listRecentPipelines(cursor) {
    let projects;
    if (!cursor) {
      const { data } = await rest("/projects", {
        membership: true, archived: false, order_by: "last_activity_at", sort: "desc", simple: true, per_page: RECENT_PROJECTS,
      });
      projects = (Array.isArray(data) ? data : []).map(p => ({ id: String(p.id), path: p.path_with_namespace, after: null }));
    } else {
      const wanted = decodeMergedCursor(cursor);
      if (!wanted.length) return { items: [], next: null, total: null };
      const { data } = await gql(
        "query($ids: [ID!], $n: Int) { projects(ids: $ids, first: $n) { nodes { id fullPath } } }",
        { ids: wanted.map(w => `gid://gitlab/Project/${w.id}`), n: wanted.length },
      );
      const paths = new Map(nodesOf(data?.projects).map(n => [gidTail(n.id), n.fullPath]));
      projects = wanted.filter(w => paths.has(w.id)).map(w => ({ ...w, path: paths.get(w.id) }));
    }
    if (!projects.length) return { items: [], next: null, total: null };

    const chunks = [];
    for (let i = 0; i < projects.length; i += PIPELINE_ALIASES_PER_QUERY) chunks.push(projects.slice(i, i + PIPELINE_ALIASES_PER_QUERY));
    const answers = await Promise.all(chunks.map(chunk => {
      const decl = [];
      const vars = {};
      const sel = chunk.map((p, i) => {
        decl.push(`$p${i}: ID!`, `$c${i}: String`);
        vars[`p${i}`] = p.path;
        vars[`c${i}`] = p.after;
        return `a${i}: project(fullPath: $p${i}) { pipelines(first: ${PAGE}, after: $c${i}) { pageInfo { hasNextPage } edges { cursor node { ${PIPE} } } } }`;
      });
      return gql(`query(${decl.join(", ")}) { ${sel.join(" ")} }`, vars).then(r => chunk.map((_, i) => r.data?.[`a${i}`]?.pipelines ?? null));
    }));
    const buffers = answers.flat().map((conn, i) => ({
      project: projects[i],
      edges: (conn?.edges ?? []).filter(e => e?.node),
      more: !!conn?.pageInfo?.hasNextPage,
      taken: 0,
    }));

    const newer = (a, b) => {
      const ta = epoch(a.createdAt) ?? 0;
      const tb = epoch(b.createdAt) ?? 0;
      return ta !== tb ? ta > tb : Number(gidTail(a.id)) > Number(gidTail(b.id));
    };
    const items = [];
    while (items.length < PAGE) {
      let best = null;
      let blocked = false;
      for (const b of buffers) {
        if (b.taken >= b.edges.length) {
          if (b.more) blocked = true;
          continue;
        }
        if (!best || newer(b.edges[b.taken].node, best.edges[best.taken].node)) best = b;
      }
      if (!best || blocked) break;
      items.push(toPipeline(best.edges[best.taken].node, best.project.path));
      best.taken++;
    }
    const left = buffers
      .filter(b => b.taken < b.edges.length || b.more)
      .map(b => ({ id: b.project.id, after: b.taken > 0 ? b.edges[b.taken - 1].cursor : b.project.after }));
    return { items, next: encodeMergedCursor(left), total: null };
  }

  async function listPipelines({ repo = null, cursor } = {}) {
    return repo ? listProjectPipelines(repo, cursor) : listRecentPipelines(cursor);
  }

  async function jobLogTail(repo, jobId, { lines = 80 } = {}) {
    const r = await t.tail(`${api}/projects/${enc(repo)}/jobs/${encodeURIComponent(jobId)}/trace`, { lines });
    return { lines: r.lines, truncated: r.truncated, webUrl: `${base}/${repo}/-/jobs/${jobId}` };
  }

  // ── branches ────────────────────────────────────────────────────────────

  const divergeLimit = limiter(DIVERGE_REQUESTS);
  const divergeCache = new Map();

  /** How many commits a revision range holds, capped at DIVERGE_CAP. */
  async function rangeCount(repo, range) {
    const page = async (perPage, n) => {
      const { data } = await divergeLimit(() => rest(`/projects/${enc(repo)}/repository/commits`, { ref_name: range, per_page: perPage, page: n }));
      return Array.isArray(data) ? data.length : 0;
    };
    const first = await page(100, 1);
    if (first < 100) return first;
    // A page of one is the commit at that position: is there one at 500, at
    // 1000? Then at the other hundreds of the half the count is in.
    const [at500, atCap] = await Promise.all([page(1, 500), page(1, DIVERGE_CAP)]);
    if (atCap > 0) return DIVERGE_CAP;
    const marks = at500 > 0 ? [600, 700, 800, 900] : [200, 300, 400];
    const found = await Promise.all(marks.map(m => page(1, m)));
    let floor = at500 > 0 ? 500 : 100;
    marks.forEach((m, i) => { if (found[i] > 0) floor = m; });
    // The count is in [floor, floor + 100): the page of 100 starting at
    // position floor + 1 says how far into that hundred it goes.
    return floor + await page(100, floor / 100 + 1);
  }

  function divergence(repo, defaultSha, sha) {
    if (sha === defaultSha) return Promise.resolve({ ahead: 0, behind: 0 });
    const key = `${repo}\n${defaultSha}\n${sha}`;
    let p = divergeCache.get(key);
    if (!p) {
      p = Promise.all([rangeCount(repo, `${defaultSha}..${sha}`), rangeCount(repo, `${sha}..${defaultSha}`)])
        .then(([ahead, behind]) => ({ ahead, behind }));
      p.catch(() => divergeCache.delete(key));
      divergeCache.set(key, p);
      if (divergeCache.size > DIVERGE_CACHE_MAX) divergeCache.delete(divergeCache.keys().next().value);
    }
    return p;
  }

  async function defaultHead(repo, def, rows) {
    if (!def) return null;
    const onPage = rows.find(b => b.default || b.name === def);
    if (onPage) return onPage.commit?.id ?? null;
    const { data } = await rest(`/projects/${enc(repo)}/repository/branches/${enc(def)}`);
    return data?.commit?.id ?? null;
  }

  /** For a page of branches, in one GraphQL query: the open merge request
   *  each is the source of, and the latest pipeline of each one's head. */
  async function branchExtras(repo, rows, c) {
    const empty = { mrs: new Map(), pipes: [] };
    if (!rows.length) return empty;
    const decl = ["$p: ID!", "$names: [String!]"];
    const vars = { p: repo, names: rows.map(b => b.name) };
    const sel = rows.map((b, i) => {
      decl.push(`$s${i}: String!`);
      vars[`s${i}`] = b.commit?.id ?? "";
      return `c${i}: pipelines(sha: $s${i}, first: 1) { nodes { id status path } }`;
    });
    const res = await optional(gql(
      `query(${decl.join(", ")}) { project(fullPath: $p) { mergeRequests(state: opened, sourceBranches: $names, first: 100) { nodes { iid draft ${has(c, MR, "approved") ? "approved " : ""}sourceBranch webUrl approvedBy { nodes { username } } } } ${sel.join(" ")} } }`,
      vars,
    ));
    const project = res?.data?.project;
    if (!project) return empty;
    const mrs = new Map();
    for (const m of nodesOf(project.mergeRequests)) {
      const prev = mrs.get(m.sourceBranch);
      if (!prev || Number(m.iid) > Number(prev.iid)) mrs.set(m.sourceBranch, m);
    }
    return { mrs, pipes: rows.map((_, i) => nodesOf(project[`c${i}`])[0] ?? null) };
  }

  function toBranch(b, repo, def, { counts = null, pipe = null, mr = null } = {}) {
    const c = b.commit ?? {};
    const committedAt = epoch(c.committed_date);
    return {
      name: b.name,
      webUrl: b.web_url ?? `${base}/${repo}/-/tree/${String(b.name).split("/").map(encodeURIComponent).join("/")}`,
      isDefault: !!b.default || (def != null && b.name === def),
      protected: !!b.protected,
      commit: {
        sha: c.id ?? "",
        shortSha: c.short_id ?? String(c.id ?? "").slice(0, 8),
        title: c.title ?? "",
        committedAt,
        authorName: c.author_name ?? null,
        webUrl: c.web_url ?? null,
      },
      ahead: counts?.ahead ?? null,
      behind: counts?.behind ?? null,
      ci: pipe ? { state: gitlabCiState(pipe.status), webUrl: abs(pipe.path) } : null,
      change: mr
        ? {
          number: Number(mr.iid),
          key: `${repo}!${mr.iid}`,
          state: "open",
          draft: !!mr.draft,
          approved: typeof mr.approved === "boolean" ? mr.approved : nodesOf(mr.approvedBy).length > 0,
          webUrl: abs(mr.webUrl) ?? `${base}/${repo}/-/merge_requests/${mr.iid}`,
        }
        : null,
      stale: committedAt != null && now() - committedAt > STALE_MS,
    };
  }

  const isStaleRow = (b) => {
    const at = epoch(b.commit?.committed_date);
    return at != null && now() - at > STALE_MS;
  };

  /**
   * A page of the Branches tab, most recently updated first — GitLab's own
   * order, which puts its "Active" branches before its "Stale" ones (no
   * commit for 90 days, `stale`). Ahead/behind is worked out for the active
   * branches of this page only; a stale branch's would cost the most and
   * GitLab does not show it either.
   */
  async function listBranches(repo, { cursor } = {}) {
    const page = pageParam(cursor);
    const capsPromise = caps();
    const [project, { data, headers }] = await Promise.all([
      projectInfo(repo),
      rest(`/projects/${enc(repo)}/repository/branches`, { sort: "updated_desc", per_page: PAGE, page }),
    ]);
    const rows = Array.isArray(data) ? data : [];
    const def = project?.default_branch ?? null;
    const [extras, counts] = await Promise.all([
      capsPromise.then(c => branchExtras(repo, rows, c)),
      optional(defaultHead(repo, def, rows)).then(defSha => mapLimit(rows, DIVERGE_BRANCHES, async (b) => {
        if (!defSha || !b.commit?.id || b.default || b.name === def || isStaleRow(b)) return null;
        return optional(divergence(repo, defSha, b.commit.id));
      })),
    ]);
    return {
      items: rows.map((b, i) => toBranch(b, repo, def, { counts: counts[i], pipe: extras.pipes[i], mr: extras.mrs.get(b.name) })),
      ...pageInfo(headers),
    };
  }

  async function getBranch(repo, name) {
    const capsPromise = caps();
    const [project, { data: b }] = await Promise.all([
      projectInfo(repo),
      rest(`/projects/${enc(repo)}/repository/branches/${enc(name)}`),
    ]);
    const def = project?.default_branch ?? null;
    const isDefault = !!b.default || b.name === def;
    const defSha = isDefault ? b.commit?.id ?? null : await optional(defaultHead(repo, def, []));
    const diverges = !isDefault && defSha && b.commit?.id;
    const [extras, aheadList, behind] = await Promise.all([
      capsPromise.then(c => branchExtras(repo, [b], c)),
      diverges
        ? rest(`/projects/${enc(repo)}/repository/commits`, { ref_name: `${defSha}..${b.commit.id}`, per_page: 100 }).then(r => (Array.isArray(r.data) ? r.data : []))
        : [],
      diverges ? optional(rangeCount(repo, `${b.commit.id}..${defSha}`)) : null,
    ]);
    const ahead = !diverges ? null : aheadList.length < 100 ? aheadList.length : await optional(rangeCount(repo, `${defSha}..${b.commit.id}`));
    const pipe = extras.pipes[0];
    const pipeline = pipe?.id ? await optional(getPipeline(repo, gidTail(pipe.id))) : null;
    return {
      branch: toBranch(b, repo, def, { counts: diverges ? { ahead, behind } : null, pipe, mr: extras.mrs.get(b.name) }),
      pipeline,
      commitsAhead: aheadList.map(c => toCommit(c, repo)),
    };
  }

  // ── issues ──────────────────────────────────────────────────────────────

  async function enrichIssues(rows) {
    const out = new Map();
    if (!rows.length) return out;
    const paths = [...new Set(rows.map(r => r.repo))];
    const iids = [...new Set(rows.map(r => String(r.number)))];
    const wi = `workItems(iids: $iids, first: 100) { nodes { iid widgets { type ... on WorkItemWidgetHierarchy { parent { ${ISSUE_REF} } children(first: 100) { count nodes { state } } } } } }`;
    const q = (withWorkItems) => `query($paths: [String!], $iids: [String!], $n: Int) { projects(fullPaths: $paths, first: $n) { nodes { fullPath issues(iids: $iids, first: 100) { nodes { iid titleHtml } } ${withWorkItems ? wi : ""} } } }`;
    const res = await optional(gqlFirst([q(true), q(false)], { paths, iids, n: paths.length }));
    for (const p of nodesOf(res?.data?.projects)) {
      for (const i of nodesOf(p.issues)) out.set(keyOf(p.fullPath, "#", i.iid), { ...out.get(keyOf(p.fullPath, "#", i.iid)), issue: i });
      for (const w of nodesOf(p.workItems)) out.set(keyOf(p.fullPath, "#", w.iid), { ...out.get(keyOf(p.fullPath, "#", w.iid)), workItem: w });
    }
    return out;
  }

  /** Issues assigned to the user, newest first — the Issues tab. */
  async function listIssues({ repo = null, state = "open", cursor } = {}) {
    const { data, headers } = await rest(repo ? `/projects/${enc(repo)}/issues` : "/issues", {
      scope: "assigned_to_me",
      state: state === "closed" ? "closed" : "opened",
      order_by: "created_at",
      sort: "desc",
      with_labels_details: true,
      per_page: PAGE,
      page: pageParam(cursor),
    });
    const rows = (Array.isArray(data) ? data : []).map(i => ({ i, repo: rowRepo(i, "#", repo), number: i.iid }));
    const extra = await enrichIssues(rows);
    return {
      items: rows.map(r => {
        const x = extra.get(keyOf(r.repo, "#", r.number));
        return toIssue(r.i, r.repo, x?.issue, x?.workItem);
      }),
      ...pageInfo(headers),
    };
  }

  async function getIssue(repo, number) {
    const wi = `namespace(fullPath: $p) { workItem(iid: $iid) { iid widgets { type ... on WorkItemWidgetHierarchy { parent { ${ISSUE_REF} } children(first: 100) { count nodes { ${ISSUE_REF} } } } } } }`;
    const q = (withWorkItem) => `query($p: ID!, $iid: String!) { project(fullPath: $p) { issue(iid: $iid) { titleHtml descriptionHtml labels(first: 100) { nodes { title color } } } } ${withWorkItem ? wi : ""} }`;
    const [{ data: i }, g] = await Promise.all([
      rest(`/projects/${enc(repo)}/issues/${number}`),
      optional(gqlFirst([q(true), q(false)], { p: repo, iid: String(number) })),
    ]);
    const issue = g?.data?.project?.issue ?? null;
    const workItem = g?.data?.namespace?.workItem ?? null;
    const mapped = toIssue(i, rowRepo(i, "#", repo), issue, workItem);
    // A single issue from REST names its labels without their colours.
    const labels = issue?.labels ? toLabels(issue.labels) : mapped.labels;
    return { ...mapped, labels, descriptionHtml: issue?.descriptionHtml ?? "", childItems: hierarchyOf(workItem).childItems };
  }

  async function listIssueComments(repo, number, { cursor } = {}) {
    const q = (filter) => `query($p: ID!, $iid: String!, $after: String) { project(fullPath: $p) { issue(iid: $iid) { userNotesCount notes(${filter}first: ${COMMENT_PAGE}, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${NOTE} } } } } }`;
    const { data } = await gqlFirst([q("filter: ONLY_COMMENTS, "), q("")], { p: repo, iid: String(number), after: cursor ?? null });
    const issue = data?.project?.issue;
    if (!issue) throw new ForgeError("not-found", `issue ${repo}#${number} was not found`);
    const conn = issue.notes;
    return {
      items: nodesOf(conn).filter(n => !n.system).map(toComment),
      next: conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor ?? null : null,
      total: typeof issue.userNotesCount === "number" ? issue.userNotesCount : null,
    };
  }

  // ── the rest ────────────────────────────────────────────────────────────

  async function validate() {
    const [user, version, self] = await Promise.all([
      rest("/user").then(r => r.data),
      optional(rest("/version").then(r => r.data)),
      // An OAuth token is not a personal access token and has no /self.
      optional(rest("/personal_access_tokens/self").then(r => r.data)).catch(() => null),
    ]);
    const meta = {};
    const warnings = [];
    if (Array.isArray(self?.scopes)) {
      meta.scopes = self.scopes.map(String);
      if (!meta.scopes.includes("read_api") && !meta.scopes.includes("api")) {
        warnings.push("This token has neither the read_api nor the api scope, so GitLab will refuse the lists. Make one with read_api.");
      }
    }
    if (typeof version?.version === "string") {
      meta.serverVersion = version.version;
      const major = Number(/^(\d+)/.exec(version.version)?.[1]);
      if (Number.isFinite(major) && major < 16) {
        warnings.push(`GitLab ${version.version} is older than 16: reviewer states, approvals and child tasks may be missing.`);
      }
    }
    if (warnings.length) meta.warnings = warnings;
    const account = toUser(user);
    return { account: { id: String(user.id), ...account }, meta };
  }

  async function listRepos({ search, cursor } = {}) {
    const q = typeof search === "string" ? search.trim() : "";
    const { data, headers } = await rest("/projects", {
      membership: true,
      archived: false,
      order_by: "last_activity_at",
      sort: "desc",
      simple: true,
      per_page: PAGE,
      page: pageParam(cursor),
      ...(q ? { search: q, search_namespaces: true } : {}),
    });
    return {
      items: (Array.isArray(data) ? data : []).map(p => ({
        id: String(p.id),
        path: p.path_with_namespace,
        name: p.name ?? p.path ?? "",
        webUrl: p.web_url ?? `${base}/${p.path_with_namespace}`,
        defaultBranch: p.default_branch ?? null,
        lastActivityAt: epoch(p.last_activity_at),
        archived: !!p.archived,
      })),
      ...pageInfo(headers),
    };
  }

  /** A pasted merge request or issue URL of this instance, or a key
   *  (`group/project!12`, `group/project#12`), read. Nothing is fetched. */
  async function resolveRef(input) {
    const s = String(input ?? "").trim();
    if (!s) return null;
    const key = /^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)([!#])(\d+)$/.exec(s);
    if (key) {
      const number = Number(key[3]);
      return number > 0 ? { type: key[2] === "!" ? "change" : "issue", repo: key[1], number } : null;
    }
    let url;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    if (url.origin !== origin) return null;
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    if (prefix) {
      if (!path.startsWith(`${prefix}/`)) return null;
      path = path.slice(prefix.length);
    }
    const m = /^\/(.+?)\/(?:-\/)?(merge_requests|issues|work_items)\/(\d+)(?:\/.*)?$/.exec(path);
    if (!m) return null;
    const repo = m[1];
    const number = Number(m[3]);
    if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(repo) || repo.split("/").includes("-") || number < 1) return null;
    return { type: m[2] === "merge_requests" ? "change" : "issue", repo, number };
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
  };
}
