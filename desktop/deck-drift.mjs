// The deck the app is attached to, when it serves older code than its own
// install holds — and the restart that puts it on the code it already has.
//
// Node caches every module at import, so a deck that was running when its
// package was replaced on disk keeps executing the old code until it restarts
// (src/server/self-update.mjs). The deck knows: GET /api/version answers the
// version it serves (`running`, read at its boot), the one its install holds
// (`installed`, read now) and a `restart` notice when the two differ. The app
// never asked. It compared the deck it found with the deck it carries, and
// only on the look that starts its own deck next (own-deck.mjs discoverPlan);
// every other look — the five-second one, the tray stream's reconnect, the
// own deck's exit — attached to whatever answered. So an npm deck that
// outlived an install of a newer version served the old code for as long as
// nobody pressed Restart: the deck's own away-update waits for nobody looking,
// and every terminal panel open on it counts as somebody looking
// (src/server/lifecycle.mjs deckPresence) — in a window left open, for as long
// as it is open.
//
// Three versions, then, and the app keeps them apart:
//   the app's   — app.getVersion(), and the deck it carries; what the start
//                 look replaces an older deck with, as before
//   installed   — what the attached deck's own install holds, which a restart
//                 of that deck runs
//   serving     — what the attached deck actually executes
// and acts on the last two, after every attach and every few minutes after.
//
// THE RESTART IS THE DECK'S OWN, through the route the page's Restart and the
// tray's Restart ccdeck already use: POST /api/restart, answered by the deck's
// supervisor bringing the newer worker up on the same port. Sessions live in
// tmux and survive it; no second deck is started beside it. It is asked with
// `whenIdle`, the page's automatic restart, which the deck grants only while it
// hears no turn running (src/server/lifecycle.mjs handleRestart).
//
// AND ONLY UNDER THE RULES THE APP ALREADY RESTARTS ITSELF UNDER
// (auto-update.mjs): its window not focused and nothing starting or restarting
// for a minute, and no agent working or waiting for a minute. Never while the
// deck's own "update by itself" switch is off, never for a deck that cannot
// restart without losing its canvas, and never twice for the same version: a
// restart the deck refused, or one that came back on the old version, is said
// in the tray and left to the person, whose Restart row stays there for it.
//
// Pure: main.mjs reads the clock, the window and the deck, and does what this
// answers.
import { QUIET_MS, quietLongEnough } from "./auto-update.mjs";
import { restartAsked } from "./deck-link.mjs";

/** How often the app asks the deck it is attached to what it serves. An install
 *  can land under a running deck at any moment — `npm i -g`, the deck's own
 *  away install — so once per attach is not enough. The page asks as often. */
export const VERSION_LOOK_MS = 5 * 60_000;

/** How long a restart the app asked for has to land before the version the
 *  deck then serves is taken as what it came to. */
export const LANDING_MS = 60_000;

/**
 * What GET /api/version says about the deck: the version it serves, the one its
 * install holds, and whether it can restart without losing its canvas. Null
 * for an answer that is not one — no version it serves, nothing to compare.
 */
export function versionsOf(report) {
  if (!report || typeof report !== "object") return null;
  const text = v => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const serving = text(report.running);
  if (!serving) return null;
  return { serving, installed: text(report.installed), canRestart: report.canRestart === true };
}

/** The version a restart of the deck would bring it to: its install's, when that
 *  is newer than what it serves. Null when there is nothing to gain. */
export function restartTarget(versions, olderVersion) {
  if (!versions?.serving || !versions.installed) return null;
  return olderVersion(versions.serving, versions.installed) ? versions.installed : null;
}

/**
 * What the app does about the deck it is attached to, on its ten-second tick.
 *
 *   none     the deck serves what its install holds, or newer
 *   restart  ask the deck's own restart now, with `whenIdle`
 *   wait     not yet: somebody is there, an agent is working or waiting, the
 *            deck said a turn was running, or an ask is already out
 *   notice   the app will not restart it by itself — the deck cannot restart,
 *            its own switch is off, or this version was already tried and
 *            refused or came back old — so the tray says so and its Restart
 *            row is how
 *
 * `to` is the version a restart would bring, null with `none`; `why` names the
 * reason for a wait or a notice.
 *
 * @param {object} o
 * @param {{ serving: string, installed: string | null, canRestart: boolean } | null} o.versions  versionsOf
 * @param {(running: string, ours: string) => boolean} o.olderVersion  running-deck.mjs's
 * @param {boolean | null} o.autoUpdate  the deck's own switch; null while unread
 * @param {{ to: string, outcome: "asked" | "busy" | "refused" | "failed", at: number } | null} o.tried
 *   the last restart the app asked of a deck for a newer install
 * @param {boolean} o.windowFocused
 * @param {boolean} o.busy          a deck start or restart is in flight
 * @param {number | null} o.quietSince  auto-update.mjs quietSinceNext
 * @param {number | null} o.idleSince   auto-update.mjs idleSinceNext
 * @param {number} o.now
 */
export function deckRestartStep({
  versions, olderVersion, autoUpdate, tried, windowFocused, busy, quietSince, idleSince, now, quietMs = QUIET_MS,
}) {
  const to = restartTarget(versions, olderVersion);
  if (!to) return { act: "none", to: null };
  const same = tried?.to === to;
  if (same && tried.outcome === "asked") return { act: "wait", to, why: "restarting" };
  if (same && (tried.outcome === "refused" || tried.outcome === "failed")) return { act: "notice", to, why: tried.outcome };
  if (!versions.canRestart) return { act: "notice", to, why: "cannot-restart" };
  if (autoUpdate === false) return { act: "notice", to, why: "switched-off" };
  if (autoUpdate !== true) return { act: "wait", to, why: "switch-unread" };
  // The deck heard a turn when it was last asked: a full quiet minute from that
  // answer, as well as from the agents. A clock that moved back counts as time
  // gone, as everywhere else in the update path.
  if (same && tried.outcome === "busy" && now >= tried.at && now - tried.at < quietMs) return { act: "wait", to, why: "turn-running" };
  if (!quietLongEnough({ windowFocused, busy, quietSince, now, quietMs })) return { act: "wait", to, why: "in-use" };
  if (!(typeof idleSince === "number" && now - idleSince >= quietMs)) return { act: "wait", to, why: "agents" };
  return { act: "restart", to };
}

/**
 * What POST /api/restart came to, from what deckJson resolved or rejected with:
 * "asked" — the deck took it (restartAsked, the tray's own rule); "busy" — the
 * deck heard a turn running and said no, which is a wait; "refused" — anything
 * else: a deck that cannot restart, one that does not answer in time (hung),
 * or one that is not there. A refusal is not asked again for the same version.
 */
export function restartAnswer(outcome) {
  if (restartAsked(outcome)) return "asked";
  if (!(outcome instanceof Error) && outcome?.status === 409 && outcome.json?.reason === "busy") return "busy";
  return "refused";
}

/**
 * What an asked restart came to, once the deck answers /api/version again:
 * "landed" — it serves the version asked for, or newer; "failed" — a new deck
 * that still serves older code, or the same deck still there after
 * LANDING_MS; "waiting" — too early to say; null when no restart is out.
 */
export function landing({ tried, pid, serving, olderVersion, now, landingMs = LANDING_MS }) {
  if (tried?.outcome !== "asked") return null;
  if (typeof serving === "string" && serving !== "" && !olderVersion(serving, tried.to)) return "landed";
  if (pid !== tried.pid) return "failed";
  return now < tried.at || now - tried.at >= landingMs ? "failed" : "waiting";
}

/**
 * What the tray says about it (tray-menu.mjs): the version the deck serves and
 * the one a restart would bring. Null when there is nothing to say beyond the
 * deck's own version.
 */
export function trayDrift(versions, olderVersion) {
  const to = restartTarget(versions, olderVersion);
  return to ? { serving: versions.serving, to } : null;
}
