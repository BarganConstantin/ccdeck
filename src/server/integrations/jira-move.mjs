// One bounded Jira write: a top-level issue's sprint/backlog membership and
// rank. No URL, method, field id or arbitrary Jira body comes from the caller.
// Both Cloud and Server/DC support these Agile endpoints. Use assignment then
// rank separately: older Server schemas accept only `issues` on assignment.
// https://docs.atlassian.com/jira-software/REST/9.12.0/
// https://developer.atlassian.com/cloud/jira/software/rest/api-group-issue/
import { errorFromFetchFailure, errorFromStatus, errorResponse, integrationError } from "./errors.mjs";
import { isSafeTarget, originOf } from "./proxy.mjs";

const KEY = /^[A-Z][A-Z0-9_]{0,40}-[1-9]\d{0,11}$/;
const positiveId = n => Number.isSafeInteger(n) && n > 0 && n <= 999_999_999_999;
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const only = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
const invalid = message => integrationError("invalid", message);

export function parseJiraMove(body) {
  if (!only(body, ["issueKey", "target", "beforeIssue", "afterIssue"])) throw invalid("Supply one issue and a sprint or backlog target.");
  const key = value => typeof value === "string" && value === value.trim() && KEY.test(value) ? value : null;
  const issueKey = key(body.issueKey);
  const t = body.target;
  if (!issueKey || !only(t, t?.kind === "sprint" ? ["kind", "sprintId"] : ["kind"]) ||
    !(t.kind === "backlog" || (t.kind === "sprint" && positiveId(t.sprintId)))) throw invalid("Not a valid issue key or move target.");
  const beforeIssue = Object.hasOwn(body, "beforeIssue") ? key(body.beforeIssue) : undefined;
  const afterIssue = Object.hasOwn(body, "afterIssue") ? key(body.afterIssue) : undefined;
  if (beforeIssue === null || afterIssue === null || (beforeIssue && afterIssue) || beforeIssue === issueKey || afterIssue === issueKey) {
    throw invalid("Use at most one other issue as the rank anchor.");
  }
  return { issueKey, target: t.kind === "sprint" ? { kind: "sprint", sprintId: t.sprintId } : { kind: "backlog" }, beforeIssue, afterIssue };
}

/** Conservative support, not a claim about the token's write permissions. */
export function jiraMoveCapability(config, filter) {
  const rank = config?.ranking?.rankCustomFieldId;
  if (config?.type !== "scrum" || !positiveId(rank)) return { enabled: false, reason: "Moving requires a Scrum board with a configured rank field." };
  // Rank order must be the only ordering. An extra sort can make a successful
  // rank invisible. Accept Jira's Rank alias or the configured field's JQL id.
  const order = /\border\s+by\s+(.+)$/i.exec(String(filter?.jql ?? ""))?.[1]?.trim();
  const field = order && /^(?:Rank|"Rank"|cf\[(\d+)\])\s+ASC$/i.exec(order);
  if (!field || (field[1] && Number(field[1]) !== rank)) return { enabled: false, reason: "Moving requires the board filter to end with ORDER BY Rank ASC." };
  return { enabled: true, rankCustomFieldId: rank };
}

export async function readJiraMoveCapability(read, agile, rest, boardId, config) {
  const cfg = config ?? await read.json(`${agile}/board/${boardId}/configuration`);
  if (cfg?.type !== "scrum" || !positiveId(cfg?.ranking?.rankCustomFieldId) || !/^\d{1,12}$/.test(String(cfg?.filter?.id ?? ""))) return jiraMoveCapability(cfg, null);
  const filter = await read.json(`${rest}/filter/${cfg.filter.id}`);
  return jiraMoveCapability(cfg, filter);
}

/** Only this closure can sign a write. The returned API takes a validated
 * move, never an upstream address or HTTP method. */
export function createJiraMover({ secret, origins, sign, authCheck, fetchImpl = globalThis.fetch, reader, agile, rest, invalidate }) {
  async function write(suffix, method, body, issueKey, signal) {
    const url = `${agile}/${suffix}`;
    if (!isSafeTarget(url) || !origins().includes(originOf(url))) throw integrationError("permission", "This Jira write is outside the connection's token origins.");
    const controller = new AbortController();
    const stop = () => controller.abort(signal?.reason);
    if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer.unref?.();
    let res;
    try {
      try {
        res = await fetchImpl(url, { method, redirect: "manual", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "ccdeck", ...sign(secret) }, body: JSON.stringify(body), signal: controller.signal });
      } catch (err) { throw errorFromFetchFailure(err, "Jira"); }
      // Never follow even a same-origin redirect: replaying a write is unsafe.
      if (res.status >= 300 && res.status < 400) throw integrationError("upstream", "Jira redirected the write. It was not replayed; refresh the board before trying again.", { status: res.status });
      const refused = authCheck(res.headers, secret);
      if (refused) throw integrationError("expired", refused, { status: 401 });
      if (res.status === 204) return;
      if (res.status === 207) {
        // A single issue was sent. Only an explicit successful entry for that
        // exact key is success; don't treat HTTP 207's `ok` as all successful.
        let size = 0;
        const chunks = [];
        if (res.body) for await (const chunk of res.body) {
          size += chunk.byteLength;
          if (size > 32_000) throw integrationError("upstream", "Jira's rank result was too large. Refresh the board to check its position.", { status: 207 });
          chunks.push(Buffer.from(chunk));
        }
        let json;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* unknown result */ }
        const entries = json?.entries;
        const entry = Array.isArray(entries) && entries.length === 1 && entries[0]?.issueKey === issueKey ? entries[0] : null;
        if (entry && Number.isInteger(entry.status) && entry.status >= 200 && entry.status < 300) return;
        if (entry && Number.isInteger(entry.status) && entry.status >= 400 && entry.status < 600) throw errorFromStatus(entry.status, res.headers, { label: "Jira" });
        throw integrationError("upstream", "Jira did not confirm the issue's rank. Refresh the board to check its position.", { status: 207 });
      }
      if (!res.ok) {
        const err = errorFromStatus(res.status, res.headers, { label: "Jira" });
        if (res.status === 403) err.message = "Jira refused the move: the account or token needs permission to edit and schedule this issue.";
        throw err;
      }
      throw integrationError("upstream", "Jira did not confirm the write. Refresh the board to check the issue.", { status: res.status });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      await res?.body?.cancel().catch(() => {});
    }
  }

  return async (boardId, input, signal) => {
    const move = parseJiraMove(input);
    const { issueKey, target, beforeIssue, afterIssue } = move;
    const anchor = beforeIssue ?? afterIssue;
    const read = reader(signal);
    const outcome = { membership: "unchanged", rank: "unchanged" };
    let attempted = false;
    let stage = "membership";
    try {
      if (!/^[1-9]\d{0,11}$/.test(boardId) || boardId !== boardId.trim()) throw invalid("Not a board id.");
      // No cached authorization, ordering, membership or sprint-state reads.
      const board = await read.json(`${agile}/board/${boardId}`);
      const cfg = await read.json(`${agile}/board/${boardId}/configuration`);
      const capability = await readJiraMoveCapability(read, agile, rest, boardId, { ...cfg, type: board?.type });
      if (!capability.enabled) throw invalid(capability.reason);
      const keys = [issueKey, ...(anchor ? [anchor] : [])];
      const params = new URLSearchParams({ jql: `key in (${keys.join(",")})`, fields: "issuetype,status,sprint", maxResults: "2" });
      const page = await read.json(`${agile}/board/${boardId}/issue?${params}`);
      const issues = Array.isArray(page?.issues) ? page.issues : [];
      for (const key of keys) {
        const issue = issues.find(i => i.key === key);
        if (!issue) throw invalid("The issue and anchor must both belong to this board.");
        if (issue.fields?.issuetype?.subtask !== false) throw invalid("The issue and rank anchor must be top-level issues.");
        if (key === issueKey && (issue.fields?.issuetype?.name?.toLowerCase() === "epic" || !["new", "indeterminate"].includes(issue.fields?.status?.statusCategory?.key))) {
          throw invalid("Only unfinished top-level non-epic issues can be moved.");
        }
      }
      const issue = issues.find(i => i.key === issueKey);
      const raw = issue.fields?.sprint;
      const current = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
      if (current.length > 1 || current.some(s => !positiveId(s?.id) || !["active", "future"].includes(s?.state))) throw invalid("The issue must be in the backlog or one active or future sprint.");
      const source = current.length ? { kind: "sprint", sprintId: current[0].id } : { kind: "backlog" };
      const wanted = new Set([...(source.kind === "sprint" ? [source.sprintId] : []), ...(target.kind === "sprint" ? [target.sprintId] : [])]);
      // A sprint visible elsewhere is not enough: it must be on this board.
      for (let startAt = 0, guard = 0; wanted.size && guard < 20; guard++) {
        const q = new URLSearchParams({ state: "active,future", startAt: String(startAt), maxResults: "50" });
        const sprints = await read.json(`${agile}/board/${boardId}/sprint?${q}`);
        const values = Array.isArray(sprints?.values) ? sprints.values : [];
        for (const s of values) if (["active", "future"].includes(s?.state)) wanted.delete(s.id);
        if (!values.length || sprints.isLast === true) break;
        startAt += values.length;
      }
      if (wanted.size) throw invalid("The source and target must be active or future sprints on this board.");
      const inGroup = async (key, group) => {
        const suffix = group.kind === "sprint" ? `sprint/${group.sprintId}/issue` : "backlog";
        const q = new URLSearchParams({ jql: `key = ${key}`, fields: "issuetype", maxResults: "1" });
        const answer = await read.json(`${agile}/board/${boardId}/${suffix}?${q}`);
        return Array.isArray(answer?.issues) && answer.issues.some(i => i.key === key);
      };
      if (!await inGroup(issueKey, source)) throw invalid("The issue's source changed or is a closed sprint. Refresh the board.");
      if (anchor && !await inGroup(anchor, target)) throw invalid("The rank anchor must be in the target group. Refresh the board.");
      const sameGroup = source.kind === target.kind && (source.kind === "backlog" || source.sprintId === target.sprintId);
      if (!sameGroup) {
        attempted = true;
        const suffix = target.kind === "sprint" ? `sprint/${target.sprintId}/issue` : "backlog/issue";
        await write(suffix, "POST", { issues: [issueKey] }, issueKey, signal);
        outcome.membership = "moved";
      }
      if (anchor) {
        stage = "rank";
        attempted = true;
        await write("issue/rank", "PUT", { issues: [issueKey], rankCustomFieldId: capability.rankCustomFieldId,
          ...(beforeIssue ? { rankBeforeIssue: beforeIssue } : { rankAfterIssue: afterIssue }) }, issueKey, signal);
        outcome.rank = "ranked";
      }
      return { status: 200, body: { ok: true, issueKey, target, refresh: true } };
    } catch (err) {
      const result = errorResponse(err);
      if (attempted) {
        const rejected = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500;
        if (stage === "membership") outcome.membership = rejected ? "unchanged" : "unknown";
        else outcome.rank = rejected ? "failed" : "unknown";
        const prefix = outcome.membership === "moved" ? "The issue moved, but its requested position was not confirmed. " : "";
        result.body.error.message = `${prefix}${result.body.error.message} Refresh the board before trying again.`;
        result.body.refresh = true;
        result.body.outcome = outcome;
      }
      return result;
    } finally {
      // Also after timeouts/redirects/partial failure: the remote may have
      // applied a write. Replace the cache so older in-flight reads cannot
      // repopulate the cache future requests use.
      if (attempted) invalidate();
    }
  };
}
