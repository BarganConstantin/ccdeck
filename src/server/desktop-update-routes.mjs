// The desktop app's update, as the window sees it: the state the app's updater
// reports, and the window's two answers to it relayed back to the app.
//
// These lived in src/server/index.mjs, after the tray notifier. The state is
// this module's; the frames go out through the subscriber sets and writeSse in
// sse-clients.mjs — to the pages for the state, and to the app's own tray
// connections for the window's answers. The handlers are unchanged.
import { readBody, send } from "./http-io.mjs";
import { presentsDeckToken } from "./request-gates.mjs";
import { sseClients, trayClients, writeSse } from "./sse-clients.mjs";

// The desktop app's updater lives in Electron, while the window is a page
// served by this deck. Keep only the small piece of state the page needs. A
// report is accepted only with the deck token; a browser may request an
// install, but Electron verifies the exact ready version again before acting.
const DESKTOP_UPDATE_STATUSES = new Set(["idle", "checking", "current", "downloading", "ready", "error"]);
let desktopUpdateState = { status: "idle", version: null };

function cleanDesktopUpdate(value) {
  if (!value || typeof value !== "object" || !DESKTOP_UPDATE_STATUSES.has(value.status)) return null;
  const version = typeof value.version === "string" && value.version.trim()
    ? value.version.trim().slice(0, 80)
    : null;
  if (value.status === "ready" && !version) return null;
  return { status: value.status, version };
}

function broadcastDesktopUpdate() {
  const frame = `event: desktop-update\ndata: ${JSON.stringify(desktopUpdateState)}\n\n`;
  for (const client of sseClients) {
    if (!trayClients.has(client)) writeSse(client, frame);
  }
}

function handleDesktopUpdateRead(_req, res) {
  send(res, 200, desktopUpdateState);
}

async function handleDesktopUpdateReport(req, res) {
  // Same-origin pages pass the generic mutation gate, but only the native app
  // may claim what its updater has verified.
  if (!presentsDeckToken(req.headers ?? {})) {
    return send(res, 401, { ok: false, reason: "app_token_required" });
  }
  const body = await readBody(req, res).catch(() => null);
  let value = null;
  try { value = cleanDesktopUpdate(JSON.parse(body ?? "")); } catch { /* bad JSON */ }
  if (!value) return send(res, 400, { ok: false, reason: "bad_update_state" });
  desktopUpdateState = value;
  broadcastDesktopUpdate();
  send(res, 200, { ok: true });
}

// The window's two messages about that update, relayed to the app as frames
// on its tray stream: apply it (`desktop-update-restart`), or it has been shown
// (`desktop-update-seen`, so the app's own ready notice stands down, #1182).
// Both behind the same gates as /api/restart, and neither decides anything:
// this refuses only what cannot be current, and Electron checks the exact
// ready version again before acting on either.
async function handleDesktopUpdateRequest(req, res, event) {
  const body = await readBody(req, res).catch(() => null);
  let version = "";
  try { version = String(JSON.parse(body ?? "")?.version ?? "").trim(); } catch { /* bad JSON */ }
  if (!version || desktopUpdateState.status !== "ready" || desktopUpdateState.version !== version) {
    return send(res, 409, { ok: false, reason: "update_not_ready" });
  }
  if (trayClients.size === 0) return send(res, 409, { ok: false, reason: "app_disconnected" });
  const frame = `event: ${event}\ndata: ${JSON.stringify({ version })}\n\n`;
  for (const client of trayClients) writeSse(client, frame);
  send(res, 202, { ok: true });
}

// The four routes index.mjs dispatches to these. Listed rather than marked at
// each declaration, so the declarations read as they did where they came from.
export { handleDesktopUpdateRead, handleDesktopUpdateReport, handleDesktopUpdateRequest };
