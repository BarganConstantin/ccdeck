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
//   NO SESSION may be running or waiting on a human. A restart under a running
//   agent loses the events of that turn, and one under a waiting agent takes
//   away the queue the person came to read;
//
//   THE WINDOW must not be FOCUSED. A focused window is somebody there right
//   now, mid-read or mid-type. A window left open behind other things is not,
//   and it comes back by itself after the restart, so it does not hold an
//   update off for days the way "any open window" did;
//
//   and it must have been QUIET for a minute. Not "idle right now": an agent
//   between two turns reads as idle for a few seconds at a time, and that is
//   the worst moment of all to take the deck away. A minute is short on
//   purpose — the owner asked for an app that is on the current version
//   without anybody remembering to check, so the wait is the smallest one that
//   still cannot land between two turns.
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
 * @param {number} o.waiting       sessions stopped on a human
 * @param {number} o.running       sessions working
 * @param {boolean} o.busy         a deck start or restart is already in flight
 * @param {number} o.quietSince    when the last of all that stopped being true
 * @param {number} o.now
 * @param {number} [o.quietMs]
 */
export function canInstallQuietly({ status, windowFocused, waiting, running, busy, quietSince, now, quietMs = QUIET_MS }) {
  if (status !== "ready") return false;
  if (windowFocused || busy) return false;
  if (waiting > 0 || running > 0) return false;
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
export function quietSinceNext(previous, { windowFocused, waiting, running, busy, now }) {
  const quiet = !windowFocused && !busy && waiting === 0 && running === 0;
  if (!quiet) return null;
  return typeof previous === "number" ? previous : now;
}
