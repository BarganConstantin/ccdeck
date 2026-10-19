#!/usr/bin/env node
// mock-jira.mjs — a realistic, local, read-only Jira for testing ccdeck's Jira client.
//
// Two flavours, shaped after Atlassian's official docs:
//   server  Jira Server / Data Center: REST v2 (/rest/api/2) + Jira Software Agile 1.0
//   cloud   Jira Cloud: REST v3 (/rest/api/3) + Agile 1.0, plus a second origin that
//           stands in for https://api.atlassian.com (/ex/jira/{cloudId}/...)
// Pure Node (node:http, node:zlib, node:crypto), ESM, no dependencies, deterministic.
// The data lives in mock-jira-fixtures.mjs.
//
// ── Module API ───────────────────────────────────────────────────────────────
//   import { startMockJira } from "./scripts/mock-jira.mjs";
//   const jira = await startMockJira({ flavor: "server" | "cloud", port: 0, host: "127.0.0.1",
//     apiPort: 0 /* cloud */, version: "9.0.0" /* server */, deploymentType: "Server" | "DataCenter",
//     hoursPerDay: 8, daysPerWeek: 5 });
//   jira.url        site / base URL, e.g. http://127.0.0.1:41234
//   jira.apiUrl     cloud: the api.atlassian.com stand-in (null on server)
//   jira.cloudId    cloud: 11111111-2222-3333-4444-555555555555 (null on server)
//   jira.requests   log: { origin: "site"|"api", method, path, query, auth: "basic"|"bearer"|"none",
//                   authOk, user?, status } — raw tokens are never stored
//   jira.setMode(m) "ok" | "401" | "403" | "429" | "500" | "slow"
//   await jira.close()
//
// ── Credentials ──────────────────────────────────────────────────────────────
//   Server/DC  Authorization: Bearer mock-server-pat  (user jdoe). Anything else -> 401 with
//              X-Seraph-LoginReason: AUTHENTICATED_FAILED (when credentials were sent).
//              GET /rest/api/2/serverInfo also works without auth, as real Jira does.
//   Cloud      Basic jane@example.com : ATATTmockClassicToken0123456789abcdef
//                -> works on the site origin and on the api origin under /ex/jira/{cloudId}/.
//              Basic jane@example.com : ATATTmockScopedToken0123456789abcdef (scoped token)
//                -> 401 "Client must be authenticated to access this resource." on the site,
//                   accepted on the api origin under /ex/jira/{cloudId}/rest/... (as real Jira).
//              GET {site}/_edge/tenant_info (no auth) -> {"cloudId":"..."}.
//              The api origin serves only /ex/jira/{cloudId}/...; a wrong cloudId -> 404. Its
//              401 is the gateway's {"code":401,"message":"Unauthorized"}.
//   Images (/secure/*, /images/*, the redirects) need the same credentials as REST.
//
// ── Modes (setMode / POST /__mock/mode {"mode":"429"}) ───────────────────────
//   Every route that needs auth answers: 401 | 403 | 429 (Retry-After: 30) | 500 | slow
//   (waits 3 s, then answers normally). Anonymous serverInfo, tenant_info and /__mock/* are exempt.
//   Control endpoints on the site origin, no auth: POST /__mock/mode, GET /__mock/mode[?mode=429],
//   GET /__mock/requests (the log as JSON), POST /__mock/reset (log cleared, mode ok).
//
// ── Fixtures (MOCK_NOW = 2026-10-19T12:00:00.000+0300; relative JQL dates count from it) ─
//   Me: Jane Doe (cloud accountId 5b10ac8d82e05b22cc7d4ef5; server jdoe / JIRAUSER10000).
//   Others: Alex Morgan (amorgan), Sam Lee (slee), Priya Patel (ppatel).
//   Projects: MOCK (scrum), KAN (kanban), TWO (scrum).
//   Boards: 1 "MOCK board" (scrum, estimation Original Time Estimate), 2 "KAN board" (kanban,
//     backlog DISABLED -> /backlog is 400), 3 "TWO board" (scrum, TWO ACTIVE sprints at once,
//     estimation story points), 4 "Empty board" (no sprints, empty backlog), 5..62 "Filler board N".
//   Board 1 sprints: MOCK Sprint 1..12 closed (2-4 done issues each, MOCK-100..MOCK-135),
//     MOCK Sprint 13 active (2026-10-13 -> 2026-10-27), MOCK Sprint 14 + 15 future.
//   Active sprint 13 in rank order: MOCK-10 (mine, epic MOCK-1, flagged, 2d/1d, carried over
//     from sprint 12), MOCK-11 (mine, sub-task of 10), MOCK-12 (Alex, sub-task of 10),
//     MOCK-20 (Alex), MOCK-21 (MINE, sub-task under Alex's MOCK-20), MOCK-22 (Sam),
//     MOCK-30 (mine, Done), MOCK-31 (Priya), MOCK-32 (unassigned), MOCK-33 (mine), MOCK-34 (Sam).
//     Epics MOCK-1 "Checkout redesign" (colour 4) and MOCK-2 "Search" (colour 9) are in no sprint
//     and, as on real Jira, are not part of a scrum board's issue lists.
//   Sprint 14: MOCK-40 (me), MOCK-41 (Alex), MOCK-42 (me). Sprint 15: MOCK-43 (Sam).
//   Backlog board 1: MOCK-50..MOCK-75 (26 issues, 9 mine). Kanban: KAN-1..KAN-12.
//   Board 3: TWO Sprint A (TWO-1..4) and TWO Sprint B (TWO-5..8), backlog TWO-9, TWO-10.
//   MOCK-10 carries the rich description, 12 comments and 3 attachments (screenshot.png,
//   notes.txt, design.pdf). Test images: /images/big.png (3.5 MB), /images/fake.png (text/html),
//   /redirect-foreign (302 -> https://evil.example/steal), /redirect-same (302 -> same origin).
//
// ── CLI ──────────────────────────────────────────────────────────────────────
//   node scripts/mock-jira.mjs --flavor server|cloud [--host 127.0.0.1] [--port 4751]
//        [--api-port 4752] [--version 8.5.0] [--deployment DataCenter]
//        [--hours-per-day 8] [--days-per-week 5]
//   Prints the URL(s) and the credentials, runs until SIGINT/SIGTERM.
import http from "node:http";
import { pathToFileURL } from "node:url";
import {
  BOARDS, CLOUD_CLASSIC_TOKEN, CLOUD_EMAIL, CLOUD_ID, CLOUD_SCOPED_TOKEN, DAY, HOUR, ISSUE_TYPES, ME,
  MINUTE, MOCK_NOW, OFFSET_MIN, PRIORITIES, PROJECTS, PRIORITY_SVGS, SERVER_PAT, SERVER_USER, SPRINTS,
  STATUSES, STATUS_CATEGORIES, USERS, COMPONENTS, VERSIONS, avatarPng, bigPng, buildWorld, designPdf,
  iconPng, notesTxt, parseDuration, screenshotPng, statusPng, thumbnailPng,
} from "./mock-jira-fixtures.mjs";

export { MOCK_NOW, CLOUD_ID };
export const MOCK_CREDENTIALS = Object.freeze({
  server: { bearer: SERVER_PAT, user: SERVER_USER },
  cloud: { email: CLOUD_EMAIL, classicToken: CLOUD_CLASSIC_TOKEN, scopedToken: CLOUD_SCOPED_TOKEN },
});

const JSON_TYPE = "application/json;charset=UTF-8";
const MODES = new Set(["ok", "401", "403", "429", "500", "slow"]);
const SLOW_MS = 3000;

// ===========================================================================
// JQL: a small but honest subset (tokenizer, recursive-descent parser, evaluator)
// ===========================================================================

class JqlError extends Error {}
const jqlSyntax = (message, tok) => new JqlError(`Error in the JQL Query: ${message} (line 1, character ${(tok?.pos ?? 0) + 1})`);

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")" || c === ",") { toks.push({ t: c, v: c, pos: i }); i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, out = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) { out += src[j + 1]; j += 2; } else out += src[j++];
      }
      if (j >= src.length) throw jqlSyntax(`The quoted string '${src.slice(i + 1)}' has not been completed.`, { pos: i });
      toks.push({ t: "str", v: out, pos: i });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["!=", "!~", ">=", "<="].includes(two)) { toks.push({ t: "op", v: two, pos: i }); i += 2; continue; }
    if ("=~<>".includes(c)) { toks.push({ t: "op", v: c, pos: i }); i++; continue; }
    if (c === "!") { toks.push({ t: "word", v: "not", pos: i }); i++; continue; }
    let j = i;
    while (j < src.length && !/[\s(),=!~<>"']/.test(src[j])) j++;
    toks.push({ t: "word", v: src.slice(i, j), pos: i });
    i = j;
  }
  toks.push({ t: "eof", v: "EOF", pos: src.length });
  return toks;
}

const RESERVED = new Set(["and", "or", "not", "in", "is", "order", "by", "asc", "desc", "&&", "||", "&", "|"]);

export function parseJql(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isWord = (tok, w) => tok.t === "word" && tok.v.toLowerCase() === w;
  const expect = t => {
    const tok = next();
    if (tok.t !== t) throw jqlSyntax(`Expecting '${t}' but got '${tok.v}'.`, tok);
    return tok;
  };
  const isAnd = tok => isWord(tok, "and") || (tok.t === "word" && (tok.v === "&&" || tok.v === "&"));
  const isOr = tok => isWord(tok, "or") || (tok.t === "word" && (tok.v === "||" || tok.v === "|"));

  function parseOr() {
    let left = parseAnd();
    while (isOr(peek())) { next(); left = { op: "or", a: left, b: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (isAnd(peek())) { next(); left = { op: "and", a: left, b: parseNot() }; }
    return left;
  }
  function parseNot() {
    if (isWord(peek(), "not")) { next(); return { op: "not", a: parseNot() }; }
    if (peek().t === "(") {
      next();
      const e = parseOr();
      const close = next();
      if (close.t !== ")") throw jqlSyntax(`Expecting ')' but got '${close.v}'.`, close);
      return e;
    }
    return parseClause();
  }
  function parseValue() {
    const tok = next();
    if (tok.t === "str") return { kind: "value", v: tok.v, tok };
    if (tok.t === "word") {
      if (RESERVED.has(tok.v.toLowerCase())) throw jqlSyntax(`Expecting either a value, list or function but got '${tok.v}'. You must surround '${tok.v}' in quotation marks to use it as a value.`, tok);
      if (peek().t === "(") {
        next();
        const args = [];
        if (peek().t !== ")") {
          for (;;) {
            const a = next();
            if (a.t !== "word" && a.t !== "str") throw jqlSyntax(`Expecting a function argument but got '${a.v}'.`, a);
            args.push(a.v);
            if (peek().t !== ",") break;
            next();
          }
        }
        expect(")");
        return { kind: "func", name: tok.v, args, tok };
      }
      if (/^(empty|null)$/i.test(tok.v)) return { kind: "empty", tok };
      return { kind: "value", v: tok.v, tok };
    }
    throw jqlSyntax(`Expecting either a value, list or function but got '${tok.v}'.`, tok);
  }
  function parseOperand() {
    if (peek().t === "(") {
      next();
      const items = [];
      if (peek().t === ")") throw jqlSyntax(`Expecting either a value or function but got ')'.`, peek());
      for (;;) {
        items.push(parseValue());
        if (peek().t !== ",") break;
        next();
      }
      const close = next();
      if (close.t !== ")") throw jqlSyntax(`Expecting ')' but got '${close.v}'.`, close);
      return { kind: "list", items };
    }
    return parseValue();
  }
  function parseClause() {
    const f = next();
    if ((f.t !== "word" && f.t !== "str") || (f.t === "word" && RESERVED.has(f.v.toLowerCase()))) {
      throw jqlSyntax(`Expecting a field name but got '${f.v}'.`, f);
    }
    const opTok = next();
    let op;
    if (opTok.t === "op") op = opTok.v;
    else if (isWord(opTok, "in")) op = "in";
    else if (isWord(opTok, "not") && isWord(peek(), "in")) { next(); op = "not in"; }
    else if (isWord(opTok, "is")) { if (isWord(peek(), "not")) { next(); op = "is not"; } else op = "is"; }
    else if (opTok.t === "word" && /^(was|changed)$/i.test(opTok.v)) throw new JqlError(`mock-jira does not support the '${opTok.v.toUpperCase()}' operator.`);
    else throw jqlSyntax(`Expecting operator but got '${opTok.v}'. The valid operators are '=', '!=', '<', '>', '<=', '>=', '~', '!~', 'IN', 'NOT IN', 'IS' and 'IS NOT'.`, opTok);
    const operand = parseOperand();
    if ((op === "in" || op === "not in") && operand.kind !== "list" && operand.kind !== "func") {
      throw jqlSyntax(`Expecting a list or function after '${op.toUpperCase()}' but got '${operand.tok?.v}'.`, operand.tok);
    }
    if ((op === "is" || op === "is not") && operand.kind !== "empty") {
      throw jqlSyntax(`Expecting 'EMPTY' or 'NULL' after '${op.toUpperCase()}' but got '${operand.tok?.v}'.`, operand.tok);
    }
    return { op: "clause", field: f.v, fieldTok: f, cop: op, operand };
  }

  let where = null;
  if (!isWord(peek(), "order") && peek().t !== "eof") where = parseOr();
  const orderBy = [];
  if (isWord(peek(), "order")) {
    next();
    if (!isWord(peek(), "by")) throw jqlSyntax(`Expecting 'by' but got '${peek().v}'.`, peek());
    next();
    for (;;) {
      const f = next();
      if (f.t !== "word" && f.t !== "str") throw jqlSyntax(`Expecting a field name but got '${f.v}'.`, f);
      let dir = "asc";
      if (isWord(peek(), "asc") || isWord(peek(), "desc")) dir = next().v.toLowerCase();
      orderBy.push({ field: f.v, dir });
      if (peek().t !== ",") break;
      next();
    }
  }
  if (peek().t !== "eof") throw jqlSyntax(`Expecting either 'OR' or 'AND' but got '${peek().v}'.`, peek());
  return { where, orderBy };
}

/** "-14d", "-2w", "2026-10-01", "2026/10/01 10:00", now(), startOfDay(-1) -> epoch ms. */
function jqlDate(value, field) {
  const bad = () => new JqlError(`Date value '${value}' for field '${field}' is invalid. Valid formats include: 'yyyy/MM/dd HH:mm', 'yyyy-MM-dd HH:mm', 'yyyy/MM/dd', 'yyyy-MM-dd', or a period format e.g. '-5d', '4w 2d'.`);
  const s = String(value).trim();
  const rel = /^([+-]?)((?:\d+\s*[yMwdhm]\s*)+)$/.exec(s);
  if (rel) {
    let ms = 0;
    for (const [, n, u] of rel[2].matchAll(/(\d+)\s*([yMwdhm])/g)) {
      ms += Number(n) * { y: 365 * DAY, M: 30 * DAY, w: 7 * DAY, d: DAY, h: HOUR, m: MINUTE }[u];
    }
    return MOCK_NOW + (rel[1] === "-" ? -ms : ms);
  }
  const abs = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(s);
  if (abs) {
    const [, y, mo, d, h = "0", mi = "0"] = abs;
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) - OFFSET_MIN * MINUTE;
  }
  throw bad();
}
function startOf(unit, arg) {
  const local = new Date(MOCK_NOW + OFFSET_MIN * MINUTE);
  let y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
  const n = arg ? parseInt(String(arg), 10) || 0 : 0;
  if (unit === "day") d += n;
  if (unit === "week") d += n * 7 - ((local.getUTCDay() + 6) % 7) - 1; // Jira weeks start on Sunday
  if (unit === "month") { m += n; d = 1; }
  if (unit === "year") { y += n; m = 0; d = 1; }
  return Date.UTC(y, m, d) - OFFSET_MIN * MINUTE;
}
const DATE_FUNCS = {
  now: () => MOCK_NOW,
  startofday: a => startOf("day", a), endofday: a => startOf("day", a) + DAY - 1,
  startofweek: a => startOf("week", a), endofweek: a => startOf("week", a) + 7 * DAY - 1,
  startofmonth: a => startOf("month", a), startofyear: a => startOf("year", a),
};

/**
 * Compile JQL against a world. Returns { where(issue) -> bool, sort(list) -> list }.
 * Throws JqlError with the message Jira would put in errorMessages.
 */
function compileJql(world, jql) {
  const { cloud, F } = world;
  const ast = parseJql(jql ?? "");
  const lc = s => String(s).toLowerCase();
  const sprintsOf = r => r.sprints.map(id => world.sprintById.get(id));
  const userAliases = who => (who ? [USERS[who].accountId, USERS[who].name, USERS[who].key, USERS[who].displayName, USERS[who].email].map(lc) : null);
  const one = a => (a == null ? [] : [a]);
  const issueTypeIds = name => [name, cloud ? ISSUE_TYPES[name].cloudId : ISSUE_TYPES[name].serverId].map(lc);
  const textOf = r => {
    const d = world.descriptionOf(r);
    return [r.summary, d?.text ?? "", ...world.commentRows(r).map(c => c.text), r.environment ?? ""].join("\n").toLowerCase();
  };
  const durationValue = v => {
    const s = parseDuration(v, world.hoursPerDay, world.daysPerWeek);
    if (Number.isNaN(s)) throw new JqlError(`The value '${v}' is not a valid duration.`);
    return s;
  };

  // field handlers: kind = enum | text | date | number
  const H = {};
  const def = (names, h) => { for (const n of names) H[lc(n)] = h; };
  const enumOf = (name, values, known, funcs = {}) => ({ kind: "enum", name, values, known, funcs });
  const sprintKnown = v => SPRINTS.some(s => String(s.id) === v || lc(s.name) === v);
  const sprintAliases = s => [String(s.id), lc(s.name)];
  const sprintFuncs = {
    opensprints: () => SPRINTS.filter(s => s.state !== "closed").map(s => String(s.id)),
    closedsprints: () => SPRINTS.filter(s => s.state === "closed").map(s => String(s.id)),
    futuresprints: () => SPRINTS.filter(s => s.state === "future").map(s => String(s.id)),
  };
  const userFuncs = { currentuser: () => userAliases(ME).slice(0, 1) };
  const userField = (name, get) => enumOf(name, r => one(userAliases(get(r))), v => !!world.findUser(v), userFuncs);
  const keyKnown = field => v => {
    if (world.byId.has(v)) return true;
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(v)) throw new JqlError(`The issue key '${v}' for field '${field}' is invalid.`);
    if (!world.byKey.has(v.toUpperCase())) throw new JqlError(`An issue with key '${v.toUpperCase()}' does not exist for field '${field}'.`);
    return true;
  };
  const keyAliases = r => [lc(r.key), r.id];
  const parentKeyOf = r => (r.parent ?? (cloud ? r.epic : null));

  def(["key", "issuekey", "id", "issue"], enumOf("key", r => [keyAliases(r)], keyKnown("key")));
  def(["project"], enumOf("project", r => [[lc(r.project), PROJECTS[r.project].id, lc(PROJECTS[r.project].name)]], v => Object.values(PROJECTS).some(p => [lc(p.key), p.id, lc(p.name)].includes(v))));
  def(["issuetype", "type"], enumOf("issuetype", r => [issueTypeIds(r.type)], v => Object.keys(ISSUE_TYPES).some(n => issueTypeIds(n).includes(v)), {
    subtaskissuetypes: () => ["sub-task"], standardissuetypes: () => Object.keys(ISSUE_TYPES).filter(n => !ISSUE_TYPES[n].subtask).map(lc),
  }));
  def(["status"], enumOf("status", r => [[lc(r.status), STATUSES[r.status].id]], v => Object.entries(STATUSES).some(([n, s]) => lc(n) === v || s.id === v)));
  def(["statuscategory"], enumOf("statusCategory", r => {
    const c = STATUS_CATEGORIES[STATUSES[r.status].cat];
    return [[lc(c.name), c.key, String(c.id)]];
  }, v => Object.values(STATUS_CATEGORIES).some(c => [lc(c.name), c.key, String(c.id)].includes(v))));
  def(["priority"], enumOf("priority", r => (r.priority ? [[lc(r.priority), PRIORITIES[r.priority].id]] : []), v => Object.entries(PRIORITIES).some(([n, x]) => lc(n) === v || x.id === v)));
  def(["resolution"], enumOf("resolution", r => (r.status === "Done" ? [["done", "10000"]] : []), v => ["done", "10000", "unresolved"].includes(v)));
  def(["assignee"], userField("assignee", r => r.assignee));
  def(["reporter"], userField("reporter", r => r.reporter));
  def(["creator"], userField("creator", r => r.creator));
  def(["labels"], enumOf("labels", r => r.labels.map(l => [lc(l)]), () => true));
  def(["component"], enumOf("component", r => r.components.map(c => [lc(c), COMPONENTS[c]]), v => Object.entries(COMPONENTS).some(([n, id]) => lc(n) === v || id === v)));
  def(["fixversion"], enumOf("fixVersion", r => r.fixVersions.map(n => [lc(n), VERSIONS[n].id]), v => Object.entries(VERSIONS).some(([n, x]) => lc(n) === v || x.id === v), {
    unreleasedversions: () => Object.keys(VERSIONS).filter(n => !VERSIONS[n].released).map(lc),
    releasedversions: () => Object.keys(VERSIONS).filter(n => VERSIONS[n].released).map(lc),
  }));
  def(["parent"], enumOf("parent", r => (parentKeyOf(r) ? [keyAliases(world.byKey.get(parentKeyOf(r)))] : []), keyKnown("parent")));
  def(["sprint", `cf[${F.sprint.slice(12)}]`], enumOf("sprint", r => sprintsOf(r).map(sprintAliases), sprintKnown, sprintFuncs));
  def(["flagged", `cf[${F.flagged.slice(12)}]`, "flagged[checkboxes]"], enumOf("Flagged", r => (r.flagged ? [["impediment", cloud ? "10019" : "10200"]] : []), v => ["impediment", "10019", "10200"].includes(v)));
  if (!cloud) {
    def(["epic link", `cf[${F.epicLink.slice(12)}]`], enumOf("Epic Link", r => (r.epic && r.type !== "Sub-task" ? [keyAliases(world.byKey.get(r.epic))] : []), keyKnown("Epic Link")));
    def(["epic name", `cf[${F.epicName.slice(12)}]`], { kind: "text", name: "Epic Name", get: r => lc(r.epicName ?? "") });
    def(["story points", `cf[${F.sp.slice(12)}]`], { kind: "number", name: "Story Points", get: r => r.sp ?? null });
  } else {
    def(["story point estimate", `cf[${F.sp.slice(12)}]`, "story point estimate[number]"], { kind: "number", name: "Story point estimate", get: r => r.sp ?? null });
    def(["story points", `cf[${F.spAlt.slice(12)}]`, "story points[number]"], { kind: "number", name: "Story Points", get: () => null });
  }
  def(["summary"], { kind: "text", name: "summary", get: r => lc(r.summary) });
  def(["description"], { kind: "text", name: "description", get: r => lc(world.descriptionOf(r)?.text ?? "") });
  def(["environment"], { kind: "text", name: "environment", get: r => lc(r.environment ?? "") });
  def(["comment"], { kind: "text", name: "comment", get: r => world.commentRows(r).map(c => c.text).join("\n").toLowerCase() });
  def(["text"], { kind: "text", name: "text", get: textOf });
  def(["created", "createddate"], { kind: "date", name: "created", get: r => r.created });
  def(["updated", "updateddate"], { kind: "date", name: "updated", get: r => r.updated });
  def(["resolutiondate", "resolved"], { kind: "date", name: "resolutiondate", get: r => (r.status === "Done" ? r.resolved : null) });
  def(["statuscategorychangeddate"], { kind: "date", name: "statusCategoryChangedDate", get: r => r.statusChanged });
  def(["duedate", "due"], { kind: "date", name: "duedate", get: r => r.due ?? null });
  def(["originalestimate", "timeoriginalestimate"], { kind: "number", name: "originalEstimate", get: r => r.orig, duration: true });
  def(["remainingestimate", "timeestimate"], { kind: "number", name: "remainingEstimate", get: r => r.rem, duration: true });
  def(["timespent"], { kind: "number", name: "timespent", get: r => r.spent, duration: true });
  def(["rank", `cf[${F.rank.slice(12)}]`], { kind: "rank", name: "Rank" });

  const handlerFor = name => {
    const h = H[lc(name)];
    if (!h) throw new JqlError(`Field '${name}' does not exist or you do not have permission to view it.`);
    return h;
  };

  // Resolve an operand item to lowercase strings (enum) or a value of the field's kind.
  const funcValues = (h, item) => {
    const fname = lc(item.name);
    if (h.kind === "date") {
      const f = DATE_FUNCS[fname];
      if (!f) throw new JqlError(`Unable to find JQL function '${item.name}(${item.args.join(", ")})'.`);
      return [f(item.args[0])];
    }
    const f = h.funcs?.[fname];
    if (!f) {
      if (["currentuser", "opensprints", "closedsprints", "futuresprints", "now", "startofday", "membersof", "unreleasedversions", "releasedversions", "subtaskissuetypes", "standardissuetypes"].includes(fname)) {
        throw new JqlError(`Function '${item.name}' is not supported for the field '${h.name}'.`);
      }
      throw new JqlError(`Unable to find JQL function '${item.name}(${item.args.join(", ")})'.`);
    }
    return f(item.args);
  };
  const items = operand => (operand.kind === "list" ? operand.items : [operand]);

  function compileClause(node) {
    const h = handlerFor(node.field);
    const { cop: op, operand } = node;
    const unsupported = () => new JqlError(`The operator '${op.toUpperCase()}' is not supported by the '${h.name}' field.`);
    if (h.kind === "rank") throw unsupported();

    if (op === "is" || op === "is not") {
      const empty = r => {
        if (h.kind === "enum") return h.values(r).length === 0;
        const v = h.get(r);
        return v == null || v === "";
      };
      return op === "is" ? empty : r => !empty(r);
    }

    if (h.kind === "text") {
      if (op !== "~" && op !== "!~") throw unsupported();
      if (operand.kind !== "value") throw jqlSyntax(`Expecting a value for '${op}'.`, operand.tok);
      const needle = lc(operand.v).replace(/\*/g, "").trim();
      const words = needle.split(/\s+/).filter(Boolean);
      const has = r => { const t = h.get(r); return words.every(w => t.includes(w)); };
      return op === "~" ? has : r => !has(r);
    }

    if (h.kind === "date" || h.kind === "number") {
      if (op === "~" || op === "!~") throw unsupported();
      const toValue = item => {
        if (item.kind === "empty") return null;
        if (item.kind === "func") return funcValues(h, item)[0];
        if (h.kind === "date") return jqlDate(item.v, h.name);
        if (h.duration) return durationValue(item.v);
        const n = Number(item.v);
        if (Number.isNaN(n)) throw new JqlError(`The value '${item.v}' is not a valid number for the field '${h.name}'.`);
        return n;
      };
      const vals = items(operand).map(toValue);
      const target = vals[0];
      const cmp = {
        "=": v => (target == null ? v == null : v != null && (h.kind === "date" && items(operand)[0].kind === "value" && /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(items(operand)[0].v) ? v >= target && v < target + DAY : v === target)),
        "!=": v => v != null && v !== target,
        ">": v => v != null && v > target, ">=": v => v != null && v >= target,
        "<": v => v != null && v < target, "<=": v => v != null && v <= target,
        in: v => vals.some(t => (t == null ? v == null : v === t)),
        "not in": v => v != null && !vals.includes(v),
      }[op];
      if (!cmp) throw unsupported();
      return r => cmp(h.get(r));
    }

    // enum
    if (!["=", "!=", "in", "not in"].includes(op)) throw unsupported();
    const wanted = [];
    let wantsEmpty = false;
    for (const item of items(operand)) {
      if (item.kind === "empty") { wantsEmpty = true; continue; }
      if (item.kind === "func") { wanted.push(...funcValues(h, item).map(lc)); continue; }
      const v = lc(item.v);
      if (h.name === "resolution" && v === "unresolved") { wantsEmpty = true; continue; }
      if (!h.known(v)) throw new JqlError(`The value '${item.v}' does not exist for the field '${h.name}'.`);
      wanted.push(v);
    }
    const matches = r => {
      const vals = h.values(r);
      if (!vals.length) return wantsEmpty;
      return vals.some(aliases => aliases.some(a => wanted.includes(a)));
    };
    if (op === "=" || op === "in") return matches;
    return r => h.values(r).length > 0 && !matches(r) && !(wantsEmpty && h.values(r).length === 0);
  }

  function compile(node) {
    if (!node) return () => true;
    if (node.op === "and") { const a = compile(node.a), b = compile(node.b); return r => a(r) && b(r); }
    if (node.op === "or") { const a = compile(node.a), b = compile(node.b); return r => a(r) || b(r); }
    if (node.op === "not") { const a = compile(node.a); return r => !a(r); }
    return compileClause(node);
  }

  const where = compile(ast.where);
  const PRIORITY_WEIGHT = { Highest: 5, High: 4, Medium: 3, Low: 2, Lowest: 1 };
  const sorters = ast.orderBy.map(({ field, dir }) => {
    const key = lc(field);
    const h = H[key];
    if (!h) throw new JqlError(`Field '${field}' does not exist or you do not have permission to view it.`);
    if (key === "text" || h.kind === "text" && key !== "summary") throw new JqlError(`Field '${field}' does not support sorting.`);
    const get = h.kind === "rank" ? r => r.rankIndex
      : h.name === "key" ? r => `${r.project}-${String(r.num).padStart(8, "0")}`
      : h.name === "priority" ? r => (r.priority ? PRIORITY_WEIGHT[r.priority] : null)
      : h.name === "status" ? r => r.status
      : h.name === "issuetype" ? r => r.type
      : h.name === "project" ? r => r.project
      : h.name === "summary" ? r => r.summary
      : ["assignee", "reporter", "creator"].includes(h.name) ? r => (r[h.name] ? USERS[r[h.name]].displayName : null)
      : h.name === "sprint" ? r => (r.sprints.length ? Math.max(...r.sprints) : null)
      : h.kind === "enum" ? r => (h.values(r)[0]?.[0] ?? null)
      : h.get;
    const sign = dir === "desc" ? -1 : 1;
    return (a, b) => {
      const x = get(a), y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return sign; // empty last when ascending, first when descending
      if (y == null) return -sign;
      return x < y ? -sign : x > y ? sign : 0;
    };
  });
  const sort = list => (sorters.length ? [...list].sort((a, b) => {
    for (const s of sorters) { const c = s(a, b); if (c) return c; }
    return a.rankIndex - b.rankIndex;
  }) : list);
  return { where, sort, bounded: !!ast.where };
}

// ===========================================================================
// HTTP helpers
// ===========================================================================

const errorBody = (...messages) => ({ errorMessages: messages, errors: {} });
const json = (status, body, headers = {}) => ({ status, json: body, headers });
const bytes = (status, body, type, headers = {}) => ({ status, body, type, headers });
const notFound = (...m) => json(404, errorBody(...m));
const badRequest = (...m) => json(400, errorBody(...m));

function intParam(q, name, fallback) {
  const raw = q[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function listParam(q, name) {
  const raw = q[name];
  if (raw == null) return [];
  return (Array.isArray(raw) ? raw : [raw]).flatMap(x => String(x).split(",")).map(s => s.trim()).filter(Boolean);
}
function paging(q, { defaultMax = 50, cap = 50 } = {}) {
  const startAt = Math.max(0, intParam(q, "startAt", 0));
  let maxResults = intParam(q, "maxResults", defaultMax);
  if (maxResults < 0) maxResults = defaultMax;
  return { startAt, maxResults: Math.min(maxResults, cap) };
}
function pageOf(list, q, opts) {
  const { startAt, maxResults } = paging(q, opts);
  const values = list.slice(startAt, startAt + maxResults);
  return { maxResults, startAt, total: list.length, isLast: startAt + values.length >= list.length, values };
}

// ===========================================================================
// Routes
// ===========================================================================

function buildRoutes(world, state) {
  const { cloud, v } = world;
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/(?<!\\)\./g, "\\.").replace(/\/:(\w+)(\([^)]*\))?/g, (_, k, g) => { keys.push(k); return `/${g ?? "([^/]+)"}`; })}$`);
    routes.push({ method, re, keys, handler, auth: opts.auth ?? true, public: opts.public ?? false });
  };
  const core = cloud ? "/rest/api/3" : "/rest/api/2";
  const both = cloud ? "/rest/api/(?:2|3)" : "/rest/api/2";
  const AG = "/rest/agile/1.0";
  const boardById = id => BOARDS.find(b => b.id === Number(id));
  const boardMissing = () => notFound("Board does not exist or you do not have permission to see it.");
  const issueMissing = () => notFound("Issue does not exist or you do not have permission to see it.");
  const findIssue = idOrKey => world.byKey.get(String(idOrKey).toUpperCase()) ?? world.byId.get(String(idOrKey));
  const expandSet = q => new Set(listParam(q, "expand"));
  const fieldsParam = q => (q.fields == null ? [] : Array.isArray(q.fields) ? q.fields : [q.fields]);

  const runJql = (list, jql) => {
    if (!jql || !String(jql).trim()) return list;
    const c = compileJql(world, String(jql));
    return c.sort(list.filter(c.where));
  };
  const withJql = fn => (ctx) => {
    try { return fn(ctx); } catch (e) {
      if (e instanceof JqlError) return json(400, { errorMessages: [e.message], warningMessages: [], errors: {} });
      throw e;
    }
  };

  /** An Agile issue page: { expand, startAt, maxResults, total, issues } in rank order. */
  const agilePage = (list, q, selfFor) => {
    const filtered = runJql(list, q.jql);
    const { startAt, maxResults } = paging(q, { defaultMax: 50, cap: cloud ? 50 : 1000 });
    const sel = world.resolveFields(fieldsParam(q), "agile");
    const expand = expandSet(q);
    return json(200, {
      expand: "schema,names", startAt, maxResults, total: filtered.length,
      issues: filtered.slice(startAt, startAt + maxResults).map(r => world.issueJson(r, { fields: sel, expand, agile: true, self: selfFor(r) })),
    });
  };

  // ---- core REST ----------------------------------------------------------
  route("GET", `${both}/myself`, () => json(200, world.myself()));
  route("GET", `${both}/serverInfo`, () => json(200, serverInfo(world, state)), { public: true });
  route("GET", `${both}/field`, () => json(200, world.fieldList));
  route("GET", `${both}/user`, ({ q }) => {
    const who = world.findUser(q.accountId ?? q.username ?? q.key ?? "");
    return who ? json(200, world.userJson(who)) : notFound(cloud ? "Specified user does not exist or you do not have required permissions" : `The user named '${q.username ?? q.key}' does not exist`);
  });
  if (cloud) {
    route("GET", `${both}/configuration/timetracking/options`, () => json(200, { workingHoursPerDay: world.hoursPerDay, workingDaysPerWeek: world.daysPerWeek, timeFormat: "pretty", defaultUnit: "minute" }));
    route("GET", `${both}/configuration/timetracking`, () => json(200, { key: "JIRA", name: "JIRA provided time tracking", url: "/secure/admin/TimeTrackingAdmin!default.jspa" }));
  }
  // Both deployments answer /configuration to any signed-in user, with the
  // working day and week inside it.
  route("GET", `${core}/configuration`, () => json(200, {
    votingEnabled: true, watchingEnabled: true, unassignedIssuesAllowed: true, subTasksEnabled: true, issueLinkingEnabled: true,
    timeTrackingEnabled: true, attachmentsEnabled: true,
    timeTrackingConfiguration: { workingHoursPerDay: world.hoursPerDay, workingDaysPerWeek: world.daysPerWeek, timeFormat: "pretty", defaultUnit: "minute" },
  }));

  route("GET", `${core}/issue/:key`, ({ params, q }) => {
    const r = findIssue(params.key);
    if (!r) return issueMissing();
    return json(200, world.issueJson(r, { fields: world.resolveFields(fieldsParam(q), "all"), expand: expandSet(q) }));
  });
  route("GET", `${core}/issue/:key/comment`, ({ params, q }) => {
    const r = findIssue(params.key);
    if (!r) return issueMissing();
    let rows = world.commentRows(r);
    const order = String(q.orderBy ?? "created");
    if (!["created", "+created", "-created"].includes(order)) return badRequest(`The orderBy value '${order}' is invalid. Valid values are: created, -created, +created.`);
    rows = [...rows].sort((a, b) => a.created - b.created);
    if (order === "-created") rows.reverse();
    const { startAt, maxResults } = paging(q, { defaultMax: cloud ? 100 : 50, cap: 5000 });
    const rendered = expandSet(q).has("renderedBody");
    return json(200, { comments: rows.slice(startAt, startAt + maxResults).map(c => world.commentJson(r, c, { rendered })), ...(cloud ? { self: `${world.rest}/issue/${r.id}/comment` } : {}), maxResults, total: rows.length, startAt });
  });
  route("GET", `${core}/attachment/:id`, ({ params }) => {
    const a = world.attachments.find(x => x.id === params.id);
    return a ? json(200, world.attachmentJson(a)) : notFound(`The attachment with id '${params.id}' does not exist`);
  });
  if (cloud) {
    route("GET", `${core}/attachment/content/:id`, ({ params }) => attachmentBytes(world, params.id));
    route("GET", `${core}/attachment/thumbnail/:id`, ({ params }) => (world.attachments.some(a => a.id === params.id && a.thumb) ? bytes(200, thumbnailPng(params.id), "image/png") : notFound("The attachment has no thumbnail.")));
  }

  // search
  if (cloud) {
    const removed = () => json(410, errorBody("The requested API has been removed. Please migrate to the /rest/api/3/search/jql API. A full migration guideline is available at https://developer.atlassian.com/changelog/#CHANGE-2046"));
    route("GET", `${both}/search`, removed);
    route("POST", `${both}/search`, removed);
    const searchJql = withJql(({ q, body, method }) => {
      const input = method === "POST" ? (body ?? {}) : q;
      const jql = input.jql ?? "";
      const c = compileJql(world, String(jql));
      if (!c.bounded) return badRequest("Unbounded JQL queries are not allowed here. Please add a search restriction to your query.");
      const list = c.sort(world.issues.filter(c.where));
      const fieldsIn = method === "POST" ? (Array.isArray(input.fields) ? input.fields : input.fields != null ? [input.fields] : []) : fieldsParam(q);
      const sel = world.resolveFields(fieldsIn, "id");
      const lean = [...sel].every(id => id === "id" || id === "key");
      let maxResults = Number(input.maxResults ?? 50);
      if (!Number.isFinite(maxResults) || maxResults < 1) maxResults = 50;
      maxResults = Math.min(Math.trunc(maxResults), lean ? 5000 : 100);
      const fp = searchFingerprint(String(jql), sel);
      let offset = 0;
      if (input.nextPageToken) {
        const tok = readPageToken(input.nextPageToken);
        if (!tok || tok.f !== fp) return badRequest("The provided next page token is invalid or expired.");
        offset = tok.o;
      }
      const expandIn = method === "POST" ? String(input.expand ?? "") : String(q.expand ?? "");
      const expand = new Set(expandIn.split(",").map(s => s.trim()).filter(Boolean));
      const pageItems = list.slice(offset, offset + maxResults);
      const end = offset + pageItems.length;
      const out = { issues: pageItems.map(r => world.issueJson(r, { fields: sel, expand })) };
      if (end < list.length) out.nextPageToken = makePageToken({ o: end, f: fp });
      out.isLast = end >= list.length;
      if (expand.has("names")) out.names = Object.fromEntries([...sel].filter(id => world.fieldNames[id]).map(id => [id, world.fieldNames[id]]));
      if (expand.has("schema")) out.schema = Object.fromEntries([...sel].filter(id => world.fieldSchemas[id]).map(id => [id, world.fieldSchemas[id]]));
      return json(200, out);
    });
    route("GET", `${core}/search/jql`, searchJql);
    route("POST", `${core}/search/jql`, searchJql);
  } else {
    const search = withJql(({ q, body, method }) => {
      const input = method === "POST" ? (body ?? {}) : q;
      const list = runJql(world.issues, input.jql);
      const pq = method === "POST" ? { startAt: input.startAt, maxResults: input.maxResults } : q;
      const { startAt, maxResults } = paging(pq, { defaultMax: 50, cap: 1000 });
      const fieldsIn = method === "POST" ? (Array.isArray(input.fields) ? input.fields : input.fields != null ? [input.fields] : []) : fieldsParam(q);
      const expandIn = method === "POST" ? (Array.isArray(input.expand) ? input.expand : listParam({ e: input.expand }, "e")) : listParam(q, "expand");
      const sel = world.resolveFields(fieldsIn, "navigable");
      const expand = new Set(expandIn);
      const out = { expand: "schema,names", startAt, maxResults, total: list.length, issues: list.slice(startAt, startAt + maxResults).map(r => world.issueJson(r, { fields: sel, expand })) };
      if (expand.has("names")) out.names = Object.fromEntries([...sel].filter(id => world.fieldNames[id]).map(id => [id, world.fieldNames[id]]));
      if (expand.has("schema")) out.schema = Object.fromEntries([...sel].filter(id => world.fieldSchemas[id]).map(id => [id, world.fieldSchemas[id]]));
      return json(200, out);
    });
    route("GET", `${core}/search`, search);
    route("POST", `${core}/search`, search);
  }

  // ---- Agile ---------------------------------------------------------------
  route("GET", `${AG}/board`, ({ q }) => {
    let list = BOARDS;
    const name = q.name != null ? String(q.name).toLowerCase() : null;
    if (name) list = list.filter(b => b.name.toLowerCase().includes(name));
    const types = listParam(q, "type");
    if (types.length) list = list.filter(b => types.includes(b.type));
    if (q.projectKeyOrId) {
      const p = Object.values(PROJECTS).find(x => x.key === String(q.projectKeyOrId).toUpperCase() || x.id === String(q.projectKeyOrId));
      list = p ? list.filter(b => b.project === p.key) : [];
    }
    if (cloud && q.orderBy) {
      const desc = String(q.orderBy).startsWith("-");
      list = [...list].sort((a, b) => a.name.localeCompare(b.name) * (desc ? -1 : 1));
    }
    const page = pageOf(list, q, { defaultMax: 50, cap: 50 });
    return json(200, { ...page, values: page.values.map(world.boardJson) });
  });
  route("GET", `${AG}/board/:id(\\d+)`, ({ params }) => {
    const b = boardById(params.id);
    return b ? json(200, world.boardJson(b)) : boardMissing();
  });
  route("GET", `${AG}/board/:id(\\d+)/configuration`, ({ params }) => {
    const b = boardById(params.id);
    return b ? json(200, world.boardConfig(b)) : boardMissing();
  });
  route("GET", `${AG}/board/:id(\\d+)/project`, ({ params, q }) => {
    const b = boardById(params.id);
    if (!b) return boardMissing();
    const page = pageOf([b.project], q, { defaultMax: 50, cap: 50 });
    return json(200, { ...page, values: page.values.map(world.projectJson) });
  });
  if (cloud) {
    // Jira Software Server/DC 9.x has neither of these in its public Agile API (404 there).
    route("GET", `${AG}/board/:id(\\d+)/quickfilter`, ({ params, q }) => {
      const b = boardById(params.id);
      if (!b) return boardMissing();
      const page = pageOf(b.quickFilters, q, { defaultMax: 50, cap: 50 });
      return json(200, { ...page, values: page.values.map(x => ({ id: x.id, boardId: b.id, name: x.name, jql: x.jql, description: x.description, position: x.position })) });
    });
    route("GET", `${AG}/board/:id(\\d+)/quickfilter/:qf(\\d+)`, ({ params }) => {
      const b = boardById(params.id);
      const x = b?.quickFilters.find(f => f.id === Number(params.qf));
      return x ? json(200, { id: x.id, boardId: b.id, name: x.name, jql: x.jql, description: x.description, position: x.position }) : notFound("The quick filter does not exist or you do not have permission to see it.");
    });
    route("GET", `${AG}/board/:id(\\d+)/features`, ({ params }) => {
      const b = boardById(params.id);
      return b ? json(200, world.boardFeatures(b)) : boardMissing();
    });
  }
  route("GET", `${AG}/board/:id(\\d+)/sprint`, ({ params, q }) => {
    const b = boardById(params.id);
    if (!b) return boardMissing();
    if (b.type !== "scrum") return badRequest("The board does not support sprints");
    const states = listParam(q, "state");
    for (const s of states) if (!["future", "active", "closed"].includes(s)) return badRequest(`The state '${s}' is not valid. Valid values are: future, active, closed.`);
    const order = { closed: 0, active: 1, future: 2 };
    const list = SPRINTS.filter(s => s.boardId === b.id && (!states.length || states.includes(s.state))).sort((x, y) => order[x.state] - order[y.state] || x.sequence - y.sequence);
    const page = pageOf(list, q, { defaultMax: 50, cap: 50 });
    return json(200, { ...page, values: page.values.map(world.agileSprint) });
  });
  route("GET", `${AG}/board/:id(\\d+)/sprint/:sid(\\d+)/issue`, withJql(({ params, q }) => {
    const b = boardById(params.id);
    if (!b) return boardMissing();
    if (b.type !== "scrum") return badRequest("The board does not support sprints");
    const s = world.sprintById.get(Number(params.sid));
    if (!s) return notFound(`Sprint with id ${params.sid} does not exist or you do not have permission to see it.`);
    return agilePage(world.boardIssues(b).filter(r => r.sprints.includes(s.id)), q, r => `${world.agile}/board/${b.id}/issue/${r.id}`);
  }));
  route("GET", `${AG}/board/:id(\\d+)/backlog`, withJql(({ params, q }) => {
    const b = boardById(params.id);
    if (!b) return boardMissing();
    if (!b.backlog) return badRequest("Backlogs are not supported on this board");
    const list = world.boardIssues(b).filter(r => STATUSES[r.status].cat !== "done" && !r.sprints.some(id => world.sprintById.get(id).state !== "closed"));
    return agilePage(list, q, r => `${world.agile}/board/${b.id}/issue/${r.id}`);
  }));
  route("GET", `${AG}/board/:id(\\d+)/issue`, withJql(({ params, q }) => {
    const b = boardById(params.id);
    if (!b) return boardMissing();
    return agilePage(world.boardIssues(b), q, r => `${world.agile}/board/${b.id}/issue/${r.id}`);
  }));
  route("GET", `${AG}/board/:id(\\d+)/epic`, ({ params, q }) => {
    const b = boardById(params.id);
    if (!b) return boardMissing();
    if (b.type !== "scrum" && b.project !== "MOCK") return json(200, { maxResults: 50, startAt: 0, isLast: true, values: [] });
    let epics = b.empty ? [] : world.issues.filter(r => r.type === "Epic" && r.project === b.project);
    if (q.done != null) epics = epics.filter(e => (STATUSES[e.status].cat === "done") === (String(q.done) === "true"));
    const page = pageOf(epics, q, { defaultMax: 50, cap: 50 });
    return json(200, { maxResults: page.maxResults, startAt: page.startAt, isLast: page.isLast, values: page.values.map(world.agileEpic) });
  });
  route("GET", `${AG}/sprint/:sid(\\d+)`, ({ params }) => {
    const s = world.sprintById.get(Number(params.sid));
    return s ? json(200, world.agileSprint(s)) : notFound(`Sprint with id ${params.sid} does not exist or you do not have permission to see it.`);
  });
  route("GET", `${AG}/sprint/:sid(\\d+)/issue`, withJql(({ params, q }) => {
    const s = world.sprintById.get(Number(params.sid));
    if (!s) return notFound(`Sprint with id ${params.sid} does not exist or you do not have permission to see it.`);
    return agilePage(world.issues.filter(r => r.sprints.includes(s.id)), q, r => `${world.agile}/issue/${r.id}`);
  }));
  route("GET", `${AG}/epic/:key`, ({ params }) => {
    const r = findIssue(params.key);
    if (!r) return notFound(`Issue with key '${params.key}' does not exist or you do not have permission to see it.`);
    if (r.type !== "Epic") return badRequest(`Issue ${r.key} is not an epic.`);
    return json(200, world.agileEpic(r));
  });
  route("GET", `${AG}/epic/:key/issue`, withJql(({ params, q }) => {
    const r = findIssue(params.key);
    if (!r) return notFound(`Issue with key '${params.key}' does not exist or you do not have permission to see it.`);
    if (r.type !== "Epic") return badRequest(`Issue ${r.key} is not an epic.`);
    return agilePage(world.issues.filter(x => x.epic === r.key), q, x => `${world.agile}/issue/${x.id}`);
  }));
  route("GET", `${AG}/issue/:key`, ({ params, q }) => {
    const r = findIssue(params.key);
    if (!r) return issueMissing();
    return json(200, world.issueJson(r, { fields: world.resolveFields(fieldsParam(q), "agile"), expand: expandSet(q), agile: true, self: `${world.agile}/issue/${r.id}` }));
  });
  // Private GreenHopper API: the only place Server/DC exposes a board's quick filters.
  route("GET", "/rest/greenhopper/1.0/rapidviewconfig/editmodel\\.json", ({ q }) => {
    const b = boardById(q.rapidViewId);
    return b ? json(200, world.editModel(b)) : json(404, errorBody("The requested board cannot be viewed because it either does not exist or you do not have permission to view it."));
  });

  // ---- images (auth required, not REST) ----------------------------------------
  route("GET", "/secure/useravatar", ({ q }) => bytes(200, avatarPng(q.ownerId ?? "default", q.size ?? "large"), "image/png"));
  route("GET", "/secure/viewavatar", ({ q }) => bytes(200, iconPng(Number(q.avatarId ?? 0), q.size ?? "xsmall"), "image/png"));
  route("GET", "/secure/projectavatar", ({ q }) => bytes(200, iconPng(Number(q.avatarId ?? q.pid ?? 0), q.size ?? "large"), "image/png"));
  route("GET", "/images/icons/priorities/:name(highest|high|medium|low|lowest)\\.svg", ({ params }) => bytes(200, Buffer.from(PRIORITY_SVGS[params.name]), "image/svg+xml"));
  route("GET", "/images/icons/statuses/:name", ({ params }) => bytes(200, statusPng(params.name), "image/png"));
  route("GET", "/secure/attachment/:id(\\d+)/:name", ({ params }) => attachmentBytes(world, params.id));
  route("GET", "/secure/thumbnail/:id(\\d+)/:name", ({ params }) => (world.attachments.some(a => a.id === params.id && a.thumb) ? bytes(200, thumbnailPng(params.id), "image/png") : notFound("The attachment has no thumbnail.")));
  route("GET", "/images/big\\.png", () => bytes(200, bigPng(), "image/png"));
  route("GET", "/images/fake\\.png", () => bytes(200, Buffer.from("<!DOCTYPE html><html><head><title>Log in - Jira</title></head><body><form action=\"/login.jsp\">Not an image</form></body></html>"), "text/html;charset=UTF-8"));
  route("GET", "/redirect-foreign", () => ({ status: 302, body: Buffer.alloc(0), type: "text/plain", headers: { Location: "https://evil.example/steal" } }));
  route("GET", "/redirect-same", ({ origin }) => ({ status: 302, body: Buffer.alloc(0), type: "text/plain", headers: { Location: `${origin === "api" ? `/ex/jira/${CLOUD_ID}` : ""}/images/icons/priorities/high.svg` } }));

  // ---- public ---------------------------------------------------------------------
  if (cloud) route("GET", "/_edge/tenant_info", () => json(200, { cloudId: CLOUD_ID }), { auth: false });

  return routes;
}

function attachmentBytes(world, id) {
  const a = world.attachments.find(x => x.id === String(id));
  if (!a) return notFound(`The attachment with id '${id}' does not exist`);
  const body = a.filename === "screenshot.png" ? screenshotPng() : a.filename === "notes.txt" ? notesTxt() : designPdf();
  const type = a.mimeType === "text/plain" ? "text/plain;charset=UTF-8" : a.mimeType;
  return bytes(200, body, type, { "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(a.filename)}` });
}

function serverInfo(world, state) {
  const nums = state.version.split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
  while (nums.length < 3) nums.push(0);
  if (world.cloud) {
    return {
      baseUrl: world.site, displayUrl: world.site, version: "1001.0.0-SNAPSHOT", versionNumbers: [1001, 0, 0], deploymentType: "Cloud",
      buildNumber: 100288, buildDate: "2026-10-15T00:00:00.000+0000", serverTime: new Date(MOCK_NOW).toISOString().replace("Z", "+0000"),
      scmInfo: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", serverTitle: "Mock Jira", defaultLocale: { locale: "en_US" }, serverTimeZone: "Etc/UTC",
    };
  }
  return {
    baseUrl: world.site, version: state.version, versionNumbers: nums, deploymentType: state.deploymentType,
    buildNumber: nums[0] * 100000 + nums[1] * 1000 + nums[2], buildDate: "2026-06-20T00:00:00.000+0300",
    databaseBuildNumber: nums[0] * 100000 + nums[1] * 1000 + nums[2], serverTime: new Date(MOCK_NOW).toISOString().replace("Z", "+0000"),
    scmInfo: "c0ffee0123456789abcdef0123456789abcdef01", serverTitle: "Mock Jira",
  };
}

// nextPageToken: opaque base64url strings, tied to the query that made them.
function searchFingerprint(jql, sel) {
  let h = 2166136261;
  for (const ch of `${jql}|${[...sel].sort().join(",")}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h.toString(36);
}
function makePageToken(obj) {
  return Buffer.from(JSON.stringify({ ...obj, n: "mock" })).toString("base64url").replace(/=+$/, "");
}
function readPageToken(token) {
  try {
    const o = JSON.parse(Buffer.from(String(token), "base64url").toString("utf8"));
    return Number.isInteger(o.o) && o.o >= 0 && typeof o.f === "string" ? o : null;
  } catch { return null; }
}

// ===========================================================================
// Auth
// ===========================================================================

function parseAuth(header) {
  if (!header) return { scheme: "none", present: false };
  const m = /^(\S+)\s+(.+)$/.exec(String(header).trim());
  if (!m) return { scheme: "none", present: true };
  const scheme = m[1].toLowerCase();
  if (scheme === "bearer") return { scheme: "bearer", present: true, token: m[2].trim() };
  if (scheme === "basic") {
    let decoded = "";
    try { decoded = Buffer.from(m[2].trim(), "base64").toString("utf8"); } catch { /* fall through */ }
    const i = decoded.indexOf(":");
    return { scheme: "basic", present: true, user: i >= 0 ? decoded.slice(0, i) : decoded, secret: i >= 0 ? decoded.slice(i + 1) : "" };
  }
  return { scheme: "none", present: true };
}

function checkAuth(flavor, origin, a) {
  if (flavor === "server") {
    if (a.scheme === "bearer" && a.token === SERVER_PAT) return { ok: true, user: SERVER_USER };
    return { ok: false, user: a.scheme === "basic" ? a.user : undefined };
  }
  if (a.scheme === "basic") {
    const emailOk = String(a.user).toLowerCase() === CLOUD_EMAIL;
    const ok = emailOk && (a.secret === CLOUD_CLASSIC_TOKEN || (origin === "api" && a.secret === CLOUD_SCOPED_TOKEN));
    return { ok, user: a.user };
  }
  return { ok: false };
}

function unauthorized(world, origin, a) {
  if (origin === "api") return json(401, { code: 401, message: "Unauthorized" });
  if (world.cloud) {
    return json(401, errorBody("Client must be authenticated to access this resource."), { "WWW-Authenticate": `OAuth realm="${encodeURIComponent(world.site)}"` });
  }
  return json(401, errorBody("You are not authenticated. Authentication required to perform this operation."), {
    "WWW-Authenticate": `OAuth realm="${encodeURIComponent(world.site)}"`,
    ...(a.present ? { "X-Seraph-LoginReason": "AUTHENTICATED_FAILED" } : {}),
  });
}

function forced(mode, world, origin, a) {
  if (mode === "401") return unauthorized(world, origin, { ...a, present: true });
  if (mode === "403") return json(403, errorBody(world.cloud ? "You do not have permission to access this resource." : "You do not have the permission to see the specified resource."));
  if (mode === "429") {
    return json(429, errorBody("Rate limit exceeded."), {
      "Retry-After": "30",
      ...(world.cloud ? { "X-RateLimit-Limit": "350", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": new Date(Date.now() + 30_000).toISOString(), "RateLimit-Reason": "jira-burst-based" } : {}),
    });
  }
  if (mode === "500") return json(500, errorBody("Internal server error"));
  return null;
}

// ===========================================================================
// Server
// ===========================================================================

function queryObject(searchParams) {
  const o = {};
  for (const [k, val] of searchParams) {
    if (k in o) o[k] = Array.isArray(o[k]) ? [...o[k], val] : [o[k], val];
    else o[k] = val;
  }
  return o;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => { size += c.length; if (size > 1_000_000) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(server.address().port); });
  });
}

const urlHost = host => (host.includes(":") ? `[${host}]` : host);

export async function startMockJira({
  flavor = "server", port = 0, host = "127.0.0.1", apiPort = 0, version = "9.0.0",
  deploymentType, hoursPerDay = 8, daysPerWeek = 5,
} = {}) {
  if (flavor !== "server" && flavor !== "cloud") throw new Error(`startMockJira: flavor must be "server" or "cloud", got ${flavor}`);
  const cloud = flavor === "cloud";
  const state = { mode: "ok", version: String(version), deploymentType: cloud ? "Cloud" : deploymentType ?? "Server" };
  const requests = [];
  const timers = new Set();
  let world = null, routes = null, apiBase = null;
  let reqSeq = 0;

  const send = (res, out, origin, entry, authed = false) => {
    const headers = { "Cache-Control": "no-cache, no-store, no-transform", "X-AREQUESTID": `${600 + (reqSeq % 400)}x${++reqSeq}x1`, ...(out.headers ?? {}) };
    if (cloud) { if (authed) headers["X-AAccountId"] = USERS[ME].accountId; }
    else headers["X-AUSERNAME"] = authed ? SERVER_USER : "anonymous";
    let body;
    if (out.json !== undefined) {
      let text = JSON.stringify(out.json);
      if (origin === "api") text = text.split(`${world.site}/rest/`).join(`${apiBase}/rest/`);
      body = Buffer.from(text, "utf8");
      headers["Content-Type"] = JSON_TYPE;
    } else {
      body = out.body;
      headers["Content-Type"] = out.type;
    }
    headers["Content-Length"] = String(body.length);
    if (entry) entry.status = out.status;
    res.writeHead(out.status, headers);
    res.end(body);
  };

  const sleep = ms => new Promise(resolve => {
    const t = setTimeout(() => { timers.delete(t); resolve(); }, ms);
    timers.add(t);
  });

  async function handle(req, res, origin) {
    const u = new URL(req.url, "http://mock.invalid");
    const rawPath = u.pathname;
    const q = queryObject(u.searchParams);

    // Control endpoints (site origin only, no auth, not logged)
    if (origin === "site" && rawPath.startsWith("/__mock/")) return control(req, res, rawPath, q);

    const a = parseAuth(req.headers.authorization);
    const verdict = checkAuth(flavor, origin, a);
    const entry = { origin, method: req.method, path: rawPath, query: q, auth: a.scheme, authOk: verdict.ok, ...(verdict.user ? { user: verdict.user } : {}) };
    requests.push(entry);

    let path = rawPath;
    if (origin === "api") {
      const m = /^\/ex\/jira\/([^/]+)(\/.*)?$/.exec(rawPath);
      if (!m || m[1] !== CLOUD_ID || !m[2]) return send(res, json(404, { code: 404, message: "Not Found" }), origin, entry);
      path = m[2];
      if (path.startsWith("/_edge/")) return send(res, json(404, { code: 404, message: "Not Found" }), origin, entry);
    }

    let match = null, pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      break;
    }
    if (!match) {
      if (a.present && !verdict.ok && path.startsWith("/rest/")) return send(res, unauthorized(world, origin, a), origin, entry);
      if (pathMatched) return send(res, json(405, errorBody(`Method ${req.method} is not allowed for ${path}`)), origin, entry, verdict.ok);
      const out = path.startsWith("/rest/")
        ? json(404, { message: `null for uri: ${origin === "api" ? apiBase : world.site}${path}${u.search}`, "status-code": 404 })
        : json(404, errorBody(`No resource at ${path}`));
      return send(res, out, origin, entry, verdict.ok);
    }

    const { r } = match;
    if (r.auth === false) return send(res, await r.handler({ q, params: match.params, origin }), origin, entry, verdict.ok);

    // Anonymous serverInfo on the site, as real Jira allows (bad credentials still fail).
    const anonymousOk = r.public && origin === "site" && !a.present;
    if (!anonymousOk) {
      if (state.mode === "slow") await sleep(SLOW_MS);
      const f = forced(state.mode, world, origin, a);
      if (f) return send(res, f, origin, entry, verdict.ok);
      if (!verdict.ok) return send(res, unauthorized(world, origin, a), origin, entry, false);
    }

    let body;
    if (req.method === "POST") {
      const text = await readBody(req);
      try { body = text ? JSON.parse(text) : {}; } catch {
        return send(res, badRequest("Unexpected character in the request body: the body is not valid JSON."), origin, entry, verdict.ok);
      }
    }
    let out;
    try {
      out = await r.handler({ q, params: match.params, body, method: req.method, origin });
    } catch (e) {
      out = json(500, errorBody(`mock-jira: ${e?.message ?? e}`));
    }
    return send(res, out, origin, entry, verdict.ok);
  }

  async function control(req, res, path, q) {
    const reply = (status, obj) => {
      const body = Buffer.from(JSON.stringify(obj));
      res.writeHead(status, { "Content-Type": JSON_TYPE, "Content-Length": String(body.length), "Cache-Control": "no-store" });
      res.end(body);
    };
    if (path === "/__mock/mode") {
      let mode = null;
      if (req.method === "POST") {
        try { mode = JSON.parse((await readBody(req)) || "{}").mode; } catch { return reply(400, errorBody("Body must be JSON like {\"mode\":\"429\"}")); }
      } else if (req.method === "GET" && q.mode != null) mode = q.mode;
      else if (req.method === "GET") return reply(200, { mode: state.mode });
      mode = String(mode);
      if (!MODES.has(mode)) return reply(400, errorBody(`Unknown mode '${mode}'. Valid: ${[...MODES].join(", ")}`));
      state.mode = mode;
      return reply(200, { mode });
    }
    if (path === "/__mock/requests" && req.method === "GET") return reply(200, requests);
    if (path === "/__mock/reset" && req.method === "POST") { requests.length = 0; state.mode = "ok"; return reply(200, { mode: "ok", requests: 0 }); }
    return reply(404, errorBody(`Unknown control endpoint ${req.method} ${path}`));
  }

  const handler = origin => (req, res) => {
    handle(req, res, origin).catch(e => {
      if (!res.headersSent) {
        const body = Buffer.from(JSON.stringify(errorBody(`mock-jira: ${e?.message ?? e}`)));
        res.writeHead(500, { "Content-Type": JSON_TYPE, "Content-Length": String(body.length) });
        res.end(body);
      } else res.destroy();
    });
  };

  const site = http.createServer(handler("site"));
  const api = cloud ? http.createServer(handler("api")) : null;
  const sitePort = await listen(site, port, host);
  let apiPortBound = null;
  try {
    if (api) apiPortBound = await listen(api, apiPort, host);
  } catch (e) {
    site.close();
    throw e;
  }
  const url = `http://${urlHost(host)}:${sitePort}`;
  const apiUrl = api ? `http://${urlHost(host)}:${apiPortBound}` : null;
  apiBase = api ? `${apiUrl}/ex/jira/${CLOUD_ID}` : null;
  world = buildWorld({ flavor, site: url, hoursPerDay, daysPerWeek });
  routes = buildRoutes(world, state);

  let closed = null;
  return {
    url,
    apiUrl,
    cloudId: cloud ? CLOUD_ID : null,
    requests,
    setMode(mode) {
      const m = String(mode);
      if (!MODES.has(m)) throw new Error(`setMode: unknown mode ${mode} (valid: ${[...MODES].join(", ")})`);
      state.mode = m;
    },
    close() {
      if (closed) return closed;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      const stop = s => new Promise(resolve => { if (!s) return resolve(); s.close(() => resolve()); s.closeAllConnections?.(); });
      closed = Promise.all([stop(site), stop(api)]).then(() => undefined);
      return closed;
    },
  };
}

// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [k, inline] = arg.slice(2).split("=", 2);
    const val = inline ?? argv[++i];
    if (val == null) throw new Error(`Missing value for --${k}`);
    out[k] = val;
  }
  return out;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(String(e.message));
    console.error("usage: node scripts/mock-jira.mjs --flavor server|cloud [--host 127.0.0.1] [--port 4751] [--api-port 4752] [--version 8.5.0] [--deployment DataCenter] [--hours-per-day 8] [--days-per-week 5]");
    process.exit(2);
  }
  const flavor = args.flavor ?? "server";
  const jira = await startMockJira({
    flavor,
    host: args.host ?? "127.0.0.1",
    port: args.port != null ? Number(args.port) : 0,
    apiPort: args["api-port"] != null ? Number(args["api-port"]) : 0,
    version: args.version ?? "9.0.0",
    deploymentType: args.deployment,
    hoursPerDay: args["hours-per-day"] != null ? Number(args["hours-per-day"]) : 8,
    daysPerWeek: args["days-per-week"] != null ? Number(args["days-per-week"]) : 5,
  });
  const lines = [];
  if (flavor === "cloud") {
    lines.push(`Mock Jira Cloud`);
    lines.push(`  site (base URL)   ${jira.url}`);
    lines.push(`  api origin        ${jira.apiUrl}/ex/jira/${jira.cloudId}   (stands in for https://api.atlassian.com)`);
    lines.push(`  cloudId           ${jira.cloudId}   (GET ${jira.url}/_edge/tenant_info)`);
    lines.push(`  email             ${CLOUD_EMAIL}`);
    lines.push(`  classic token     ${CLOUD_CLASSIC_TOKEN}   (site + api origin)`);
    lines.push(`  scoped token      ${CLOUD_SCOPED_TOKEN}   (api origin only; 401 on the site)`);
  } else {
    lines.push(`Mock Jira ${args.deployment ?? "Server"} ${args.version ?? "9.0.0"}`);
    lines.push(`  base URL          ${jira.url}`);
    lines.push(`  auth              Authorization: Bearer ${SERVER_PAT}   (user ${SERVER_USER})`);
  }
  lines.push(`  modes             curl -X POST ${jira.url}/__mock/mode -d '{"mode":"429"}'   (ok|401|403|429|500|slow)`);
  lines.push(`  request log       ${jira.url}/__mock/requests`);
  lines.push(`Ctrl+C to stop.`);
  console.log(lines.join("\n"));
  const stop = () => { jira.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e?.stack ?? e); process.exit(1); });
}

