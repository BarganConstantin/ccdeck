// Jira, as an integration provider (#2178): Jira Cloud with an API token, and
// Jira Server / Data Center 8.14 or newer with a personal access token.
//
// WHAT IT READS, AND FROM WHERE.
//   Cloud   REST v3 (`/rest/api/3/...`) — search only through the enhanced
//           `/rest/api/3/search/jql` with `nextPageToken`, since the old
//           `/rest/api/3/search` was removed — and Agile 1.0 for boards and
//           sprints. A board's issue lists come from `/rest/software/1.0`
//           (token paged), which replaces Agile 1.0's deprecated lists there,
//           falling back to Agile 1.0 where it is not deployed. Basic auth with
//           the account's email and an API token. A token created "with
//           scopes" is refused on the site itself and answers on
//           `https://api.atlassian.com/ex/jira/{cloudId}`, so validate tries
//           the site first and, when the refusal looks like that, the
//           api.atlassian.com base (found from the site's `/_edge/tenant_info`).
//   Server  REST v2 (`/rest/api/2/...`, startAt/maxResults/total paging) and
//           Agile 1.0. `Authorization: Bearer <PAT>`. Personal access tokens
//           arrived in Jira 8.14, so an older server is `incompatible`.
//
// Every request goes through the core's proxy (proxy.mjs), which
// signs with `sign` below and only for the connection's allowed origins. The
// routes are GET-only and answer normalised shapes (see `normaliseIssue`), so
// the page draws Cloud and Server with one renderer: descriptions and comments
// are Jira's own `renderedFields` HTML on both, sanitised in the browser
// (src/web/jira-html.tsx).
import { createCache } from "./cache.mjs";
import { errorResponse, integrationError, IntegrationError } from "./errors.mjs";
import { createProxy, fetchImage, isLocalHost, isSafeTarget, normaliseBaseUrl, originOf } from "./proxy.mjs";
import { createRouter } from "./registry.mjs";

export const MIN_SERVER_VERSION = [8, 14, 0];
const ATLASSIAN_API = "https://api.atlassian.com";
const PAGE = 100;
/** How many issues a sprint or a kanban column is read to, page by page. A
 *  backlog is paged by the reader instead. */
const SPRINT_CAP = 600;

const HOUR = 3600_000;
const MINUTE = 60_000;

// ── form, auth ──────────────────────────────────────────────────────────────

function text(value, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** The form's values as a candidate connection. `existing` is set on an edit:
 *  a token left blank keeps the saved one. */
export function parseJiraInput(input = {}, existing = null) {
  const deployment = input.deployment === "cloud" ? "cloud" : input.deployment === "server" ? "server" : "";
  if (!deployment) throw integrationError("invalid", "Choose Jira Cloud or Jira Server / Data Center.", { field: "deployment" });
  let typed = text(input.baseUrl, 500);
  // "acme" for a Cloud site is acme.atlassian.net: the one shorthand anybody types.
  if (deployment === "cloud" && /^[a-z0-9][a-z0-9-]*$/i.test(typed)) typed = `${typed}.atlassian.net`;
  const baseUrl = normaliseBaseUrl(typed, { field: "baseUrl", label: deployment === "cloud" ? "your Jira site URL" : "your Jira URL" });
  const kept = existing?.secret && typeof existing.secret === "object" ? existing.secret : null;
  const sameKind = kept && (deployment === "cloud" ? kept.auth === "basic" : kept.auth === "bearer");
  const token = text(input.token, 4096) || (sameKind ? kept.token : "");
  if (!token) throw integrationError("invalid", deployment === "cloud" ? "Enter an API token." : "Enter a personal access token.", { field: "token" });
  if (/\s/.test(token)) throw integrationError("invalid", "The token has a space in it. Paste it again.", { field: "token" });
  if (deployment === "cloud") {
    const email = text(input.email, 320) || (sameKind ? kept.email : "");
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw integrationError("invalid", "Enter the email address of your Atlassian account.", { field: "email" });
    return { baseUrl, secret: { auth: "basic", email, token }, meta: { deployment } };
  }
  return { baseUrl, secret: { auth: "bearer", token }, meta: { deployment } };
}

export function signJira(secret) {
  if (secret?.auth === "basic") {
    return { Authorization: `Basic ${Buffer.from(`${secret.email}:${secret.token}`, "utf8").toString("base64")}` };
  }
  if (secret?.auth === "bearer") return { Authorization: `Bearer ${secret.token}` };
  return {};
}

/**
 * A refusal Jira answers with a 200. A bad credential on an endpoint that
 * anonymous visitors may read is served as anonymous rather than refused: Cloud
 * and Server say so in `X-Seraph-LoginReason`, and Server, for a bearer token
 * it did not accept, only in `X-AUSERNAME: anonymous` (JRASERVER-78126).
 */
export function jiraAuthCheck(headers, secret) {
  const reason = String(headers?.get?.("x-seraph-loginreason") ?? "").toUpperCase();
  if (reason.includes("AUTHENTICATION_DENIED")) {
    return "Jira wants a CAPTCHA after too many failed sign-ins. Sign in to Jira once in your browser, then test the connection again.";
  }
  if (reason.includes("AUTHENTICATED_FAILED")) return "Jira did not accept these credentials.";
  if (secret?.auth === "bearer" && String(headers?.get?.("x-ausername") ?? "").toLowerCase() === "anonymous") {
    return "Jira did not accept this personal access token: it answered as an anonymous visitor. Check that the token is right and has not expired or been revoked.";
  }
  return null;
}

/** Jira's own reason, short, out of an error body: `errorMessages` and `errors`. */
export function jiraErrorDetail(json) {
  const parts = [
    ...(Array.isArray(json?.errorMessages) ? json.errorMessages : []),
    ...(json?.errors && typeof json.errors === "object" ? Object.values(json.errors) : []),
  ].filter(v => typeof v === "string" && v.trim());
  return parts.join(" ").slice(0, 300);
}

// ── validation ──────────────────────────────────────────────────────────────

/** "9.0.0" or [9, 0, 0] against the minimum. */
export function versionAtLeast(version, min = MIN_SERVER_VERSION) {
  const parts = Array.isArray(version) ? version : String(version ?? "").split(".");
  const nums = [0, 1, 2].map(i => Number.parseInt(parts[i], 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (nums[i] > min[i]) return true;
    if (nums[i] < min[i]) return false;
  }
  return true;
}

function personFrom(user, conn) {
  if (!user || typeof user !== "object") return null;
  const id = text(user.accountId ?? user.key ?? user.name, 200);
  if (!id) return null;
  return {
    id,
    name: text(user.displayName ?? user.name, 200) || id,
    avatar: imageUrl(conn, user.avatarUrls?.["48x48"] ?? user.avatarUrls?.["32x32"] ?? user.avatarUrls?.["24x24"] ?? null),
  };
}

/** Where the deck sends a scoped Cloud token: api.atlassian.com, or — for the
 *  suite and the browser mock, and only when the Jira "site" is itself on this
 *  machine — the origin CCDECK_JIRA_API_ORIGIN names. */
function atlassianApiOrigin(siteUrl, override) {
  const forced = override ?? process.env.CCDECK_JIRA_API_ORIGIN;
  if (forced) {
    try {
      if (isLocalHost(new URL(siteUrl).hostname) && isLocalHost(new URL(forced).hostname)) return originOf(forced);
    } catch { /* fall through to the real one */ }
  }
  return ATLASSIAN_API;
}

async function validateServer(conn, ctx) {
  const client = ctx.client([originOf(conn.baseUrl)]);
  let info;
  try { info = await client.json(`${conn.baseUrl}/rest/api/2/serverInfo`); }
  catch (err) {
    if (err instanceof IntegrationError && (err.kind === "not-found" || err.kind === "incompatible")) {
      throw integrationError("incompatible", "There is no Jira REST API at this address. Check the URL — some servers live under a path such as /jira.", { field: "baseUrl" });
    }
    throw err;
  }
  if (String(info?.deploymentType ?? "").toLowerCase() === "cloud") {
    throw integrationError("incompatible", "This is a Jira Cloud site. Choose Jira Cloud and connect with your email and an API token.", { field: "deployment" });
  }
  if (!versionAtLeast(info?.versionNumbers ?? info?.version)) {
    throw integrationError("incompatible",
      `This server runs Jira ${text(info?.version, 40) || "of an unknown version"}. Personal access tokens need Jira Server or Data Center 8.14 or newer, so the deck cannot connect to it.`);
  }
  const me = await client.json(`${conn.baseUrl}/rest/api/2/myself`);
  const warnings = [];
  const reported = originOf(info?.baseUrl);
  if (reported && reported !== originOf(conn.baseUrl)) {
    warnings.push(`Jira says its own address is ${reported}. The deck uses the one you entered.`);
  }
  return {
    account: {
      id: text(me?.key ?? me?.name, 200),
      login: text(me?.name ?? me?.emailAddress, 200),
      name: text(me?.displayName ?? me?.name, 200),
      avatarUrl: text(me?.avatarUrls?.["48x48"], 1000),
    },
    meta: {
      deployment: "server",
      deploymentType: info?.deploymentType === "DataCenter" ? "DataCenter" : "Server",
      serverVersion: text(info?.version, 40),
      serverTitle: text(info?.serverTitle, 120),
      apiVersion: "2",
      warnings,
    },
    allowedOrigins: [originOf(conn.baseUrl)],
  };
}

async function validateCloud(conn, ctx, apiOriginOverride) {
  const site = originOf(conn.baseUrl);
  const siteClient = ctx.client([site]);
  let me = null;
  let via = "site";
  let apiBase = "";
  let cloudId = "";
  let apiOrigin = "";
  let siteError = null;
  try { me = await siteClient.json(`${conn.baseUrl}/rest/api/3/myself`); }
  catch (err) {
    if (!(err instanceof IntegrationError) || !["auth", "expired", "permission", "not-found"].includes(err.kind)) throw err;
    siteError = err;
  }
  if (!me) {
    // A refusal on the site is what a token created with scopes gets: it is
    // valid only on api.atlassian.com, under the site's cloud id.
    let tenant;
    try { tenant = await siteClient.json(`${site}/_edge/tenant_info`); }
    catch { throw siteError; }
    cloudId = text(tenant?.cloudId, 100);
    if (!/^[A-Za-z0-9-]{8,100}$/.test(cloudId)) throw siteError;
    apiOrigin = atlassianApiOrigin(conn.baseUrl, apiOriginOverride);
    apiBase = `${apiOrigin}/ex/jira/${cloudId}`;
    const apiClient = ctx.client([site, apiOrigin]);
    try { me = await apiClient.json(`${apiBase}/rest/api/3/myself`); }
    catch (err) {
      if (err instanceof IntegrationError && (err.kind === "auth" || err.kind === "expired")) {
        throw integrationError(ctx.phase === "use" ? "expired" : "auth",
          "Jira did not accept this email and API token, on the site or through api.atlassian.com. Check both, and that the token has not expired.");
      }
      throw err;
    }
    via = "api";
  }
  const api = apiBase || conn.baseUrl;
  const client = apiBase ? ctx.client([site, apiOrigin]) : siteClient;
  let info = null;
  try { info = await client.json(`${api}/rest/api/3/serverInfo`); } catch { /* the account answered; serverInfo is a nicety */ }
  if (info && info.deploymentType && String(info.deploymentType).toLowerCase() !== "cloud") {
    throw integrationError("incompatible", "This is Jira Server or Data Center, not Cloud. Choose Jira Server / Data Center and use a personal access token.", { field: "deployment" });
  }
  const warnings = [];
  if (via === "api") warnings.push("This is a scoped API token: the deck reads Jira through api.atlassian.com. Make sure it has the read scopes listed in the form.");
  return {
    account: {
      id: text(me?.accountId, 200),
      login: text(me?.emailAddress, 200),
      name: text(me?.displayName, 200),
      avatarUrl: text(me?.avatarUrls?.["48x48"], 1000),
    },
    meta: {
      deployment: "cloud",
      deploymentType: "Cloud",
      apiVersion: "3",
      via,
      ...(apiBase ? { apiBase, cloudId } : {}),
      serverTitle: text(info?.serverTitle, 120),
      warnings,
    },
    allowedOrigins: apiBase ? [site, apiOrigin] : [site],
  };
}

export async function validateJira(conn, secret, ctx, { apiOrigin } = {}) {
  if (conn?.meta?.deployment === "cloud") return validateCloud(conn, ctx, apiOrigin);
  return validateServer(conn, ctx);
}

// ── shapes ──────────────────────────────────────────────────────────────────

const isCloud = conn => conn?.meta?.deployment === "cloud";
const apiRoot = conn => (isCloud(conn) && conn.meta.apiBase ? conn.meta.apiBase : conn.baseUrl);
const restBase = conn => `${apiRoot(conn)}/rest/api/${isCloud(conn) ? "3" : "2"}`;
const agileBase = conn => `${apiRoot(conn)}/rest/agile/1.0`;

/**
 * The hosts Jira serves PUBLIC images from, which the deck may read an image
 * off without the token — never with it. Taken from what Jira's own answers
 * point at: a Cloud user's `avatarUrls` are on Atlassian's avatar CDN
 * (avatar-management--avatars.<region>.prod.public.atl-paas.net), or on
 * Gravatar with the CDN as its fallback (`?d=…`, a redirect there); an older
 * Cloud site still names avatar-cdn.atlassian.com; a picture attached to a
 * Cloud issue is answered with a 303 to api.media.atlassian.com, whose URL
 * carries its own short-lived token. Jira Server and Data Center keep every
 * avatar and icon on the instance, except Gravatar when an admin turned it on.
 */
export function jiraImageHost(conn, url) {
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
  if (/^(?:[a-z0-9-]+\.)?gravatar\.com$/.test(host)) return true;
  if (!isCloud(conn)) return false;
  return /^avatar-management--avatars\.[a-z0-9-]+\.prod\.public\.atl-paas\.net$/.test(host)
    || host === "avatar-cdn.atlassian.com"
    || host === "api.media.atlassian.com";
}

/**
 * An image Jira named, as the page should load it: always through the
 * connection's asset route, which reads it with the token on the
 * connection's own origins and without it on Jira's public image hosts
 * (jiraImageHost). Anything else, and an SVG — Jira's priority icons, which
 * the route does not serve — is null, and the page draws its own.
 */
export function imageUrl(conn, raw) {
  if (!raw || typeof raw !== "string") return null;
  let u;
  try { u = new URL(raw, `${conn.baseUrl}/`); } catch { return null; }
  // A scoped token is refused on the site: the images the gateway serves too
  // (universal avatars, icons) are asked for through the api base instead.
  if (conn.meta?.apiBase && u.origin === originOf(conn.baseUrl) && /^\/(rest|images)\//.test(u.pathname)) {
    try { u = new URL(`${conn.meta.apiBase}${u.pathname}${u.search}`); } catch { return null; }
  }
  if (/\.svg$/i.test(u.pathname)) return null;
  const own = (conn.allowedOrigins ?? []).includes(u.origin) && isSafeTarget(u.href);
  if (!own && !(u.protocol === "https:" && jiraImageHost(conn, u.href))) return null;
  return `/api/integrations/jira/${encodeURIComponent(conn.id)}/asset?url=${encodeURIComponent(u.href)}`;
}

/** A status category as one of Jira's three keys. */
function category(status) {
  const key = status?.statusCategory?.key;
  return key === "done" || key === "indeterminate" ? key : "new";
}

/** Jira's epic colour, as its number 1-14 ("ghx-label-4", "color_4"). */
export function epicColour(value) {
  const raw = typeof value === "string" ? value : value?.key;
  const m = /(?:ghx-label-|color_)(\d{1,2})$/.exec(String(raw ?? ""));
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 14 ? n : null;
}

/** A sprint field value, in either shape: Cloud's objects, or the
 *  `com.atlassian.greenhopper.service.sprint.Sprint@…[id=1,state=ACTIVE,name=…]`
 *  strings Server's REST v2 still answers with. */
export function sprintsFrom(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map(item => {
    if (item && typeof item === "object") {
      return { id: Number(item.id) || 0, name: text(item.name, 200), state: String(item.state ?? "").toLowerCase() };
    }
    if (typeof item === "string") {
      const get = key => new RegExp(`[\\[,]${key}=([^,\\]]*)`).exec(item)?.[1] ?? "";
      return { id: Number(get("id")) || 0, name: get("name"), state: get("state").toLowerCase() };
    }
    return null;
  }).filter(s => s && s.name);
}

function flaggedFrom(fields, ids) {
  if (fields?.flagged === true) return true;
  const value = ids.flagged ? fields?.[ids.flagged] : null;
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function summaryOf(issue) {
  return text(issue?.fields?.summary, 500);
}

function typeOf(conn, issuetype) {
  return {
    name: text(issuetype?.name, 80) || "Issue",
    icon: imageUrl(conn, issuetype?.iconUrl),
    subtask: Boolean(issuetype?.subtask),
    epic: issuetype?.hierarchyLevel === 1 || /^epic$/i.test(String(issuetype?.name ?? "")),
  };
}

function statusOf(status) {
  return { name: text(status?.name, 80) || "Unknown", category: category(status) };
}

function priorityOf(conn, priority) {
  return priority ? { name: text(priority.name, 80), icon: imageUrl(conn, priority.iconUrl) } : null;
}

const seconds = v => (Number.isFinite(v) && v >= 0 ? v : null);

/** One issue, as a row of the backlog draws it. `ids` is the field map
 *  (fieldIds), `epics` what is known of the epics by key. */
export function normaliseIssue(conn, issue, ids = {}, epics = new Map(), estimationField = null) {
  const f = issue?.fields ?? {};
  const key = text(issue?.key, 64);
  const parentRaw = f.parent ?? null;
  const parentType = parentRaw ? typeOf(conn, parentRaw.fields?.issuetype) : null;
  // The epic: Server's Epic Link field, the Agile API's `epic`, or on Cloud an
  // epic-level parent.
  let epicKey = (ids.epicLink && typeof f[ids.epicLink] === "string" ? f[ids.epicLink] : "")
    || (f.epic && typeof f.epic === "object" ? text(f.epic.key, 64) : "")
    || (parentRaw && parentType?.epic ? text(parentRaw.key, 64) : "");
  epicKey = text(epicKey, 64);
  const known = epicKey ? epics.get(epicKey) : null;
  const epic = epicKey ? {
    key: epicKey,
    name: known?.name || (f.epic && typeof f.epic === "object" ? text(f.epic.name ?? f.epic.summary, 200) : "")
      || (parentType?.epic ? summaryOf(parentRaw) : "") || epicKey,
    color: known?.color ?? epicColour(f.epic?.color) ?? null,
  } : null;
  const assignee = personFrom(f.assignee, conn);
  const estimateValue = estimationField && estimationField !== "timeoriginalestimate" ? f[estimationField] : null;
  return {
    id: text(String(issue?.id ?? ""), 40),
    key,
    summary: text(f.summary, 500),
    url: `${conn.baseUrl}/browse/${encodeURIComponent(key)}`,
    type: typeOf(conn, f.issuetype),
    status: statusOf(f.status),
    priority: priorityOf(conn, f.priority),
    assignee,
    mine: Boolean(assignee && assignee.id === conn.account?.id),
    // A subtask's parent always; an epic is not a parent for the backlog's
    // purposes — it is the epic chip.
    parent: parentRaw && !parentType?.epic ? {
      key: text(parentRaw.key, 64),
      summary: summaryOf(parentRaw),
      type: parentType,
      status: statusOf(parentRaw.fields?.status),
      priority: priorityOf(conn, parentRaw.fields?.priority),
    } : null,
    subtaskKeys: Array.isArray(f.subtasks) ? f.subtasks.map(s => text(s?.key, 64)).filter(Boolean) : [],
    epic,
    fixVersions: Array.isArray(f.fixVersions) ? f.fixVersions.map(v => text(v?.name, 80)).filter(Boolean) : [],
    estimate: seconds(f.timeoriginalestimate) ?? seconds(f.aggregatetimeoriginalestimate),
    remaining: seconds(f.timeestimate),
    points: Number.isFinite(estimateValue) ? estimateValue : null,
    flagged: flaggedFrom(f, ids),
    updated: text(f.updated, 40),
  };
}

// ── reads ───────────────────────────────────────────────────────────────────

/** The custom fields the backlog needs, found by their type, once an hour. */
async function fieldIds(ctx) {
  return ctx.cache.remember("fields", HOUR, async () => {
    const list = await ctx.client.json(`${restBase(ctx.conn)}/field`);
    const ids = {};
    for (const field of Array.isArray(list) ? list : []) {
      const custom = String(field?.schema?.custom ?? "");
      if (custom === "com.pyxis.greenhopper.jira:gh-sprint") ids.sprint ??= field.id;
      else if (custom === "com.pyxis.greenhopper.jira:gh-epic-link") ids.epicLink ??= field.id;
      else if (custom === "com.pyxis.greenhopper.jira:gh-epic-color") ids.epicColor ??= field.id;
      else if (custom === "com.pyxis.greenhopper.jira:gh-epic-label") ids.epicName ??= field.id;
      else if (custom === "com.pyxis.greenhopper.jira:jsw-issue-color") ids.issueColor ??= field.id;
      else if (/^flagged$/i.test(String(field?.name ?? "")) && field.custom) ids.flagged ??= field.id;
    }
    return ids;
  });
}

/** Hours in a working day and days in a week, as the instance counts them —
 *  what "2d 2h" means there. 8 and 5 when it will not say. */
async function timeTracking(ctx) {
  return ctx.cache.remember("timetracking", HOUR, async () => {
    const fallback = { hoursPerDay: 8, daysPerWeek: 5 };
    const pick = cfg => {
      const h = Number(cfg?.workingHoursPerDay);
      const d = Number(cfg?.workingDaysPerWeek);
      return { hoursPerDay: h > 0 && h <= 24 ? h : 8, daysPerWeek: d > 0 && d <= 7 ? d : 5 };
    };
    try {
      // /configuration answers any signed-in user on Cloud and on Server; the
      // time-tracking options endpoint is Cloud-only and wants an admin.
      const cfg = await ctx.client.json(`${restBase(ctx.conn)}/configuration`);
      return cfg?.timeTrackingConfiguration ? pick(cfg.timeTrackingConfiguration) : fallback;
    } catch (err) {
      if (err instanceof IntegrationError && (err.kind === "expired" || err.kind === "rate-limit")) throw err;
      return fallback;
    }
  });
}

async function boardConfig(ctx, boardId) {
  return ctx.cache.remember(`board-config:${boardId}`, 10 * MINUTE, async () => {
    const cfg = await ctx.client.json(`${agileBase(ctx.conn)}/board/${boardId}/configuration`);
    const field = cfg?.estimation?.field ?? null;
    const fieldId = text(field?.fieldId, 80);
    const kind = !fieldId ? "count" : fieldId === "timeoriginalestimate" ? "time" : "points";
    const columns = (Array.isArray(cfg?.columnConfig?.columns) ? cfg.columnConfig.columns : []).map(c => ({
      name: text(c?.name, 80),
      statusIds: (Array.isArray(c?.statuses) ? c.statuses : []).map(st => String(st?.id ?? "")).filter(id => /^\d{1,12}$/.test(id)),
    }));
    return {
      estimation: { kind, fieldId: fieldId || null, label: text(field?.displayName, 80) || (kind === "time" ? "Original Time Estimate" : kind === "points" ? "Story points" : "Issue count") },
      columns,
    };
  });
}

async function quickFilters(ctx, boardId) {
  return ctx.cache.remember(`quickfilters:${boardId}`, 10 * MINUTE, async () => {
    // Agile 1.0 lists a board's quick filters on Cloud only. Server and Data
    // Center have them in the board's configuration model, which the board's
    // own settings page reads.
    if (!isCloud(ctx.conn)) {
      const model = await ctx.client.json(`${ctx.conn.baseUrl}/rest/greenhopper/1.0/rapidviewconfig/editmodel.json?rapidViewId=${boardId}`);
      const list = Array.isArray(model?.quickFilterConfig?.quickFilters) ? model.quickFilterConfig.quickFilters : [];
      return list
        .filter(q => q?.id != null && typeof q.query === "string")
        .map(q => ({ id: String(q.id), name: text(q.name, 120), jql: q.query, description: text(q.description, 300) }));
    }
    const out = [];
    for (let startAt = 0; startAt < 200;) {
      const page = await ctx.client.json(`${agileBase(ctx.conn)}/board/${boardId}/quickfilter?startAt=${startAt}&maxResults=50`);
      const values = Array.isArray(page?.values) ? page.values : [];
      for (const q of values) {
        if (q?.id != null && typeof q.jql === "string") out.push({ id: String(q.id), name: text(q.name, 120), jql: q.jql, description: text(q.description, 300) });
      }
      if (page?.isLast !== false || values.length === 0) break;
      startAt += values.length;
    }
    return out;
  });
}

function sprintOf(raw) {
  return {
    id: Number(raw?.id) || 0,
    name: text(raw?.name, 200),
    state: String(raw?.state ?? "").toLowerCase(),
    startDate: text(raw?.startDate, 40) || null,
    endDate: text(raw?.endDate, 40) || null,
    completeDate: text(raw?.completeDate, 40) || null,
    goal: text(raw?.goal, 500),
  };
}

async function sprintsIn(ctx, boardId, state, cap = 300) {
  const out = [];
  for (let startAt = 0; startAt < cap;) {
    const page = await ctx.client.json(`${agileBase(ctx.conn)}/board/${boardId}/sprint?state=${state}&startAt=${startAt}&maxResults=50`);
    const values = Array.isArray(page?.values) ? page.values : [];
    out.push(...values.map(sprintOf));
    if (page?.isLast !== false || values.length === 0) break;
    startAt += values.length;
  }
  return out;
}

/** Whether a kanban board shows a backlog. Agile's feature list where the
 *  instance has it; otherwise, whether the backlog answers at all. */
async function kanbanBacklog(ctx, boardId) {
  return ctx.cache.remember(`backlog-on:${boardId}`, 10 * MINUTE, async () => {
    try {
      const features = await ctx.client.json(`${agileBase(ctx.conn)}/board/${boardId}/features`);
      const backlog = (features?.features ?? []).find(f => /backlog/i.test(String(f?.boardFeature ?? f?.feature ?? "")));
      if (backlog) return String(backlog.state ?? "").toUpperCase() === "ENABLED";
    } catch (err) {
      if (err instanceof IntegrationError && (err.kind === "expired" || err.kind === "rate-limit")) throw err;
    }
    try {
      await listPage(ctx, `board/${boardId}/backlog`, { fields: "summary", max: 1 });
      return true;
    } catch (err) {
      if (err instanceof IntegrationError && (err.kind === "expired" || err.kind === "rate-limit")) throw err;
      return false;
    }
  });
}

const softwareBase = conn => `${apiRoot(conn)}/rest/software/1.0`;

/**
 * One page of a board's issue list (`suffix`: "board/1/backlog",
 * "board/1/sprint/5/issue", "board/1/issue"), in Rank order. On Cloud it is
 * /rest/software/1.0, paged by a next-page token, and Agile 1.0 where that is
 * not deployed; on Server, Agile 1.0 paged by startAt. `cursor` is the `next`
 * the last page answered — "" for the first — and `next` is "" on the last.
 */
async function listPage(ctx, suffix, { jql = "", fields, cursor = "", max = PAGE }) {
  if (isCloud(ctx.conn) && !cursor.startsWith("s.")) {
    const params = new URLSearchParams({ maxResults: String(max), fields });
    if (jql) params.set("jql", jql);
    if (cursor.startsWith("t.")) params.set("nextPageToken", cursor.slice(2));
    try {
      const page = await ctx.client.json(`${softwareBase(ctx.conn)}/${suffix}?${params}`);
      const issues = Array.isArray(page?.issues) ? page.issues : [];
      const token = typeof page?.nextPageToken === "string" ? page.nextPageToken : "";
      return { issues, next: token && page?.isLast !== true && issues.length ? `t.${token}` : "", total: null };
    } catch (err) {
      if (!(err instanceof IntegrationError) || err.kind !== "not-found" || cursor) throw err;
      // Not on this site yet: Agile 1.0's own list.
    }
  }
  const startAt = cursor.startsWith("s.") ? Math.max(0, Number.parseInt(cursor.slice(2), 10) || 0) : 0;
  const params = new URLSearchParams({ startAt: String(startAt), maxResults: String(max), fields });
  if (jql) params.set("jql", jql);
  const page = await ctx.client.json(`${agileBase(ctx.conn)}/${suffix}?${params}`);
  const issues = Array.isArray(page?.issues) ? page.issues : [];
  const total = Number.isFinite(page?.total) ? page.total : null;
  const end = startAt + issues.length;
  const more = issues.length > 0 && (total == null ? issues.length >= max : end < total);
  return { issues, next: more ? `s.${end}` : "", total };
}

/** Cloud's count of a backlog, which its token-paged list does not carry. */
async function approximateCount(ctx, suffix, jql) {
  if (!isCloud(ctx.conn)) return null;
  try {
    const params = new URLSearchParams(jql ? { jql } : {});
    const answer = await ctx.client.json(`${softwareBase(ctx.conn)}/${suffix}/approximate-count?${params}`);
    return Number.isFinite(answer?.count) ? answer.count : null;
  } catch (err) {
    if (err instanceof IntegrationError && (err.kind === "expired" || err.kind === "rate-limit")) throw err;
    return null;
  }
}

/** The issue fields a backlog row needs. */
function rowFields(ids, estimationField) {
  return [
    "summary", "status", "issuetype", "priority", "assignee", "parent", "subtasks", "fixVersions",
    "timeoriginalestimate", "timeestimate", "aggregatetimeoriginalestimate", "updated", "flagged", "epic",
    ids.epicLink, ids.flagged, estimationField && estimationField !== "timeoriginalestimate" ? estimationField : null,
  ].filter(Boolean).join(",");
}

/** Cloud's "Issue color" names, as Jira's epic colour numbers. */
const ISSUE_COLOURS = {
  dark_grey: 1, dark_yellow: 2, yellow: 3, dark_blue: 4, dark_teal: 5, green: 6, purple: 7,
  dark_purple: 8, orange: 9, blue: 10, teal: 11, grey: 12, dark_green: 13, dark_orange: 14,
};

function epicFrom(fields, ids) {
  const f = fields ?? {};
  const named = ids.issueColor ? ISSUE_COLOURS[String(f[ids.issueColor] ?? "").toLowerCase()] ?? null : null;
  return {
    name: text((ids.epicName && f[ids.epicName]) || f.summary, 200),
    color: (ids.epicColor ? epicColour(f[ids.epicColor]) : null) ?? named,
  };
}

/** Read the names and colours of the epics a page of issues points at: one
 *  search for all of them, or one read each when the search is refused (a key
 *  the account cannot see fails the whole JQL). */
async function resolveEpics(ctx, issues, ids) {
  const keys = new Set();
  for (const issue of issues) {
    const f = issue?.fields ?? {};
    const k = (ids.epicLink && typeof f[ids.epicLink] === "string" && f[ids.epicLink])
      || (f.epic && typeof f.epic === "object" && f.epic.key)
      || (f.parent && (f.parent.fields?.issuetype?.hierarchyLevel === 1 || /^epic$/i.test(String(f.parent.fields?.issuetype?.name ?? ""))) && f.parent.key);
    if (k && /^[A-Z][A-Z0-9_]{0,40}-\d{1,12}$/i.test(String(k))) keys.add(String(k).toUpperCase());
  }
  const epics = new Map();
  const wanted = [];
  for (const key of [...keys].slice(0, 100)) {
    const hit = ctx.cache.peek(`epic:${key}`, 10 * MINUTE);
    if (hit) epics.set(key, hit); else wanted.push(key);
  }
  if (!wanted.length) return epics;
  const fields = ["summary", ids.epicName, ids.epicColor, ids.issueColor].filter(Boolean).join(",");
  const keep = (key, epic) => { epics.set(key, epic); ctx.cache.set(`epic:${key}`, epic); };
  try {
    const found = await searchAll(ctx, `issuekey in (${wanted.join(",")})`, fields, wanted.length);
    for (const issue of found) {
      const key = text(issue?.key, 64).toUpperCase();
      if (key) keep(key, epicFrom(issue.fields, ids));
    }
    return epics;
  } catch (err) {
    if (err instanceof IntegrationError && (err.kind === "expired" || err.kind === "rate-limit")) throw err;
  }
  await Promise.all(wanted.slice(0, 30).map(async key => {
    try {
      const issue = await ctx.client.json(`${restBase(ctx.conn)}/issue/${encodeURIComponent(key)}?fields=${fields}`);
      keep(key, epicFrom(issue?.fields, ids));
    } catch (err) {
      if (err instanceof IntegrationError && (err.kind === "expired" || err.kind === "rate-limit")) throw err;
      // An epic the account cannot read is a neutral chip with its key.
    }
  }));
  return epics;
}

/** The JQL the reader's filters add: their own issues, and the board's quick
 *  filters by id — the page never sends JQL of its own. */
async function filterJql(ctx, boardId, query) {
  const clauses = [];
  if (query.get("mine") === "1") clauses.push("assignee = currentUser()");
  const wanted = String(query.get("quick") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (wanted.length) {
    const filters = await quickFilters(ctx, boardId);
    for (const id of wanted) {
      const q = filters.find(f => f.id === id);
      if (!q) throw integrationError("not-found", "That quick filter is not on this board any more. Refresh the board.");
      if (q.jql.trim()) clauses.push(`(${q.jql})`);
    }
  }
  return clauses;
}

const KANBAN_COLUMNS = {
  todo: 'statusCategory = "To Do"',
  progress: 'statusCategory = "In Progress"',
  done: "statusCategory = Done AND updated >= -14d",
};

function boardId(params) {
  const id = String(params.boardId ?? "");
  if (!/^\d{1,12}$/.test(id)) throw integrationError("invalid", "Not a board id.");
  return id;
}

function issueKey(params) {
  const key = String(params.key ?? "");
  if (!/^[A-Z][A-Z0-9_]{0,40}-\d{1,12}$/i.test(key)) throw integrationError("invalid", "Not an issue key.");
  return key.toUpperCase();
}

function startAtOf(query) {
  const n = Number.parseInt(String(query.get("startAt") ?? "0"), 10);
  return Number.isFinite(n) && n >= 0 && n < 100_000 ? n : 0;
}

/** Search issues by JQL: Cloud's enhanced search with next-page tokens, or
 *  Server's v2 search with startAt. Up to `cap` issues. */
async function searchAll(ctx, jql, fields, cap = 300) {
  const out = [];
  if (isCloud(ctx.conn)) {
    let token = "";
    for (let guard = 0; guard < 20 && out.length < cap; guard++) {
      const params = new URLSearchParams({ jql, fields, maxResults: String(Math.min(PAGE, cap - out.length)) });
      if (token) params.set("nextPageToken", token);
      const page = await ctx.client.json(`${restBase(ctx.conn)}/search/jql?${params}`);
      const issues = Array.isArray(page?.issues) ? page.issues : [];
      out.push(...issues);
      token = typeof page?.nextPageToken === "string" ? page.nextPageToken : "";
      if (!token || page?.isLast === true || issues.length === 0) break;
    }
    return out;
  }
  for (let startAt = 0; out.length < cap;) {
    const params = new URLSearchParams({ jql, fields, startAt: String(startAt), maxResults: String(Math.min(PAGE, cap - out.length)) });
    const page = await ctx.client.json(`${restBase(ctx.conn)}/search?${params}`);
    const issues = Array.isArray(page?.issues) ? page.issues : [];
    out.push(...issues);
    startAt += issues.length;
    if (issues.length === 0 || startAt >= Number(page?.total ?? 0)) break;
  }
  return out;
}

// ── routes ──────────────────────────────────────────────────────────────────

export function registerJiraRoutes(router) {
  /** Boards, a page at a time, optionally by name. */
  router.get("boards", async ctx => {
    const startAt = startAtOf(ctx.query);
    const name = text(ctx.query.get("name") ?? "", 100);
    const params = new URLSearchParams({ startAt: String(startAt), maxResults: "50" });
    if (name) params.set("name", name);
    return ctx.cache.remember(`boards:${params}`, 5 * MINUTE, async () => {
      const page = await ctx.client.json(`${agileBase(ctx.conn)}/board?${params}`);
      const values = (Array.isArray(page?.values) ? page.values : []).map(b => ({
        id: Number(b?.id) || 0,
        name: text(b?.name, 200),
        type: String(b?.type ?? "").toLowerCase(),
        projectKey: text(b?.location?.projectKey, 40),
        projectName: text(b?.location?.projectName ?? b?.location?.displayName ?? b?.location?.name, 200),
        avatar: imageUrl(ctx.conn, b?.location?.avatarURI),
      })).filter(b => b.id);
      const total = Number.isFinite(page?.total) ? page.total : null;
      return { boards: values, startAt, total, isLast: page?.isLast !== false || values.length === 0 };
    });
  });

  /** One board: what it is, how it estimates, its quick filters and its open
   *  sprints — everything the panel draws before any issue is read. */
  router.get("board/:boardId", async ctx => {
    const id = boardId(ctx.params);
    const board = await ctx.cache.remember(`board:${id}`, 10 * MINUTE, () => ctx.client.json(`${agileBase(ctx.conn)}/board/${id}`));
    const type = String(board?.type ?? "").toLowerCase();
    const scrum = type === "scrum";
    const [config, filters, time, sprints, backlog] = await Promise.all([
      boardConfig(ctx, id),
      quickFilters(ctx, id).catch(err => {
        if (err instanceof IntegrationError && (err.kind === "expired" || err.kind === "rate-limit")) throw err;
        return [];
      }),
      timeTracking(ctx),
      scrum ? sprintsIn(ctx, id, "active,future") : Promise.resolve([]),
      scrum ? Promise.resolve(true) : kanbanBacklog(ctx, id),
    ]);
    return {
      board: {
        id: Number(board?.id) || Number(id),
        name: text(board?.name, 200),
        type: type || "simple",
        projectKey: text(board?.location?.projectKey, 40),
        projectName: text(board?.location?.projectName ?? board?.location?.displayName, 200),
      },
      estimation: config.estimation,
      quickFilters: filters.map(({ id: qid, name, description }) => ({ id: qid, name, description })),
      sprints: {
        active: sprints.filter(s => s.state === "active"),
        future: sprints.filter(s => s.state === "future"),
      },
      hasSprints: scrum,
      hasBacklog: backlog,
      timeTracking: time,
    };
  });

  /** The board's closed sprints, most recent first, a page at a time. */
  router.get("board/:boardId/closed-sprints", async ctx => {
    const id = boardId(ctx.params);
    const startAt = startAtOf(ctx.query);
    const all = await ctx.cache.remember(`closed:${id}`, 10 * MINUTE, () => sprintsIn(ctx, id, "closed", 1000));
    const ordered = all.slice().sort((a, b) => String(b.completeDate ?? b.endDate ?? "").localeCompare(String(a.completeDate ?? a.endDate ?? "")) || b.id - a.id);
    const size = 10;
    return { sprints: ordered.slice(startAt, startAt + size), startAt, total: ordered.length, isLast: startAt + size >= ordered.length };
  });

  /** A group's issues, in rank order: one sprint, the backlog (a page at a
   *  time, from `cursor`), or one kanban column. */
  router.get("board/:boardId/issues", async ctx => {
    const id = boardId(ctx.params);
    const source = String(ctx.query.get("source") ?? "");
    const [ids, config] = await Promise.all([fieldIds(ctx), boardConfig(ctx, id)]);
    const clauses = await filterJql(ctx, id, ctx.query);
    let suffix;
    let paged = false;
    if (source === "sprint") {
      const sprint = String(ctx.query.get("sprint") ?? "");
      if (!/^\d{1,12}$/.test(sprint)) throw integrationError("invalid", "Not a sprint id.");
      suffix = `board/${id}/sprint/${sprint}/issue`;
    } else if (source === "backlog") {
      suffix = `board/${id}/backlog`;
      paged = true;
    } else if (source === "kanban") {
      const name = String(ctx.query.get("column") ?? "");
      const column = KANBAN_COLUMNS[name];
      if (!column) throw integrationError("invalid", "Not a board column.");
      // With the kanban backlog on, its column's issues are the Backlog
      // group's, not To Do's.
      const backlogColumn = config.columns[0];
      if (name === "todo" && ctx.query.get("backlog") === "1" && backlogColumn && /backlog/i.test(backlogColumn.name) && backlogColumn.statusIds.length) {
        clauses.unshift(`status not in (${backlogColumn.statusIds.join(",")})`);
      }
      clauses.unshift(column);
      suffix = `board/${id}/issue`;
    } else {
      throw integrationError("invalid", "Not an issue group.");
    }
    const estimationField = config.estimation.fieldId;
    const fields = rowFields(ids, estimationField);
    const jql = clauses.join(" AND ");
    const issues = [];
    const cursor = paged ? String(ctx.query.get("cursor") ?? "").slice(0, 2000) : "";
    const cap = paged ? PAGE : SPRINT_CAP;
    let next = cursor;
    let total = null;
    const counting = paged && !cursor ? approximateCount(ctx, suffix, jql) : Promise.resolve(null);
    for (let guard = 0; guard < 12 && issues.length < cap; guard++) {
      const page = await listPage(ctx, suffix, { jql, fields, cursor: next, max: Math.min(PAGE, cap - issues.length) });
      issues.push(...page.issues);
      if (page.total != null) total = page.total;
      next = page.next;
      if (!next || page.issues.length === 0) break;
    }
    total ??= await counting;
    const epics = await resolveEpics(ctx, issues, ids);
    return {
      issues: issues.map(issue => normaliseIssue(ctx.conn, issue, ids, epics, estimationField)),
      // Cloud's token-paged backlog has no total but its approximate count.
      total: total ?? (!paged && !next ? issues.length : null),
      next: paged ? next : "",
      capped: !paged && Boolean(next),
    };
  });

  /** Every subtask of one issue, whoever has it. */
  router.get("issue/:key/subtasks", async ctx => {
    const key = issueKey(ctx.params);
    const ids = await fieldIds(ctx);
    const issues = await searchAll(ctx, `parent = ${key}`, rowFields(ids, null), 200);
    const epics = new Map();
    return { issues: issues.map(issue => normaliseIssue(ctx.conn, issue, ids, epics, null)) };
  });

  /** One issue in full: the detail pane. */
  router.get("issue/:key", async ctx => {
    const key = issueKey(ctx.params);
    const ids = await fieldIds(ctx);
    const fields = [
      "summary", "status", "issuetype", "priority", "assignee", "reporter", "project", "labels", "components",
      "fixVersions", "duedate", "created", "updated", "timeoriginalestimate", "timeestimate", "timespent",
      "aggregatetimeoriginalestimate", "description", "subtasks", "parent", "attachment", "resolution",
      ids.sprint, ids.epicLink, ids.flagged,
    ].filter(Boolean).join(",");
    const [issue, comments] = await Promise.all([
      ctx.client.json(`${restBase(ctx.conn)}/issue/${encodeURIComponent(key)}?fields=${fields}&expand=renderedFields`),
      ctx.client.json(`${restBase(ctx.conn)}/issue/${encodeURIComponent(key)}/comment?orderBy=-created&maxResults=10&expand=renderedBody`).catch(err => {
        if (err instanceof IntegrationError && (err.kind === "expired" || err.kind === "rate-limit")) throw err;
        return null;
      }),
    ]);
    const f = issue?.fields ?? {};
    const epics = await resolveEpics(ctx, [issue], ids);
    const row = normaliseIssue(ctx.conn, issue, ids, epics, null);
    const subtasks = row.subtaskKeys.length
      ? await searchAll(ctx, `parent = ${key}`, rowFields(ids, null), 200).catch(() => [])
      : [];
    const order = new Map(row.subtaskKeys.map((k, i) => [k, i]));
    const sprints = sprintsFrom(ids.sprint ? f[ids.sprint] : null);
    const sprint = sprints.find(s => s.state === "active") ?? sprints.find(s => s.state === "future") ?? sprints.at(-1) ?? null;
    const items = Array.isArray(comments?.comments) ? comments.comments : [];
    return {
      issue: {
        ...row,
        project: { key: text(f.project?.key, 40), name: text(f.project?.name, 200), avatar: imageUrl(ctx.conn, f.project?.avatarUrls?.["48x48"]) },
        reporter: personFrom(f.reporter, ctx.conn),
        labels: Array.isArray(f.labels) ? f.labels.map(l => text(l, 80)).filter(Boolean) : [],
        components: Array.isArray(f.components) ? f.components.map(c => text(c?.name, 80)).filter(Boolean) : [],
        dueDate: text(f.duedate, 20) || null,
        created: text(f.created, 40),
        resolution: text(f.resolution?.name, 80) || null,
        timeSpent: seconds(f.timespent),
        sprint: sprint ? { name: sprint.name, state: sprint.state } : null,
        descriptionHtml: typeof issue?.renderedFields?.description === "string" ? issue.renderedFields.description : "",
      },
      comments: {
        total: Number.isFinite(comments?.total) ? comments.total : items.length,
        items: items.map(c => ({
          id: text(String(c?.id ?? ""), 40),
          author: personFrom(c?.author, ctx.conn),
          created: text(c?.created, 40),
          updated: text(c?.updated, 40),
          html: typeof c?.renderedBody === "string" ? c.renderedBody : "",
        })),
      },
      attachments: (Array.isArray(f.attachment) ? f.attachment : []).map(a => ({
        id: text(String(a?.id ?? ""), 40),
        filename: text(a?.filename, 300),
        size: Number.isFinite(a?.size) ? a.size : null,
        mimeType: text(a?.mimeType, 100),
        created: text(a?.created, 40),
        // Opened in the browser, where Jira's own sign-in applies; never
        // fetched by the deck.
        url: typeof a?.content === "string" && /^https?:\/\//.test(a.content) ? a.content : null,
      })),
      subtasks: subtasks
        .map(s => normaliseIssue(ctx.conn, s, ids, new Map(), null))
        .sort((a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9)),
    };
  });
}

const jiraRouter = createRouter();
registerJiraRoutes(jiraRouter);

/**
 * A client for one Jira connection (registry.mjs's contract). It holds the
 * secret in its closure — never as a property, so nothing that serialises a
 * client can carry it — a transport that signs only for the connection's
 * origins, and the connection's short caches.
 *
 * `apiOrigin` replaces api.atlassian.com for a suite whose "site" is on this
 * machine (atlassianApiOrigin keeps it to local hosts).
 */
export function createJiraClient(conn, secret, { fetchImpl, apiOrigin } = {}) {
  let origins = Array.isArray(conn.allowedOrigins) && conn.allowedOrigins.length ? conn.allowedOrigins.slice() : [originOf(conn.baseUrl)].filter(Boolean);
  const cache = createCache();
  const proxy = (list, phase, signal) => createProxy({
    conn: { ...conn, allowedOrigins: list }, secret, sign: signJira, phase, signal, fetchImpl,
    label: "Jira", errorDetail: jiraErrorDetail, authCheck: jiraAuthCheck,
  });
  let useProxy = null;
  const reader = () => (useProxy ??= proxy(origins, "use"));
  return {
    kind: "jira",
    conn,
    cache,
    get allowedOrigins() { return origins.slice(); },
    async validate({ phase = "validate", signal } = {}) {
      const result = await validateJira(conn, secret, { phase, signal, client: list => proxy(list, phase, signal) }, { apiOrigin });
      origins = result.allowedOrigins.slice();
      useProxy = null;
      return { account: result.account, meta: result.meta };
    },
    /** An image for the asset route (registry.mjs): with the token on the
     *  connection's own origins only, without it on Jira's public image
     *  hosts, nowhere else — the address and every redirect checked. */
    fetchAsset(url, { maxBytes, signal } = {}) {
      return fetchImage(url, {
        tokenOrigins: origins, imageHost: u => jiraImageHost(conn, u.href), sign: signJira, secret, fetchImpl, maxBytes, signal,
      });
    },
    /** A read through this connection, bound to one request's abort. */
    reader(signal) {
      const p = reader();
      return {
        allows: p.allows,
        origins: p.origins,
        json: (url, opts = {}) => p.json(url, { ...opts, signal }),
        bytes: (url, opts = {}) => p.bytes(url, { ...opts, signal }),
      };
    },
  };
}

/** The panel's reads (registerJiraRoutes), as registry.mjs's `routes`. */
export async function jiraRoutes(client, method, subpath, searchParams, _req, { signal } = {}) {
  if (method !== "GET" && method !== "HEAD") return errorResponse(integrationError("invalid", "The Jira panel only reads."));
  const route = jiraRouter.find(subpath);
  if (!route) return errorResponse(integrationError("not-found", "No such Jira read."));
  try {
    const data = await route.handler({
      conn: client.conn, client: client.reader(signal), params: route.params, query: searchParams, cache: client.cache, signal,
    });
    return { status: 200, body: { ok: true, ...(data ?? {}) } };
  } catch (err) {
    return errorResponse(err);
  }
}

/** The provider, for providers.mjs. */
export function createJiraProvider({ apiOrigin } = {}) {
  return {
    kind: "jira",
    label: "Jira",
    createClient: (conn, secret, opts = {}) => createJiraClient(conn, secret, { ...opts, apiOrigin }),
    routes: jiraRoutes,
    parseInput: parseJiraInput,
    defaultName: checked => {
      try { return new URL(checked.baseUrl).host; } catch { return "Jira"; }
    },
  };
}

export const jiraProvider = createJiraProvider();
