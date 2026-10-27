// One bounded Jira write: up to 50 top-level issues' sprint/backlog membership and
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
  if (!only(body, ["issueKey", "issueKeys", "target", "beforeIssue", "afterIssue"]) || Object.hasOwn(body, "issueKey") === Object.hasOwn(body, "issueKeys")) {
    throw invalid("Supply either one issueKey or 2–50 ordered issueKeys and a sprint or backlog target.");
  }
  const key = value => typeof value === "string" && value === value.trim() && KEY.test(value) ? value : null;
  const batch = Object.hasOwn(body, "issueKeys");
  const issueKeys = batch ? body.issueKeys : [body.issueKey];
  if (!Array.isArray(issueKeys) || issueKeys.length < (batch ? 2 : 1) || issueKeys.length > 50 ||
    issueKeys.some(value => !key(value)) || new Set(issueKeys).size !== issueKeys.length) throw invalid("Supply unique, valid issue keys (2–50 for a batch).");
  const t = body.target;
  if (!only(t, t?.kind === "sprint" ? ["kind", "sprintId"] : ["kind"]) ||
    !(t.kind === "backlog" || (t.kind === "sprint" && positiveId(t.sprintId)))) throw invalid("Not a valid issue key or move target.");
  const beforeIssue = Object.hasOwn(body, "beforeIssue") ? key(body.beforeIssue) : undefined;
  const afterIssue = Object.hasOwn(body, "afterIssue") ? key(body.afterIssue) : undefined;
  if (beforeIssue === null || afterIssue === null || (beforeIssue && afterIssue) || issueKeys.includes(beforeIssue) || issueKeys.includes(afterIssue)) {
    throw invalid("Use at most one other issue as the rank anchor.");
  }
  return { issueKeys: issueKeys.slice(), batch, target: t.kind === "sprint" ? { kind: "sprint", sprintId: t.sprintId } : { kind: "backlog" }, beforeIssue, afterIssue };
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
  async function write(suffix, method, body, issueKeys, signal) {
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
        // Every requested key needs exactly one explicit success. A missing,
        // duplicate or unrecognized entry is uncertainty, never success.
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
        const recognized = Array.isArray(entries) && entries.every(e => issueKeys.includes(e?.issueKey));
        const results = new Map(issueKeys.map(key => {
          const matches = recognized ? entries.filter(e => e.issueKey === key) : [];
          const status = matches.length === 1 && Number.isInteger(matches[0].status) ? matches[0].status : null;
          return [key, { status, state: status >= 200 && status < 300 ? "succeeded" : status >= 400 && status < 500 ? "failed" : "unknown" }];
        }));
        if ([...results.values()].every(r => r.state === "succeeded")) return;
        const single = issueKeys.length === 1 ? results.get(issueKeys[0]) : null;
        const err = single?.status >= 400 && single.status < 600
          ? errorFromStatus(single.status, res.headers, { label: "Jira" })
          : integrationError("upstream", "Jira did not confirm every requested issue update. Some issues may have changed; refresh the board to check them.", { status: 207 });
        err.writeOutcomes = results;
        throw err;
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
    const { issueKeys, batch, target, beforeIssue, afterIssue } = move;
    const anchor = beforeIssue ?? afterIssue;
    const read = reader(signal);
    const outcomes = new Map(issueKeys.map(key => [key, { membership: "unchanged", rank: "unchanged" }]));
    let attempted = false;
    let stage = "membership";
    let pendingKeys = [];
    try {
      if (!/^[1-9]\d{0,11}$/.test(boardId) || boardId !== boardId.trim()) throw invalid("Not a board id.");
      // No cached authorization, ordering, membership or sprint-state reads.
      const board = await read.json(`${agile}/board/${boardId}`);
      const cfg = await read.json(`${agile}/board/${boardId}/configuration`);
      const capability = await readJiraMoveCapability(read, agile, rest, boardId, { ...cfg, type: board?.type });
      if (!capability.enabled) throw invalid(capability.reason);
      const keys = [...issueKeys, ...(anchor ? [anchor] : [])];
      // The board may cap a page below 51 (50 moved keys plus their anchor).
      // Read only these validated keys, stopping on no progress or at the bound.
      const readIssues = async (suffix, selected, fields) => {
        const found = new Map();
        for (let startAt = 0, guard = 0; found.size < selected.length && guard < selected.length; guard++) {
          const q = new URLSearchParams({ jql: `key in (${selected.join(",")})`, fields, maxResults: String(selected.length), startAt: String(startAt) });
          const page = await read.json(`${agile}/board/${boardId}/${suffix}?${q}`);
          const values = Array.isArray(page?.issues) ? page.issues : [];
          const count = found.size;
          for (const issue of values) if (selected.includes(issue?.key)) found.set(issue.key, issue);
          if (found.size === count || page?.isLast === true || (Number.isInteger(page?.total) && startAt + values.length >= page.total)) break;
          startAt += values.length;
        }
        return found;
      };
      const issues = await readIssues("issue", keys, "issuetype,status,sprint");
      for (const key of keys) {
        const issue = issues.get(key);
        if (!issue) throw invalid("The issues and anchor must all belong to this board.");
        if (issue.fields?.issuetype?.subtask !== false) throw invalid("The issues and rank anchor must be top-level issues.");
        // Match Jira's issue normalizer, including renamed epic-level types.
        const type = issue.fields?.issuetype;
        const epic = type?.hierarchyLevel === 1 || /^epic$/i.test(String(type?.name ?? ""));
        if (issueKeys.includes(key) && (epic || !["new", "indeterminate"].includes(issue.fields?.status?.statusCategory?.key))) {
          throw invalid("Only unfinished top-level non-epic issues can be moved.");
        }
      }
      const sources = new Map();
      const sameGroup = source => source.kind === target.kind && (source.kind === "backlog" || source.sprintId === target.sprintId);
      const groupId = group => group.kind === "backlog" ? "backlog" : `sprint:${group.sprintId}`;
      const groups = new Map();
      const wanted = new Set(target.kind === "sprint" ? [target.sprintId] : []);
      for (const key of issueKeys) {
        const raw = issues.get(key).fields?.sprint;
        const current = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
        if (current.length > 1 || current.some(s => !positiveId(s?.id) || !["active", "future"].includes(s?.state))) throw invalid("Every issue must be in the backlog or one active or future sprint.");
        const source = current.length ? { kind: "sprint", sprintId: current[0].id } : { kind: "backlog" };
        sources.set(key, source);
        if (source.kind === "sprint") wanted.add(source.sprintId);
        const id = groupId(source);
        if (!groups.has(id)) groups.set(id, { group: source, keys: [] });
        groups.get(id).keys.push(key);
      }
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
      const groupSuffix = group => group.kind === "sprint" ? `sprint/${group.sprintId}/issue` : "backlog";
      for (const { group, keys } of groups.values()) {
        const found = await readIssues(groupSuffix(group), keys, "issuetype");
        if (keys.some(key => !found.has(key))) throw invalid("An issue's source changed or is a closed sprint. Refresh the board.");
      }
      if (anchor && !(await readIssues(groupSuffix(target), [anchor], "issuetype")).has(anchor)) throw invalid("The rank anchor must be in the target group. Refresh the board.");
      const needed = issueKeys.filter(key => !sameGroup(sources.get(key)));
      if (needed.length) {
        attempted = true;
        pendingKeys = needed;
        const suffix = target.kind === "sprint" ? `sprint/${target.sprintId}/issue` : "backlog/issue";
        await write(suffix, "POST", { issues: needed }, needed, signal);
        for (const key of needed) outcomes.get(key).membership = "moved";
      }
      if (anchor) {
        stage = "rank";
        attempted = true;
        pendingKeys = issueKeys;
        await write("issue/rank", "PUT", { issues: issueKeys, rankCustomFieldId: capability.rankCustomFieldId,
          ...(beforeIssue ? { rankBeforeIssue: beforeIssue } : { rankAfterIssue: afterIssue }) }, issueKeys, signal);
        for (const key of issueKeys) outcomes.get(key).rank = "ranked";
      }
      return { status: 200, body: { ok: true, ...(batch ? { issueKeys } : { issueKey: issueKeys[0] }), target, refresh: true } };
    } catch (err) {
      const result = errorResponse(err);
      if (attempted) {
        const rejected = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500;
        for (const key of pendingKeys) {
          const state = err?.writeOutcomes?.get(key)?.state ?? (rejected ? "failed" : "unknown");
          outcomes.get(key)[stage] = state === "succeeded" ? (stage === "membership" ? "moved" : "ranked")
            : state === "failed" ? (stage === "membership" ? "unchanged" : "failed") : "unknown";
        }
        const summarize = field => {
          const states = new Set([...outcomes.values()].map(o => o[field]));
          return states.size === 1 ? [...states][0] : states.has("unknown") ? "unknown" : "partial";
        };
        const outcome = { membership: summarize("membership"), rank: summarize("rank") };
        const updated = [...outcomes.values()].some(o => o.membership === "moved" || o.rank === "ranked");
        const prefix = batch && updated ? "Some issues were updated, but the whole batch was not confirmed. "
          : !batch && outcome.membership === "moved" ? "The issue moved, but its requested position was not confirmed. " : "";
        result.body.error.message = `${prefix}${result.body.error.message} Refresh the board before trying again.`;
        result.body.refresh = true;
        result.body.outcome = outcome;
        if (batch) result.body.outcomes = issueKeys.map(issueKey => ({ issueKey, ...outcomes.get(issueKey) }));
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
