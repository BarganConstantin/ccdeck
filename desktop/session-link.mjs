// The session a notification or a tray row is about, carried to the window so
// it opens that session in Chat rather than wherever it was.
//
// The deck names the session in its notify frame (src/server/sse-clients.mjs)
// and the tray snapshot names each blocked one. main.mjs holds the id, and the
// page takes it over the one call preload.cjs gives it: as it starts, and
// whenever the app tells a page already loaded that one is waiting (a bare
// DOM event with nothing in it, so the id itself only ever travels through
// that checked call). The page (src/web/use-chat-alerts.ts) opens the session
// and answers nothing. Checked here as it is everywhere else.

/** What the page asks the app for. */
export const SESSION_TAKE_CHANNEL = "ccdeck:session:take";
/** The event the app raises in a loaded page: a session is waiting to be taken. */
export const SESSION_HELD_EVENT = "ccdeck:session-held";
/** How long a held session waits for a page to take it: a window opening on
 *  a deck that has to start first takes a while, and a click that old is not
 *  what a later window should open on. */
export const HOLD_MS = 30_000;

/** A session id as the deck has them (src/web/alert-worker.ts). */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** `value` when it can be a session id, otherwise null. */
export function sessionOf(value) {
  return typeof value === "string" && SESSION_ID.test(value) ? value : null;
}

/** What main.mjs holds for a click on `id` at `now`: null when it names no session. */
export function holdSession(id, now) {
  const sid = sessionOf(id);
  return sid ? { id: sid, at: now } : null;
}

/** The held session a page may still take at `now`, or null. */
export function takeHeld(held, now) {
  return held && now - held.at <= HOLD_MS ? held.id : null;
}

/** The script that tells a loaded page a session is waiting: constant, and
 *  carrying nothing. */
export const POKE_SCRIPT = `window.dispatchEvent(new Event(${JSON.stringify(SESSION_HELD_EVENT)}))`;

/**
 * Tells the window's page a session is waiting, when the page has loaded; one
 * still loading takes it as it starts. Returns whether it was told.
 *
 * @param {{ isDestroyed?(): boolean, isLoading(): boolean, executeJavaScript(code: string): Promise<unknown> } | null | undefined} contents
 */
export function pokePage(contents) {
  if (!contents || contents.isDestroyed?.() || contents.isLoading()) return false;
  contents.executeJavaScript(POKE_SCRIPT).catch(() => {});
  return true;
}
