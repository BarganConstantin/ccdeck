// ccdeck desktop (#1160): the deck in a window, a tray icon that says what the
// favicon says, and notifications under ccdeck's own name.
//
// THE RULE THE WHOLE SHELL KEEPS: a window open is a tab open. While it is,
// the page plays its sounds and the deck counts it as somebody looking. Close
// it and the window is destroyed — not hidden — so the deck sees no page and
// raises its closed-deck notifications, which reach this app over the tray
// stream and are shown as ccdeck. Hiding instead would keep the page alive,
// the deck would go on believing somebody was looking, and nothing would ever
// be said (the choice made in #1160, decision 2).
//
// The tray icon is the favicon of a closed tab: the same four marks, the same
// count, computed by the page's own reducer (src/web/tray-model.ts, bundled to
// dist/lib by vite.tray.config.mjs) over the same event stream.
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deckJson, findDecks, openTrayStream } from "./deck-link.mjs";
import { shellPath, startDeck, writeLauncher } from "./deck-host.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const icons = join(here, "dist", "icons");
const APP_ID = "dev.ccdeck.app";

/** Where the deck's own files are: the repo root in development, the copy
 *  packed into the app's resources once it is built. CCDECK_DECK_ROOT points a
 *  built app at a checkout, for testing one against the other. */
function deckRoot() {
  if (process.env.CCDECK_DECK_ROOT) return process.env.CCDECK_DECK_ROOT;
  return app.isPackaged ? join(process.resourcesPath, "deck") : join(here, "..");
}

// ── one app per machine ─────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => openWindow());
}
app.setAppUserModelId(APP_ID);

// ── state ───────────────────────────────────────────────────────────────────
let tray = null;
let win = null;
let deck = null;              // { pid, port, token, version }
let stream = null;
let model = null;             // TrayModel from dist/lib/tray-model.mjs
let snapshot = { icon: "offline", waiting: 0, running: 0, title: "ccdeck", blocked: [] };
let notifyOn = null;          // the deck's own switch, read from /api/prefs
let redraw = null;
let ownDeck = null;           // the deck process this app started, if it did
let starting = null;          // the start in flight, so two clicks start one deck

// ── the tray ────────────────────────────────────────────────────────────────
function trayImage(icon) {
  const name = process.platform === "darwin" ? `tray-${icon}Template.png` : `tray-${icon}.png`;
  return nativeImage.createFromPath(join(icons, name));
}

/** "3m", "2h" — how long a session has been waiting. */
function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

function statusLine() {
  if (starting) return "Starting the deck…";
  if (!deck) return "No deck running";
  if (snapshot.icon === "offline") return "Reconnecting to the deck…";
  if (snapshot.waiting > 0) return `${snapshot.waiting} session${snapshot.waiting === 1 ? "" : "s"} waiting for you`;
  if (snapshot.running > 0) return `${snapshot.running} session${snapshot.running === 1 ? "" : "s"} running`;
  return "Idle";
}

function buildMenu() {
  const now = Date.now();
  const items = [{ label: statusLine(), enabled: false }];
  for (const b of snapshot.blocked.slice(0, 6)) {
    const what = b.kind === "asked" ? "asking" : "needs permission";
    items.push({ label: `${b.label} — ${what}, ${ago(now - b.since)}`, click: () => openWindow() });
  }
  if (!deck && !starting) items.push({ label: "Start the deck", click: () => ensureDeck().then(() => openWindow()) });
  items.push(
    { type: "separator" },
    { label: "Open ccdeck", enabled: !!deck, click: () => openWindow() },
    { label: "Open in browser", enabled: !!deck, click: () => deck && shell.openExternal(`http://127.0.0.1:${deck.port}/`) },
    { type: "separator" },
    {
      label: "Notifications while closed",
      type: "checkbox",
      checked: notifyOn === true,
      enabled: !!deck && notifyOn !== null,
      click: () => toggleNotifications(),
    },
    {
      label: "Start at login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    { label: `ccdeck ${app.getVersion()}${deck?.version && deck.version !== app.getVersion() ? ` · deck ${deck.version}` : ""}`, enabled: false },
    { label: "Quit ccdeck", click: () => app.quit() },
  );
  return Menu.buildFromTemplate(items);
}

/** Redraw the icon, the count, the tooltip and the menu — coalesced, because
 *  a reconnect replays up to two thousand events and each one changes the
 *  board. */
function scheduleRedraw() {
  if (redraw) return;
  redraw = setTimeout(() => {
    redraw = null;
    if (model) snapshot = model.snapshot();
    if (!tray) return;
    tray.setImage(trayImage(snapshot.icon));
    // macOS draws text beside a menu-bar icon; nowhere else can.
    if (process.platform === "darwin") tray.setTitle(snapshot.waiting > 0 ? ` ${snapshot.waiting}` : "");
    tray.setToolTip(`${snapshot.title} — ${statusLine()}`);
    tray.setContextMenu(buildMenu());
  }, 150);
}

// ── the deck ────────────────────────────────────────────────────────────────
async function loadModel() {
  const { createTrayModel } = await import(pathToFileURL(join(here, "dist", "lib", "tray-model.mjs")).href);
  model = createTrayModel();
}

async function refreshPrefs() {
  if (!deck) { notifyOn = null; return; }
  try {
    const { json } = await deckJson(deck, "/api/prefs");
    notifyOn = json?.prefs?.notifications === true;
  } catch { notifyOn = null; }
  scheduleRedraw();
}

async function toggleNotifications() {
  if (!deck || notifyOn === null) return;
  try {
    const { json } = await deckJson(deck, "/api/prefs", { method: "POST", body: { notifications: !notifyOn } });
    notifyOn = json?.prefs?.notifications === true;
  } catch { /* the menu keeps saying what the file says */ }
  scheduleRedraw();
}

/** Attach to a deck, or to a different one than before (a restart gives a new
 *  pid and a new token). */
function attach(found) {
  if (deck && found && deck.pid === found.pid && deck.token === found.token) return;
  stream?.close();
  stream = null;
  deck = found ?? null;
  model?.reset();
  model?.setConnected(false);
  scheduleRedraw();
  if (!deck) return;
  stream = openTrayStream(deck, {
    connected: () => { model.reset(); model.setConnected(true); scheduleRedraw(); },
    hook: env => { model.apply(env); scheduleRedraw(); },
    live: () => { refreshPrefs(); },
    notify: n => showNotification(n),
    lost: () => { model.setConnected(false); scheduleRedraw(); discoverSoon(); },
  });
}

/**
 * A deck to attach to: the running one if there is one — started by
 * `npx ccdeck`, a login item, or this app last time — otherwise one of this
 * app's own. Waits for the new deck's discovery file, which it writes once it
 * is listening.
 */
async function ensureDeck() {
  await discover();
  if (deck) return deck;
  if (starting) return starting;
  starting = (async () => {
    scheduleRedraw();
    const launcher = writeLauncher(process.execPath);
    ownDeck = startDeck({
      deckRoot: deckRoot(),
      appBinary: process.execPath,
      logFile: join(app.getPath("logs"), "deck-app.log"),
      path: shellPath(),
      launcher,
    });
    ownDeck.on("exit", code => { trace(`own deck exited ${code}`); ownDeck = null; discoverSoon(); });
    for (let i = 0; i < 80 && !deck; i++) {
      await new Promise(r => setTimeout(r, 500));
      await discover();
    }
    return deck;
  })();
  try { return await starting; } finally { starting = null; scheduleRedraw(); }
}

/** Stop the deck this app started, and only that one: a deck from a terminal
 *  or a login item is somebody else's, and outlives the app. */
async function stopOwnDeck() {
  if (!ownDeck) return;
  try {
    if (deck) await deckJson(deck, "/api/shutdown", { method: "POST", body: {}, timeoutMs: 3000 });
  } catch { /* asked; the kill below is the fallback */ }
  const child = ownDeck;
  await new Promise(r => {
    const t = setTimeout(() => { try { child.kill(); } catch {} r(); }, 4000);
    child.once("exit", () => { clearTimeout(t); r(); });
  });
}

async function discover() {
  try {
    const decks = await findDecks(deckRoot());
    attach(decks[0] ?? null);
  } catch {
    attach(null);
  }
}
let discovering = null;
function discoverSoon(ms = 2000) {
  if (discovering) return;
  discovering = setTimeout(async () => { discovering = null; await discover(); }, ms);
}

// ── notifications ───────────────────────────────────────────────────────────
function showNotification({ title, body }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: String(title ?? "ccdeck"), body: String(body ?? "") });
  n.on("click", () => openWindow());
  n.show();
}

// ── the window ──────────────────────────────────────────────────────────────
/** macOS: a menu-bar app with no window (no Dock tile, not in Cmd+Tab), and an
 *  ordinary app while its window is open — so the window orders, hides and
 *  switches like every other app's. Switched here rather than declared with
 *  LSUIElement: an app that declared itself an agent and then turned regular
 *  kept its window in front of the app the person had just clicked. */
function setRegular(regular) {
  if (process.platform !== "darwin") return;
  app.setActivationPolicy(regular ? "regular" : "accessory");
}

/** A line to ~/Library/Logs/ccdeck-desktop.log, for the window behaviour that
 *  only shows on a real desktop. */
function trace(line) {
  try {
    appendFileSync(join(app.getPath("logs"), "ccdeck-desktop.log"), `${new Date().toISOString()} ${line}\n`);
  } catch { /* a log that cannot be written is not worth failing over */ }
}

function openWindow() {
  if (!deck) {
    ensureDeck().then(found => { if (found) openWindow(); });
    return;
  }
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  const origin = `http://127.0.0.1:${deck.port}`;
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: "ccdeck",
    backgroundColor: "#1f1f1f",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The page's chimes: in a browser they wait for the first click to
      // unlock audio. An app the person opened on purpose need not.
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  // Anything that leaves the deck opens in the person's own browser — a
  // login flow, a docs link — never inside this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(origin)) { event.preventDefault(); shell.openExternal(url); }
  });
  win.once("ready-to-show", () => {
    win?.show();
    app.focus({ steal: true });
  });
  win.on("focus", () => trace(`focus onTop=${win?.isAlwaysOnTop()}`));
  win.on("blur", () => trace(`blur onTop=${win?.isAlwaysOnTop()} visible=${win?.isVisible()}`));
  win.on("closed", () => {
    win = null;
    setRegular(false);
  });
  setRegular(true);
  // The page reads this to word itself for a window and to drop the browser
  // notification section it has no use for here (src/web/in-app.ts).
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} ccdeck-desktop/${app.getVersion()}`);
  win.loadURL(`${origin}/`);
}

// ── first run ───────────────────────────────────────────────────────────────
function statePath() { return join(app.getPath("userData"), "desktop-state.json"); }
function readState() {
  try { return JSON.parse(readFileSync(statePath(), "utf8")); } catch { return {}; }
}
async function firstRun() {
  const state = readState();
  if (state.askedLogin) return;
  // Attached to the window when there is one — a sheet moves with it — rather
  // than an app-modal alert, which macOS floats above every other app until
  // it is answered.
  const options = {
    type: "question",
    message: "ccdeck lives in the menu bar",
    detail: "It tells you when a session needs you, even with the window closed.",
    checkboxLabel: "Start ccdeck when I log in",
    checkboxChecked: true,
    buttons: ["OK"],
  };
  const { checkboxChecked } = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  app.setLoginItemSettings({ openAtLogin: checkboxChecked });
  writeFileSync(statePath(), JSON.stringify({ ...state, askedLogin: true }, null, 2));
}

/**
 * The npm deck's own login item, if one is registered: `ccdeck
 * --install-service`, or the offer a globally installed deck makes on its
 * first start. Beside the app's it starts a second deck at login — an older
 * one, from a copy the app does not update — and whichever starts first is the
 * deck both end up on. The app starts the deck itself, so it offers once to
 * take that item away, with the deck's own code for it (login-service.mjs,
 * the same call `ccdeck --uninstall-service` makes). Never silently: it is
 * something the person, or a script of theirs, set up.
 */
async function offerToReplaceLoginItem() {
  const state = readState();
  if (state.askedReplaceService) return;
  const root = deckRoot();
  const svc = await import(pathToFileURL(join(root, "src", "server", "login-service.mjs")).href);
  const { deckDataDir } = await import(pathToFileURL(join(root, "src", "server", "deck-home.mjs")).href);
  let present = false;
  if (process.platform === "win32") {
    try {
      const { spawnSync } = await import("node:child_process");
      present = spawnSync("schtasks", ["/Query", "/TN", svc.SERVICE_LABEL], { windowsHide: true }).status === 0;
    } catch { present = false; }
  } else {
    present = existsSync(svc.servicePath());
  }
  writeFileSync(statePath(), JSON.stringify({ ...readState(), askedReplaceService: true }, null, 2));
  if (!present) return;
  const options = {
    type: "question",
    message: "Another ccdeck starts when you log in",
    detail: "It was set up by the npm version (npx ccdeck or npm i -g) and starts an older deck of its own. The app starts the deck itself, so that login item is no longer needed.",
    buttons: ["Replace it with the app", "Keep it"],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  if (response !== 0) return;
  const out = svc.uninstallService();
  svc.writeServiceRecord(deckDataDir(), { removed: new Date().toISOString(), version: app.getVersion(), by: "ccdeck desktop" });
  if (out.ok) app.setLoginItemSettings({ openAtLogin: true });
  trace(`npm login item ${out.ok ? "removed" : `not removed: ${out.reason}`} (${out.path})`);
  scheduleRedraw();
}

// ── lifecycle ───────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  setRegular(false);
  await loadModel();
  tray = new Tray(trayImage("offline"));
  tray.setToolTip("ccdeck");
  tray.setContextMenu(buildMenu());
  // Windows and Linux: a left click opens the window, the menu is on the right.
  if (process.platform !== "darwin") tray.on("click", () => openWindow());
  await ensureDeck();
  // The page's housekeeping (stale sessions, evictions), and a look for a deck
  // that came up while none was running.
  setInterval(() => { model?.tick(); scheduleRedraw(); }, 10_000);
  setInterval(() => { if (!deck) discover(); }, 5_000);
  if (deck) openWindow();
  await firstRun();
  await offerToReplaceLoginItem().catch(err => trace(`login item check failed: ${err?.message ?? err}`));
});

app.on("activate", () => openWindow());
// A window closing never ends the app: it keeps the tray, and the deck keeps
// being watched. Only Quit ends it.
app.on("window-all-closed", () => {});
// Quit stops this app's own deck before leaving, once: the first before-quit
// is held while the deck shuts down, the second is the real one.
let quitting = false;
app.on("before-quit", event => {
  stream?.close();
  if (quitting || !ownDeck) return;
  event.preventDefault();
  quitting = true;
  stopOwnDeck().finally(() => app.quit());
});
