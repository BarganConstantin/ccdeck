// Whether somebody is looking at this deck — the one fact the server's
// away-update needs from a page (src/server/auto-update.mjs), and one only a
// page can know. The server keeps each tab's claim for PRESENCE_TTL_MS
// (presence.mjs) and forgets it unless it is renewed.

/** How often a tab holding focus renews its claim: three beats inside the
 *  server's forty-five seconds. */
export const PRESENCE_BEAT_MS = 15_000;

/** Looking means on screen AND holding the keyboard. A deck visible on a second
 *  monitor while the person types into a terminal is not being looked at. */
export function tabLooking(doc: { visibilityState: string; hasFocus(): boolean }): boolean {
  return doc.visibilityState === "visible" && doc.hasFocus();
}

/** Whether this tick tells the server anything: every tick while looking — the
 *  beat that keeps the claim alive — and once on the way out of looking. A tab
 *  that was never looked at says nothing. */
export function presenceShouldSend(last: boolean | null, looking: boolean): boolean {
  return looking || last === true;
}

/** This page load's name on the server. Not persisted: a reload is a new tab
 *  as far as a forty-five-second claim is concerned. */
export function newTabId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* not a secure context — a deck reached over the LAN */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
