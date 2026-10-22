// A read that starts a side request beside its main one must never leave that
// side request's failure unhandled: Node ends a process on an unhandled
// rejection, and the deck has no handler for one, so a single rate limit could
// take the whole deck down. Three reads did:
//   - a Jira Cloud backlog's first page starts its approximate count before the
//     list, and waited for it only when the list had no total of its own — so
//     a count that failed while the list failed first, or had its own total,
//     was a rejection nobody handled;
//   - GitLab's merge request list asks for the schema beside the list, and
//     waited for it only when the page had rows;
//   - GitLab's changed files ask for the diff stats beside /diffs, and a hard
//     failure of the stats (a 401) that came back first went unhandled until
//     /diffs answered.
// Each answer stays what it was; only the stray rejection is gone. Every
// tracker here is a fake fetch: nothing leaves the machine.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createJiraClient, jiraRoutes } from "../../server/integrations/jira.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createGitlabClient } from "../../server/gitlab-api.mjs";

/** A fake token, built at run time so no literal here reads as a live one. */
const fakeToken = (seed: string) => ["fake", seed, "token", "0123456789abcdef"].join("-");

type Route = { status?: number; body?: unknown; headers?: Record<string, string>; delayMs?: number };
/** A fetch that answers by path (and, for the same path, by method), after an
 *  optional delay, and records what it was asked. */
function fakeFetch(routes: Record<string, Route>) {
  const asked: string[] = [];
  const impl = async (url: string, init: { method?: string } = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    asked.push(`${method} ${u.pathname}`);
    const route = routes[`${method} ${u.pathname}`] ?? routes[u.pathname];
    if (!route) return new Response(JSON.stringify({ message: "no such route" }), { status: 404, headers: { "content-type": "application/json" } });
    if (route.delayMs) await new Promise(r => setTimeout(r, route.delayMs));
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json", ...(route.headers ?? {}) },
    });
  };
  return { impl, asked };
}

/** What `run` answered, and every rejection Node found unhandled while it
 *  ran and for a moment after (the side requests settle later). */
async function unhandledDuring<T>(run: () => Promise<T>, settleMs = 120) {
  const seen: unknown[] = [];
  const on = (reason: unknown) => { seen.push(reason); };
  process.on("unhandledRejection", on);
  try {
    let result: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      result = { ok: true, value: await run() };
    } catch (error) {
      result = { ok: false, error };
    }
    await new Promise(r => setTimeout(r, settleMs));
    return { result, unhandled: seen.map(r => (r as { kind?: string; name?: string })?.kind ?? (r as Error)?.name ?? String(r)) };
  } finally {
    process.off("unhandledRejection", on);
  }
}

describe("a Jira Cloud backlog's approximate count (unhandled rejections)", () => {
  const SITE = "https://acme.example.net";
  const conn = { id: "c1", kind: "jira", baseUrl: SITE, allowedOrigins: [SITE], meta: { deployment: "cloud" } };
  const secret = { auth: "basic", email: "jane@example.com", token: fakeToken("unhandled-jira") };
  const read = (routes: Record<string, Route>) => {
    const f = fakeFetch({
      "/rest/api/3/field": { body: [] },
      "/rest/agile/1.0/board/1/configuration": { body: {} },
      ...routes,
    });
    const client = createJiraClient(conn, secret, { fetchImpl: f.impl });
    return { f, run: () => jiraRoutes(client, "GET", "board/1/issues", new URLSearchParams("source=backlog"), null, {}) };
  };
  const rateLimited: Route = { status: 429, headers: { "retry-after": "30" }, body: { errorMessages: ["Rate limit exceeded."] } };

  it("is never left unhandled when it fails and the list had its own total", async () => {
    const { f, run } = read({
      "/rest/software/1.0/board/1/backlog/approximate-count": rateLimited,
      // Not on this site yet: Agile 1.0's own list, which carries a total.
      "/rest/software/1.0/board/1/backlog": { status: 404, body: { errorMessages: ["Not found"] }, delayMs: 20 },
      "/rest/agile/1.0/board/1/backlog": { body: { issues: [], total: 0, startAt: 0, maxResults: 50 } },
    });
    const { result, unhandled } = await unhandledDuring(run);
    expect(f.asked).toContain("GET /rest/software/1.0/board/1/backlog/approximate-count");
    expect(result).toMatchObject({ ok: true, value: { status: 200, body: { ok: true, total: 0, issues: [] } } });
    expect(unhandled).toEqual([]);
  });

  it("is never left unhandled when it fails after the list failed first", async () => {
    const { f, run } = read({
      "/rest/software/1.0/board/1/backlog/approximate-count": { ...rateLimited, delayMs: 40 },
      "/rest/software/1.0/board/1/backlog": { status: 500, body: { errorMessages: ["Internal server error"] } },
    });
    const { result, unhandled } = await unhandledDuring(run);
    expect(f.asked).toContain("GET /rest/software/1.0/board/1/backlog/approximate-count");
    // The list's own failure, as before.
    expect(result).toMatchObject({ ok: true, value: { body: { ok: false, error: { kind: "upstream" } } } });
    expect(unhandled).toEqual([]);
  });
});

describe("GitLab's merge request reads (unhandled rejections)", () => {
  const BASE = "https://gitlab.example.com";
  const client = (routes: Record<string, Route>) => {
    const f = fakeFetch(routes);
    return { f, c: createGitlabClient({ baseUrl: BASE, token: fakeToken("unhandled-gitlab"), fetchImpl: f.impl, now: () => 1_700_000_000_000 }) };
  };

  it("never leaves an unreadable schema answer unhandled when the list has no rows", async () => {
    const { f, c } = client({
      // The schema answer is not the shape it should be: reading it throws.
      "POST /api/graphql": { body: { data: { mr: { fields: {} }, ix: { fields: {} } } } },
      "/api/v4/projects/a%2Fb/merge_requests": { body: [], headers: { "x-total": "0" }, delayMs: 20 },
    });
    const { result, unhandled } = await unhandledDuring(() => c.listChanges({ repo: "a/b" }));
    expect(f.asked).toContain("POST /api/graphql");
    expect(result).toMatchObject({ ok: true, value: { items: [] } });
    expect(unhandled).toEqual([]);
  });

  it("never leaves a hard diff-stats failure unhandled while /diffs is still answering", async () => {
    const { f, c } = client({
      "POST /api/graphql": { status: 401, body: { message: "401 Unauthorized" } },
      "/api/v4/projects/a%2Fb/merge_requests/1/diffs": { body: [], delayMs: 40 },
    });
    const { result, unhandled } = await unhandledDuring(() => c.listChangeFiles("a/b", 1));
    expect(f.asked).toContain("POST /api/graphql");
    // The stats' own failure, as before: the read answers it once it gets there.
    expect(result.ok).toBe(false);
    expect((result as { error: { kind: string } }).error.kind).toBe("auth");
    expect(unhandled).toEqual([]);
  });
});
