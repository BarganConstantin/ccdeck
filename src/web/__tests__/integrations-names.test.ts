// The words a tracker or a forge answers with, looked up in the providers'
// own tables, must find only the tables' own entries. A plain object
// also answers to the names every object inherits — `constructor`,
// `toString`, `__proto__` and the rest — so a status, a colour or a column
// with one of those names found a function: a kanban column named
// `constructor` sent Object's source text to Jira as JQL, an epic's colour
// became a function, and a GitLab failure reason read
// "function Object() { [native code] }". Each such name now reads as a name
// the table does not have. Every tracker here is a fake fetch.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createJiraClient, jiraRoutes } from "../../server/integrations/jira.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { gitlabCiState, humanFailureReason } from "../../server/gitlab-api.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createGithubClient, githubCheckState, githubRollupState } from "../../server/github-api.mjs";

/** The names every plain object answers to without having them. */
const INHERITED = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "__proto__", "toLocaleString", "propertyIsEnumerable"];
/** A fake token, built at run time so no literal here reads as a live one. */
const fakeToken = (seed: string) => ["fake", seed, "token", "0123456789abcdef"].join("-");

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("GitLab's words", () => {
  it("reads an inherited name as no CI state", () => {
    for (const name of INHERITED) {
      expect(gitlabCiState(name), name).toBe("none");
      expect(gitlabCiState(name.toUpperCase()), name).toBe("none");
    }
  });

  it("writes a failure reason made of inherited names as its words", () => {
    expect(humanFailureReason("constructor")).toBe("Constructor");
    expect(humanFailureReason("constructor_failure")).toBe("Constructor failure");
    expect(humanFailureReason("script_failure")).toBe("Script failure");
    expect(humanFailureReason("api_failure")).toBe("API failure");
  });
});

describe("GitHub's words", () => {
  it("reads an inherited name as no check or rollup state", () => {
    for (const name of INHERITED) {
      expect(githubCheckState("completed", name), name).toBe("none");
      expect(githubCheckState(name, null), name).toBe("none");
      expect(githubRollupState(name), name).toBe("none");
    }
  });

  it("reads a changed file's inherited status as modified", async () => {
    const fetchImpl = async () => json(INHERITED.map((status, i) => ({ filename: `src/f${i}.ts`, status, additions: 1, deletions: 0 })));
    const c = createGithubClient({ token: fakeToken("d9-github"), fetchImpl, now: () => 1_700_000_000_000 });
    const p = await c.listChangeFiles("octo-org/widgets", 1);
    expect(p.items.map((f: { status: unknown }) => f.status)).toEqual(INHERITED.map(() => "modified"));
  });
});

describe("Jira's words", () => {
  const SITE = "https://jira.example.com";
  const conn = { id: "c1", kind: "jira", baseUrl: SITE, allowedOrigins: [SITE], meta: { deployment: "server" } };
  const secret = { auth: "bearer", token: fakeToken("d9-jira") };
  const FIELDS = [
    { id: "customfield_10010", name: "Epic Link", custom: true, schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" } },
    { id: "customfield_10020", name: "Issue color", custom: true, schema: { custom: "com.pyxis.greenhopper.jira:jsw-issue-color" } },
  ];
  /** A Jira answering by path, recording every path and query it was asked. */
  const jira = (answer: (u: URL) => Response | undefined) => {
    const asked: string[] = [];
    const fetchImpl = async (url: string) => {
      const u = new URL(url);
      asked.push(`${u.pathname}${u.search}`);
      if (u.pathname === "/rest/api/2/field") return json(FIELDS);
      if (u.pathname === "/rest/agile/1.0/board/1/configuration") return json({ columnConfig: { columns: [] } });
      return answer(u) ?? json({ errorMessages: ["no such route"] }, 404);
    };
    return { asked, client: createJiraClient(conn, secret, { fetchImpl }) };
  };

  it("refuses a kanban column with an inherited name before Jira is asked for issues", async () => {
    for (const column of INHERITED) {
      const { asked, client } = jira(() => json({ issues: [], total: 0, startAt: 0, maxResults: 50 }));
      const r = await jiraRoutes(client, "GET", "board/1/issues", new URLSearchParams({ source: "kanban", column }), null, {});
      expect([r.status, r.body?.error?.kind], column).toEqual([400, "invalid"]);
      expect(asked.filter(p => /\/board\/1\/issue(\?|$)|\/search/.test(p)), column).toEqual([]);
    }
  });

  it("still reads a kanban column that is one", async () => {
    const { asked, client } = jira(u => (u.pathname === "/rest/agile/1.0/board/1/issue" ? json({ issues: [], total: 0, startAt: 0, maxResults: 50 }) : undefined));
    const r = await jiraRoutes(client, "GET", "board/1/issues", new URLSearchParams({ source: "kanban", column: "todo" }), null, {});
    expect(r.status).toBe(200);
    const issueReads = asked.filter(p => p.startsWith("/rest/agile/1.0/board/1/issue?"));
    expect(issueReads).toHaveLength(1);
    expect(new URLSearchParams(issueReads[0].split("?")[1]).get("jql")).toContain('statusCategory = "To Do"');
  });

  it("gives an epic whose issue colour has an inherited name no colour", async () => {
    for (const colour of ["constructor", "toString", "__proto__", "dark_teal"]) {
      const { client } = jira(u => {
        if (u.pathname === "/rest/agile/1.0/board/1/backlog") {
          return json({ startAt: 0, maxResults: 50, total: 1, issues: [{ id: "1", key: "A-1", fields: { summary: "A story", customfield_10010: "A-9", issuetype: { name: "Story" }, status: { name: "To Do", statusCategory: { key: "new" } } } }] });
        }
        if (u.pathname === "/rest/api/2/search") {
          return json({ startAt: 0, maxResults: 50, total: 1, issues: [{ id: "9", key: "A-9", fields: { summary: "The epic", customfield_10020: colour } }] });
        }
        return undefined;
      });
      const r = await jiraRoutes(client, "GET", "board/1/issues", new URLSearchParams({ source: "backlog" }), null, {});
      expect(r.status, colour).toBe(200);
      const epic = r.body.issues[0].epic;
      expect(epic?.key, colour).toBe("A-9");
      expect(epic.color, colour).toBe(colour === "dark_teal" ? 5 : null);
    }
  });
});
