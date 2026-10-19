// The GitHub and GitLab panels' reads, as one route each (#2179).
//
// The integrations core (#2178) owns the address — /api/integrations/<kind>/
// <connId>/… — the connection, and the token; it hands this file a client made
// for that connection (github-api.mjs or gitlab-api.mjs, the same interface)
// and the rest of the path. What is here is the part that is the same for both
// forges: which sub-path is which read, what its parameters must look like
// before anything is asked of the forge, and how an answer or a failure goes
// back to the page.
//
// GET ONLY, AND EVERY PARAMETER CHECKED. The panels read; nothing here writes
// to a forge, and a parameter that is not the shape it should be is a 400
// before the forge hears of it — a repository path is a path, a number is a
// positive integer, a filter is one of its words.
//
// ONE ENVELOPE FOR EVERY INTEGRATION. A failure answers { ok: false, error:
// { kind, message, status?, retryAfter? } } — the same shape the Jira panel's
// reads answer in (#2178) — with the HTTP status the kind implies: 401 for a
// token refused or expired, 403 permission, 404 not found, 429 rate limit,
// 502 for a forge that could not be reached or answered wrongly, 400 for a
// parameter that is not the shape it should be. The page picks its recovery
// from `kind`, never from the status.
import { forgeErrorInfo } from "./forge-http.mjs";

const STATUS_OF_KIND = {
  auth: 401, expired: 401, permission: 403, "not-found": 404, "rate-limit": 429,
  unreachable: 502, tls: 502, incompatible: 502, upstream: 502, invalid: 400,
};

/** The answer for a failure: the uniform envelope and the status its kind implies. */
export function failure(info, status = STATUS_OF_KIND[info.kind] ?? 502) {
  return { status, body: { ok: false, error: info } };
}

const REPO = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,20}$/;
const CURSOR = /^[A-Za-z0-9_=+/.:-]{1,512}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

class BadRequest extends Error {}

function repo(params, required = true) {
  const v = params.get("repo");
  if (v == null || v === "") {
    if (required) throw new BadRequest("repo is required");
    return null;
  }
  if (v.length > 255 || !REPO.test(v) || v.split("/").some(s => s === "." || s === "..")) throw new BadRequest("repo is not a repository path");
  return v;
}

// Up to fifteen digits: GitHub's workflow run ids are past ten billion already,
// and fifteen still fits a JavaScript number exactly.
function number(params, name = "number") {
  const v = params.get(name);
  if (!/^\d{1,15}$/.test(v ?? "") || Number(v) < 1) throw new BadRequest(`${name} is not a positive number`);
  return Number(v);
}

function oneOf(params, name, words, fallback) {
  const v = params.get(name) ?? fallback;
  if (!words.includes(v)) throw new BadRequest(`${name} must be one of ${words.join(", ")}`);
  return v;
}

function cursor(params) {
  const v = params.get("cursor");
  if (v == null || v === "") return undefined;
  if (!CURSOR.test(v)) throw new BadRequest("cursor is not a cursor");
  return v;
}

function text(params, name, max) {
  const v = params.get(name);
  if (v == null) return undefined;
  if (v.length > max) throw new BadRequest(`${name} is too long`);
  return v;
}

/** Sub-path → the read it is. Each takes the query and the client. */
const READS = {
  "repos": (p, c) => c.listRepos({ search: text(p, "search", 100), cursor: cursor(p) }),
  "branches": (p, c) => c.listBranches(repo(p), { cursor: cursor(p) }),
  "branch": (p, c) => {
    const name = text(p, "name", 255);
    if (!name || /[\0\s]/.test(name)) throw new BadRequest("name is not a branch name");
    return c.getBranch(repo(p), name);
  },
  "changes": (p, c) => c.listChanges({
    repo: repo(p, false),
    filter: oneOf(p, "filter", ["all", "mine", "review"], "all"),
    state: oneOf(p, "state", ["open", "merged", "closed"], "open"),
    sort: oneOf(p, "sort", ["created", "updated"], "created"),
    cursor: cursor(p),
  }),
  "change-counts": (p, c) => c.countChanges({ repo: repo(p, false), filter: oneOf(p, "filter", ["all", "mine", "review"], "all") }),
  "change": (p, c) => c.getChange(repo(p), number(p)),
  "change/commits": (p, c) => c.listChangeCommits(repo(p), number(p), { cursor: cursor(p) }),
  "change/pipelines": (p, c) => c.listChangePipelines(repo(p), number(p)),
  "change/files": (p, c) => c.listChangeFiles(repo(p), number(p), { cursor: cursor(p) }),
  "pipelines": (p, c) => c.listPipelines({ repo: repo(p, false), cursor: cursor(p) }),
  "pipeline": (p, c) => c.getPipeline(repo(p), number(p, "id")),
  "job-log": (p, c) => {
    const id = p.get("id") ?? "";
    if (!JOB_ID.test(id)) throw new BadRequest("id is not a job id");
    const lines = p.get("lines");
    return c.jobLogTail(repo(p), id, { lines: lines && /^\d{1,6}$/.test(lines) ? Math.min(500, Math.max(10, Number(lines))) : 80 });
  },
  "issues": (p, c) => c.listIssues({ repo: repo(p, false), state: oneOf(p, "state", ["open", "closed"], "open"), cursor: cursor(p) }),
  "issue": (p, c) => c.getIssue(repo(p), number(p)),
  "issue/comments": (p, c) => c.listIssueComments(repo(p), number(p), { cursor: cursor(p) }),
  "resolve": (p, c) => {
    const q = text(p, "q", 500)?.trim();
    if (!q) throw new BadRequest("q is required");
    return c.resolveRef(q);
  },
};

/** The sub-paths there are, for the core's route table and for tests. */
export const FORGE_READS = Object.freeze(Object.keys(READS));

/**
 * One panel read.
 *
 * @param {object} client  a github-api.mjs or gitlab-api.mjs client for the connection
 * @param {string} method  the request's method
 * @param {string} subpath what follows /api/integrations/<kind>/<connId>/, without a leading slash
 * @param {URLSearchParams} params
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function forgeRead(client, method, subpath, params) {
  const read = Object.hasOwn(READS, subpath) ? READS[subpath] : null;
  if (!read) return failure({ kind: "not-found", message: "no such read" });
  if (method !== "GET") return failure({ kind: "upstream", message: "the panels only read" }, 405);
  try {
    return { status: 200, body: { ok: true, data: await read(params, client) } };
  } catch (err) {
    if (err instanceof BadRequest) return failure({ kind: "invalid", message: err.message });
    return failure(forgeErrorInfo(err));
  }
}
