// Which features got used today, for the "active" report's `features` (see
// usage-day.mjs for the list and reports.mjs for what leaves).
//
// Two doors in. The page names what it saw opened — a panel shown, a dialog
// opened — through POST /api/feature, once per name per day (feature-use.ts).
// The server names what a request did: the routes below are actions somebody
// takes on purpose, never something a page polls, so the request is the use.
// Either way only a name off FEATURES is kept, and only as "used today".
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
]);

/** Note the feature a request is, if it is one. Called for requests that got
 *  past the deck's own gates. */
export function noteRouteFeature(method, pathname) {
  const name = ROUTE_FEATURES.get(`${method} ${pathname}`);
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
