// When the tray's menu is replaced, and when it is left alone.
//
// Every redraw used to hand the tray a new menu: once per ten-second tick, and
// once per coalesced burst of hook events, which while agents work is several
// times a second. On Linux the menu is exported over D-Bus, and the panel
// rebuilds an open menu when it is told the layout changed — so the menu
// closed under the pointer, often before the row that was pressed could take
// the click, and had to be opened and pressed again.
//
// So a menu is replaced only when what it says has changed — a session
// starting or stopping, one starting to wait, an update's state — and never
// while it is open: a change that lands then waits for it to close. An open
// menu is only trusted for MENU_HOLD_MS, in case a platform never reports the
// close — after that the change is made anyway, rather than a menu that is out
// of date until the app restarts.
//
// The second rule needs Electron to say when the menu opens and closes, and on
// Linux it does not: measured on Electron 42, a panel's dbusmenu AboutToShow
// and its "opened" and "closed" events reach no menu-will-show or
// menu-will-close. There the first rule does the work. Measured the same way,
// twelve seconds of redraws sent the panel eleven LayoutUpdated signals before
// it, and none after it.
//
// Electron-free: `install` is handed the template and the two callbacks to
// wire to the Menu's menu-will-show and menu-will-close.

/** How long an open menu holds a change back, at most. */
export const MENU_HOLD_MS = 30_000;

/** What a template says, as one string: the rows' words and states, not what
 *  they do when clicked. Two templates with the same signature draw the same
 *  menu. */
export function menuSignature(template) {
  const row = item => ({
    type: item.type ?? "normal",
    label: item.label ?? "",
    enabled: item.enabled !== false,
    checked: !!item.checked,
    visible: item.visible !== false,
    ...(Array.isArray(item.submenu) ? { submenu: item.submenu.map(row) } : {}),
  });
  return JSON.stringify((template ?? []).map(row));
}

/**
 * @param {object} o
 * @param {() => object[]} o.build  the template for the state the app is in now
 * @param {(template: object[], on: { opened: () => void, closed: () => void }) => void} o.install
 * @param {() => number} [o.now]
 * @param {number} [o.holdMs]
 * @param {(fn: () => void, ms: number) => unknown} [o.later]
 * @param {(timer: unknown) => void} [o.cancel]
 */
export function createMenuSwap({ build, install, now = Date.now, holdMs = MENU_HOLD_MS, later = setTimeout, cancel = clearTimeout }) {
  let shown = null;       // the signature of the menu the tray holds
  let openSince = null;   // when the panel said that menu opened
  let waiting = false;    // a refresh arrived while it was open
  let timer = null;

  const isOpen = () => openSince !== null && now() - openSince < holdMs;

  function refresh() {
    if (isOpen()) {
      waiting = true;
      if (timer === null) timer = later(expire, Math.max(0, holdMs - (now() - openSince)));
      return "held";
    }
    openSince = null;
    waiting = false;
    const template = build();
    const signature = menuSignature(template);
    if (signature === shown) return "unchanged";
    shown = signature;
    install(template, { opened, closed });
    return "installed";
  }

  function opened() {
    openSince = now();
  }

  function closed() {
    openSince = null;
    if (timer !== null) { cancel(timer); timer = null; }
    if (waiting) refresh();
  }

  function expire() {
    timer = null;
    if (waiting) refresh();
  }

  return { refresh, get open() { return isOpen(); } };
}
