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
import { readBody, send } from "./http-io.mjs";
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
