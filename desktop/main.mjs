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
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deckJson, findDecks, openTrayStream } from "./deck-link.mjs";
import { shellPath, startDeck, writeLauncher } from "./deck-host.mjs";
import { navigationFor } from "./nav.mjs";
import { canInstallQuietly, quietSinceNext } from "./auto-update.mjs";
import { createUpdater } from "./updater.mjs";
import { shouldOfferReadyUpdate } from "./update-notice.mjs";
import { matchesReadyUpdate, restartReadyUpdate } from "./window-update.mjs";
import { createNotificationAudioStore } from "./notification-audio-store.mjs";

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
let restarting = null;        // since when a restart has been asked for, until a new deck answers
let updater = null;           // updater.mjs, created once the app is ready
let quietSince = null;        // since when nothing is running, waiting or open (#1187)
let updateNoticeVersion = null; // last version whose ready notice was shown (#1182)
let updateNoticePrompting = false;

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
  if (restarting) return "Restarting the deck…";
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
    { label: `ccdeck v${app.getVersion()}${deck?.version && deck.version !== app.getVersion() ? ` · deck v${deck.version}` : ""}`, enabled: false },
    updateItem(),
    // #1163: the deck restarted from the tray, the way the page's version
    // dialog does it, rather than Quit and a trip to the Start menu.
    { label: "Restart ccdeck", enabled: !!deck && !starting && !restarting, click: () => restartDeck() },
    { label: "Quit ccdeck", click: () => app.quit() },
  );
  return Menu.buildFromTemplate(items);
}

/** The update line of the menu, which says where the update is rather than
 *  offering a button that does nothing while one is already on its way.
 *  "Restart to update" and "v1.64.0" are the words the native sheet and the
 *  window's dialog use for the same action — one verb and one spelling of the
 *  version on all three surfaces, so a person told to find this line by the
 *  window can recognise it. */
function updateItem() {
  const u = updater?.state ?? { status: "idle" };
  if (u.status === "ready") return { label: `Restart to update to v${u.version}`, click: () => updater.restartNow() };
  if (u.status === "downloading") return { label: `Downloading ccdeck v${u.version}…`, enabled: false };
  if (u.status === "checking") return { label: "Checking for updates…", enabled: false };
  return { label: u.status === "current" ? "Up to date — check again" : "Check for updates", click: () => updater?.check() };
}

/** Redraw the icon, the count, the tooltip and the menu — coalesced, because
 *  a reconnect replays up to two thousand events and each one changes the
 *  board. */
function scheduleRedraw() {
  if (redraw) return;
  redraw = setTimeout(() => {
    redraw = null;
    if (model) snapshot = model.snapshot();
    offerReadyUpdate();
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
  // A different deck answering is the restart having landed.
  if (found && restarting) restarting = null;
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
    live: () => { refreshPrefs(); publishUpdateState(); },
    notify: n => showNotification(n),
    restartUpdate: request => {
      const version = request?.version;
      if (restartReadyUpdate(updater, version)) trace(`window requested verified update ${version}`);
      else trace(`ignored window update request ${version ?? "without a version"}`);
    },
    // The window's dialog has put this version's Restart to update in front
    // of the person, which is the one notice a version gets (#1182). Without
    // this the native sheet still owed its own, and arrived on top of the
    // window's offer, or after the person had already closed it, to ask the
    // same question a second time.
    updateSeen: request => {
      if (matchesReadyUpdate(updater, request?.version)) rememberUpdateNotice(updater.state.version);
    },
    lost: () => { model.setConnected(false); scheduleRedraw(); discoverSoon(); },
  });
}

function publishUpdateState() {
  if (!deck || !updater) return;
  const { status, version = null } = updater.state;
  deckJson(deck, "/api/desktop-update", { method: "POST", body: { status, version } })
    .catch(err => trace(`could not publish update state: ${err?.message ?? err}`));
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

/**
 * Restart the deck (#1163) through the same route the page's own Restart uses,
 * so its supervisor brings the new one up on the same port and the tray simply
 * reattaches when the stream comes back. A deck that cannot restart itself —
 * unsupervised, or with no log to replay — and was started by this app is
 * stopped and started again instead; one that belongs to a terminal is left
 * alone, and the menu says it could not.
 */
async function restartDeck() {
  if (!deck || restarting) return;
  // A RESTART THIS APP IS ALREADY DOING IS THE CHEAPEST MOMENT TO UPDATE
  // (#1187). The person asked for the deck to go down and come back; taking
  // the app through the same second, into the version already verified and
  // staged, costs them nothing more and saves the trip through the menu.
  if (updater?.state.status === "ready") {
    trace(`restart takes the staged update ${updater.state.version}`);
    updater.restartNow();
    return;
  }
  restarting = Date.now();
  scheduleRedraw();
  let asked = false;
  try {
    const { status, json } = await deckJson(deck, "/api/restart", { method: "POST", body: {}, timeoutMs: 5000 });
    asked = status >= 200 && status < 300 && json?.ok === true;
  } catch { /* the socket going away mid-answer is the restart */ asked = true; }
  if (!asked && ownDeck) {
    await stopOwnDeck();
    attach(null);
    await ensureDeck();
  }
  if (!asked && !ownDeck) restarting = null;
  // A restart that never lands is not left saying it is happening.
  setTimeout(() => { if (restarting && Date.now() - restarting >= 30_000) { restarting = null; scheduleRedraw(); } }, 30_000);
  discoverSoon(1500);
  scheduleRedraw();
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

/** The version of the deck packed into this app. */
function bundledDeckVersion() {
  try { return JSON.parse(readFileSync(join(deckRoot(), "package.json"), "utf8")).version ?? ""; }
  catch { return ""; }
}

/**
 * Attach to the running deck — unless it is OLDER than the one this app
 * carries, in which case it is replaced, exactly as a newer `ccdeck` started in
 * a terminal replaces an older running one (running-deck.mjs `olderVersion`,
 * the rule `secondStart` uses). An older deck may not know the tray connection
 * at all, and would count the app as a page open forever — the notifications
 * the app exists to deliver would never come.
 */
async function discover() {
  try {
    const decks = await findDecks(deckRoot());
    const found = decks[0] ?? null;
    if (found && !ownDeck && !starting) {
      const { olderVersion } = await import(pathToFileURL(join(deckRoot(), "src", "server", "running-deck.mjs")).href);
      const ours = bundledDeckVersion();
      if (olderVersion(found.version, ours)) {
        trace(`replacing an older deck (${found.version || "unversioned"} on ${found.port}) with this app's ${ours}`);
        await deckJson(found, "/api/shutdown", { method: "POST", body: {}, timeoutMs: 3000 }).catch(() => {});
        // Until it has let go of its port, so the app's deck gets 4317 rather
        // than a random one beside it.
        for (let i = 0; i < 24; i++) {
          if (!(await findDecks(deckRoot())).some(d => d.pid === found.pid)) break;
          await new Promise(r => setTimeout(r, 250));
        }
        attach(null);
        return;
      }
    }
    attach(found);
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
/** The tone the page would have played, as the sound the notification makes:
 *  a file in the app's Resources on macOS (scripts/chimes.mjs). Windows and
 *  Linux take no custom sound for an unpackaged app's notification, so there it
 *  is the system's own. */
const CHIME_SOUNDS = { done: "ccdeck-done.wav", "needs-input": "ccdeck-asking.wav" };

function showNotification({ title, body, chime }) {
  if (!Notification.isSupported()) return;
  const sound = process.platform === "darwin" ? CHIME_SOUNDS[chime] : undefined;
  const n = new Notification({ title: String(title ?? "ccdeck"), body: String(body ?? ""), sound, silent: false });
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

/** @param {boolean} steal Whether to pull OS-level activation to this app on
 *  top of showing the window — only for a person's own gesture (a tray click,
 *  a Dock reactivation, a second launch, a notification). The one caller that
 *  is not that is startup's own `if (deck) openWindow()`: an app relaunching
 *  itself after a quiet auto-update, or restored at login, opens with nobody
 *  having asked for it, and had no business pulling a person out of a
 *  fullscreen browser Space to do it (#1214). */
function openWindow(steal = true) {
  if (!deck) {
    ensureDeck().then(found => { if (found) openWindow(steal); });
    return;
  }
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    offerReadyUpdate();
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
      preload: join(here, "preload.cjs"),
      // The page's chimes: in a browser they wait for the first click to
      // unlock audio. An app the person opened on purpose need not.
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  // Anything that leaves the deck opens in the person's own browser — a
  // login flow, a docs link — never inside this window, and anything that is
  // not a web page is not opened at all (nav.mjs).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (navigationFor(url, origin) !== "block") shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const where = navigationFor(url, origin);
    if (where === "stay") return;
    event.preventDefault();
    if (where === "external") shell.openExternal(url);
  });
  win.once("ready-to-show", () => {
    win?.show();
    if (steal) app.focus({ steal: true });
    offerReadyUpdate();
  });
  win.on("focus", () => {
    trace(`focus onTop=${win?.isAlwaysOnTop()}`);
    offerReadyUpdate();
  });
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

// Custom notification sounds and voices (#1207): local app data the page
// reaches through preload.cjs by opaque id, never by path. What may be stored,
// and how much of it, is notification-audio-store.mjs; who may ask is here.
const notificationAudio = createNotificationAudioStore(() => join(app.getPath("userData"), "notification-audio.json"));

/** Whether an IPC call came from the deck's own page in the deck's own window.
 *  The preload runs in whatever this window shows, and navigation is already
 *  held to the deck's origin (nav.mjs) — but that is the window's rule, and a
 *  handler that trusted it would be one missed redirect from answering some
 *  other site. So the door checks for itself, as Electron's security guidance
 *  asks: the sender must be this window, and the frame must be on the origin
 *  the window was opened at. */
function fromDeckPage(event) {
  if (!deck || !win || win.isDestroyed() || event.sender.id !== win.webContents.id) return false;
  const url = event.senderFrame?.url;
  return typeof url === "string" && navigationFor(url, `http://127.0.0.1:${deck.port}`) === "stay";
}

function installNotificationAudioIpc() {
  const handle = (name, run) => ipcMain.handle(`ccdeck:notification-audio:${name}`, (event, arg) => {
    if (!fromDeckPage(event)) throw new Error("Notification audio is only available to the deck.");
    return run(arg);
  });
  handle("list", () => notificationAudio.list());
  handle("get", id => notificationAudio.get(id));
  handle("put", asset => { notificationAudio.put(asset); });
  handle("remove", id => { notificationAudio.remove(id); });
}

/** How long a question waits for the window to reach the screen before it is
 *  asked app-modally instead. Longer than a deck's page takes to paint, short
 *  enough that a window which never comes does not hold the question forever. */
const ON_SCREEN_WAIT_MS = 5_000;

/**
 * The window once it is actually on screen, or null.
 *
 * A dialog attached to a window that has not been shown yet ENDS THE APP on
 * Wayland: the compositor has given that window's surface no role, and
 * exporting a roleless surface to parent the dialog is a protocol error
 * (zxdg_exporter_v2: "exported surface had an invalid role"), which kills the
 * process rather than the dialog. Windows are created hidden and shown on
 * ready-to-show, so first run — the one moment these questions are asked — is
 * exactly when the surface is still roleless. macOS and Windows attach to a
 * hidden window happily, which is why this was only ever a Linux crash, and on
 * first run only: the one launch a new person makes.
 */
function windowOnScreen(within) {
  const here = win;
  if (!here || here.isDestroyed()) return Promise.resolve(null);
  if (here.isVisible()) return Promise.resolve(here);
  return new Promise(resolve => {
    const settle = () => {
      clearTimeout(timer);
      here.off("show", settle);
      resolve(here.isDestroyed() || !here.isVisible() ? null : here);
    };
    const timer = setTimeout(settle, within);
    here.on("show", settle);
  });
}

/** A question for the person, attached to the window when one is on screen —
 *  a sheet moves with it — and app-modal only when none arrives, which on
 *  macOS floats above every other app until it is answered. */
async function ask(options) {
  const parent = await windowOnScreen(ON_SCREEN_WAIT_MS);
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

/**
 * This version has had its one notice, from whichever surface gave it first:
 * the native sheet below, or the window's own version dialog, which offers
 * the same Restart to update (#1187). One memory for both, kept on disk, so
 * "Later" in either place survives a relaunch and neither asks again. The
 * version chip and the tray line stay, as the places to find it afterwards.
 */
function rememberUpdateNotice(version) {
  if (updateNoticeVersion === version) return;
  updateNoticeVersion = version;
  try {
    const state = readState();
    writeFileSync(statePath(), JSON.stringify({ ...state, readyUpdateNoticeVersion: version }, null, 2));
  } catch (err) {
    trace(`could not remember update notice ${version}: ${err?.message ?? err}`);
  }
}

/**
 * Say that a verified update is ready while the person is already looking at
 * ccdeck. The updater never opens or raises a window for this notice: if the
 * window is closed, unfocused, or the deck is active, the next focus/redraw
 * gets another chance. Dismissing it remembers the version across launches so
 * "Later" really means later rather than every six-hour update check.
 *
 * Not routed through `ask()`: `shouldOfferReadyUpdate` already requires
 * `windowVisible` before this ever runs, so `target` is never the unshown,
 * roleless-surface window `ask()` exists to wait out.
 */
async function offerReadyUpdate() {
  const u = updater?.state ?? { status: "idle" };
  const target = win;
  const windowOpen = !!target && !target.isDestroyed();
  if (!shouldOfferReadyUpdate({
    status: u.status,
    version: u.version,
    shownVersion: updateNoticeVersion,
    windowOpen,
    windowVisible: windowOpen && target.isVisible(),
    windowFocused: windowOpen && target.isFocused(),
    running: snapshot.running,
    waiting: snapshot.waiting,
    prompting: updateNoticePrompting,
  })) return;

  const version = u.version;
  updateNoticePrompting = true;
  try {
    const { response } = await dialog.showMessageBox(target, {
      type: "info",
      message: `ccdeck v${version} is ready`,
      // The tray's own words for where it lives, the ones the window's dialog
      // uses when a restart from there fails (trayMenuName in desktop-update.ts).
      detail: `It has been downloaded and verified. To do it later, use Restart to update in ${process.platform === "darwin" ? "the ccdeck menu in the menu bar" : "the ccdeck tray menu"}.`,
      buttons: ["Restart to update", "Later"],
      defaultId: 0,
      cancelId: 1,
    });

    // The sheet was actually shown, so this version has had its one notice.
    rememberUpdateNotice(version);

    // A newer update may have replaced this one while the sheet was open.
    // Only restart for the exact verified version the person accepted.
    if (response === 0 && updater?.state.status === "ready" && updater.state.version === version) {
      updater.restartNow();
    }
  } catch (err) {
    trace(`update ready notice failed: ${err?.message ?? err}`);
  } finally {
    updateNoticePrompting = false;
  }
}

async function firstRun() {
  const state = readState();
  if (state.askedLogin) return;
  const { checkboxChecked } = await ask({
    type: "question",
    message: "ccdeck lives in the menu bar",
    detail: "It tells you when a session needs you, even with the window closed.",
    checkboxLabel: "Start ccdeck when I log in",
    checkboxChecked: true,
    buttons: ["OK"],
  });
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
  const { response } = await ask({
    type: "question",
    message: "Another ccdeck starts when you log in",
    detail: "It was set up by the npm version (npx ccdeck or npm i -g) and starts an older deck of its own. The app starts the deck itself, so that login item is no longer needed.",
    buttons: ["Replace it with the app", "Keep it"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  const out = svc.uninstallService();
  svc.writeServiceRecord(deckDataDir(), { removed: new Date().toISOString(), version: app.getVersion(), by: "ccdeck desktop" });
  if (out.ok) app.setLoginItemSettings({ openAtLogin: true });
  trace(`npm login item ${out.ok ? "removed" : `not removed: ${out.reason}`} (${out.path})`);
  scheduleRedraw();
}

// ── lifecycle ───────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  installNotificationAudioIpc();
  setRegular(false);
  updateNoticeVersion = readState().readyUpdateNoticeVersion ?? null;
  await loadModel();
  tray = new Tray(trayImage("offline"));
  tray.setToolTip("ccdeck");
  tray.setContextMenu(buildMenu());
  // Windows and Linux: a left click opens the window, the menu is on the right.
  if (process.platform !== "darwin") tray.on("click", () => openWindow());
  updater = createUpdater({
    app,
    onChange: s => {
      trace(`update: ${s.status}${s.version ? ` ${s.version}` : ""}${s.error ? ` — ${s.error}` : ""}`);
      scheduleRedraw();
      publishUpdateState();
      offerReadyUpdate();
      // An update that lands while the app is already quiet does not wait for
      // the next tick to be noticed.
      updateWhenQuiet();
    },
    log: trace,
  });
  // AT EVERY START, and then four times a day. An app that is opened, used and
  // closed the same day would never have reached a check on a six-hour timer,
  // and the owner asked for one that is on the current version without anybody
  // remembering to look (#1187). Fifteen seconds in, so the check is behind the
  // window and the deck rather than in front of them. Only a built app looks: a
  // development run has nothing to update into.
  setTimeout(() => updater.check(), 15_000);
  setInterval(() => updater.check(), 6 * 60 * 60_000);
  await ensureDeck();
  // The page's housekeeping (stale sessions, evictions), and a look for a deck
  // that came up while none was running.
  setInterval(() => { model?.tick(); scheduleRedraw(); updateWhenQuiet(); }, 10_000);
  setInterval(() => { if (!deck) discover(); }, 5_000);
  // Nobody asked for this one — see openWindow's own doc on `steal`.
  if (deck) openWindow(false);
  await firstRun();
  await offerToReplaceLoginItem().catch(err => trace(`login item check failed: ${err?.message ?? err}`));
});

/**
 * Install a verified update by itself, once the app has been left alone long
 * enough (#1187) — see auto-update.mjs for what "alone" means and why.
 *
 * Run on the same ten-second tick that redraws the tray, so the quiet is
 * measured from the same snapshot the icon is drawn from rather than from a
 * clock of its own.
 */
function updateWhenQuiet() {
  const where = {
    windowFocused: !!win && !win.isDestroyed() && win.isFocused(),
    busy: !!starting || !!restarting,
    now: Date.now(),
  };
  quietSince = quietSinceNext(quietSince, where);
  if (!canInstallQuietly({ status: updater?.state.status ?? "idle", quietSince, ...where })) return;
  trace(`installing ${updater.state.version} by itself after a quiet spell`);
  quietSince = null;
  updater.restartNow();
}

app.on("activate", () => openWindow());
// A window closing never ends the app: it keeps the tray, and the deck keeps
// being watched. Only Quit ends it.
app.on("window-all-closed", () => {});
// The staged macOS update is handed to its swap script as the app leaves —
// after its own deck has been stopped, so nothing runs from the old bundle.
app.on("will-quit", () => { updater?.installOnQuit(); });

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
