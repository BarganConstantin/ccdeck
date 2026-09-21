// ccdeck desktop — phase 0 spike (#1160). Proves two things before anything is
// built on them: that a notification permission granted to one build survives
// the next (the self-signed identity, scripts/sign-mac.cjs), and that the app
// can raise notifications as ccdeck. Replaced by the real shell in phase 1.
import { app, Menu, Notification, Tray, nativeImage } from "electron";
import { bundleOf, checkForUpdate, installOnExit, stageUpdate } from "./updater-mac.mjs";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const icons = join(here, "dist", "icons");
let tray = null;

function trayImage(state) {
  const name = process.platform === "darwin" ? `tray-${state}Template.png` : `tray-${state}.png`;
  return nativeImage.createFromPath(join(icons, name));
}

// `--test-notify`: raise one notification at launch and write what macOS did
// with it to ~/Library/Logs/ccdeck-spike.log, so a rebuild can be checked
// without anybody clicking.
function testNotify(build) {
  const log = join(app.getPath("home"), "Library", "Logs", "ccdeck-spike.log");
  const note = (line) => appendFileSync(log, `${new Date().toISOString()} ${build} ${line}\n`);
  const n = new Notification({ title: "ccdeck", body: `Automatic test from ${build}` });
  n.on("show", () => note("shown"));
  n.on("failed", (_e, err) => note(`failed: ${err}`));
  n.show();
  note("requested");
}

// `--test-update <manifest url>`: run the macOS updater once, logging each
// step to the same file, and quit into the new version if there is one.
async function testUpdate(manifestUrl, build) {
  const log = join(app.getPath("home"), "Library", "Logs", "ccdeck-spike.log");
  const note = (line) => appendFileSync(log, `${new Date().toISOString()} ${build} update: ${line}\n`);
  try {
    const update = await checkForUpdate({ manifestUrl, currentVersion: build });
    if (!update) { note("none newer"); return; }
    note(`found ${update.version} (${update.file.arch}, ${update.file.size} bytes)`);
    const runningApp = bundleOf(app.getPath("exe"));
    const { staged, dir } = await stageUpdate(update, { runningApp });
    note(`verified and staged ${staged}; swapping ${runningApp} on exit`);
    installOnExit({ pid: process.pid, target: runningApp, staged, dir });
    app.quit();
  } catch (err) {
    note(`refused: ${err.message}`);
  }
}

app.whenReady().then(() => {
  tray = new Tray(trayImage("running"));
  tray.setToolTip("ccdeck");
  const build = app.getVersion();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `ccdeck ${build}`, enabled: false },
    { type: "separator" },
    {
      label: "Send a test notification",
      click: () => new Notification({ title: "ccdeck", body: `Test from ${build}` }).show(),
    },
    { type: "separator" },
    { label: "Quit", role: "quit" },
  ]));
  // Delayed, so the notification is not raised in the instant the launch made
  // this app frontmost — the banner decision is taken then.
  if (process.argv.includes("--test-notify")) setTimeout(() => testNotify(build), 8000);
  const at = process.argv.indexOf("--test-update");
  if (at > -1 && process.argv[at + 1]) setTimeout(() => testUpdate(process.argv[at + 1], build), 3000);
});

// A tray app has no window to close; nothing here should end it but Quit.
app.on("window-all-closed", () => {});
