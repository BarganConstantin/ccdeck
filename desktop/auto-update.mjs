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
//   NOT WHAT AN AGENT IS DOING, and that is the owner's call, made on
//   2026-09-22: a restart under a running agent is a second in which the deck
//   is not there to be posted to, and the hook survives it — it POSTs, exits 0
//   and never speaks to the agent about it, so the worst case is a gap in the
//   drawing of a turn rather than a turn that goes wrong. Waiting for every
//   agent on the machine to be idle is how an app stays three versions behind;
//
//   THE WINDOW must not be FOCUSED. A focused window is somebody there right
//   now, mid-read or mid-type. A window left open behind other things is not,
//   and it comes back by itself after the restart, so it does not hold an
//   update off for days the way "any open window" did;
//
//   and it must have been QUIET for a minute: the window unfocused and no deck
//   start or restart in flight, for a minute rather than at this instant, so an
//   app being clicked through does not update between two of the clicks.
//
// Nothing here bypasses the deck's own shutdown: the restart goes through the
// same quit path, which stops the deck before the swap and starts it again
// after it.

/** How long the app must have been quiet before it updates itself. */
export const QUIET_MS = 60_000;

/**
 * May the app install the staged update right now?
 *
 * @param {object} o
 * @param {string} o.status        the updater's state: "ready" and nothing else will do
 * @param {boolean} o.windowFocused is somebody in the deck's window right now
 * @param {boolean} o.busy         a deck start or restart is already in flight
 * @param {number} o.quietSince    when the last of all that stopped being true
 * @param {number} o.now
 * @param {number} [o.quietMs]
 */
export function canInstallQuietly({ status, windowFocused, busy, quietSince, now, quietMs = QUIET_MS }) {
  if (status !== "ready") return false;
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
