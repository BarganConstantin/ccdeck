// Two faults in the forge panels' reads, found in review (#2179):
//   - GitHub's Actions list across repositories pages by a cursor made of the
//     last run's time and the ids already shown, joined by "~" — which the
//     route's cursor check refused, so the list stopped at its first page with
//     "cursor is not a cursor";
//   - a job log's tail trimmed what it kept while the log streamed, and the
//     blank lines a log ends on counted towards what it kept: a log ending on
//     a long enough run of them came back with no lines at all, or with some,
//     depending only on where the network cut the body into chunks.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module, no types
import { forgeRead } from "../../server/forge-routes.mjs";
// @ts-expect-error — plain JS module, no types
import { createGithubClient } from "../../server/github-api.mjs";
// @ts-expect-error — plain JS module, no types
import { createForgeTransport } from "../../server/forge-http.mjs";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const API = "https://api.github.com";
const GQL = `${API}/graphql`;
/** A fake token, built at run time so no literal here reads as a live one. */
const TOKEN = ["fake", "q12", "token", "0123456789abcdef"].join("-");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("GitHub's Actions runs across repositories, page after page", () => {
  const restRun = (id: number, created: string, repo = "octo-org/a") => ({
    id, name: "ci", display_title: `run ${id}`, status: "completed", conclusion: "failure", event: "push",
    head_branch: "main", head_sha: "c".repeat(40), created_at: created, run_started_at: created, updated_at: created,
    html_url: `https://github.com/${repo}/actions/runs/${id}`, actor: { login: "alice", avatar_url: null, html_url: "https://github.com/alice" },
    repository: { full_name: repo },
  });
  // 22 runs; 119, 120 and 121 started in the same second, 119 the last of the
  // first page.
  const runs = Array.from({ length: 22 }, (_, i) => restRun(100 + i, i < 19 ? `2026-10-19T10:${String(59 - i).padStart(2, "0")}:00Z` : "2026-10-19T10:00:00Z"));
  const github = () => {
    const asked: string[] = [];
    const fetchImpl = async (url: string) => {
      if (url === GQL) return json({ data: { viewer: { repositories: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ nameWithOwner: "octo-org/a" }] } } } });
      const params = new URL(url).searchParams;
      asked.push(params.get("created") ?? "");
      const before = params.get("created")?.replace("<=", "");
      const list = runs.filter(r => !before || r.created_at <= before);
      return json({ total_count: list.length, workflow_runs: list.slice(0, 20) });
    };
    return { c: createGithubClient({ token: TOKEN, fetchImpl, now: () => NOW }), asked };
  };
  const read = (c: object, query: Record<string, string>) => forgeRead(c, "GET", "pipelines", new URLSearchParams(query));

  it("reads the next page through the route with the cursor the first page gave", async () => {
    const { c, asked } = github();
    const first = await read(c, {});
    expect(first.status).toBe(200);
    expect(first.body.data.items).toHaveLength(20);
    const cursor = first.body.data.next;
    expect(cursor).toBe("2026-10-19T10:00:00Z~119");
    const second = await read(c, { cursor });
    expect(second).toMatchObject({ status: 200, body: { ok: true } });
    expect(second.body.data.items.map((p: { id: string }) => p.id)).toEqual(["120", "121"]);
    expect(second.body.data.next).toBeNull();
    expect(asked).toEqual(["", "<=2026-10-19T10:00:00Z"]);
  });

  it("takes a cursor carrying several runs of the boundary second", async () => {
    const calls: unknown[] = [];
    const client = { listPipelines: async (args: unknown) => { calls.push(args); return { items: [], next: null, total: null }; } };
    expect((await read(client, { cursor: "2026-10-19T10:00:00Z~119.120.121" })).status).toBe(200);
    expect(calls).toEqual([{ repo: null, cursor: "2026-10-19T10:00:00Z~119.120.121" }]);
  });

  it("still refuses a cursor with anything a cursor never has", async () => {
    const client = { listPipelines: async () => ({ items: [], next: null, total: null }) };
    for (const cursor of ["a b", "x&created=<=1", "<script>", "a\nb", "~".repeat(513)]) {
      const r = await read(client, { cursor });
      expect([r.status, r.body.error.kind], JSON.stringify(cursor)).toEqual([400, "invalid"]);
    }
  });
});

describe("a job log's tail that ends on blank lines", () => {
  const URL_ = "https://gitlab.example.com/api/v4/projects/1/jobs/1/trace";
  /** A transport whose log arrives in the given chunks. */
  const tailOf = (chunks: string[], lines: number) => {
    const fetchImpl = async () => new Response(new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/plain" } });
    const t = createForgeTransport({ token: TOKEN, authHeaders: (tok: string) => ({ authorization: `Bearer ${tok}` }), allowedOrigins: ["https://gitlab.example.com"], fetchImpl, now: () => NOW });
    return t.tail(URL_, { lines });
  };
  const real = Array.from({ length: 60 }, (_, i) => `step ${i}`).join("\n") + "\nreal\n";

  it("keeps the log's last real lines, however many blank ones follow them", async () => {
    for (const blanks of [41, 50, 100, 1000]) {
      const r = await tailOf([real + "\n".repeat(blanks)], 10);
      expect(r, `${blanks} blank lines`).toEqual({
        lines: ["step 51", "step 52", "step 53", "step 54", "step 55", "step 56", "step 57", "step 58", "step 59", "real"],
        truncated: true,
      });
    }
  });

  it("keeps the same lines whatever chunks the body arrives in", async () => {
    const body = real + "\n".repeat(50);
    const whole = await tailOf([body], 10);
    for (const cut of [1, 7, 100, 300, body.length - 9]) {
      expect(await tailOf([body.slice(0, cut), body.slice(cut)], 10), `cut at ${cut}`).toEqual(whole);
    }
    expect(await tailOf(body.split(/(?<=\n)/), 10)).toEqual(whole);
  });

  it("keeps the blank lines between real ones", async () => {
    const r = await tailOf(["a\n\n\nb\n" + "\n".repeat(200)], 10);
    expect(r).toEqual({ lines: ["a", "", "", "b"], truncated: false });
  });

  it("keeps the last lines of a long blank run in the middle, as before", async () => {
    const r = await tailOf(["a\n" + "\n".repeat(500) + "b\nc\n"], 5);
    expect(r).toEqual({ lines: ["", "", "", "b", "c"], truncated: true });
  });
});
