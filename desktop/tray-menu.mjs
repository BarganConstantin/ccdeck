// What the tray says (#1160): the line under the icon, and the menu behind it.
//
// This knows nothing about Electron. main.mjs reads the app's state, hands it
// in, and gets back the template Menu.buildFromTemplate takes — so which rows
// there are, what they say and which of them can be clicked is small enough to
// pin directly.
//
// What a row DOES is passed in too, as `on`, and called when it is clicked.
// Each of those reads main.mjs's own variables at that moment, the way the
// closures written inline in the menu always did: a menu drawn before a
// restart and clicked after it opens the deck that is there now, not the one
// that was there when the menu was drawn.

/** "3m", "2h" — how long a session has been waiting. */
export function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

/** The first row of the menu, and the second half of the tooltip. */
export function statusLine({ restarting, starting, deck, snapshot }) {
  if (restarting) return "Restarting the deck…";
  if (starting) return "Starting the deck…";
  if (!deck) return "No deck running";
  if (snapshot.icon === "offline") return "Reconnecting to the deck…";
  if (snapshot.waiting > 0) return `${snapshot.waiting} session${snapshot.waiting === 1 ? "" : "s"} waiting for you`;
  if (snapshot.running > 0) return `${snapshot.running} session${snapshot.running === 1 ? "" : "s"} running`;
  return "Idle";
}

/**
 * Whether the tray should ask the deck what the status pages say (#1311): only
 * while a session is running or waiting. An app left in the tray with nothing
 * going on is idle, and an idle app asks nobody's server anything — the answer
 * it already has stays in the menu until the page's own expiry drops it.
 */
export function statusWorthAsking(snapshot) {
  return snapshot.running > 0 || snapshot.waiting > 0;
}

/**
 * The tray menu, top to bottom.
 *
 * @param {object} s
 * @param {number} s.now
 * @param {{ icon: string, waiting: number, running: number, blocked: Array<{ label: string, kind: string, since: number }> }} s.snapshot
 * @param {{ port: number, version?: string } | null} s.deck
 * @param {unknown} s.starting    a deck start in flight
 * @param {unknown} s.restarting  a restart asked for and not yet answered
 * @param {boolean | null} s.notifyOn  the deck's own switch; null until it is read
 * @param {boolean} s.openAtLogin
 * @param {string} s.appVersion
 * @param {{ status: string, version?: string }} s.update  the updater's state
 * @param {Array<{ label: string, href: string }>} [s.incidents]  what the
 *   providers' status pages report, incidents only — the page's own incidentsOf
 * @param {object} on  what each row does when it is clicked
 */
export function trayMenuItems({ now, snapshot, deck, starting, restarting, notifyOn, openAtLogin, appVersion, update, incidents = [] }, on) {
  const items = [{ label: statusLine({ restarting, starting, deck, snapshot }), enabled: false }];
  for (const b of snapshot.blocked.slice(0, 6)) {
    const what = b.kind === "asked" ? "asking" : "needs permission";
    items.push({ label: `${b.label} — ${what}, ${ago(now - b.since)}`, click: () => on.openWindow() });
  }
  // A provider's own incident (#1311), under the sessions it may be the cause
  // of, so an outage can be seen without opening the window. The row opens the
  // provider's status page, the same link as the page's chip.
  for (const i of incidents) {
    items.push({ label: `${i.label} — status page`, click: () => on.openStatusPage(i.href) });
  }
  if (!deck && !starting) items.push({ label: "Start the deck", click: () => on.startDeck() });
  items.push(
    { type: "separator" },
    { label: "Open ccdeck", enabled: !!deck, click: () => on.openWindow() },
    { label: "Open in browser", enabled: !!deck, click: () => on.openInBrowser() },
    { type: "separator" },
    {
      label: "Notifications while closed",
      type: "checkbox",
      checked: notifyOn === true,
      enabled: !!deck && notifyOn !== null,
      click: () => on.toggleNotifications(),
    },
    {
      label: "Start at login",
      type: "checkbox",
      checked: openAtLogin,
      click: item => on.setOpenAtLogin(item.checked),
    },
    { type: "separator" },
    { label: `ccdeck v${appVersion}${deck?.version && deck.version !== appVersion ? ` · deck v${deck.version}` : ""}`, enabled: false },
    updateItem(update, on),
    // #1163: the deck restarted from the tray, the way the page's version
    // dialog does it, rather than Quit and a trip to the Start menu.
    { label: "Restart ccdeck", enabled: !!deck && !starting && !restarting, click: () => on.restartDeck() },
    { label: "Quit ccdeck", click: () => on.quit() },
  );
  return items;
}

/** The update line of the menu, which says where the update is rather than
 *  offering a button that does nothing while one is already on its way.
 *  "Restart to update" and "v1.64.0" are the words the native sheet and the
 *  window's dialog use for the same action — one verb and one spelling of the
 *  version on all three surfaces, so a person told to find this line by the
 *  window can recognise it. */
export function updateItem(u, on) {
  if (u.status === "ready") return { label: `Restart to update to v${u.version}`, click: () => on.restartToUpdate() };
  if (u.status === "downloading") return { label: `Downloading ccdeck v${u.version}…`, enabled: false };
  if (u.status === "checking") return { label: "Checking for updates…", enabled: false };
  return { label: u.status === "current" ? "Up to date — check again" : "Check for updates", click: () => on.checkForUpdates() };
}
