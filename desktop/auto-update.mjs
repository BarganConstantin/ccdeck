// When the app may install a verified update by itself (#1187).
//
// Until now a staged update waited for somebody to press "Restart to update"
// in the tray menu, or to quit the app. People do neither: the app is meant to
// be left alone in the menu bar, so an update sat there for weeks and the
// version people ran was whichever one they installed.
//
// The rule below is the whole of "by itself", and every clause in it is a way
// of saying NOT WHILE SOMEBODY IS THERE. An update restarts the app, and the
// app restarts the deck it hosts — a second or two where the board is not
// being drawn and the hooks have nowhere to post. That is nothing at 03:00 and
// unacceptable while a session is mid-turn, so:
//
//   the update must be READY, which by construction means downloaded, its
//   SHA-256 checked and its Ed25519 signature checked against ccdeck's own key
//   (updater.mjs, updater-mac.mjs) — nothing here can install anything else;
//
//   NO AGENT WORKING OR WAITING, for a minute — FOR A DAY AT MOST. The owner
//   first decided otherwise, on 2026-09-22: the hook survives a restart, so
//   the cost is a gap in the drawing of a turn. People read it differently:
//   an app that restarts while their agents work restarts "randomly", and a
//   user said so in feedback (2026-10-16). So it now waits for the agents too,
//   and the reason for the old rule survives as its limit: a machine that is
//   never idle would never update, so after MAX_WAIT_MS behind it installs
//   at the next quiet minute whatever the agents are doing;
//
//   NOT POSTPONED: "Later" on the ready notice holds it off for POSTPONE_MS,
//   and the day's limit counts from the end of that, not from the download;
//
//   THE NEWEST ONE: the release staged may have been overtaken while it waited.
//   It installs only after a look for a newer one that is no older than
//   FRESH_MS, and with no look in flight — or the app would update into a
//   version that is already behind, and update again an hour later;
//
//   THE WINDOW must not be FOCUSED. A focused window is somebody there right
//   now, mid-read or mid-type. A window left open behind other things is not,
//   and it comes back by itself after the restart, so it does not hold an
//   update off for days the way "any open window" did;
//
//   and it must have been QUIET for a minute: the window unfocused and no deck
//   start or restart in flight, for a minute rather than at this instant, so an
//   app being clicked through does not update between two of the clicks;
//
//   and the install must ASK NOBODY ANYTHING (#1755). A .deb installs through
//   dpkg under pkexec or sudo, and a password prompt that comes up by itself a
//   minute after the person looked away, freezing the tray until it is
//   answered and coming back after every check, is somebody being asked. That
//   one waits for the person's own Restart to update.
//
// Nothing here bypasses the deck's own shutdown: the restart goes through the
// same quit path, which stops the deck before the swap and starts it again
// after it.

/** How long the app must have been quiet before it updates itself. */
export const QUIET_MS = 60_000;

/** How long an update may wait for the agents before it stops waiting. */
export const MAX_WAIT_MS = 24 * 60 * 60_000;

/** How long "Later" holds the update off. */
export const POSTPONE_MS = 24 * 60 * 60_000;

/** How old the last look for a newer release may be when a staged one installs. */
export const FRESH_MS = 30 * 60_000;

/**
 * May the app install the staged update right now?
 *
 * @param {object} o
 * @param {string} o.status        the updater's state: "ready" and nothing else will do
 * @param {boolean} o.unattended    the install asks nothing of anybody; only true will do
 * @param {boolean} o.windowFocused is somebody in the deck's window right now
 * @param {boolean} o.busy         a deck start or restart is already in flight
 * @param {number} o.quietSince    when the last of all that stopped being true
 * @param {number|null} o.idleSince when the agents last stopped working or waiting
 * @param {number|null} o.behindSince when an update first became ready
 * @param {number|null} [o.postponedUntil] until when "Later" holds it off
 * @param {number|null} o.lookedAt  when the updater last started a look for a newer release
 * @param {boolean} o.looking       a look is in flight
 * @param {number} o.now
 * @param {number} [o.quietMs]
 */
export function canInstallQuietly({
  status, unattended, windowFocused, busy, quietSince, idleSince, behindSince, postponedUntil,
  lookedAt, looking, now, quietMs = QUIET_MS,
}) {
  if (status !== "ready" || unattended !== true) return false;
  if (postponed({ postponedUntil, now })) return false;
  if (!isFresh({ lookedAt, looking, now })) return false;
  if (!quietLongEnough({ windowFocused, busy, quietSince, now, quietMs })) return false;
  if (overdue({ behindSince, postponedUntil, now })) return true;
  return typeof idleSince === "number" && now - idleSince >= quietMs;
}

/** Is "Later" still holding the update off? */
export function postponed({ postponedUntil, now }) {
  return typeof postponedUntil === "number" && now < postponedUntil;
}

/** Has the update waited for the agents for as long as it will? Counted from
 *  the first ready update, or from the end of a "Later", whichever is later. */
export function overdue({ behindSince, postponedUntil, now }) {
  if (typeof behindSince !== "number") return false;
  const from = Math.max(behindSince, typeof postponedUntil === "number" ? postponedUntil : 0);
  return now - from >= MAX_WAIT_MS;
}

/** Is the staged update known to be the newest: no look in flight, and the
 *  last one started within FRESH_MS? With none in flight, the last one has
 *  also finished, and a newer release it found is being downloaded — which
 *  takes the update out of "ready" until it is staged. */
export function isFresh({ lookedAt, looking, now }) {
  return !looking && typeof lookedAt === "number" && now - lookedAt < FRESH_MS;
}

/**
 * When the agents last went idle, given where it stood and what is true now:
 * any agent working or waiting resets it, idle keeps the first idle moment.
 */
export function idleSinceNext(previous, { agentsBusy, now }) {
  if (agentsBusy) return null;
  return typeof previous === "number" ? previous : now;
}

/**
 * Has the app been left alone for a full `quietMs`, and is it still? The rule
 * canInstallQuietly applies to an update, and the one the app restarts by
 * itself under for any other reason (tray-presence.mjs).
 */
export function quietLongEnough({ windowFocused, busy, quietSince, now, quietMs = QUIET_MS }) {
  if (windowFocused || busy) return false;
  // `quietSince` is null until there has been a quiet moment to measure from,
  // which is also what an app that has just started has: it waits out one full
  // window rather than updating in the first seconds after launch.
  if (typeof quietSince !== "number") return false;
  return now - quietSince >= quietMs;
}

/**
 * The moment the quiet started, given where it stood and what is true now.
 * Anything that is not quiet resets it; quiet keeps the first quiet moment.
 */
export function quietSinceNext(previous, { windowFocused, busy, now }) {
  const quiet = !windowFocused && !busy;
  if (!quiet) return null;
  return typeof previous === "number" ? previous : now;
}
