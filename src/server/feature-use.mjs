// Which features got used today, for the "active" report's `features` (see
// usage-day.mjs for the list and reports.mjs for what leaves).
//
// Two doors in. The page names what it saw opened — a panel shown, a dialog
// opened — through POST /api/feature, once per name per day (feature-use.ts).
// The server names what a request did: the routes below are actions somebody
// takes on purpose, never something a page polls, so the request is the use.
// Either way only a name off FEATURES is kept, and only as "used today".
//
// And where the deck was looked at from: a page connected to /events is the
// desktop app's window or a browser tab for as long as it stays (event-routes.mjs),
// and `ccdeck tui` says so on the requests it makes (deck-client.mjs).
import { readBody, send } from "./http-io.mjs";
import { usageDay } from "./usage-day.mjs";

/** The requests that are a feature being used. Only actions: a read the page
 *  makes on its own (the quota, the roster, a radio probe) says nothing about
 *  what somebody chose to do. */
const ROUTE_FEATURES = new Map([
  ["POST /api/claude-accounts/switch", "account-switch"],
  ["POST /api/claude-accounts/admin", "accounts-manage"],
  ["POST /api/cswap-auto", "auto-switch"],
  ["POST /api/lan/invite", "lan-pairing"],
  ["POST /api/lan/peer", "lan-pairing"],
  ["POST /api/feedback", "feedback-sent"],
  ["POST /api/upgrade", "self-update"],
  ["POST /api/clear", "clear-board"],
  // A session started from the deck's New session, and one brought back into
  // a pane by Reopen here or Move session here: each only ever on a press
  // (use-terminal-session.ts). Attaching a pane is not on the list, since a
  // reloaded page attaches its panes by itself.
  ["POST /api/terminal/launch", "session-launch"],
  ["POST /api/terminal/adopt", "session-reopen"],
  ["POST /api/session-name", "session-rename"],
  ["POST /api/claude-install", "claude-install"],
  ["POST /api/claude-settings", "claude-settings"],
  ["POST /api/codex-profile-select", "codex-account-switch"],
  ["POST /api/codex-profile-add", "codex-accounts-manage"],
  ["POST /api/codex-profile-remove", "codex-accounts-manage"],
  ["POST /api/codex-profile-rename", "codex-accounts-manage"],
  ["POST /api/codex-profile-replace-login", "codex-accounts-manage"],
  ["POST /api/codex-auto", "codex-auto-switch"],
]);

/** Features a whole namespace of routes is: a connected tracker's reads carry
 *  the connection's id in the path (#2178), so they are matched by prefix. The
 *  name is the provider's, never the connection, board or issue read. */
const ROUTE_PREFIX_FEATURES = [
  ["GET /api/integrations/jira/", "jira"],
  ["GET /api/integrations/github/", "github"],
  ["GET /api/integrations/gitlab/", "gitlab"],
];

/** Jira's three writes, which carry a connection, a board or an issue key in
 *  the path and so are matched by their shape (integrations/routes.mjs): an
 *  issue moved, moved to another status, or commented on. The name says that
 *  one was asked for, never which issue or what it said. */
const ROUTE_PATTERN_FEATURES = [
  [/^POST \/api\/integrations\/jira\/[^/]+\/(?:board\/[^/]+\/move|issue\/[^/]+\/(?:transitions|comment))$/, "jira-change"],
];

/** The feature a request is, or undefined. */
export function routeFeature(method, pathname) {
  const route = `${method} ${pathname}`;
  return ROUTE_FEATURES.get(route)
    ?? ROUTE_PREFIX_FEATURES.find(([prefix]) => route.startsWith(prefix))?.[1]
    ?? ROUTE_PATTERN_FEATURES.find(([shape]) => shape.test(route))?.[1];
}

/** Note the feature a request is, if it is one. Called for requests that got
 *  past the deck's own gates. */
export function noteRouteFeature(method, pathname) {
  const name = routeFeature(method, pathname);
  if (name) usageDay.noteFeature(name);
}

/** POST /api/feature — the page saying it showed or opened something.
 *  `{ name }`; a name off the list is a 400, and nothing about it is kept. */
export async function handleFeature(req, res) {
  const raw = await readBody(req).catch(() => null);
  let body = null;
  try { body = JSON.parse(raw ?? ""); } catch { /* handled below */ }
  const name = typeof body?.name === "string" ? body.name : "";
  if (!usageDay.noteFeature(name)) return send(res, 400, { ok: false, reason: "unknown_feature" });
  return send(res, 200, { ok: true });
}

/** The desktop app's window says so in its User-Agent, `ccdeck-desktop/<version>`
 *  after the browser's own (desktop/main.mjs), and the page reads it the same way
 *  (src/web/in-app.ts). */
const IN_APP = /\bccdeck-desktop\/\d/;

/** Which surface a page is: "desktop-window" for the app's window, else
 *  "browser-tab" — any browser, on this machine or through a tunnel. */
export function pageSurface(headers = {}) {
  const ua = headers?.["user-agent"];
  return typeof ua === "string" && IN_APP.test(ua) ? "desktop-window" : "browser-tab";
}

/** A page connected to /events: its surface is used today, and on every day it
 *  is still connected when the day turns, until the connection closes. Never
 *  for the app's tray connection, which is a reader and not somebody looking
 *  (sse-clients.mjs): the caller leaves it out. Never throws. */
export function holdPageSurface(req, usage = usageDay) {
  try {
    const release = usage.holdFeature(pageSurface(req?.headers));
    req.once("close", release);
  } catch {
    // A page this could not count still gets its stream.
  }
}

/** What a terminal client may say it is, in `x-ccdeck-client`, and the features
 *  each is: `ccdeck tui`, and `ccdeck tui` reading its Network tab while that
 *  tab is on screen (bin/cli/tui.js). Anything else — another value, another
 *  command — is nothing. */
const CLIENT_FEATURES = new Map([["tui", ["tui"]], ["tui-network", ["tui", "tui-network"]]]);

/** Note the client a request says it came from, if it is one off the list and
 *  the request carries the deck's own token (`authenticated`, request-gates.mjs
 *  presentsDeckToken), which only this user's own commands read off the deck's
 *  record: nothing else can pass for a terminal by setting the header. */
export function noteClientFeature(headers = {}, authenticated = false, usage = usageDay) {
  if (!authenticated) return;
  const raw = headers?.["x-ccdeck-client"];
  if (typeof raw !== "string") return;
  for (const name of CLIENT_FEATURES.get(raw.trim().toLowerCase()) ?? []) usage.noteFeature(name);
}
