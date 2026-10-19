// #2179: forge-routes.mjs turns a panel's read — the path after
// /api/integrations/<kind>/<connId>/ and its query — into one call on the
// connection's GitHub or GitLab client.
//
// What these pin: each sub-path reaches its method with checked, typed
// arguments and defaults; a malformed parameter is a 400 before the forge is
// asked anything; only GET is served; an unknown read is a 404; and a forge's
// own failure answers 502 with its kind, never with the message of an error
// that was not the forge's.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module, no types
import { FORGE_READS, forgeRead } from "../../server/forge-routes.mjs";
// @ts-expect-error — plain JS module, no types
import { ForgeError } from "../../server/forge-http.mjs";

/** A client that records each call and answers with its name and arguments. */
function fakeClient(fail?: Error) {
  const calls: [string, unknown[]][] = [];
  const methods = [
    "listRepos", "listBranches", "getBranch", "listChanges", "countChanges", "getChange", "listChangeCommits",
    "listChangePipelines", "listChangeFiles", "listPipelines", "getPipeline", "jobLogTail", "listIssues",
    "getIssue", "listIssueComments", "resolveRef",
  ];
  const client = Object.fromEntries(methods.map(m => [m, async (...args: unknown[]) => {
    calls.push([m, args]);
    if (fail) throw fail;
    return { m };
  }]));
  return { client, calls };
}

const read = (client: object, path: string, query = "", method = "GET") =>
  forgeRead(client, method, path, new URLSearchParams(query));

describe("reads reach their method", () => {
  it("passes typed arguments, with defaults for the words left out", async () => {
    const { client, calls } = fakeClient();
    expect(await read(client, "changes", "repo=group/sub/project&filter=review&cursor=abc")).toEqual({ status: 200, body: { ok: true, data: { m: "listChanges" } } });
    await read(client, "change", "repo=owner/repo&number=5093");
    await read(client, "change/files", "repo=owner/repo&number=12&cursor=2");
    await read(client, "pipeline", "repo=owner/repo&id=18512345678");
    await read(client, "job-log", "repo=owner/repo&id=4242&lines=5000");
    await read(client, "issues");
    await read(client, "branch", "repo=owner/repo&name=feature/x-1");
    expect(calls).toEqual([
      ["listChanges", [{ repo: "group/sub/project", filter: "review", state: "open", sort: "created", cursor: "abc" }]],
      ["getChange", ["owner/repo", 5093]],
      ["listChangeFiles", ["owner/repo", 12, { cursor: "2" }]],
      ["getPipeline", ["owner/repo", 18512345678]],
      ["jobLogTail", ["owner/repo", "4242", { lines: 500 }]],
      ["listIssues", [{ repo: null, state: "open", cursor: undefined }]],
      ["getBranch", ["owner/repo", "feature/x-1"]],
    ]);
  });

  it("has a read for every method a client offers", () => {
    expect(FORGE_READS).toEqual([
      "repos", "branches", "branch", "changes", "change-counts", "change", "change/commits", "change/pipelines",
      "change/files", "pipelines", "pipeline", "job-log", "issues", "issue", "issue/comments", "resolve",
    ]);
  });
});

describe("what is refused before the forge hears of it", () => {
  it.each([
    ["change", "repo=owner/repo&number=0"],
    ["change", "repo=owner/repo&number=12abc"],
    ["change", "number=3"],
    ["branches", "repo=../../etc"],
    ["branches", "repo=owner/repo?x=1"],
    ["branches", "repo=justone"],
    ["changes", "filter=everyone"],
    ["changes", "state=draft"],
    ["changes", "cursor=" + encodeURIComponent("a b")],
    ["job-log", "repo=owner/repo&id=../../x"],
    ["branch", "repo=owner/repo&name=" + encodeURIComponent("a b")],
    ["resolve", "q=%20"],
  ])("%s?%s is a 400", async (path, query) => {
    const { client, calls } = fakeClient();
    const r = await read(client, path, query);
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("serves GET only, and nothing it does not know", async () => {
    const { client, calls } = fakeClient();
    expect((await read(client, "changes", "", "POST")).status).toBe(405);
    expect((await read(client, "merge", "repo=a/b&number=1")).status).toBe(404);
    expect((await read(client, "constructor")).status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("when the forge fails", () => {
  it("answers 502 with the forge's kind and wait", async () => {
    const { client } = fakeClient(new ForgeError("rate-limit", "API rate limit exceeded", { status: 403, retryAfter: 40 }));
    expect(await read(client, "branches", "repo=owner/repo")).toEqual({
      status: 502,
      body: { ok: false, forge: { kind: "rate-limit", message: "API rate limit exceeded", status: 403, retryAfter: 40 } },
    });
  });

  it("does not pass on the message of an error that was not the forge's", async () => {
    const { client } = fakeClient(new Error("internal detail"));
    const r = await read(client, "branches", "repo=owner/repo");
    expect(r.body).toEqual({ ok: false, forge: { kind: "upstream", message: "unexpected error reading the forge" } });
  });
});
