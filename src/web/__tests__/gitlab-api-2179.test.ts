// #2179: the GitLab panel reads its instance through src/server/gitlab-api.mjs,
// which answers in forge-types.ts's shapes.
//
// What these pin, from anonymised fixtures shaped like GitLab 17's answers:
// each method asks the endpoint the panel copies (the dashboard's filters and
// order, the Branches page's order) and maps it, REST rows completed by one
// GraphQL query; ahead/behind is exact up to the 1000 cap and worked out only
// for the active branches of a page; reviewer states and approvedByMe come from
// approvedBy as well as the reviewer's own state; pages carry GitLab's cursor
// and x-total; every path GitLab gives relative is made absolute, under an
// install's path prefix too; the forge's failures leave as they came; and a
// pasted URL or key is read without asking the forge.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module, no types
import { createGitlabClient, gitlabCiState, humanFailureReason } from "../../server/gitlab-api.mjs";
// @ts-expect-error — plain JS module, no types
import { ForgeError } from "../../server/forge-http.mjs";

const BASE = "https://gitlab.example.com";
const NOW = Date.parse("2026-10-19T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const REPO = "group/project";
const ENC = encodeURIComponent(REPO);

type Json = Record<string, any>;
type Call = { url: URL; method: string; headers: Record<string, string>; query?: string; variables?: Json };
type RestRoute = (u: URL) => unknown;
type GqlRoute = [RegExp, (vars: Json, query: string) => unknown];

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A REST page with GitLab's pagination headers. */
const paged = (items: unknown[], { total, next }: { total?: number | null; next?: string } = {}) =>
  jsonRes(items, 200, { ...(total != null ? { "x-total": String(total) } : {}), "x-next-page": next ?? "" });

/** GitLab 17 CE's optional fields: no approval rules, reviewers with a state. */
const CE_CAPS = {
  mr: { fields: ["approved", "approvedBy", "resolvableDiscussionsCount", "resolvedDiscussionsCount", "titleHtml"].map(name => ({ name })) },
  ix: { fields: ["approved", "reviewed", "reviewState"].map(name => ({ name })) },
};
const EE_CAPS = { ...CE_CAPS, mr: { fields: [...CE_CAPS.mr.fields, { name: "approvalsRequired" }, { name: "approvalsLeft" }] } };

/**
 * A GitLab that answers REST GETs by path (below /api/v4, project ids
 * encoded as GitLab wants them) and GraphQL queries by what they ask, and
 * records every request.
 */
function fakeGitlab({ base = BASE, rest = {}, graphql = [], caps = CE_CAPS }: {
  base?: string; rest?: Record<string, RestRoute>; graphql?: GqlRoute[]; caps?: unknown;
} = {}) {
  const calls: Call[] = [];
  const apiPath = `${new URL(base).pathname.replace(/\/+$/, "")}/api/v4`;
  const routes: GqlRoute[] = [...graphql, [/__type\(name: "MergeRequest"\)/, () => caps]];
  const fetchImpl = async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    if (u.pathname.endsWith("/api/graphql")) {
      const { query, variables } = JSON.parse(init.body ?? "{}");
      calls.push({ url: u, method, headers: init.headers, query, variables });
      expect(query).not.toMatch(/^\s*mutation/);
      const route = routes.find(([re]) => re.test(query));
      if (!route) throw new Error(`unexpected GraphQL ${query.slice(0, 120)}`);
      const out = route[1](variables ?? {}, query);
      return out instanceof Response ? out : jsonRes({ data: out });
    }
    calls.push({ url: u, method, headers: init.headers });
    expect(method).toBe("GET");
    const route = rest[u.pathname.slice(apiPath.length)];
    if (!route) throw new Error(`unexpected ${u.pathname}${u.search}`);
    const out = route(u);
    return out instanceof Response ? out : jsonRes(out);
  };
  const client = createGitlabClient({ baseUrl: base, token: "glpat-TEST", fetchImpl, now: () => NOW });
  const restCalls = (fragment: string) => calls.filter(c => !c.query && c.url.pathname.includes(fragment));
  const gqlCalls = (re: RegExp) => calls.filter(c => c.query && re.test(c.query));
  return { client, calls, restCalls, gqlCalls };
}

const user = (login: string, id = 1) => ({
  id, username: login, name: login.charAt(0).toUpperCase() + login.slice(1), state: "active",
  avatar_url: `${BASE}/uploads/-/system/user/avatar/${id}/avatar.png`, web_url: `${BASE}/${login}`,
});
/** GraphQL gives avatars as paths. */
const gUser = (login: string, id = 1) => ({
  username: login, name: login.charAt(0).toUpperCase() + login.slice(1),
  avatarUrl: `/uploads/-/system/user/avatar/${id}/avatar.png`, webUrl: `${BASE}/${login}`,
});

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as InstanceType<typeof ForgeError>;
  }
  throw new Error("expected a failure");
}

describe("the connection", () => {
  it("allows only the instance's origin and sends the token as Bearer", async () => {
    const { client, calls } = fakeGitlab({
      rest: {
        "/user": () => user("alice", 7),
        "/version": () => ({ version: "17.7.7", revision: "abc" }),
        "/personal_access_tokens/self": () => ({ id: 1, scopes: ["read_api", "read_user"], active: true }),
      },
    });
    expect(client.allowedOrigins).toEqual([BASE]);
    const v = await client.validate();
    expect(v).toEqual({
      account: {
        id: "7", login: "alice", name: "Alice",
        avatarUrl: `${BASE}/uploads/-/system/user/avatar/7/avatar.png`, webUrl: `${BASE}/alice`,
      },
      meta: { scopes: ["read_api", "read_user"], serverVersion: "17.7.7" },
    });
    expect(calls.every(c => c.headers.authorization === "Bearer glpat-TEST")).toBe(true);
    expect(calls.every(c => !("private-token" in c.headers))).toBe(true);
  });

  it("warns about a token without read_api and an instance older than 16, naming the version", async () => {
    const { client } = fakeGitlab({
      rest: {
        "/user": () => user("alice"),
        "/version": () => ({ version: "15.11.13" }),
        "/personal_access_tokens/self": () => ({ scopes: ["read_user"] }),
      },
    });
    const { meta } = await client.validate();
    expect(meta.scopes).toEqual(["read_user"]);
    expect(meta.warnings).toHaveLength(2);
    expect(meta.warnings[0]).toMatch(/read_api/);
    expect(meta.warnings[1]).toContain("15.11.13");
  });

  it("leaves scopes absent for a token that is not a personal access token", async () => {
    const { client } = fakeGitlab({
      rest: {
        "/user": () => user("alice"),
        "/version": () => ({ version: "17.7.7" }),
        "/personal_access_tokens/self": () => jsonRes({ message: "404 Not Found" }, 404),
      },
    });
    const { meta } = await client.validate();
    expect(meta).toEqual({ serverVersion: "17.7.7" });
  });

  it("lets the forge's failures through as they came", async () => {
    const { client } = fakeGitlab({
      rest: {
        "/user": () => jsonRes({ message: "401 Unauthorized" }, 401),
        "/version": () => jsonRes({ message: "401 Unauthorized" }, 401),
        "/personal_access_tokens/self": () => jsonRes({ message: "401 Unauthorized" }, 401),
        [`/projects/${ENC}/merge_requests/9/commits`]: () => jsonRes({ message: "404 Not found" }, 404),
        "/projects": () => jsonRes({ message: "Retry later" }, 429, { "retry-after": "30" }),
      },
    });
    const auth = await failure(client.validate());
    expect(auth).toBeInstanceOf(ForgeError);
    expect(auth.kind).toBe("auth");
    expect((await failure(client.listChangeCommits(REPO, 9))).kind).toBe("not-found");
    expect(await failure(client.listRepos({}))).toMatchObject({ kind: "rate-limit", retryAfter: 30 });
  });
});

describe("projects", () => {
  it("lists the user's projects by last activity, unarchived, searching namespaces too", async () => {
    const { client, restCalls } = fakeGitlab({
      rest: {
        "/projects": () => paged([{
          id: 41, name: "Project", path: "project", path_with_namespace: REPO, default_branch: "main",
          web_url: `${BASE}/${REPO}`, last_activity_at: daysAgo(1),
        }], { total: 73, next: "3" }),
      },
    });
    const page = await client.listRepos({ search: "group/proj", cursor: "2" });
    expect(page).toEqual({
      items: [{ id: "41", path: REPO, name: "Project", webUrl: `${BASE}/${REPO}`, defaultBranch: "main", lastActivityAt: NOW - 86_400_000, archived: false }],
      next: "3",
      total: 73,
    });
    const q = restCalls("/projects")[0].url.searchParams;
    expect(Object.fromEntries(q)).toMatchObject({
      membership: "true", archived: "false", order_by: "last_activity_at", sort: "desc", search: "group/proj", search_namespaces: "true", page: "2",
    });
  });
});

// ── branches ────────────────────────────────────────────────────────────

const SHA = { main: "a".repeat(40), small: "b".repeat(40), mid: "c".repeat(40), far: "d".repeat(40), old: "e".repeat(40) };

function branchRow(name: string, sha: string, days: number, extra: Json = {}) {
  return {
    name, merged: false, protected: false, default: false, web_url: `${BASE}/${REPO}/-/tree/${name}`,
    commit: {
      id: sha, short_id: sha.slice(0, 8), title: `Work on ${name}`, author_name: "Alice",
      committed_date: daysAgo(days), authored_date: daysAgo(days), web_url: `${BASE}/${REPO}/-/commit/${sha}`,
    },
    ...extra,
  };
}

/** How many commits each `from..to` range holds. */
const RANGES: Record<string, number> = {
  [`${SHA.main}..${SHA.small}`]: 3, [`${SHA.small}..${SHA.main}`]: 0,
  [`${SHA.main}..${SHA.mid}`]: 120, [`${SHA.mid}..${SHA.main}`]: 437,
  [`${SHA.main}..${SHA.far}`]: 999, [`${SHA.far}..${SHA.main}`]: 4000,
};

/** The commits API over a revision range, as GitLab pages it. */
function commitsRoute(u: URL) {
  const range = u.searchParams.get("ref_name") ?? "";
  const n = RANGES[range];
  if (n == null) throw new Error(`unexpected range ${range}`);
  const per = Number(u.searchParams.get("per_page"));
  const page = Number(u.searchParams.get("page") ?? 1);
  const count = Math.max(0, Math.min(per, n - (page - 1) * per));
  return Array.from({ length: count }, (_, i) => ({
    id: `${String(i).padStart(4, "0")}${"f".repeat(36)}`, short_id: String(i).padStart(8, "0"),
    title: `Commit ${i}`, author_name: "Bob", authored_date: daysAgo(1), web_url: `${BASE}/${REPO}/-/commit/${i}`,
  }));
}

function branchesGitlab(extraRest: Record<string, RestRoute> = {}, extraGql: GqlRoute[] = []) {
  const rows = [
    branchRow("feature/small", SHA.small, 1),
    branchRow("main", SHA.main, 2, { default: true, protected: true }),
    branchRow("feature/mid", SHA.mid, 10),
    branchRow("feature/far", SHA.far, 60),
    branchRow("old/idea", SHA.old, 200),
  ];
  return fakeGitlab({
    rest: {
      [`/projects/${ENC}`]: () => ({ id: 41, path_with_namespace: REPO, default_branch: "main" }),
      [`/projects/${ENC}/repository/branches`]: () => paged(rows, { total: 57, next: "2" }),
      [`/projects/${ENC}/repository/commits`]: commitsRoute,
      ...extraRest,
    },
    graphql: [
      [/sourceBranches/, (v) => ({
        project: {
          mergeRequests: { nodes: [
            { iid: "11", draft: true, approved: false, sourceBranch: "feature/small", webUrl: `${BASE}/${REPO}/-/merge_requests/11`, approvedBy: { nodes: [] } },
            { iid: "15", draft: false, approved: true, sourceBranch: "feature/small", webUrl: `${BASE}/${REPO}/-/merge_requests/15`, approvedBy: { nodes: [{ username: "bob" }] } },
          ] },
          ...Object.fromEntries(Object.keys(v).filter(k => /^s\d+$/.test(k)).map(k => [`c${k.slice(1)}`, {
            nodes: v[k] === SHA.small ? [{ id: "gid://gitlab/Ci::Pipeline/501", status: "FAILED", path: `/${REPO}/-/pipelines/501` }]
              : v[k] === SHA.main ? [{ id: "gid://gitlab/Ci::Pipeline/500", status: "SUCCESS", path: `/${REPO}/-/pipelines/500` }]
                : [],
          }])),
        },
      })],
      ...extraGql,
    ],
  });
}

describe("the Branches page", () => {
  it("maps each row, and counts ahead|behind for the active branches only, exactly up to 1000", async () => {
    const { client, restCalls } = branchesGitlab();
    const page = await client.listBranches(REPO, {});
    expect(page.total).toBe(57);
    expect(page.next).toBe("2");
    expect(restCalls("/repository/branches")[0].url.searchParams.get("sort")).toBe("updated_desc");
    const by = Object.fromEntries(page.items.map((b: Json) => [b.name, b]));

    expect(by["feature/small"]).toEqual({
      name: "feature/small",
      webUrl: `${BASE}/${REPO}/-/tree/feature/small`,
      isDefault: false,
      protected: false,
      commit: {
        sha: SHA.small, shortSha: SHA.small.slice(0, 8), title: "Work on feature/small",
        committedAt: NOW - 86_400_000, authorName: "Alice", webUrl: `${BASE}/${REPO}/-/commit/${SHA.small}`,
      },
      ahead: 3,
      behind: 0,
      ci: { state: "failed", webUrl: `${BASE}/${REPO}/-/pipelines/501` },
      // Two open merge requests from the branch: the newest is its badge.
      change: { number: 15, key: `${REPO}!15`, state: "open", draft: false, approved: true, webUrl: `${BASE}/${REPO}/-/merge_requests/15` },
      stale: false,
    });
    expect([by["feature/mid"].ahead, by["feature/mid"].behind]).toEqual([120, 437]);
    // 4000 behind is GitLab's 999+: the cap.
    expect([by["feature/far"].ahead, by["feature/far"].behind]).toEqual([999, 1000]);
    expect(by.main).toMatchObject({ isDefault: true, protected: true, ahead: null, behind: null, ci: { state: "success" }, change: null });
    // No commit for 90 days: GitLab's "Stale branches", and never counted.
    expect(by["old/idea"]).toMatchObject({ stale: true, ahead: null, behind: null, ci: null, change: null });
    expect(page.items.filter((b: Json) => !b.stale).map((b: Json) => b.name)).toEqual(["feature/small", "main", "feature/mid", "feature/far"]);
    expect(restCalls("/repository/commits").some(c => (c.url.searchParams.get("ref_name") ?? "").includes(SHA.old))).toBe(false);
  });

  it("never asks the commits API past position 1000, and remembers a count by the pair of SHAs", async () => {
    const { client, restCalls } = branchesGitlab();
    await client.listBranches(REPO, {});
    const commitCalls = restCalls("/repository/commits");
    const positions = commitCalls.map(c => Number(c.url.searchParams.get("per_page")) * Number(c.url.searchParams.get("page")));
    expect(Math.max(...positions)).toBeLessThanOrEqual(1000);
    // A capped range costs the first page and two probes.
    expect(commitCalls.filter(c => c.url.searchParams.get("ref_name") === `${SHA.far}..${SHA.main}`)).toHaveLength(3);
    const before = commitCalls.length;
    await client.listBranches(REPO, {});
    expect(restCalls("/repository/commits")).toHaveLength(before);
  });

  it("reads the default branch's head when it is not on the page", async () => {
    const rows = [branchRow("feature/small", SHA.small, 1)];
    const { client, restCalls } = fakeGitlab({
      rest: {
        [`/projects/${ENC}`]: () => ({ id: 41, default_branch: "main" }),
        [`/projects/${ENC}/repository/branches`]: () => paged(rows, { total: 1 }),
        [`/projects/${ENC}/repository/branches/main`]: () => branchRow("main", SHA.main, 2, { default: true }),
        [`/projects/${ENC}/repository/commits`]: commitsRoute,
      },
      graphql: [[/sourceBranches/, () => ({ project: { mergeRequests: { nodes: [] }, c0: { nodes: [] } } })]],
    });
    const page = await client.listBranches(REPO, { cursor: "3" });
    expect(page).toMatchObject({ next: null, total: 1 });
    expect(page.items[0]).toMatchObject({ ahead: 3, behind: 0, ci: null, change: null });
    expect(restCalls("/repository/branches")[0].url.searchParams.get("page")).toBe("3");
    expect(restCalls("/repository/branches/main")).toHaveLength(1);
  });

  it("opens a branch with the commits it has, its counts and its latest pipeline", async () => {
    const { client } = branchesGitlab({
      [`/projects/${ENC}/repository/branches/feature%2Fmid`]: () => branchRow("feature/mid", SHA.mid, 10),
      [`/projects/${ENC}/repository/branches/main`]: () => branchRow("main", SHA.main, 2, { default: true }),
    }, [
      [/pipeline\(id: \$id\)/, () => ({ project: { pipeline: pipelineNode("700", "SUCCESS", [job(1, "build", "SUCCESS", "build")], ["build"]) } })],
    ]);
    // feature/mid's head has no pipeline in the fixture.
    const detail = await client.getBranch(REPO, "feature/mid");
    expect(detail.branch).toMatchObject({ name: "feature/mid", ahead: 120, behind: 437, stale: false });
    expect(detail.commitsAhead).toHaveLength(100);
    expect(detail.commitsAhead[0]).toEqual({
      sha: `0000${"f".repeat(36)}`, shortSha: "00000000", title: "Commit 0", authorName: "Bob",
      authoredAt: NOW - 86_400_000, webUrl: `${BASE}/${REPO}/-/commit/0`,
    });
    expect(detail.pipeline).toBeNull();
  });

  it("opens the default branch without counts, with its pipeline", async () => {
    const { client } = branchesGitlab({
      [`/projects/${ENC}/repository/branches/main`]: () => branchRow("main", SHA.main, 2, { default: true }),
    }, [
      [/pipeline\(id: \$id\)/, (v) => {
        expect(v.id).toBe("gid://gitlab/Ci::Pipeline/500");
        return { project: { pipeline: pipelineNode("500", "SUCCESS", [job(1, "build", "SUCCESS", "build")], ["build"]) } };
      }],
    ]);
    const detail = await client.getBranch(REPO, "main");
    expect(detail.branch).toMatchObject({ isDefault: true, ahead: null, behind: null });
    expect(detail.commitsAhead).toEqual([]);
    expect(detail.pipeline).toMatchObject({ id: "500", state: "success", jobs: [{ name: "build" }] });
  });
});

// ── merge requests ──────────────────────────────────────────────────────

function restMr(iid: number, repo = REPO, extra: Json = {}) {
  return {
    id: 1000 + iid, iid, project_id: 41, title: `Change ${iid}`, state: "opened", draft: false,
    created_at: daysAgo(3), updated_at: daysAgo(1), merged_at: null, closed_at: null,
    source_branch: `feature/${iid}`, target_branch: "main", user_notes_count: 4,
    author: user("alice", 1), assignees: [user("alice", 1)],
    reviewers: [user("bob", 2), user("carol", 3), user("dave", 4), user("erin", 5)],
    labels: [{ name: "backend", color: "#1f75cb", text_color: "#FFFFFF" }],
    web_url: `${BASE}/${repo}/-/merge_requests/${iid}`, references: { full: `${repo}!${iid}` },
    ...extra,
  };
}

const ix = (reviewState: string, approved = false) => ({ mergeRequestInteraction: { reviewState, approved, reviewed: reviewState !== "UNREVIEWED" } });

const enrichedMr = (iid: string, extra: Json = {}) => ({
  iid,
  titleHtml: `<p>Change ${iid} <a href="https://jira.example.com/browse/ABC-1">ABC-1</a></p>`,
  approved: true,
  approvedBy: { nodes: [gUser("bob", 2), gUser("me", 9)] },
  reviewers: { nodes: [
    { ...gUser("bob", 2), ...ix("UNREVIEWED") },
    { ...gUser("carol", 3), ...ix("REQUESTED_CHANGES") },
    { ...gUser("dave", 4), ...ix("REVIEWED") },
    { ...gUser("erin", 5), ...ix("UNREVIEWED") },
  ] },
  headPipeline: { status: "RUNNING", path: `/${REPO}/-/pipelines/55` },
  resolvableDiscussionsCount: 5,
  resolvedDiscussionsCount: 3,
  ...extra,
});

function changesGitlab({ caps = CE_CAPS, enrich }: { caps?: unknown; enrich?: (v: Json, q: string) => unknown } = {}) {
  return fakeGitlab({
    caps,
    rest: {
      "/user": () => user("me", 9),
      "/merge_requests": () => paged([restMr(12), restMr(7, "group/sub/other", { draft: true, labels: [] })], { total: 41, next: "2" }),
      [`/projects/${ENC}/merge_requests`]: () => paged([restMr(12)], { total: 1 }),
    },
    graphql: [[/projects\(fullPaths: \$paths/, enrich ?? (() => ({
      currentUser: { username: "me" },
      projects: { nodes: [
        { fullPath: REPO, mergeRequests: { nodes: [enrichedMr("12")] } },
        // The other project answers for iid 12 too: it is not its row's.
        { fullPath: "group/sub/other", mergeRequests: { nodes: [
          enrichedMr("12", { titleHtml: "<p>wrong</p>" }),
          enrichedMr("7", { approved: false, approvedBy: { nodes: [] }, headPipeline: null, resolvableDiscussionsCount: 0, resolvedDiscussionsCount: 0, reviewers: { nodes: [] } }),
        ] } },
      ] },
    }))]],
  });
}

describe("the Merge requests dashboard", () => {
  it("lists all open ones newest first and completes them with one GraphQL query", async () => {
    const { client, restCalls, gqlCalls } = changesGitlab();
    const page = await client.listChanges({ filter: "all", state: "open", sort: "created" });
    expect(page.total).toBe(41);
    expect(page.next).toBe("2");
    const q = Object.fromEntries(restCalls("/merge_requests")[0].url.searchParams);
    expect(q).toMatchObject({ scope: "all", state: "opened", order_by: "created_at", sort: "desc", with_labels_details: "true" });
    // "All" needs no username: the dashboard's scope says it.
    expect(restCalls("/user")).toHaveLength(0);

    const enrich = gqlCalls(/projects\(fullPaths/);
    expect(enrich).toHaveLength(1);
    expect(enrich[0].variables).toMatchObject({ paths: [REPO, "group/sub/other"], iids: ["12", "7"] });
    // CE has no approval rules: they are not asked for.
    expect(enrich[0].query).not.toMatch(/approvalsRequired/);

    const [a, b] = page.items;
    expect(a).toEqual({
      kind: "gitlab",
      key: `${REPO}!12`,
      number: 12,
      repo: REPO,
      title: "Change 12",
      titleHtml: `<p>Change 12 <a href="https://jira.example.com/browse/ABC-1">ABC-1</a></p>`,
      state: "open",
      draft: false,
      webUrl: `${BASE}/${REPO}/-/merge_requests/12`,
      author: { login: "alice", name: "Alice", avatarUrl: `${BASE}/uploads/-/system/user/avatar/1/avatar.png`, webUrl: `${BASE}/alice` },
      assignees: [{ login: "alice", name: "Alice", avatarUrl: `${BASE}/uploads/-/system/user/avatar/1/avatar.png`, webUrl: `${BASE}/alice` }],
      reviewers: [
        // GitLab leaves an approver's reviewState alone: approvedBy decides.
        { login: "bob", name: "Bob", avatarUrl: `${BASE}/uploads/-/system/user/avatar/2/avatar.png`, webUrl: `${BASE}/bob`, state: "approved" },
        { login: "carol", name: "Carol", avatarUrl: `${BASE}/uploads/-/system/user/avatar/3/avatar.png`, webUrl: `${BASE}/carol`, state: "changes_requested" },
        { login: "dave", name: "Dave", avatarUrl: `${BASE}/uploads/-/system/user/avatar/4/avatar.png`, webUrl: `${BASE}/dave`, state: "commented" },
        { login: "erin", name: "Erin", avatarUrl: `${BASE}/uploads/-/system/user/avatar/5/avatar.png`, webUrl: `${BASE}/erin`, state: "pending" },
      ],
      sourceBranch: "feature/12",
      targetBranch: "main",
      createdAt: NOW - 3 * 86_400_000,
      updatedAt: NOW - 86_400_000,
      mergedAt: null,
      closedAt: null,
      comments: 4,
      unresolvedThreads: 2,
      approved: true,
      approvedByMe: true,
      approvalsRequired: null,
      approvalsLeft: null,
      ci: { state: "running", webUrl: `${BASE}/${REPO}/-/pipelines/55` },
      labels: [{ name: "backend", color: "#1f75cb" }],
    });
    expect(b).toMatchObject({
      key: "group/sub/other!7", repo: "group/sub/other", draft: true, approved: false, approvedByMe: false,
      unresolvedThreads: 0, ci: null, labels: [], titleHtml: "<p>Change 7 <a href=\"https://jira.example.com/browse/ABC-1\">ABC-1</a></p>",
    });
    expect(b.reviewers.map((r: Json) => r.state)).toEqual(["pending", "pending", "pending", "pending"]);
  });

  it("Mine and Review filter by the user, and a project's list by its own endpoint", async () => {
    const { client, restCalls } = changesGitlab();
    await client.listChanges({ filter: "mine", state: "merged", sort: "updated", cursor: "3" });
    await client.listChanges({ repo: REPO, filter: "review", state: "closed" });
    const [mine] = restCalls("/merge_requests").filter(c => c.url.pathname.endsWith("/api/v4/merge_requests"));
    expect(Object.fromEntries(mine.url.searchParams)).toMatchObject({
      scope: "all", author_username: "me", state: "merged", order_by: "updated_at", page: "3",
    });
    const [review] = restCalls(`/projects/${ENC}/merge_requests`);
    expect(Object.fromEntries(review.url.searchParams)).toMatchObject({ scope: "all", reviewer_username: "me", state: "closed" });
    // The user is read once for both.
    expect(restCalls("/user")).toHaveLength(1);
  });

  it("asks for approval rules where the instance has them (EE)", async () => {
    const { client, gqlCalls } = changesGitlab({
      caps: EE_CAPS,
      enrich: () => ({
        currentUser: { username: "me" },
        projects: { nodes: [{ fullPath: REPO, mergeRequests: { nodes: [enrichedMr("12", { approved: false, approvalsRequired: 2, approvalsLeft: 1 })] } }] },
      }),
    });
    const page = await client.listChanges({});
    expect(gqlCalls(/projects\(fullPaths/)[0].query).toMatch(/approvalsRequired approvalsLeft/);
    expect(page.items[0]).toMatchObject({ approved: false, approvalsRequired: 2, approvalsLeft: 1 });
  });

  it("asks only the reviewer fields an older instance has", async () => {
    const { client, gqlCalls } = changesGitlab({
      caps: { mr: { fields: [{ name: "approved" }] }, ix: { fields: [{ name: "approved" }] } },
    });
    await client.listChanges({});
    const q = gqlCalls(/projects\(fullPaths/)[0].query;
    expect(q).toMatch(/mergeRequestInteraction \{ approved \}/);
    expect(q).not.toMatch(/reviewState|resolvableDiscussionsCount/);
  });

  it("still draws the rows from REST when the GraphQL half fails", async () => {
    const { client } = changesGitlab({ enrich: () => jsonRes({ message: "500 Internal Server Error" }, 500) });
    const page = await client.listChanges({});
    expect(page.items[0]).toMatchObject({
      key: `${REPO}!12`, titleHtml: null, approved: false, approvedByMe: false, unresolvedThreads: null, ci: null,
    });
    expect(page.items[0].reviewers.map((r: Json) => r.state)).toEqual(["pending", "pending", "pending", "pending"]);
  });

  it("counts the tabs from x-total, unknown where GitLab leaves it out past 10,000", async () => {
    const { client, restCalls } = fakeGitlab({
      rest: {
        "/user": () => user("me", 9),
        "/merge_requests": (u) => {
          const state = u.searchParams.get("state");
          expect(u.searchParams.get("per_page")).toBe("1");
          return state === "opened" ? paged([restMr(1)], { total: 3, next: "2" })
            : state === "closed" ? paged([restMr(2)], { total: 397, next: "2" })
              : paged([restMr(3)], { next: "2" });
        },
      },
    });
    expect(await client.countChanges({ filter: "review" })).toEqual({ open: 3, merged: null, closed: 397 });
    expect(restCalls("/merge_requests").every(c => c.url.searchParams.get("reviewer_username") === "me")).toBe(true);
  });
});

// ── a merge request's page ──────────────────────────────────────────────

const note = (id: number, login: string, extra: Json = {}) => ({
  id: `gid://gitlab/Note/${id}`, system: false, bodyHtml: `<p>note ${id}</p>`, createdAt: daysAgo(1),
  url: `${BASE}/${REPO}/-/merge_requests/12#note_${id}`, author: gUser(login), position: null, ...extra,
});

function detailNode(extra: Json = {}) {
  return {
    iid: "12", title: "Draft: Change 12", titleHtml: "<p>Draft: Change 12</p>", descriptionHtml: "<p>What and why</p>",
    state: "opened", draft: true, webUrl: `${BASE}/${REPO}/-/merge_requests/12`, sourceBranch: "feature/x", targetBranch: "main",
    createdAt: daysAgo(5), updatedAt: daysAgo(1), mergedAt: null, closedAt: null,
    userNotesCount: 6, commitCount: 29, diffRefs: { baseSha: "1".repeat(40), headSha: "2".repeat(40) },
    author: gUser("alice", 1), assignees: { nodes: [gUser("alice", 1)] }, participants: { nodes: [gUser("alice", 1), gUser("bob", 2)] },
    labels: { nodes: [{ title: "backend", color: "#1f75cb" }] }, milestone: { title: "Sprint 9", webPath: `/${REPO}/-/milestones/9` },
    pipelines: { count: 3 }, diffStatsSummary: { fileCount: 112 },
    approved: false, approvedBy: { nodes: [] },
    reviewers: { nodes: [{ ...gUser("bob", 2), ...ix("REVIEWED") }] },
    headPipeline: { status: "FAILED", path: `/${REPO}/-/pipelines/77` },
    resolvableDiscussionsCount: 2, resolvedDiscussionsCount: 1,
    discussions: {
      pageInfo: { hasNextPage: true, endCursor: "CUR1" },
      nodes: [
        { id: "gid://gitlab/Discussion/aaa", resolvable: true, resolved: false, notes: { nodes: [
          note(1, "bob", { id: "gid://gitlab/DiffNote/1", position: { filePath: "src/app.ts", newLine: 52, oldLine: null, diffRefs: { baseSha: "1".repeat(40), headSha: "2".repeat(40) } } }),
          note(2, "alice", { id: "gid://gitlab/DiffNote/2" }),
        ] } },
        { id: "gid://gitlab/Discussion/bbb", resolvable: true, resolved: true, notes: { nodes: [
          note(3, "bob", { id: "gid://gitlab/DiffNote/3", position: { filePath: "src/old.ts", newLine: null, oldLine: 8, diffRefs: { baseSha: "1".repeat(40), headSha: "9".repeat(40) } } }),
        ] } },
        { id: "gid://gitlab/Discussion/ccc", resolvable: false, resolved: false, notes: { nodes: [note(4, "carol")] } },
        { id: "gid://gitlab/Discussion/ddd", resolvable: false, resolved: false, notes: { nodes: [note(5, "alice", { system: true, bodyHtml: "<p>added 1 commit</p>" })] } },
      ],
    },
    ...extra,
  };
}

describe("a merge request's page", () => {
  it("reads the Overview in one query, with every discussion page, threads apart from general comments", async () => {
    const { client, gqlCalls } = fakeGitlab({
      graphql: [
        [/discussions\(first: 100, after: \$after\)/, (v) => {
          expect(v.after).toBe("CUR1");
          return { project: { mergeRequest: { discussions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
            { id: "gid://gitlab/Discussion/eee", resolvable: true, resolved: false, notes: { nodes: [note(6, "dave")] } },
          ] } } } };
        }],
        [/mergeRequest\(iid: \$iid\) \{ iid title/, (v) => {
          expect(v).toEqual({ p: REPO, iid: "12" });
          return { currentUser: { username: "bob" }, project: { fullPath: REPO, mergeRequest: detailNode() } };
        }],
      ],
    });
    const d = await client.getChange(REPO, 12);
    expect(d).toMatchObject({
      kind: "gitlab", key: `${REPO}!12`, number: 12, repo: REPO, title: "Draft: Change 12", state: "open", draft: true,
      descriptionHtml: "<p>What and why</p>", comments: 6, unresolvedThreads: 1, approved: false, approvedByMe: false,
      ci: { state: "failed", webUrl: `${BASE}/${REPO}/-/pipelines/77` },
      milestone: { title: "Sprint 9", webUrl: `${BASE}/${REPO}/-/milestones/9` },
      counts: { discussions: 6, commits: 29, pipelines: 3, files: 112 },
      labels: [{ name: "backend", color: "#1f75cb" }],
    });
    expect(d.author.avatarUrl).toBe(`${BASE}/uploads/-/system/user/avatar/1/avatar.png`);
    expect(d.participants.map((u: Json) => u.login)).toEqual(["alice", "bob"]);
    expect(d.reviewers).toEqual([{ login: "bob", name: "Bob", avatarUrl: `${BASE}/uploads/-/system/user/avatar/2/avatar.png`, webUrl: `${BASE}/bob`, state: "commented" }]);
    expect(d.threads).toHaveLength(3);
    expect(d.threads[0]).toEqual({
      id: "aaa", resolvable: true, resolved: false, path: "src/app.ts", line: 52, outdated: false,
      comments: [
        { id: "1", author: expect.objectContaining({ login: "bob" }), bodyHtml: "<p>note 1</p>", createdAt: NOW - 86_400_000, webUrl: `${BASE}/${REPO}/-/merge_requests/12#note_1` },
        { id: "2", author: expect.objectContaining({ login: "alice" }), bodyHtml: "<p>note 2</p>", createdAt: NOW - 86_400_000, webUrl: `${BASE}/${REPO}/-/merge_requests/12#note_2` },
      ],
      webUrl: `${BASE}/${REPO}/-/merge_requests/12#note_1`,
    });
    // A line on an older version of the diff is outdated; the old line is its line.
    expect(d.threads[1]).toMatchObject({ id: "bbb", resolved: true, path: "src/old.ts", line: 8, outdated: true });
    expect(d.threads[2]).toMatchObject({ id: "eee", resolvable: true, path: null, line: null, outdated: false });
    // System notes are left out; a note that is not a thread is a general comment.
    expect(d.generalComments.map((c: Json) => c.id)).toEqual(["4"]);
    expect(gqlCalls(/discussions/)).toHaveLength(2);
  });

  it("is not-found when GitLab has no such merge request", async () => {
    const { client } = fakeGitlab({
      graphql: [[/mergeRequest\(iid: \$iid\) \{ iid title/, () => ({ currentUser: { username: "me" }, project: { fullPath: REPO, mergeRequest: null } })]],
    });
    expect((await failure(client.getChange(REPO, 404))).kind).toBe("not-found");
  });

  it("lists its commits a page at a time", async () => {
    const { client, restCalls } = fakeGitlab({
      rest: {
        [`/projects/${ENC}/merge_requests/12/commits`]: () => paged([{
          id: "3".repeat(40), short_id: "33333333", title: "Fix the thing", author_name: "Alice", authored_date: daysAgo(2), web_url: `${BASE}/${REPO}/-/commit/${"3".repeat(40)}`,
        }], { total: 29, next: "2" }),
      },
    });
    expect(await client.listChangeCommits(REPO, 12, {})).toEqual({
      items: [{ sha: "3".repeat(40), shortSha: "33333333", title: "Fix the thing", authorName: "Alice", authoredAt: NOW - 2 * 86_400_000, webUrl: `${BASE}/${REPO}/-/commit/${"3".repeat(40)}` }],
      next: "2",
      total: 29,
    });
    expect(restCalls("/commits")[0].url.searchParams.get("page")).toBe("1");
  });

  it("lists the Changes tab's files with their status, line counts and GitLab's file anchor", async () => {
    const diffs = [
      { old_path: "a.ts", new_path: "a.ts", new_file: false, renamed_file: false, deleted_file: false, diff: "@@" },
      { old_path: "b.ts", new_path: "b.ts", new_file: true, renamed_file: false, deleted_file: false, diff: "@@" },
      { old_path: "c.ts", new_path: "c.ts", new_file: false, renamed_file: false, deleted_file: true, diff: "@@" },
      { old_path: "old/d.ts", new_path: "new/d.ts", new_file: false, renamed_file: true, deleted_file: false, diff: "" },
    ];
    const { client } = fakeGitlab({
      rest: { [`/projects/${ENC}/merge_requests/12/diffs`]: () => paged(diffs, { total: 112, next: "2" }) },
      graphql: [[/diffStats \{/, () => ({ project: { mergeRequest: { diffStats: [
        { path: "a.ts", additions: 5, deletions: 2 }, { path: "b.ts", additions: 40, deletions: 0 },
        { path: "c.ts", additions: 0, deletions: 12 }, { path: "new/d.ts", additions: 1, deletions: 1 },
      ] } } })]],
    });
    const page = await client.listChangeFiles(REPO, 12, {});
    const anchor = (p: string) => `${BASE}/${REPO}/-/merge_requests/12/diffs#${createHash("sha1").update(p).digest("hex")}`;
    expect(page).toEqual({
      items: [
        { path: "a.ts", oldPath: null, status: "modified", additions: 5, deletions: 2, webUrl: anchor("a.ts") },
        { path: "b.ts", oldPath: null, status: "added", additions: 40, deletions: 0, webUrl: anchor("b.ts") },
        { path: "c.ts", oldPath: null, status: "deleted", additions: 0, deletions: 12, webUrl: anchor("c.ts") },
        { path: "new/d.ts", oldPath: "old/d.ts", status: "renamed", additions: 1, deletions: 1, webUrl: anchor("new/d.ts") },
      ],
      next: "2",
      total: 112,
    });
  });

  it("lists the files from diffStats alone on a GitLab without /diffs", async () => {
    const stats = Array.from({ length: 35 }, (_, i) => ({ path: `f${i}.ts`, additions: i, deletions: 0 }));
    const { client } = fakeGitlab({
      rest: { [`/projects/${ENC}/merge_requests/12/diffs`]: () => jsonRes({ error: "404 Not Found" }, 404) },
      graphql: [[/diffStats \{/, () => ({ project: { mergeRequest: { diffStats: stats } } })]],
    });
    const page = await client.listChangeFiles(REPO, 12, { cursor: "2" });
    expect(page.total).toBe(35);
    expect(page.next).toBeNull();
    expect(page.items.map((f: Json) => f.path)).toEqual(["f30.ts", "f31.ts", "f32.ts", "f33.ts", "f34.ts"]);
  });
});

// ── pipelines ───────────────────────────────────────────────────────────

function job(id: number, name: string, status: string, stage: string, extra: Json = {}) {
  return {
    id: `gid://gitlab/Ci::Build/${id}`, name, status, allowFailure: false, startedAt: daysAgo(1), finishedAt: daysAgo(1),
    duration: 61.6, webPath: `/${REPO}/-/jobs/${id}`, stage: { name: stage }, ...extra,
  };
}

function pipelineNode(id: string, status: string, jobs: Json[], stages: string[], extra: Json = {}) {
  return {
    id: `gid://gitlab/Ci::Pipeline/${id}`, iid: "9", status, source: "push", ref: "main", sha: "4".repeat(40),
    createdAt: daysAgo(1), startedAt: daysAgo(1), finishedAt: null, duration: 388, path: `/${REPO}/-/pipelines/${id}`,
    commit: { title: "Merge branch feature/x" }, user: gUser("bob", 2),
    stages: { nodes: stages.map(name => ({ name })) },
    jobs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: jobs },
    ...extra,
  };
}

describe("pipelines", () => {
  it("maps every GitLab status to the panel's states", () => {
    expect(Object.fromEntries([
      "created", "waiting_for_resource", "preparing", "pending", "running", "success", "failed", "canceled", "skipped",
      "manual", "scheduled", "CANCELING", "WAITING_FOR_CALLBACK", "SUCCESS",
    ].map(s => [s, gitlabCiState(s)]))).toEqual({
      created: "pending", waiting_for_resource: "pending", preparing: "pending", pending: "pending", running: "running",
      success: "success", failed: "failed", canceled: "canceled", skipped: "skipped", manual: "manual",
      scheduled: "pending", CANCELING: "canceled", WAITING_FOR_CALLBACK: "pending", SUCCESS: "success",
    });
    expect(gitlabCiState(null)).toBe("none");
    expect(gitlabCiState("something_new")).toBe("none");
  });

  it("says why a job failed in words", () => {
    expect(humanFailureReason("script_failure")).toBe("Script failure");
    expect(humanFailureReason("api_failure")).toBe("API failure");
    expect(humanFailureReason("ci_quota_exceeded")).toBe("CI quota exceeded");
    expect(humanFailureReason("")).toBeNull();
  });

  it("opens a pipeline with its jobs in stage order, each failure's reason, and bridges without a log", async () => {
    const node = pipelineNode("900", "FAILED", [
      job(5, "deploy", "MANUAL", "deploy"),
      job(3, "test 10", "FAILED", "test"),
      job(2, "test 2", "SUCCESS", "test"),
      job(1, "build", "SUCCESS", "build"),
      { ...job(6, "downstream", "FAILED", "deploy"), id: "gid://gitlab/Ci::Bridge/6", webPath: null },
    ], ["build", "test", "deploy"]);
    const { client, restCalls } = fakeGitlab({
      rest: {
        [`/projects/${ENC}/pipelines/900/jobs`]: (u) => {
          expect(u.searchParams.getAll("scope[]")).toEqual(["failed"]);
          return [{ id: 3, status: "failed", failure_reason: "script_failure" }];
        },
        [`/projects/${ENC}/pipelines/900/bridges`]: () => [{ id: 6, status: "failed", failure_reason: "downstream_pipeline_creation_failed" }],
      },
      graphql: [[/pipeline\(id: \$id\)/, (v) => {
        expect(v).toEqual({ p: REPO, id: "gid://gitlab/Ci::Pipeline/900" });
        return { project: { pipeline: node } };
      }]],
    });
    const p = await client.getPipeline(REPO, 900);
    expect(p).toMatchObject({
      id: "900", repo: REPO, ref: "main", sha: "4".repeat(40), shortSha: "44444444", title: "Merge branch feature/x",
      state: "failed", source: "push", durationSec: 388, finishedAt: null, webUrl: `${BASE}/${REPO}/-/pipelines/900`,
      triggeredBy: { login: "bob", avatarUrl: `${BASE}/uploads/-/system/user/avatar/2/avatar.png` },
    });
    expect(p.jobs.map((j: Json) => j.name)).toEqual(["build", "test 2", "test 10", "deploy", "downstream"]);
    expect(p.jobs[2]).toEqual({
      id: "3", name: "test 10", stage: "test", state: "failed", allowFailure: false, startedAt: NOW - 86_400_000,
      finishedAt: NOW - 86_400_000, durationSec: 62, webUrl: `${BASE}/${REPO}/-/jobs/3`, failureReason: "Script failure",
      annotations: [], logAvailable: true,
    });
    expect(p.jobs[3]).toMatchObject({ state: "manual", failureReason: null });
    expect(p.jobs[4]).toMatchObject({ id: "6", state: "failed", failureReason: "Downstream pipeline creation failed", logAvailable: false, webUrl: null });
    expect(restCalls("/pipelines/900/")).toHaveLength(2);
  });

  it("asks REST nothing for a pipeline without failed jobs, and is not-found for one that is gone", async () => {
    const { client, restCalls } = fakeGitlab({
      graphql: [[/pipeline\(id: \$id\)/, (v) => ({
        project: { pipeline: v.id.endsWith("/1") ? pipelineNode("1", "SUCCESS", [job(1, "build", "SUCCESS", "build")], ["build"]) : null },
      })]],
    });
    expect((await client.getPipeline(REPO, 1)).jobs).toHaveLength(1);
    expect(restCalls("/pipelines/")).toHaveLength(0);
    expect((await failure(client.getPipeline(REPO, 2))).kind).toBe("not-found");
  });

  it("lists a merge request's pipelines with their jobs", async () => {
    const { client } = fakeGitlab({
      graphql: [[/mergeRequest\(iid: \$iid\) \{ pipelines/, () => ({ project: { mergeRequest: { pipelines: { nodes: [
        pipelineNode("31", "RUNNING", [job(1, "build", "RUNNING", "build")], ["build"], { source: "merge_request_event", ref: "refs/merge-requests/12/head" }),
        pipelineNode("30", "CANCELED", [job(2, "build", "CANCELED", "build")], ["build"]),
      ] } } } })]],
    });
    const list = await client.listChangePipelines(REPO, 12);
    expect(list.map((p: Json) => [p.id, p.state, p.source, p.jobs.length])).toEqual([
      ["31", "running", "merge_request_event", 1], ["30", "canceled", "push", 1],
    ]);
  });

  it("lists a project's pipelines with GraphQL's cursor and count", async () => {
    const { client, gqlCalls } = fakeGitlab({
      graphql: [[/pipelines\(first: 20, after: \$after\) \{ count/, () => ({ project: { pipelines: {
        count: 9937, pageInfo: { hasNextPage: true, endCursor: "eyJpZCI6IjkwMCJ9" },
        nodes: [pipelineNode("900", "SUCCESS", [], [])],
      } } })]],
    });
    const page = await client.listPipelines({ repo: REPO, cursor: "eyJpZCI6IjkyMCJ9" });
    expect(page.total).toBe(9937);
    expect(page.next).toBe("eyJpZCI6IjkwMCJ9");
    expect(page.items[0]).toMatchObject({ id: "900", repo: REPO, state: "success", title: "Merge branch feature/x", durationSec: 388 });
    expect(gqlCalls(/pipelines\(first/)[0].variables).toEqual({ p: REPO, after: "eyJpZCI6IjkyMCJ9" });
  });

  it("merges the latest pipelines of the most recent projects by time, page after page", async () => {
    // Project A ran at hours 1, 3, 5 …; project B at 2, 4, 6 … (hours ago).
    const pipes = (project: string, first: number, count: number) => Array.from({ length: count }, (_, i) => {
      const hours = first + i * 2;
      const id = project === "A" ? 1000 - i : 2000 - i;
      return { cursor: `${project}${i}`, node: pipelineNode(String(id), "SUCCESS", [], [], { createdAt: new Date(NOW - hours * 3_600_000).toISOString() }) };
    });
    const all = { "group/a": pipes("A", 1, 30), "group/sub/b": pipes("B", 2, 30) } as Record<string, Json[]>;
    const answer = (path: string, after: string | null) => {
      const list = all[path];
      const start = after ? list.findIndex(e => e.cursor === after) + 1 : 0;
      const edges = list.slice(start, start + 20);
      return { pipelines: { pageInfo: { hasNextPage: start + 20 < list.length }, edges } };
    };
    const { client, gqlCalls } = fakeGitlab({
      rest: {
        "/projects": (u) => {
          expect(Object.fromEntries(u.searchParams)).toMatchObject({ membership: "true", order_by: "last_activity_at", per_page: "10" });
          return [{ id: 1, path_with_namespace: "group/a" }, { id: 2, path_with_namespace: "group/sub/b" }];
        },
      },
      graphql: [
        [/projects\(ids: \$ids/, (v) => {
          expect(v.ids).toEqual(["gid://gitlab/Project/1", "gid://gitlab/Project/2"]);
          return { projects: { nodes: [{ id: "gid://gitlab/Project/2", fullPath: "group/sub/b" }, { id: "gid://gitlab/Project/1", fullPath: "group/a" }] } };
        }],
        [/a0: project\(fullPath: \$p0\)/, (v) => ({ a0: answer(v.p0, v.c0), ...(v.p1 ? { a1: answer(v.p1, v.c1) } : {}) })],
      ],
    });
    const one = await client.listPipelines({});
    expect(one.total).toBeNull();
    expect(one.items.map((p: Json) => p.repo)).toEqual(Array.from({ length: 20 }, (_, i) => (i % 2 ? "group/sub/b" : "group/a")));
    expect(one.items.every((p: Json, i: number) => i === 0 || one.items[i - 1].createdAt > p.createdAt)).toBe(true);
    // Each project still able to give more, by id, after the last row taken.
    expect(one.next).toBe("m:1.A9:2.B9");
    expect(one.next.length).toBeLessThan(512);
    const two = await client.listPipelines({ cursor: one.next });
    expect(two.items[0].createdAt).toBeLessThan(one.items[19].createdAt);
    expect(two.items.map((p: Json) => p.id)).toEqual(Array.from({ length: 20 }, (_, i) => String(i % 2 ? 2000 - 10 - (i >> 1) : 1000 - 10 - (i >> 1))));
    expect(gqlCalls(/a0: project/)[1].variables).toMatchObject({ c0: "A9", c1: "B9" });
  });

  it("reads the end of a job's log, clean, with the job's page", async () => {
    const { client, calls } = fakeGitlab({
      rest: {
        [`/projects/${ENC}/jobs/313694/trace`]: () => new Response("one\n\x1b[31mERROR boom\x1b[0m\nsection_end:1700000001:step_script\r\x1b[0K\n", { status: 200, headers: { "content-type": "text/plain" } }),
      },
    });
    expect(await client.jobLogTail(REPO, "313694", { lines: 80 })).toEqual({
      lines: ["one", "ERROR boom"], truncated: false, webUrl: `${BASE}/${REPO}/-/jobs/313694`,
    });
    expect(calls[0].headers.range).toMatch(/^bytes=-/);
  });
});

// ── issues ──────────────────────────────────────────────────────────────

function restIssue(iid: number, extra: Json = {}) {
  return {
    id: 5000 + iid, iid, project_id: 41, title: `Issue ${iid}`, state: "opened", created_at: daysAgo(4), updated_at: daysAgo(1), closed_at: null,
    labels: [{ name: "bug", color: "#dc143c" }], milestone: { title: "Sprint 9", web_url: `${BASE}/${REPO}/-/milestones/9` },
    assignees: [user("me", 9)], author: user("alice", 1), user_notes_count: 2, type: "ISSUE",
    web_url: `${BASE}/${REPO}/-/issues/${iid}`, references: { full: `${REPO}#${iid}` }, _links: { closed_as_duplicate_of: null },
    ...extra,
  };
}

const ref = (iid: string, title: string, state: string, type: string, path = REPO) => ({
  iid, title, state, webUrl: `${BASE}/${path}/-/work_items/${iid}`, reference: `${path}#${iid}`, workItemType: { name: type },
});

describe("issues", () => {
  it("lists the issues assigned to the user with their child tasks and parent", async () => {
    const { client, restCalls, gqlCalls } = fakeGitlab({
      rest: { "/issues": () => paged([restIssue(3), restIssue(4, { state: "closed", _links: { closed_as_duplicate_of: `${BASE}/x` } })], { total: 6 }) },
      graphql: [[/projects\(fullPaths: \$paths/, () => ({ projects: { nodes: [{
        fullPath: REPO,
        issues: { nodes: [{ iid: "3", titleHtml: "<p>Issue 3</p>" }, { iid: "4", titleHtml: "<p>Issue 4</p>" }] },
        workItems: { nodes: [
          { iid: "3", widgets: [{ type: "ASSIGNEES" }, { type: "HIERARCHY", parent: null, children: { count: 3, nodes: [{ state: "CLOSED" }, { state: "OPEN" }, { state: "CLOSED" }] } }] },
          { iid: "4", widgets: [{ type: "HIERARCHY", parent: ref("1", "Parent", "OPEN", "Issue"), children: { count: 0, nodes: [] } }] },
        ] },
      }] } })]],
    });
    const page = await client.listIssues({ state: "open" });
    expect(Object.fromEntries(restCalls("/issues")[0].url.searchParams)).toMatchObject({ scope: "assigned_to_me", state: "opened", with_labels_details: "true" });
    expect(page.total).toBe(6);
    expect(page.items[0]).toEqual({
      kind: "gitlab", key: `${REPO}#3`, number: 3, repo: REPO, title: "Issue 3", titleHtml: "<p>Issue 3</p>", state: "open", stateReason: null,
      webUrl: `${BASE}/${REPO}/-/issues/3`, author: expect.objectContaining({ login: "alice" }), assignees: [expect.objectContaining({ login: "me" })],
      labels: [{ name: "bug", color: "#dc143c" }], milestone: { title: "Sprint 9", webUrl: `${BASE}/${REPO}/-/milestones/9` },
      createdAt: NOW - 4 * 86_400_000, updatedAt: NOW - 86_400_000, closedAt: null, comments: 2,
      children: { total: 3, completed: 2 }, parent: null,
    });
    expect(page.items[1]).toMatchObject({
      state: "closed", stateReason: "duplicate", children: null,
      parent: { key: `${REPO}#1`, number: 1, repo: REPO, title: "Parent", state: "open", webUrl: `${BASE}/${REPO}/-/work_items/1`, type: "Issue" },
    });
    expect(gqlCalls(/projects\(fullPaths/)).toHaveLength(1);
  });

  it("drops the work-item part on an instance that does not have it, and filters by project", async () => {
    const { client, gqlCalls, restCalls } = fakeGitlab({
      rest: { [`/projects/${ENC}/issues`]: () => paged([restIssue(3)], { total: 1 }) },
      graphql: [[/projects\(fullPaths: \$paths/, (_v, q) => (/workItems/.test(q)
        ? jsonRes({ errors: [{ message: "Field 'workItems' doesn't exist on type 'Project'" }] })
        : { projects: { nodes: [{ fullPath: REPO, issues: { nodes: [{ iid: "3", titleHtml: "<p>Issue 3</p>" }] } }] } })]],
    });
    const page = await client.listIssues({ repo: REPO, state: "closed" });
    expect(page.items[0]).toMatchObject({ titleHtml: "<p>Issue 3</p>", children: null, parent: null });
    expect(gqlCalls(/projects\(fullPaths/)).toHaveLength(2);
    expect(restCalls(`/projects/${ENC}/issues`)[0].url.searchParams.get("state")).toBe("closed");
  });

  it("opens an issue with its description, label colours and child tasks", async () => {
    const { client } = fakeGitlab({
      rest: { [`/projects/${ENC}/issues/3`]: () => restIssue(3, { labels: ["bug"] }) },
      graphql: [[/issue\(iid: \$iid\) \{ titleHtml descriptionHtml/, () => ({
        project: { issue: { titleHtml: "<p>Issue 3</p>", descriptionHtml: "<p>Steps</p>", labels: { nodes: [{ title: "bug", color: "#dc143c" }] } } },
        namespace: { workItem: { iid: "3", widgets: [{ type: "HIERARCHY", parent: null, children: { count: 2, nodes: [ref("8", "Task one", "CLOSED", "Task"), ref("9", "Task two", "OPEN", "Task")] } }] } },
      })]],
    });
    const issue = await client.getIssue(REPO, 3);
    expect(issue).toMatchObject({
      key: `${REPO}#3`, descriptionHtml: "<p>Steps</p>", labels: [{ name: "bug", color: "#dc143c" }],
      children: { total: 2, completed: 1 }, parent: null,
    });
    expect(issue.childItems).toEqual([
      { key: `${REPO}#8`, number: 8, repo: REPO, title: "Task one", state: "closed", webUrl: `${BASE}/${REPO}/-/work_items/8`, type: "Task" },
      { key: `${REPO}#9`, number: 9, repo: REPO, title: "Task two", state: "open", webUrl: `${BASE}/${REPO}/-/work_items/9`, type: "Task" },
    ]);
  });

  it("lists an issue's comments without its system notes", async () => {
    const { client, gqlCalls } = fakeGitlab({
      graphql: [[/notes\(filter: ONLY_COMMENTS/, () => ({ project: { issue: { userNotesCount: 3, notes: {
        pageInfo: { hasNextPage: true, endCursor: "NC1" },
        nodes: [note(1, "alice"), note(2, "bob", { system: true }), note(3, "carol")],
      } } } })]],
    });
    const page = await client.listIssueComments(REPO, 3, { cursor: "NC0" });
    expect(page.items.map((c: Json) => c.id)).toEqual(["1", "3"]);
    expect(page.items[0].author.avatarUrl).toBe(`${BASE}/uploads/-/system/user/avatar/1/avatar.png`);
    expect(page).toMatchObject({ next: "NC1", total: 3 });
    expect(gqlCalls(/notes/)[0].variables).toEqual({ p: REPO, iid: "3", after: "NC0" });
  });
});

// ── URLs ────────────────────────────────────────────────────────────────

describe("an instance under a path", () => {
  it("asks under the path and makes GitLab's paths absolute without doubling it", async () => {
    const base = "https://code.example.com/gitlab";
    const { client, calls } = fakeGitlab({
      base,
      rest: {
        "/merge_requests": () => paged([{
          ...restMr(12), web_url: `${base}/${REPO}/-/merge_requests/12`, references: { full: `${REPO}!12` },
          author: { username: "alice", name: "Alice", avatar_url: "/gitlab/uploads/-/system/user/avatar/1/a.png", web_url: `${base}/alice` },
          reviewers: [], assignees: [],
        }], { total: 1 }),
      },
      graphql: [[/projects\(fullPaths: \$paths/, () => ({
        currentUser: { username: "me" },
        projects: { nodes: [{ fullPath: REPO, mergeRequests: { nodes: [enrichedMr("12", { headPipeline: { status: "SUCCESS", path: `/gitlab/${REPO}/-/pipelines/5` } })] } }] },
      })]],
    });
    expect(client.allowedOrigins).toEqual(["https://code.example.com"]);
    const page = await client.listChanges({});
    expect(calls[0].url.href.startsWith(`${base}/api/`)).toBe(true);
    expect(page.items[0].author.avatarUrl).toBe("https://code.example.com/gitlab/uploads/-/system/user/avatar/1/a.png");
    expect(page.items[0].ci.webUrl).toBe(`${base}/${REPO}/-/pipelines/5`);
    expect(await client.resolveRef(`${base}/${REPO}/-/issues/4`)).toEqual({ type: "issue", repo: REPO, number: 4 });
    expect(await client.resolveRef(`https://code.example.com/${REPO}/-/issues/4`)).toBeNull();
  });
});

describe("a pasted URL or key", () => {
  const { client, calls } = fakeGitlab();

  it.each([
    [`${BASE}/${REPO}/-/merge_requests/5093`, { type: "change", repo: REPO, number: 5093 }],
    [`${BASE}/group/sub/project/-/merge_requests/12/diffs?view=inline#note_1`, { type: "change", repo: "group/sub/project", number: 12 }],
    [`${BASE}/${REPO}/-/issues/7`, { type: "issue", repo: REPO, number: 7 }],
    [`${BASE}/${REPO}/-/work_items/8`, { type: "issue", repo: REPO, number: 8 }],
    [`${BASE}/${REPO}/merge_requests/3`, { type: "change", repo: REPO, number: 3 }],
    [`  ${REPO}!5093 `, { type: "change", repo: REPO, number: 5093 }],
    ["group/sub/project#12", { type: "issue", repo: "group/sub/project", number: 12 }],
  ])("reads %s", async (input, target) => {
    expect(await client.resolveRef(input)).toEqual(target);
  });

  it.each([
    "https://elsewhere.example.org/group/project/-/merge_requests/1",
    `${BASE}/${REPO}/-/pipelines/1`,
    `${BASE}/${REPO}`,
    `${BASE}/${REPO}/-/merge_requests/0`,
    "!12",
    "project#12",
    "group/project&3",
    "not a url",
    "",
  ])("finds nothing in %j", async (input) => {
    expect(await client.resolveRef(input)).toBeNull();
  });

  it("asks the forge nothing", () => {
    expect(calls).toEqual([]);
  });
});
