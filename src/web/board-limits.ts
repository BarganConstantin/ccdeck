// How much of the past the board keeps, as one set of numbers for every
// reader of the stream: the page's canvas (App.tsx), the desktop app's tray
// icon (tray-model.ts), and the test that builds a board the way the deck does
// (board-scope-687.test.ts). They lived in App.tsx alone, and the test copied
// them by hand; a second reader copying them too would be the drift that
// ambient-counts.ts was written to end.

/** Agents kept before finished ones start to be evicted, and how long a
 *  finished one stays visible first. */
export const AGENT_CAP = 200;
export const AGENT_GRACE_MS = 5 * 60_000;

// How many finished sessions stay on the canvas. Small on purpose: the board
// is for what is happening now, and a day of sessions otherwise buries it.
// The 2-minute grace is shorter than AGENT_GRACE_MS — a session is a bigger,
// more obvious thing to disappear, so it should not linger once it is over.
export const DONE_SESSION_CAP = 6;
export const DONE_SESSION_GRACE_MS = 2 * 60_000;
