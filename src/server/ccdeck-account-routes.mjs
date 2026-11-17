// The ccdeck account's local routes (design 4.8) — /api/account and the nine
// under it — and the `event: account` frames the open pages hear.
//
//   GET  /api/account                 the account, as the page draws it
//   POST /api/account/connect         { name } → a user code for the browser
//   POST /api/account/connect/cancel
//   POST /api/account/disconnect
//   POST /api/account/ui              { values, reason } what a person changed
//   POST /api/account/ui/applied      { revision, skipped? } a tab applied it
//   GET  /api/account/sync/preview    this deck against the shared profile
//   POST /api/account/sync/mode       join or leave shared settings
//   POST /api/account/sync/resolve    { action: "use-latest" | "reapply" }
//   POST /api/account/sync/upload     { upload: true } to a different account
//
// and the account's feedback conversations (feedback-conversations design 4.4):
//
//   GET  /api/account/feedback/threads[?before=<cursor>]     the list
//   GET  /api/account/feedback/threads/<id>[?before=<seq>]   one conversation
//   POST /api/account/feedback/threads                       a new one: JSON
//        { kind, title, body }, or the dialog's form with its images
//   POST /api/account/feedback/threads/<id>/replies          { body }
//   POST /api/account/feedback/threads/<id>/read             { seq }
//
// A malformed id, cursor or item number is answered here and never leaves the
// deck. Every failure is `{ ok: false, reason }` (feedbackFailure below); the
// dialog words it.
//
// "ccdeck-account", not "account": account-routes.mjs is the CLAUDE accounts'
// routes — the logins this deck switches between — which are a different
// thing that happens to share the word.
//
// IMPORTED ONLY WHEN THE ACCOUNT IS ON. index.mjs reaches this module through
// a dynamic import() behind accountOn, so on a deck with the flag off it is
// never evaluated, and nor is anything it imports. The gates in front of the
// route table still run first: the two reads are in GUARDED_READS and every
// POST is a mutation, so only the deck's own page or a holder of its token
// gets here.
import { readBody, readBytes, send } from "./http-io.mjs";
import { MAX_REQUEST_BYTES, isMultipart, readFeedbackForm } from "./feedback-form.mjs";
import { createAccountService } from "./account-service.mjs";
import { sseClients, trayClients, writeSse } from "./sse-clients.mjs";
import { ringSnapshot } from "./event-ring.mjs";
import { connectEventTap } from "./event-pipeline.mjs";
import { machineReading } from "./system-metrics.mjs";
import { onBeforeShutdown } from "./lifecycle.mjs";
import { setDeviceTokens } from "./token-redact.mjs";
import { setupFacts } from "./activation.mjs";
import { deckProviders } from "./deck-scope.mjs";
import { heldPrefs } from "./prefs-state.mjs";
import { accountOn } from "./account-flag.mjs";

/** The bodies here are a name, a dozen settings and a revision. */
const BODY_LIMIT = 16 * 1024;
/** A feedback message is up to 10,000 characters, escaped: the API's own
 *  cap on its feedback device routes (FeedbackDeviceRequests.MaxBytes). */
export const FEEDBACK_JSON_LIMIT = 64 * 1024;

const FEEDBACK_PREFIX = "/api/account/feedback/threads";
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIST_CURSOR = /^[A-Za-z0-9_-]{1,64}$/;
const ITEM_SEQ = /^(0|[1-9]\d{0,9})$/;
/** Each failure's status, by the reason the service gave (design 4.4). */
const FEEDBACK_STATUS = {
  invalid: 400, not_found: 404, too_large: 413, too_many: 429, not_connected: 409, revoked: 409, unavailable: 502,
};
const TOO_LARGE = { ok: false, reason: "too_large" };

/** The page frames, never the desktop app's tray connections, which have no
 *  account to draw. */
function broadcastAccount(view) {
  const frame = `event: account\ndata: ${JSON.stringify(view)}\n\n`;
  for (const client of sseClients) {
    if (!trayClients.has(client)) writeSse(client, frame);
  }
}

/** Whether anything feeds this deck at all — Claude's hooks or the Codex
 *  watcher. Before the boot has said, the providers it was asked to watch. */
function captureOn() {
  const s = setupFacts();
  if (!s.codexWatch) {
    const p = deckProviders();
    return p.claude || p.codex;
  }
  return s.claudeHooks === "ok" || s.codexWatch === "on";
}

async function jsonBody(req, res) {
  const raw = await readBody(req, res, BODY_LIMIT).catch(() => null);
  if (raw == null) return null;
  if (raw === "") return {};
  try {
    const body = JSON.parse(raw);
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** A feedback answer from the service, sent: the API's body as it came, or
 *  the failure with the status its reason has. */
function sendFeedback(res, out, okStatus = 200) {
  if (out.ok) return send(res, okStatus, out.body);
  const { ok, reason, ...rest } = out;
  return send(res, FEEDBACK_STATUS[reason] ?? 502, { ok: false, reason, ...rest });
}

const badRequest = res => send(res, 400, { ok: false, reason: "bad_request" });

/** A feedback route's JSON body, at most FEEDBACK_JSON_LIMIT bytes: an object,
 *  or null once it has been answered (too large) or is not one. */
async function feedbackJson(req, res) {
  const bytes = await readBytes(req, res, FEEDBACK_JSON_LIMIT, TOO_LARGE).catch(() => null);
  if (bytes == null) return null;
  try {
    const body = JSON.parse(bytes.length ? bytes.toString("utf8") : "{}");
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** Whether a request is one of the feedback routes. */
export function isFeedbackPath(path) {
  return path === FEEDBACK_PREFIX || path.startsWith(`${FEEDBACK_PREFIX}/`);
}

/**
 * The five feedback routes. `path` is under FEEDBACK_PREFIX; the id and the
 * cursors are checked before the service is asked anything.
 */
async function handleFeedback(service, req, res, url) {
  const rest = url.pathname.slice(FEEDBACK_PREFIX.length);
  const method = req.method;
  if (rest === "") {
    if (method === "GET") {
      const before = url.searchParams.get("before");
      if (before !== null && !LIST_CURSOR.test(before)) return badRequest(res);
      return sendFeedback(res, await service.feedbackThreads({ before: before ?? undefined }));
    }
    if (method !== "POST") return send(res, 404, { error: "not found" });
    const type = req.headers?.["content-type"];
    if (isMultipart(type)) {
      // Over the cap, readBytes has answered 413 too_large already.
      const bytes = await readBytes(req, res, MAX_REQUEST_BYTES, TOO_LARGE).catch(() => null);
      if (res.headersSent) return;
      if (!bytes) return badRequest(res);
      const form = await readFeedbackForm(bytes, type);
      if (!form) return badRequest(res);
      if (form.problems.length > 0) return send(res, 400, { ok: false, reason: "invalid", errors: { images: form.problems } });
      return sendFeedback(res, await service.feedbackCreate({ fields: form.fields, images: form.images }), 201);
    }
    const body = await feedbackJson(req, res);
    if (res.headersSent) return;
    if (!body) return badRequest(res);
    return sendFeedback(res, await service.feedbackCreate({ fields: body, images: [] }), 201);
  }
  const m = /^\/([^/]+)(\/replies|\/read)?$/.exec(rest);
  if (!m) return send(res, 404, { error: "not found" });
  const [, id, action] = m;
  if (!THREAD_ID.test(id)) return badRequest(res);
  if (!action) {
    if (method !== "GET") return send(res, 404, { error: "not found" });
    const before = url.searchParams.get("before");
    if (before !== null && !ITEM_SEQ.test(before)) return badRequest(res);
    return sendFeedback(res, await service.feedbackThread(id, { before: before === null ? undefined : Number(before) }));
  }
  if (method !== "POST") return send(res, 404, { error: "not found" });
  const body = await feedbackJson(req, res);
  if (res.headersSent) return;
  if (!body) return badRequest(res);
  if (action === "/replies") {
    if (typeof body.body !== "string") return badRequest(res);
    return sendFeedback(res, await service.feedbackReply(id, body.body), 201);
  }
  if (!Number.isInteger(body.seq) || body.seq < 0) return badRequest(res);
  return sendFeedback(res, await service.feedbackRead(id, body.seq));
}

/**
 * Build the service and start it. `deps` are startServer's `account` option,
 * the suite's stand-ins (a token store that never touches a real keychain, a
 * clock); the product passes nothing.
 */
export async function startAccountRoutes(deps = {}) {
  const service = createAccountService({
    prefs: () => heldPrefs.current(),
    broadcast: broadcastAccount,
    reading: machineReading,
    ring: ringSnapshot,
    connectTap: connectEventTap,
    capture: captureOn,
    registerShutdown: onBeforeShutdown,
    setRedactions: setDeviceTokens,
    enabled: () => accountOn(heldPrefs.current()),
    ...deps,
  });
  await service.start();

  const notConnected = res => send(res, 409, { ok: false, error: "not_connected" });

  async function handle(req, res, url) {
    const path = url.pathname;
    const method = req.method;
    if (isFeedbackPath(path)) return handleFeedback(service, req, res, url);
    if (method === "GET" && path === "/api/account") return send(res, 200, service.view());
    if (method === "GET" && path === "/api/account/sync/preview") {
      const out = await service.preview();
      if (!out) return notConnected(res);
      return send(res, out.error ? 502 : 200, out);
    }
    if (method !== "POST") return send(res, 404, { error: "not found" });

    const body = await jsonBody(req, res);
    if (res.headersSent) return;
    if (!body) return send(res, 400, { ok: false, error: "bad_request" });

    switch (path) {
      case "/api/account/connect":
        return send(res, 200, await service.connect(body.name));
      case "/api/account/connect/cancel":
        return send(res, 200, await service.cancelConnect());
      case "/api/account/disconnect":
        return send(res, 200, await service.disconnect());
      case "/api/account/ui": {
        const sync = await service.reportUi(body);
        return sync ? send(res, 200, { sync }) : notConnected(res);
      }
      case "/api/account/ui/applied": {
        const sync = await service.applied(body);
        return sync ? send(res, 200, { sync }) : notConnected(res);
      }
      case "/api/account/sync/mode": {
        const out = await service.setMode(body);
        if (!out) return notConnected(res);
        return send(res, out.error ? 409 : 200, out);
      }
      case "/api/account/sync/resolve": {
        const sync = await service.resolve(body);
        return sync ? send(res, 200, { sync }) : notConnected(res);
      }
      case "/api/account/sync/upload": {
        const sync = await service.upload(body);
        return sync ? send(res, 200, { sync }) : notConnected(res);
      }
      default:
        return send(res, 404, { error: "not found" });
    }
  }

  return { handle, service };
}
