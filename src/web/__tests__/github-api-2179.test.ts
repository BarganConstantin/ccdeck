// #2179: the GitHub panel reads GitHub through src/server/github-api.mjs, which
// turns GitHub's answers into the shapes in src/web/forge-types.ts.
//
// What these pin, each against a fixture trimmed from a real answer (personal
// data replaced): every method's request and its mapping; the token going only
// to the API origin (and not to the blob host a job log redirects to); the
// ahead/behind DIRECTION, which GitHub's Ref.compare turns around depending on
// which ref it is asked on; the branch list sorted by last commit here, because
// GitHub cannot; every check/run/rollup state's CiState; reviewer states and
// approval with and without a review rule; the cursors (GraphQL end cursors,
// REST page numbers, offsets, and the merged runs list's time-and-ids cursor);
// a failed job's reason and annotations; a job log without timestamps, group
// markers or the runner's post-job housekeeping; the retry without newer fields
// for an older Enterprise server; ForgeErrors leaving as they came; and what a
// pasted URL or key resolves to.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cleanGithubLogLine, createGithubClient, githubCheckState, githubRollupState,
  // @ts-expect-error — plain JS module, no types
} from "../../server/github-api.mjs";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const API = "https://api.github.com";
const GQL = `${API}/graphql`;

type Req = { url: string; method: string; headers: Record<string, string>; query: string; variables: Record<string, any> };
type Handler = (req: Req) => Response | undefined;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const gqlData = (data: unknown, errors?: unknown[]) => json(errors ? { data, errors } : { data });

/** A client over a fake fetch. The handler sees each request with its
 *  GraphQL query and variables parsed out; anything it does not answer fails
 *  the test, so an unexpected call is caught. */
function client(handler: Handler, opts: Record<string, unknown> = {}) {
  const calls: Req[] = [];
  const fetchImpl = async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
    const parsed = init.body ? JSON.parse(init.body) : {};
    const req = { url, method: init.method ?? "GET", headers: init.headers, query: parsed.query ?? "", variables: parsed.variables ?? {} };
    calls.push(req);
    const res = handler(req);
    if (!res) throw new Error(`unexpected ${req.method} ${url} ${req.query.slice(0, 120)}`);
    return res;
  };
  const c = createGithubClient({ token: "ghp_TEST", fetchImpl, now: () => NOW, ...opts });
  return { c, calls };
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as { kind: string; status?: number; message: string; name: string };
  }
  throw new Error("expected a failure");
}

const actor = (login: string) => ({ login, avatarUrl: `https://avatars.example/${login}`, url: `https://github.com/${login}`, name: login.toUpperCase() });
const sha = (c: string) => c.repeat(40);

// ─── States ─────────────────────────────────────────────────────────────────

describe("CI states", () => {
  it("maps every check run / Actions run status and conclusion, in either case", () => {
    const done = (c: string) => githubCheckState("completed", c);
    expect(done("success")).toBe("success");
    expect(done("FAILURE")).toBe("failed");
    expect(done("timed_out")).toBe("failed");
    expect(done("STARTUP_FAILURE")).toBe("failed");
    expect(done("cancelled")).toBe("canceled");
    expect(done("STALE")).toBe("canceled");
    expect(done("skipped")).toBe("skipped");
    expect(done("NEUTRAL")).toBe("skipped");
    expect(done("action_required")).toBe("manual");
    expect(done("")).toBe("none");
    expect(githubCheckState("QUEUED", null)).toBe("pending");
    expect(githubCheckState("requested", null)).toBe("pending");
    expect(githubCheckState("PENDING", null)).toBe("pending");
    expect(githubCheckState("IN_PROGRESS", null)).toBe("running");
    expect(githubCheckState("waiting", null)).toBe("manual");
    expect(githubCheckState(null, null)).toBe("none");
  });

  it("maps the head commit's rollup and a commit status", () => {
    expect(githubRollupState("SUCCESS")).toBe("success");
    expect(githubRollupState("FAILURE")).toBe("failed");
    expect(githubRollupState("ERROR")).toBe("failed");
    expect(githubRollupState("PENDING")).toBe("pending");
    expect(githubRollupState("EXPECTED")).toBe("pending");
    expect(githubRollupState("pending")).toBe("pending");
    expect(githubRollupState(undefined)).toBe("none");
  });
});

// ─── Connection ─────────────────────────────────────────────────────────────

describe("the connection", () => {
  const user = { id: 1001, login: "alice", name: "Alice A", avatar_url: "https://avatars.example/alice", html_url: "https://github.com/alice" };

  it("sends the token to the API only, and says the API's origins", async () => {
    const { c, calls } = client(() => json(user, 200, { "x-oauth-scopes": "admin:public_key, gist, read:org, repo" }));
    expect(c.allowedOrigins).toEqual(["https://api.github.com"]);
    const v = await c.validate();
    expect(calls[0].url).toBe(`${API}/user`);
    expect(calls[0].headers.authorization).toBe("Bearer ghp_TEST");
    expect(calls[0].headers["x-github-api-version"]).toBe("2022-11-28");
    expect(v).toEqual({
      account: { id: "1001", login: "alice", name: "Alice A", avatarUrl: "https://avatars.example/alice", webUrl: "https://github.com/alice" },
      meta: { scopes: ["admin:public_key", "gist", "read:org", "repo"] },
    });
  });

  it("warns about a classic token without repo or read:org", async () => {
    const { c } = client(() => json(user, 200, { "x-oauth-scopes": "public_repo" }));
    const v = await c.validate();
    expect(v.meta.scopes).toEqual(["public_repo"]);
    expect(v.meta.warnings).toHaveLength(2);
    expect(v.meta.warnings[0]).toMatch(/private repositories are hidden/);
    expect(v.meta.warnings[1]).toMatch(/read:org/);
  });

  it("says nothing about scopes for a fine-grained token, which sends none", async () => {
    const { c } = client(() => json(user));
    const v = await c.validate();
    expect(v.meta).toEqual({});
    expect("scopes" in v.meta).toBe(false);
  });

  it("reads an Enterprise server at its own /api/v3 and /api/graphql, with its version", async () => {
    const { c, calls } = client((req) => {
      if (req.url === "https://ghe.example.com/api/v3/user") return json(user, 200, { "x-github-enterprise-version": "3.14.2" });
      if (req.url === "https://ghe.example.com/api/graphql") return gqlData({ viewer: { repositories: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
      return undefined;
    }, { baseUrl: "https://ghe.example.com/" });
    expect(c.allowedOrigins).toEqual(["https://ghe.example.com"]);
    expect((await c.validate()).meta.serverVersion).toBe("3.14.2");
    await c.listRepos();
    expect(calls.map(x => x.headers.authorization)).toEqual(["Bearer ghp_TEST", "Bearer ghp_TEST"]);
  });

  it("lets the transport's errors leave as they came", async () => {
    const { c } = client(() => json({ message: "Bad credentials" }, 401));
    expect(await failure(c.validate())).toMatchObject({ name: "ForgeError", kind: "auth", status: 401, message: "Bad credentials" });
    const limited = client(() => json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 60) }));
    expect(await failure(limited.c.listPipelines({ repo: "octo-org/widgets" }))).toMatchObject({ kind: "rate-limit" });
    const gqlFail = client(() => json({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user" }] }));
    expect(await failure(gqlFail.c.countChanges({ filter: "all" }))).toMatchObject({ kind: "rate-limit" });
  });
});

// ─── Repositories ───────────────────────────────────────────────────────────

describe("repositories", () => {
  const repo = (path: string, pushedAt: string) => ({
    databaseId: path.length, nameWithOwner: path, name: path.split("/")[1], url: `https://github.com/${path}`,
    defaultBranchRef: { name: "main" }, pushedAt, isArchived: false,
  });
  const page = (nodes: unknown[], next: string | null) =>
    gqlData({ viewer: { repositories: { totalCount: 72, pageInfo: { hasNextPage: !!next, endCursor: next }, nodes } } });

  it("lists the viewer's repositories, most recently pushed first, with the cursor GitHub gave", async () => {
    const { c, calls } = client(() => page([repo("octo-org/widgets", "2026-10-19T10:00:00Z")], "Y3Vyc29yOjMw"));
    const p = await c.listRepos({ cursor: "Y3Vyc29yOjA=" });
    expect(calls[0].variables).toEqual({ first: 30, after: "Y3Vyc29yOjA=" });
    expect(calls[0].query).toMatch(/PUSHED_AT/);
    expect(calls[0].query).toMatch(/ORGANIZATION_MEMBER/);
    expect(p).toEqual({
      items: [{ id: "16", path: "octo-org/widgets", name: "widgets", webUrl: "https://github.com/octo-org/widgets", defaultBranch: "main", lastActivityAt: Date.parse("2026-10-19T10:00:00Z"), archived: false }],
      next: "Y3Vyc29yOjMw",
      total: 72,
    });
  });

  it("filters by a case-insensitive piece of the path, reading pages until there is a page's worth", async () => {
    const first = [repo("alice/notes", "2026-10-19T10:00:00Z"), repo("octo-org/Widgets-API", "2026-10-18T10:00:00Z")];
    const second = [repo("alice/widgets", "2026-10-01T10:00:00Z")];
    const { c, calls } = client((req) => req.variables.after == null ? page(first, "P1") : page(second, null));
    const p = await c.listRepos({ search: "WIDGETS" });
    expect(calls.map(x => x.variables.first)).toEqual([100, 100]);
    expect(p.items.map((r: { path: string }) => r.path)).toEqual(["octo-org/Widgets-API", "alice/widgets"]);
    expect(p.next).toBeNull();
    expect(p.total).toBeNull();
  });
});

// ─── Branches ───────────────────────────────────────────────────────────────

describe("branches", () => {
  // The scan answers in GitHub's alphabetical order; the panel wants the most
  // recent commit first.
  const scanRefs = [
    { name: "feat/old", target: { committedDate: "2026-06-01T00:00:00Z" } },
    { name: "feat/recent", target: { committedDate: "2026-10-18T09:00:00Z" } },
    { name: "main", target: { committedDate: "2026-10-17T09:00:00Z" } },
  ];
  const ref = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    branchProtectionRule: null,
    rules: { totalCount: 0 },
    target: {
      oid: sha("a"), abbreviatedOid: "aaaaaaa", messageHeadline: `work on ${name}`, committedDate: "2026-10-18T09:00:00Z",
      author: { name: "Alice A" }, url: `https://github.com/octo-org/widgets/commit/${sha("a")}`, statusCheckRollup: { state: "FAILURE" },
    },
    associatedPullRequests: { nodes: [] },
    ...extra,
  });

  function branchApi(refsDetail: Record<string, unknown>) {
    return client((req) => {
      if (req.url !== GQL) return undefined;
      if (/refs\(refPrefix/.test(req.query)) {
        return gqlData({ repository: { defaultBranchRef: { name: "main" }, refs: { totalCount: 3, pageInfo: { hasNextPage: false, endCursor: "Mw" }, nodes: scanRefs } } });
      }
      if (/fragment Branch on Ref/.test(req.query)) return gqlData({ repository: refsDetail });
      return undefined;
    });
  }

  it("sorts by last commit, and reads ahead/behind the right way round from a compare asked on the branch", async () => {
    const { c, calls } = branchApi({
      // Asked on the branch with the default branch as head: the BRANCH is the
      // base, so GitHub's aheadBy (2437) is the default branch's lead — this
      // branch is 2 ahead and 2437 behind (REST compare main...branch agrees).
      b0: { ...ref("feat/recent"), compare: { aheadBy: 2437, behindBy: 2 } },
      b1: {
        ...ref("main", { branchProtectionRule: { id: "BPR_1" } }),
        compare: { aheadBy: 0, behindBy: 0 },
        target: { ...ref("main").target, statusCheckRollup: { state: "SUCCESS" } },
      },
      b2: {
        ...ref("feat/old", {
          rules: { totalCount: 1 },
          target: { ...ref("x").target, committedDate: "2026-06-01T00:00:00Z", statusCheckRollup: null },
          associatedPullRequests: { nodes: [{ number: 12, isDraft: true, url: "https://github.com/octo-org/widgets/pull/12", reviewDecision: "APPROVED", latestReviews: { nodes: [] }, repository: { nameWithOwner: "octo-org/widgets" } }] },
        }),
        compare: { aheadBy: 5, behindBy: 1 },
      },
    });
    const p = await c.listBranches("octo-org/widgets");
    const detail = calls[1];
    expect(detail.variables).toMatchObject({ owner: "octo-org", name: "widgets", base: "main", q0: "refs/heads/feat/recent", q1: "refs/heads/main", q2: "refs/heads/feat/old" });
    expect(p.items.map((b: { name: string }) => b.name)).toEqual(["feat/recent", "main", "feat/old"]);
    expect(p.total).toBe(3);
    expect(p.next).toBeNull();

    const [recent, main, old] = p.items;
    expect(recent).toMatchObject({ ahead: 2, behind: 2437, isDefault: false, protected: false, stale: false, change: null });
    expect(recent.webUrl).toBe("https://github.com/octo-org/widgets/tree/feat/recent");
    expect(recent.ci).toEqual({ state: "failed", webUrl: `https://github.com/octo-org/widgets/commit/${sha("a")}/checks` });
    expect(recent.commit).toEqual({
      sha: sha("a"), shortSha: "aaaaaaa", title: "work on feat/recent", committedAt: Date.parse("2026-10-18T09:00:00Z"),
      authorName: "Alice A", webUrl: `https://github.com/octo-org/widgets/commit/${sha("a")}`,
    });
    // The default branch has nothing to be ahead of.
    expect(main).toMatchObject({ isDefault: true, protected: true, ahead: null, behind: null, ci: { state: "success" } });
    // An active ruleset protects; a last commit 140 days old is stale.
    expect(old).toMatchObject({ protected: true, stale: true, ci: null, ahead: 1, behind: 5 });
    expect(old.change).toEqual({ number: 12, key: "octo-org/widgets#12", state: "open", draft: true, approved: true, webUrl: "https://github.com/octo-org/widgets/pull/12" });
  });

  it("pages by offset over one sorted scan, and does not scan again for a later page", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `b${String(i).padStart(2, "0")}`, target: { committedDate: new Date(NOW - i * 60_000).toISOString() } }));
    let scans = 0;
    const { c, calls } = client((req) => {
      if (/refs\(refPrefix/.test(req.query)) {
        scans++;
        return gqlData({ repository: { defaultBranchRef: { name: "b00" }, refs: { totalCount: 25, pageInfo: { hasNextPage: false, endCursor: null }, nodes: many } } });
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(req.variables)) if (/^q\d+$/.test(k)) out[`b${k.slice(1)}`] = { ...ref(String(v).replace("refs/heads/", "")), compare: { aheadBy: 0, behindBy: 1 } };
      return gqlData({ repository: out });
    });
    const first = await c.listBranches("octo-org/widgets");
    expect(first.items).toHaveLength(20);
    expect(first.next).toBe("20");
    const second = await c.listBranches("octo-org/widgets", { cursor: first.next });
    expect(second.items.map((b: { name: string }) => b.name)).toEqual(["b20", "b21", "b22", "b23", "b24"]);
    expect(second.next).toBeNull();
    expect(scans).toBe(1);
    expect(calls).toHaveLength(3);
  });

  it("reads one branch with its commits ahead (newest first) and its head's latest run", async () => {
    const { c, calls } = client((req) => {
      if (req.url === GQL && /defaultBranchRef \{ name compare/.test(req.query)) {
        return gqlData({ repository: {
          // Asked on the DEFAULT branch with this branch as head: aheadBy is
          // this branch's lead, as it reads.
          defaultBranchRef: { name: "main", compare: { aheadBy: 2, behindBy: 7, commits: { nodes: [
            { oid: sha("1"), abbreviatedOid: "1111111", messageHeadline: "first", authoredDate: "2026-10-18T08:00:00Z", author: { name: "Alice A" }, url: "https://github.com/c/1" },
            { oid: sha("2"), abbreviatedOid: "2222222", messageHeadline: "second", authoredDate: "2026-10-18T09:00:00Z", author: { name: "Alice A" }, url: "https://github.com/c/2" },
          ] } } },
          ref: ref("feat/recent"),
        } });
      }
      if (req.url.startsWith(`${API}/repos/octo-org/widgets/actions/runs?`)) {
        return json({ total_count: 1, workflow_runs: [{
          id: 555, name: "ci", display_title: "work on feat/recent", status: "completed", conclusion: "success", event: "push",
          head_branch: "feat/recent", head_sha: sha("a"), created_at: "2026-10-18T09:01:00Z", run_started_at: "2026-10-18T09:01:05Z",
          updated_at: "2026-10-18T09:05:05Z", html_url: "https://github.com/octo-org/widgets/actions/runs/555",
          triggering_actor: { login: "alice", avatar_url: "https://avatars.example/alice", html_url: "https://github.com/alice" },
          check_suite_node_id: "CS_1", repository: { full_name: "octo-org/widgets" },
        }] });
      }
      if (req.url === GQL && /node\(id: \$id\)/.test(req.query)) {
        return gqlData({ node: {
          databaseId: 9, status: "COMPLETED", conclusion: "SUCCESS", createdAt: "2026-10-18T09:01:00Z", url: null,
          app: { name: "GitHub Actions", slug: "github-actions" }, branch: { name: "feat/recent" },
          commit: { oid: sha("a"), abbreviatedOid: "aaaaaaa", messageHeadline: "work on feat/recent" },
          workflowRun: { databaseId: 555, event: "push", url: "https://github.com/octo-org/widgets/actions/runs/555", createdAt: "2026-10-18T09:01:00Z", workflow: { name: "ci" } },
          checkRuns: { totalCount: 1, nodes: [{ id: "CR_1", databaseId: 777, name: "test", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-18T09:01:10Z", completedAt: "2026-10-18T09:03:10Z", detailsUrl: "https://github.com/octo-org/widgets/actions/runs/555/job/777", url: "https://github.com/octo-org/widgets/runs/777", title: null, summary: null }] },
        } });
      }
      return undefined;
    });
    const d = await c.getBranch("octo-org/widgets", "feat/recent");
    expect(calls[0].variables).toMatchObject({ qualified: "refs/heads/feat/recent", branch: "feat/recent" });
    expect(calls[1].url).toBe(`${API}/repos/octo-org/widgets/actions/runs?head_sha=${sha("a")}&per_page=1&exclude_pull_requests=true`);
    expect(d.branch).toMatchObject({ name: "feat/recent", ahead: 2, behind: 7 });
    expect(d.commitsAhead.map((x: { title: string }) => x.title)).toEqual(["second", "first"]);
    expect(d.pipeline).toMatchObject({
      id: "555", title: "ci · work on feat/recent", state: "success", source: "push", ref: "feat/recent",
      startedAt: Date.parse("2026-10-18T09:01:05Z"), finishedAt: Date.parse("2026-10-18T09:05:05Z"), durationSec: 240,
      triggeredBy: { login: "alice", name: null, avatarUrl: "https://avatars.example/alice", webUrl: "https://github.com/alice" },
    });
    expect(d.pipeline.jobs).toEqual([{
      id: "777", name: "test", stage: null, state: "success", allowFailure: false,
      startedAt: Date.parse("2026-10-18T09:01:10Z"), finishedAt: Date.parse("2026-10-18T09:03:10Z"), durationSec: 120,
      webUrl: "https://github.com/octo-org/widgets/actions/runs/555/job/777", failureReason: null, annotations: [], logAvailable: true,
    }]);
  });

  it("says a missing repository is not-found", async () => {
    const { c } = client(() => gqlData({ repository: null }, [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository with the name 'octo-org/gone'." }]));
    expect(await failure(c.listBranches("octo-org/gone"))).toMatchObject({ kind: "not-found" });
    expect(await failure(c.listBranches("not a path"))).toMatchObject({ kind: "not-found" });
  });
});

// ─── Pull requests ──────────────────────────────────────────────────────────

const prNode = (extra: Record<string, unknown> = {}) => ({
  number: 2102,
  title: "feat: manage accounts",
  titleHTML: "feat: manage <code>accounts</code>",
  state: "OPEN",
  isDraft: false,
  url: "https://github.com/octo-org/widgets/pull/2102",
  repository: { nameWithOwner: "octo-org/widgets" },
  author: actor("alice"),
  assignees: { nodes: [{ login: "alice", name: null, avatarUrl: "https://avatars.example/alice", url: "https://github.com/alice" }] },
  reviewRequests: { nodes: [] },
  latestReviews: { nodes: [] },
  headRefName: "feat/accounts",
  baseRefName: "main",
  createdAt: "2026-10-10T10:00:00Z",
  updatedAt: "2026-10-18T10:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewDecision: null,
  labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
  comments: { totalCount: 3 },
  reviewThreads: { totalCount: 3, nodes: [
    { isResolved: true, comments: { totalCount: 2 } },
    { isResolved: false, comments: { totalCount: 1 } },
    { isResolved: false, comments: { totalCount: 1 } },
  ] },
  commits: { nodes: [{ commit: { oid: sha("b"), statusCheckRollup: { state: "PENDING" } } }] },
  ...extra,
});

const searchPage = (nodes: unknown[], next: string | null = null, count = nodes.length) =>
  gqlData({ search: { issueCount: count, pageInfo: { hasNextPage: !!next, endCursor: next }, nodes } });

describe("pull request lists", () => {
  it("asks search for each filter, state and sort", async () => {
    const { c, calls } = client(() => searchPage([]));
    await c.listChanges({ repo: "octo-org/widgets", filter: "all", state: "open", sort: "created" });
    await c.listChanges({ repo: null, filter: "all", state: "merged", sort: "updated" });
    await c.listChanges({ repo: null, filter: "mine", state: "closed", sort: "created" });
    await c.listChanges({ repo: "octo-org/widgets", filter: "review", state: "open", sort: "updated", cursor: "Y3Vyc29yOjIw" });
    expect(calls.map(x => x.variables.q)).toEqual([
      "is:pr archived:false repo:octo-org/widgets is:open sort:created-desc",
      "is:pr archived:false involves:@me is:merged sort:updated-desc",
      "is:pr archived:false author:@me is:closed is:unmerged sort:created-desc",
      "is:pr archived:false repo:octo-org/widgets user-review-requested:@me is:open sort:updated-desc",
    ]);
    expect(calls[3].variables).toMatchObject({ first: 20, after: "Y3Vyc29yOjIw" });
  });

  it("maps a row: comments, unresolved threads, checks, labels", async () => {
    const { c } = client(() => searchPage([prNode(), {}], "Y3Vyc29yOjIw", 45));
    const p = await c.listChanges({ filter: "all", state: "open", sort: "created" });
    // An item the token may not read comes back empty and is left out.
    expect(p.items).toHaveLength(1);
    expect(p.next).toBe("Y3Vyc29yOjIw");
    expect(p.total).toBe(45);
    expect(p.items[0]).toEqual({
      kind: "github",
      key: "octo-org/widgets#2102",
      number: 2102,
      repo: "octo-org/widgets",
      title: "feat: manage accounts",
      titleHtml: "feat: manage <code>accounts</code>",
      state: "open",
      draft: false,
      webUrl: "https://github.com/octo-org/widgets/pull/2102",
      author: { login: "alice", name: "ALICE", avatarUrl: "https://avatars.example/alice", webUrl: "https://github.com/alice" },
      assignees: [{ login: "alice", name: null, avatarUrl: "https://avatars.example/alice", webUrl: "https://github.com/alice" }],
      reviewers: [],
      sourceBranch: "feat/accounts",
      targetBranch: "main",
      createdAt: Date.parse("2026-10-10T10:00:00Z"),
      updatedAt: Date.parse("2026-10-18T10:00:00Z"),
      mergedAt: null,
      closedAt: null,
      comments: 3 + 2 + 1 + 1,
      unresolvedThreads: 2,
      approved: false,
      approvedByMe: false,
      approvalsRequired: null,
      approvalsLeft: null,
      ci: { state: "pending", webUrl: "https://github.com/octo-org/widgets/pull/2102/checks" },
      labels: [{ name: "bug", color: "#d73a4a" }],
    });
  });

  it("reads reviewers' states, a re-request as waiting again, and a team", async () => {
    const { c } = client(() => searchPage([prNode({
      reviewDecision: "CHANGES_REQUESTED",
      latestReviews: { nodes: [
        { state: "APPROVED", viewerDidAuthor: true, author: actor("me") },
        { state: "CHANGES_REQUESTED", viewerDidAuthor: false, author: actor("bob") },
        { state: "COMMENTED", viewerDidAuthor: false, author: { login: "copilot-pull-request-reviewer", avatarUrl: null, url: "https://github.com/apps/copilot" } },
        { state: "APPROVED", viewerDidAuthor: false, author: actor("carol") },
        { state: "DISMISSED", viewerDidAuthor: false, author: actor("dave") },
        { state: "PENDING", viewerDidAuthor: false, author: actor("erin") },
      ] },
      reviewRequests: { nodes: [
        { requestedReviewer: { __typename: "User", login: "carol", name: "Carol", avatarUrl: null, url: "https://github.com/carol" } },
        { requestedReviewer: { __typename: "Team", name: "Core", combinedSlug: "octo-org/core", avatarUrl: null, url: "https://github.com/orgs/octo-org/teams/core" } },
      ] },
    })]));
    const [row] = (await c.listChanges({ filter: "review", state: "open", sort: "updated" })).items;
    expect(row.reviewers.map((r: { login: string; state: string }) => `${r.login}:${r.state}`)).toEqual([
      "me:approved", "bob:changes_requested", "copilot-pull-request-reviewer:commented", "carol:pending", "dave:commented", "octo-org/core:pending",
    ]);
    expect(row.reviewers.at(-1)).toMatchObject({ name: "Core", webUrl: "https://github.com/orgs/octo-org/teams/core" });
    // A review rule said changes are requested, whoever approved.
    expect(row.approved).toBe(false);
    expect(row.approvedByMe).toBe(true);
  });

  it("is approved by GitHub's decision, or, without a review rule, by the reviews", async () => {
    const approvedBy = (decision: string | null, states: string[]) =>
      prNode({ reviewDecision: decision, latestReviews: { nodes: states.map((s, i) => ({ state: s, viewerDidAuthor: false, author: actor(`r${i}`) })) } });
    const { c } = client(() => searchPage([
      approvedBy("APPROVED", []),
      approvedBy("REVIEW_REQUIRED", ["APPROVED"]),
      approvedBy(null, ["APPROVED", "COMMENTED"]),
      approvedBy(null, ["APPROVED", "CHANGES_REQUESTED"]),
      approvedBy(null, []),
    ]));
    const rows = (await c.listChanges({ filter: "all", state: "open" })).items;
    expect(rows.map((r: { approved: boolean }) => r.approved)).toEqual([true, false, true, false, false]);
  });

  it("counts Open / Merged / Closed in one query", async () => {
    const { c, calls } = client(() => gqlData({ open: { issueCount: 9 }, merged: { issueCount: 1328 }, closed: { issueCount: 9 } }));
    expect(await c.countChanges({ repo: "octo-org/widgets", filter: "mine" })).toEqual({ open: 9, merged: 1328, closed: 9 });
    expect(calls).toHaveLength(1);
    expect(calls[0].variables).toEqual({
      open: "is:pr archived:false repo:octo-org/widgets author:@me is:open",
      merged: "is:pr archived:false repo:octo-org/widgets author:@me is:merged",
      closed: "is:pr archived:false repo:octo-org/widgets author:@me is:closed is:unmerged",
    });
  });
});

describe("a pull request's page", () => {
  const comment = (id: string, at: string, login = "bob") => ({ id, url: `https://github.com/octo-org/widgets/pull/2102#${id}`, createdAt: at, bodyHTML: `<p>${id}</p>`, author: actor(login) });

  it("maps the Overview: threads, the conversation with review summaries, approvals, and the tab counts", async () => {
    const { c, calls } = client(() => gqlData({ repository: { pullRequest: prNode({
      bodyHTML: "<p>What and why</p>",
      milestone: { title: "3.43", url: "https://github.com/octo-org/widgets/milestone/4" },
      participants: { nodes: [{ login: "alice", name: "Alice A", avatarUrl: null, url: "https://github.com/alice" }] },
      changedFiles: 89,
      latestReviews: { nodes: [{ state: "APPROVED", viewerDidAuthor: false, author: actor("carol") }] },
      comments: { totalCount: 1, nodes: [comment("IC_2", "2026-10-12T10:00:00Z")] },
      reviews: { nodes: [
        { id: "PRR_1", state: "COMMENTED", body: "Looks close", bodyHTML: "<p>Looks close</p>", submittedAt: "2026-10-11T10:00:00Z", url: "https://github.com/octo-org/widgets/pull/2102#pullrequestreview-1", author: actor("bob") },
        // Only line comments: not a conversation entry.
        { id: "PRR_2", state: "COMMENTED", body: "", bodyHTML: "", submittedAt: "2026-10-11T11:00:00Z", url: "x", author: actor("bob") },
        { id: "PRR_3", state: "PENDING", body: "draft", bodyHTML: "<p>draft</p>", submittedAt: null, url: "y", author: actor("me") },
      ] },
      reviewThreads: { totalCount: 2, nodes: [
        { id: "PRRT_1", isResolved: true, isOutdated: true, path: "src/server/discovery.mjs", line: null, originalLine: 129, comments: { totalCount: 1, nodes: [comment("PRRC_1", "2026-10-11T10:00:00Z")] } },
        { id: "PRRT_2", isResolved: false, isOutdated: false, path: "DESIGN.md", line: 181, originalLine: 181, comments: { totalCount: 1, nodes: [comment("PRRC_2", "2026-10-11T10:05:00Z")] } },
      ] },
      commits: { totalCount: 52, nodes: [{ commit: {
        oid: sha("b"), statusCheckRollup: { state: "SUCCESS" },
        status: { contexts: [{ state: "SUCCESS" }] },
        checkSuites: { nodes: [{ checkRuns: { totalCount: 8 } }, { checkRuns: { totalCount: 0 } }] },
      } }] },
    }) } }));
    const d = await c.getChange("octo-org/widgets", "2102");
    expect(calls[0].variables).toEqual({ owner: "octo-org", name: "widgets", number: 2102 });
    expect(d).toMatchObject({
      key: "octo-org/widgets#2102",
      descriptionHtml: "<p>What and why</p>",
      milestone: { title: "3.43", webUrl: "https://github.com/octo-org/widgets/milestone/4" },
      approved: true,
      approvedBy: [{ login: "carol" }],
      participants: [{ login: "alice", name: "Alice A" }],
      unresolvedThreads: 1,
      ci: { state: "success" },
      // 1 comment + 1 review summary + 2 threads; one suite with runs + the statuses.
      counts: { discussions: 4, commits: 52, pipelines: 2, files: 89 },
    });
    expect(d.threads[0]).toEqual({
      id: "PRRT_1", resolvable: true, resolved: true, path: "src/server/discovery.mjs", line: 129, outdated: true,
      comments: [{ id: "PRRC_1", author: { login: "bob", name: "BOB", avatarUrl: "https://avatars.example/bob", webUrl: "https://github.com/bob" }, bodyHtml: "<p>PRRC_1</p>", createdAt: Date.parse("2026-10-11T10:00:00Z"), webUrl: "https://github.com/octo-org/widgets/pull/2102#PRRC_1" }],
      webUrl: "https://github.com/octo-org/widgets/pull/2102#PRRC_1",
    });
    expect(d.threads[1]).toMatchObject({ resolved: false, line: 181, outdated: false });
    expect(d.generalComments.map((x: { id: string }) => x.id)).toEqual(["PRR_1", "IC_2"]);
  });

  it("says a pull request that is not there is not-found", async () => {
    const { c } = client(() => gqlData({ repository: { pullRequest: null } }, [{ type: "NOT_FOUND", path: ["repository", "pullRequest"], message: "Could not resolve to a PullRequest with the number of 9." }]));
    expect(await failure(c.getChange("octo-org/widgets", 9))).toMatchObject({ name: "ForgeError", kind: "not-found" });
  });

  it("lists commits newest first, reading backwards from the head", async () => {
    const node = (n: string, at: string) => ({ commit: { oid: sha(n), abbreviatedOid: n.repeat(7), messageHeadline: `c${n}`, authoredDate: at, author: { name: "Alice A" }, url: `https://github.com/c/${n}` } });
    const { c, calls } = client(() => gqlData({ repository: { pullRequest: { commits: {
      totalCount: 52, pageInfo: { hasPreviousPage: true, startCursor: "MzI" },
      nodes: [node("1", "2026-10-11T10:00:00Z"), node("2", "2026-10-12T10:00:00Z")],
    } } } }));
    const p = await c.listChangeCommits("octo-org/widgets", 2102, { cursor: "NTI" });
    expect(calls[0].variables.before).toBe("NTI");
    expect(calls[0].query).toMatch(/commits\(last: 20, before: \$before\)/);
    expect(p.items.map((x: { title: string }) => x.title)).toEqual(["c2", "c1"]);
    expect(p.items[0]).toEqual({ sha: sha("2"), shortSha: "2222222", title: "c2", authorName: "Alice A", authoredAt: Date.parse("2026-10-12T10:00:00Z"), webUrl: "https://github.com/c/2" });
    expect(p.next).toBe("MzI");
    expect(p.total).toBe(52);
  });

  it("lists files with their old path, status and the files tab's anchor, paged by number", async () => {
    const { c, calls } = client(() => json([
      { filename: "src/new.ts", status: "added", additions: 10, deletions: 0 },
      { filename: "src/b.ts", previous_filename: "src/a.ts", status: "renamed", additions: 1, deletions: 1 },
      { filename: "src/gone.ts", status: "removed", additions: 0, deletions: 5 },
      { filename: "src/c.ts", status: "changed", additions: 0, deletions: 0 },
    ], 200, { link: '<https://api.github.com/repositories/1/pulls/2102/files?per_page=30&page=3>; rel="next"' }));
    const p = await c.listChangeFiles("octo-org/widgets", 2102, { cursor: "2" });
    expect(calls[0].url).toBe(`${API}/repos/octo-org/widgets/pulls/2102/files?per_page=30&page=2`);
    expect(p.items.map((f: { status: string }) => f.status)).toEqual(["added", "renamed", "deleted", "modified"]);
    expect(p.items[1]).toEqual({
      path: "src/b.ts", oldPath: "src/a.ts", status: "renamed", additions: 1, deletions: 1,
      webUrl: `https://github.com/octo-org/widgets/pull/2102/files#diff-${createHash("sha256").update("src/b.ts").digest("hex")}`,
    });
    expect(p.next).toBe("3");
  });
});

// ─── Checks and Actions ─────────────────────────────────────────────────────

describe("a pull request's checks", () => {
  const run = (id: number, name: string, status: string, conclusion: string | null, extra: Record<string, unknown> = {}) => ({
    id: `CR_${id}`, databaseId: id, name, status, conclusion,
    startedAt: "2026-10-19T10:00:00Z", completedAt: status === "COMPLETED" ? "2026-10-19T10:05:00Z" : null,
    detailsUrl: `https://github.com/octo-org/widgets/actions/runs/39/job/${id}`, url: `https://github.com/octo-org/widgets/runs/${id}`,
    title: null, summary: null, ...extra,
  });
  const actionsSuite = {
    databaseId: 106, status: "IN_PROGRESS", conclusion: null, createdAt: "2026-10-19T09:59:00Z",
    url: `https://github.com/octo-org/widgets/commit/${sha("b")}/checks?check_suite_id=106`,
    app: { name: "GitHub Actions", slug: "github-actions" }, branch: { name: "feat/accounts" },
    commit: { oid: sha("b"), abbreviatedOid: "bbbbbbb", messageHeadline: "feat: connect" },
    workflowRun: { databaseId: 39, event: "pull_request", url: "https://github.com/octo-org/widgets/actions/runs/39", createdAt: "2026-10-19T09:59:00Z", workflow: { name: "ci" } },
    checkRuns: { totalCount: 4, nodes: [
      run(1, "typecheck", "COMPLETED", "SUCCESS"),
      run(2, "test (ubuntu-latest)", "COMPLETED", "FAILURE"),
      run(3, "test (macos-latest)", "COMPLETED", "FAILURE"),
      run(4, "test (windows-latest)", "IN_PROGRESS", null),
    ] },
  };
  const appSuite = {
    ...actionsSuite, databaseId: 207, status: "COMPLETED", conclusion: "FAILURE", url: "https://github.com/octo-org/widgets/runs/x",
    app: { name: "Lint Bot", slug: "lint-bot" }, workflowRun: null,
    checkRuns: { totalCount: 1, nodes: [run(5, "lint", "COMPLETED", "FAILURE", { detailsUrl: "https://lint.example/r/5", title: "3 problems", summary: "line one\nline two" })] },
  };
  const emptySuite = { ...appSuite, databaseId: 208, checkRuns: { totalCount: 0, nodes: [] } };

  function checksApi() {
    return client((req) => {
      if (/pullRequest\(number: \$number\) \{\s*headRefName/.test(req.query)) {
        return gqlData({ repository: { pullRequest: { headRefName: "feat/accounts", commits: { nodes: [{ commit: {
          oid: sha("b"), abbreviatedOid: "bbbbbbb",
          status: { state: "FAILURE", contexts: [
            { id: "SC_1", context: "ci/legacy", state: "FAILURE", description: "2 tests failed", targetUrl: "https://ci.example/1", createdAt: "2026-10-19T10:01:00Z" },
            { id: "SC_2", context: "deploy/preview", state: "PENDING", description: "Building", targetUrl: null, createdAt: "2026-10-19T10:02:00Z" },
          ] },
          checkSuites: { nodes: [actionsSuite, appSuite, emptySuite] },
        } }] } } } });
      }
      if (/nodes\(ids: \$ids\)/.test(req.query)) {
        return gqlData({ nodes: [
          { id: "CR_2", steps: { nodes: [{ name: "Checkout", status: "COMPLETED", conclusion: "SUCCESS" }, { name: "Run tests", status: "COMPLETED", conclusion: "FAILURE" }] },
            annotations: { nodes: [
              { path: ".github", annotationLevel: "FAILURE", title: "", message: "Process completed with exit code 1.", location: { start: { line: 19450 } } },
              { path: "src/a.test.ts", annotationLevel: "WARNING", title: "flaky", message: "retried twice", location: { start: { line: 12 } } },
            ] } },
          // Its steps still say the failing one is running (GitHub, mid-run).
          { id: "CR_3", steps: { nodes: [{ name: "Checkout", status: "COMPLETED", conclusion: "SUCCESS" }, { name: "Run tests", status: "IN_PROGRESS", conclusion: null }] }, annotations: { nodes: [] } },
          { id: "CR_5", steps: { nodes: [] }, annotations: { nodes: [] } },
        ] });
      }
      return undefined;
    });
  }

  it("makes each suite with runs a pipeline, its runs the jobs, and the statuses one more", async () => {
    const { c, calls } = checksApi();
    const ps = await c.listChangePipelines("octo-org/widgets", 2187);
    // Steps and annotations are asked for the failed runs only.
    expect(calls[1].variables.ids).toEqual(["CR_2", "CR_3", "CR_5"]);
    expect(ps.map((p: { id: string; state: string }) => `${p.id}:${p.state}`)).toEqual(["39:running", "suite:207:failed", `status:${sha("b")}:failed`]);

    const [actions, app, statuses] = ps;
    expect(actions).toMatchObject({
      repo: "octo-org/widgets", ref: "feat/accounts", sha: sha("b"), shortSha: "bbbbbbb", title: "ci · feat: connect",
      source: "pull_request", triggeredBy: null, createdAt: Date.parse("2026-10-19T09:59:00Z"),
      startedAt: Date.parse("2026-10-19T10:00:00Z"), finishedAt: null, webUrl: "https://github.com/octo-org/widgets/actions/runs/39",
    });
    expect(actions.jobs.map((j: { state: string }) => j.state)).toEqual(["success", "failed", "failed", "running"]);
    expect(actions.jobs[1]).toEqual({
      id: "2", name: "test (ubuntu-latest)", stage: null, state: "failed", allowFailure: false,
      startedAt: Date.parse("2026-10-19T10:00:00Z"), finishedAt: Date.parse("2026-10-19T10:05:00Z"), durationSec: 300,
      webUrl: "https://github.com/octo-org/widgets/actions/runs/39/job/2",
      failureReason: "Step “Run tests” failed",
      annotations: [
        // The runner's own: a log line number, not a file's.
        { path: null, line: null, level: "failure", title: null, message: "Process completed with exit code 1." },
        { path: "src/a.test.ts", line: 12, level: "warning", title: "flaky", message: "retried twice" },
      ],
      logAvailable: true,
    });
    expect(actions.jobs[2].failureReason).toBe("Step “Run tests” failed");
    expect(actions.jobs[0]).toMatchObject({ failureReason: null, annotations: [] });

    expect(app).toMatchObject({ title: "Lint Bot", source: null, webUrl: "https://github.com/octo-org/widgets/runs/x" });
    expect(app.jobs[0]).toMatchObject({ failureReason: "3 problems", logAvailable: false, webUrl: "https://lint.example/r/5" });

    expect(statuses).toMatchObject({ title: "Commit statuses", webUrl: `https://github.com/octo-org/widgets/commit/${sha("b")}`, source: null });
    expect(statuses.jobs).toEqual([
      { id: "SC_1", name: "ci/legacy", stage: null, state: "failed", allowFailure: false, startedAt: Date.parse("2026-10-19T10:01:00Z"), finishedAt: Date.parse("2026-10-19T10:01:00Z"), durationSec: null, webUrl: "https://ci.example/1", failureReason: "2 tests failed", annotations: [], logAvailable: false },
      { id: "SC_2", name: "deploy/preview", stage: null, state: "pending", allowFailure: false, startedAt: Date.parse("2026-10-19T10:02:00Z"), finishedAt: null, durationSec: null, webUrl: null, failureReason: null, annotations: [], logAvailable: false },
    ]);
  });
});

describe("Actions runs", () => {
  const restRun = (id: number, created: string, repo = "octo-org/widgets", extra: Record<string, unknown> = {}) => ({
    id, name: "ci", display_title: `run ${id}`, status: "completed", conclusion: "failure", event: "push",
    head_branch: "main", head_sha: sha("c"), created_at: created, run_started_at: created, updated_at: created,
    html_url: `https://github.com/${repo}/actions/runs/${id}`, actor: { login: "alice", avatar_url: null, html_url: "https://github.com/alice" },
    repository: { full_name: repo }, ...extra,
  });

  it("lists one repository's runs by page number", async () => {
    const { c, calls } = client(() => json({ total_count: 2528, workflow_runs: [
      restRun(1, "2026-10-19T10:00:00Z", "octo-org/widgets", { status: "in_progress", conclusion: null, run_started_at: "2026-10-19T10:00:30Z" }),
    ] }, 200, { link: '<https://api.github.com/repositories/1/actions/runs?per_page=20&page=3>; rel="next"' }));
    const p = await c.listPipelines({ repo: "octo-org/widgets", cursor: "2" });
    expect(calls[0].url).toBe(`${API}/repos/octo-org/widgets/actions/runs?per_page=20&page=2&exclude_pull_requests=true`);
    expect(p).toEqual({
      items: [{
        id: "1", repo: "octo-org/widgets", ref: "main", sha: sha("c"), shortSha: "ccccccc", title: "ci · run 1", state: "running",
        source: "push", triggeredBy: { login: "alice", name: null, avatarUrl: null, webUrl: "https://github.com/alice" },
        createdAt: Date.parse("2026-10-19T10:00:00Z"), startedAt: Date.parse("2026-10-19T10:00:30Z"), finishedAt: null, durationSec: null,
        webUrl: "https://github.com/octo-org/widgets/actions/runs/1",
      }],
      next: "3",
      total: 2528,
    });
  });

  it("merges the latest runs of the most recently pushed repositories by time, and pages without repeats", async () => {
    const repos = ["octo-org/a", "octo-org/b", "octo-org/no-actions"];
    const runsOf: Record<string, ReturnType<typeof restRun>[]> = {
      "octo-org/a": [restRun(11, "2026-10-19T10:00:00Z", "octo-org/a"), restRun(12, "2026-10-19T08:00:00Z", "octo-org/a")],
      "octo-org/b": [restRun(21, "2026-10-19T09:00:00Z", "octo-org/b"), restRun(22, "2026-10-19T08:00:00Z", "octo-org/b")],
    };
    const { c, calls } = client((req) => {
      if (req.url === GQL) return gqlData({ viewer: { repositories: { totalCount: 3, pageInfo: { hasNextPage: false, endCursor: null }, nodes: repos.map(p => ({ nameWithOwner: p })) } } });
      const m = /\/repos\/(octo-org\/[^/]+)\/actions\/runs\?(.*)$/.exec(req.url);
      if (!m) return undefined;
      if (m[1] === "octo-org/no-actions") return json({ message: "Not Found" }, 404);
      const params = new URLSearchParams(m[2]);
      const before = params.get("created")?.replace("<=", "");
      const list = runsOf[m[1]].filter(r => !before || r.created_at <= before);
      const perPage = Number(params.get("per_page"));
      return json({ total_count: list.length, workflow_runs: list.slice(0, perPage) });
    });
    const page1 = await c.listPipelines({ repo: null });
    expect(calls[0].variables).toEqual({ first: 10, after: null });
    // Newest first across repositories; a repository without Actions (404)
    // is left out rather than failing the list.
    expect(page1.items.map((p: { id: string }) => p.id)).toEqual(["11", "21", "12", "22"]);
    expect(page1.next).toBeNull();
    expect(page1.total).toBeNull();
  });

  it("carries the boundary second and the runs already shown in the merged list's cursor", async () => {
    const runs = Array.from({ length: 22 }, (_, i) => restRun(100 + i, i < 19 ? `2026-10-19T10:${String(59 - i).padStart(2, "0")}:00Z` : "2026-10-19T10:00:00Z", "octo-org/a"));
    const asked: string[] = [];
    const { c } = client((req) => {
      if (req.url === GQL) return gqlData({ viewer: { repositories: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ nameWithOwner: "octo-org/a" }] } } });
      const params = new URL(req.url).searchParams;
      const before = params.get("created")?.replace("<=", "");
      asked.push(params.get("created") ?? "");
      const list = runs.filter(r => !before || r.created_at <= before);
      return json({ total_count: list.length, workflow_runs: list.slice(0, 20) });
    });
    const p1 = await c.listPipelines({ repo: null });
    expect(p1.items).toHaveLength(20);
    // Runs 119-121 share 10:00:00; 119 is the last shown.
    expect(p1.next).toBe("2026-10-19T10:00:00Z~119");
    const p2 = await c.listPipelines({ repo: null, cursor: p1.next });
    expect(asked[1]).toBe("<=2026-10-19T10:00:00Z");
    expect(p2.items.map((p: { id: string }) => p.id)).toEqual(["120", "121"]);
    expect(p2.next).toBeNull();
  });

  it("reads a workflow run with its jobs, a check suite, and a commit's statuses by the ids the lists hand out", async () => {
    const suiteNode = {
      databaseId: 207, status: "COMPLETED", conclusion: "SUCCESS", createdAt: "2026-10-19T10:00:00Z", url: "https://github.com/octo-org/widgets/runs/s",
      app: { name: "Lint Bot", slug: "lint-bot" }, branch: null, commit: { oid: sha("d"), abbreviatedOid: "ddddddd", messageHeadline: "x" }, workflowRun: null,
      checkRuns: { totalCount: 1, nodes: [{ id: "CR_9", databaseId: 9, name: "lint", status: "COMPLETED", conclusion: "SUCCESS", startedAt: null, completedAt: null, detailsUrl: null, url: "https://github.com/octo-org/widgets/runs/9", title: null, summary: null }] },
    };
    const { c, calls } = client((req) => {
      if (req.url === `${API}/repos/octo-org/widgets/actions/runs/39`) return json(restRun(39, "2026-10-19T10:00:00Z", "octo-org/widgets", { check_suite_node_id: "CS_39", conclusion: "success" }));
      if (req.url === `${API}/repos/octo-org/widgets/check-suites/207`) return json({ id: 207, node_id: "CS_207", head_branch: "main" });
      if (req.url === GQL && req.variables.id === "CS_39") return gqlData({ node: { ...suiteNode, workflowRun: { databaseId: 39, event: "push", url: "u", createdAt: null, workflow: { name: "ci" } } } });
      if (req.url === GQL && req.variables.id === "CS_207") return gqlData({ node: suiteNode });
      if (req.url === GQL && req.variables.sha) return gqlData({ repository: { object: { oid: sha("d"), abbreviatedOid: "ddddddd", status: { state: "SUCCESS", contexts: [{ id: "SC_1", context: "ci/legacy", state: "SUCCESS", description: "ok", targetUrl: null, createdAt: "2026-10-19T10:00:00Z" }] } } } });
      return undefined;
    });
    const run = await c.getPipeline("octo-org/widgets", "39");
    expect(run).toMatchObject({ id: "39", title: "ci · run 39", state: "success", triggeredBy: { login: "alice" } });
    expect(run.jobs.map((j: { name: string; logAvailable: boolean }) => `${j.name}:${j.logAvailable}`)).toEqual(["lint:true"]);
    const suite = await c.getPipeline("octo-org/widgets", "suite:207");
    expect(suite).toMatchObject({ id: "suite:207", ref: "main", title: "Lint Bot", state: "success" });
    expect(suite.jobs[0]).toMatchObject({ webUrl: "https://github.com/octo-org/widgets/runs/9", logAvailable: false });
    const statuses = await c.getPipeline("octo-org/widgets", `status:${sha("d")}`);
    expect(statuses).toMatchObject({ id: `status:${sha("d")}`, title: "Commit statuses", state: "success", jobs: [{ name: "ci/legacy" }] });
    expect(calls.filter(x => x.url === GQL).map(x => x.variables.sha ?? x.variables.id)).toEqual(["CS_39", "CS_207", sha("d")]);
  });
});

describe("a job's log", () => {
  it("cleans one line the way GitHub's log view shows it", () => {
    expect(cleanGithubLogLine("﻿2026-10-19T15:20:59.7815555Z Current runner version: '2.337.0'")).toBe("Current runner version: '2.337.0'");
    expect(cleanGithubLogLine("2026-10-19T15:26:19.8645819Z ##[group]Run npm test")).toBe("Run npm test");
    expect(cleanGithubLogLine("2026-10-19T15:26:19.8711072Z ##[endgroup]")).toBeNull();
    expect(cleanGithubLogLine("2026-10-19T15:26:19.8711072Z ##[error]Process completed with exit code 1.")).toBe("Error: Process completed with exit code 1.");
    expect(cleanGithubLogLine("2026-10-19T15:26:19.8711072Z ##[warning]Node 16 is deprecated")).toBe("Warning: Node 16 is deprecated");
    expect(cleanGithubLogLine("2026-10-19T15:26:20.1725556Z [command]/usr/bin/git version")).toBe("/usr/bin/git version");
    expect(cleanGithubLogLine("2026-10-19T15:26:19.8645898Z \x1b[36;1m  }\x1b[0m")).toBe("  }");
  });

  it("follows the redirect without the token and ends at the job's own last line", async () => {
    const stamp = (s: string) => `2026-10-19T15:26:19.0000000Z ${s}`;
    const log = [
      "ment of a line",
      stamp("✗ 1 failed"),
      stamp("##[error]Process completed with exit code 1."),
      stamp("##[group]Run node audit.mjs"),
      stamp("node audit.mjs"),
      stamp("##[endgroup]"),
      stamp("report total: 0 skipped case(s)"),
      stamp("Post job cleanup."),
      stamp("[command]/usr/bin/git config --local --unset-all http.extraheader"),
      stamp("Post job cleanup."),
      stamp("Cleaning up orphan processes"),
      "",
    ].join("\n");
    const { c, calls } = client((req) => {
      if (req.url === `${API}/repos/octo-org/widgets/actions/jobs/118/logs`) {
        return new Response(null, { status: 302, headers: { location: "https://results.blob.example.net/logs/job-logs.txt?sig=abc" } });
      }
      if (req.url === "https://results.blob.example.net/logs/job-logs.txt?sig=abc") return new Response(log, { status: 206, headers: { "content-type": "text/plain" } });
      return undefined;
    });
    const t = await c.jobLogTail("octo-org/widgets", 118, { lines: 4 });
    expect(calls[0].headers.authorization).toBe("Bearer ghp_TEST");
    expect(calls[1].headers.authorization).toBeUndefined();
    expect(t).toEqual({
      lines: ["Error: Process completed with exit code 1.", "Run node audit.mjs", "node audit.mjs", "report total: 0 skipped case(s)"],
      truncated: true,
      webUrl: "https://github.com/octo-org/widgets/runs/118",
    });
  });
});

// ─── Issues ─────────────────────────────────────────────────────────────────

const issueNode = (extra: Record<string, unknown> = {}) => ({
  number: 14529,
  title: "RFC: artifacts",
  titleHTML: "RFC: <code>artifacts</code>",
  state: "CLOSED",
  url: "https://github.com/octo-org/widgets/issues/14529",
  repository: { nameWithOwner: "octo-org/widgets" },
  author: actor("alice"),
  assignees: { nodes: [] },
  labels: { nodes: [{ name: "enhancement", color: null }] },
  milestone: null,
  createdAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-10-01T10:00:00Z",
  closedAt: "2026-10-01T10:00:00Z",
  comments: { totalCount: 6 },
  stateReason: "COMPLETED",
  issueType: null,
  subIssuesSummary: { total: 6, completed: 6 },
  parent: { number: 14563, title: "Stack map", state: "CLOSED", url: "https://github.com/octo-org/widgets/issues/14563", repository: { nameWithOwner: "octo-org/widgets" }, issueType: { name: "Epic" } },
  ...extra,
});

describe("issues", () => {
  it("lists ALL of a repository's issues in a state, newest first", async () => {
    const { c, calls } = client(() => gqlData({ repository: { issues: { totalCount: 814, pageInfo: { hasNextPage: true, endCursor: "Y3I6MjA=" }, nodes: [issueNode()] } } }));
    const p = await c.listIssues({ repo: "octo-org/widgets", state: "closed", cursor: "Y3I6MA==" });
    expect(calls[0].variables).toEqual({ owner: "octo-org", name: "widgets", states: ["CLOSED"], first: 20, after: "Y3I6MA==" });
    expect(calls[0].query).toMatch(/CREATED_AT/);
    // Not only the viewer's: no filter on who is assigned.
    expect(calls[0].query).not.toMatch(/filterBy/);
    expect(p.next).toBe("Y3I6MjA=");
    expect(p.total).toBe(814);
    expect(p.items[0]).toEqual({
      kind: "github", key: "octo-org/widgets#14529", number: 14529, repo: "octo-org/widgets",
      title: "RFC: artifacts", titleHtml: "RFC: <code>artifacts</code>", state: "closed", stateReason: "completed",
      webUrl: "https://github.com/octo-org/widgets/issues/14529",
      author: { login: "alice", name: "ALICE", avatarUrl: "https://avatars.example/alice", webUrl: "https://github.com/alice" },
      assignees: [], labels: [{ name: "enhancement", color: null }], milestone: null,
      createdAt: Date.parse("2026-09-01T10:00:00Z"), updatedAt: Date.parse("2026-10-01T10:00:00Z"), closedAt: Date.parse("2026-10-01T10:00:00Z"),
      comments: 6,
      children: { total: 6, completed: 6 },
      parent: { key: "octo-org/widgets#14563", number: 14563, repo: "octo-org/widgets", title: "Stack map", state: "closed", webUrl: "https://github.com/octo-org/widgets/issues/14563", type: "Epic" },
    });
  });

  it("across repositories, lists the issues the viewer is part of; no sub-issues and REOPENED read as nothing", async () => {
    const { c, calls } = client(() => searchPage([issueNode({ state: "OPEN", stateReason: "REOPENED", subIssuesSummary: { total: 0, completed: 0 }, parent: null })], null, 109));
    const p = await c.listIssues({ repo: null, state: "open" });
    expect(calls[0].variables.q).toBe("is:issue involves:@me archived:false is:open sort:created-desc");
    expect(p.items[0]).toMatchObject({ state: "open", stateReason: null, children: null, parent: null });
    expect(p.total).toBe(109);
  });

  it("asks again without the newer fields when an older server lacks them", async () => {
    const { c, calls } = client((req) => /subIssuesSummary/.test(req.query)
      ? json({ errors: [{ extensions: { code: "undefinedField" }, message: "Field 'subIssuesSummary' doesn't exist on type 'Issue'" }] })
      : gqlData({ repository: { issues: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issueNode({ stateReason: undefined, subIssuesSummary: undefined, parent: undefined })] } } }));
    const p = await c.listIssues({ repo: "octo-org/widgets", state: "open" });
    expect(calls).toHaveLength(2);
    expect(p.items[0]).toMatchObject({ number: 14529, children: null, parent: null, stateReason: null });
  });

  it("reads one issue with its description and sub-issues", async () => {
    const { c } = client(() => gqlData({ repository: { issue: { ...issueNode(), bodyHTML: "<p>Plan</p>", subIssues: { nodes: [
      { number: 14523, title: "Design list", state: "CLOSED", url: "https://github.com/octo-org/widgets/issues/14523", repository: { nameWithOwner: "octo-org/widgets" }, issueType: null },
    ] } } } }));
    const d = await c.getIssue("octo-org/widgets", 14529);
    expect(d.descriptionHtml).toBe("<p>Plan</p>");
    expect(d.childItems).toEqual([{ key: "octo-org/widgets#14523", number: 14523, repo: "octo-org/widgets", title: "Design list", state: "closed", webUrl: "https://github.com/octo-org/widgets/issues/14523", type: null }]);
    expect(d.parent.key).toBe("octo-org/widgets#14563");
  });

  it("pages an issue's comments, oldest first", async () => {
    const { c, calls } = client(() => gqlData({ repository: { issueOrPullRequest: { comments: {
      totalCount: 31, pageInfo: { hasNextPage: true, endCursor: "Y3I6MzA=" },
      nodes: [{ id: "IC_1", url: "https://github.com/octo-org/widgets/issues/1#issuecomment-1", createdAt: "2026-10-01T10:00:00Z", bodyHTML: "<p>hi</p>", author: null }],
    } } } }));
    const p = await c.listIssueComments("octo-org/widgets", 1, { cursor: "Y3I6MA==" });
    expect(calls[0].variables.after).toBe("Y3I6MA==");
    expect(p).toEqual({
      items: [{ id: "IC_1", author: null, bodyHtml: "<p>hi</p>", createdAt: Date.parse("2026-10-01T10:00:00Z"), webUrl: "https://github.com/octo-org/widgets/issues/1#issuecomment-1" }],
      next: "Y3I6MzA=",
      total: 31,
    });
  });
});

// ─── Pasted references ──────────────────────────────────────────────────────

describe("a pasted reference", () => {
  it("reads github URLs without asking", async () => {
    const { c, calls } = client(() => undefined);
    expect(await c.resolveRef("https://github.com/octo-org/widgets/pull/12/files")).toEqual({ type: "change", repo: "octo-org/widgets", number: 12 });
    expect(await c.resolveRef(" https://www.github.com/octo-org/widgets/issues/7#issuecomment-3 ")).toEqual({ type: "issue", repo: "octo-org/widgets", number: 7 });
    expect(await c.resolveRef("github.com/octo-org/widgets/pull/3")).toEqual({ type: "change", repo: "octo-org/widgets", number: 3 });
    expect(await c.resolveRef("https://gitlab.com/octo-org/widgets/-/merge_requests/3")).toBeNull();
    expect(await c.resolveRef("https://github.com/octo-org/widgets/tree/main")).toBeNull();
    expect(await c.resolveRef("not a reference")).toBeNull();
    expect(await c.resolveRef("")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("asks which a key is, since issues and pull requests share numbers", async () => {
    const { c, calls } = client((req) => {
      const n = req.variables.number;
      if (n === 2187) return gqlData({ repository: { issueOrPullRequest: { __typename: "PullRequest" } } });
      if (n === 2179) return gqlData({ repository: { issueOrPullRequest: { __typename: "Issue" } } });
      return gqlData({ repository: { issueOrPullRequest: null } }, [{ type: "NOT_FOUND", message: "Could not resolve to an issue or pull request with the number of 9." }]);
    });
    expect(await c.resolveRef("octo-org/widgets#2187")).toEqual({ type: "change", repo: "octo-org/widgets", number: 2187 });
    expect(await c.resolveRef("octo-org/widgets#2179")).toEqual({ type: "issue", repo: "octo-org/widgets", number: 2179 });
    expect(await c.resolveRef("octo-org/widgets#9")).toBeNull();
    expect(calls[0].variables).toEqual({ owner: "octo-org", name: "widgets", number: 2187 });
  });

  it("does not hide a failure that is not 'not there'", async () => {
    const { c } = client(() => json({ message: "Bad credentials" }, 401));
    expect(await failure(c.resolveRef("octo-org/widgets#1"))).toMatchObject({ kind: "auth" });
  });

  it("reads an Enterprise server's own URLs, not github.com's", async () => {
    const { c } = client(() => undefined, { baseUrl: "https://ghe.example.com" });
    expect(await c.resolveRef("https://ghe.example.com/team/app/pull/5")).toEqual({ type: "change", repo: "team/app", number: 5 });
    expect(await c.resolveRef("https://github.com/team/app/pull/5")).toBeNull();
  });
});

describe("images for the deck to pass on", () => {
  const png = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });

  it("come from GitHub's image hosts, none of them sent the token", async () => {
    const { c, calls } = client(() => png());
    await c.fetchAsset("https://avatars.githubusercontent.com/u/1?v=4");
    await c.fetchAsset("https://private-user-images.githubusercontent.com/1/abc.png?jwt=x");
    await c.fetchAsset("https://github.com/user-attachments/assets/abc");
    expect(calls).toHaveLength(3);
    expect(calls.every(r => r.headers.authorization === undefined)).toBe(true);
  });

  it("are never fetched from the API or anywhere else", async () => {
    const { c, calls } = client(() => png());
    expect((await failure(c.fetchAsset(`${API}/user`))).kind).toBe("permission");
    expect((await failure(c.fetchAsset("https://evil.example/a.png"))).kind).toBe("permission");
    expect((await failure(c.fetchAsset("http://avatars.githubusercontent.com/u/1"))).kind).toBe("permission");
    expect(calls).toEqual([]);
  });

  it("on an Enterprise Server come from its own host and its subdomains, the token only to its own", async () => {
    const { c, calls } = client(() => png(), { baseUrl: "https://ghe.example.com" });
    await c.fetchAsset("https://ghe.example.com/avatars/u/1");
    await c.fetchAsset("https://avatars.ghe.example.com/u/1");
    expect((await failure(c.fetchAsset("https://avatars.githubusercontent.com/u/1"))).kind).toBe("permission");
    expect(calls.map(r => r.headers.authorization)).toEqual(["Bearer ghp_TEST", undefined]);
  });
});
