// ccdeck's service worker: the buttons on a notification about a session that
// needs you, and nothing else (src/web/alert-worker.ts raises them).
//
// No fetch handler, on purpose: the deck is never cached here and never served
// from here, so a worker left over from an older version cannot stand between
// a tab and the server it talks to.
//
// A press (a button, or the notification's body) brings a deck to the front
// and tells it what was pressed; the page decides what that means, through the
// same checks an alert card's press goes through. With no deck open, one is
// opened on the session, and only opened: nothing is answered without a page
// that can check the prompt first.

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", event => { event.waitUntil(self.clients.claim()); });

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

self.addEventListener("notificationclick", event => {
  const note = event.notification;
  const data = note.data || {};
  note.close();
  if (typeof data.sessionId !== "string" || !SESSION_ID.test(data.sessionId)) return;
  const message = {
    type: "ccdeck:notification",
    sessionId: data.sessionId,
    kind: typeof data.kind === "string" ? data.kind : "",
    since: typeof data.since === "number" ? data.since : undefined,
    action: event.action === "allow" ? "allow" : "open",
  };
  event.waitUntil((async () => {
    const decks = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const deck = decks.find(c => c.focused) || decks.find(c => c.visibilityState === "visible") || decks[0];
    if (deck) {
      try { await deck.focus(); } catch { /* the message still lands */ }
      deck.postMessage(message);
      return;
    }
    await self.clients.openWindow(`/#chat=${encodeURIComponent(data.sessionId)}`);
  })());
});
