// The file in dist/icons the tray shows for a state, on each platform. One
// function, read by main.mjs and by scripts/icons.mjs that writes the files,
// so the name the app asks for and the name the build writes cannot drift.
//
//   macOS    tray-<state>Template.png, and the @2x beside it. "Template" in
//            the name is what makes Electron hand the menu bar a template
//            image, which macOS tints for a light or a dark bar; the @2x is
//            loaded with it for a Retina bar.
//   Windows  tray-<state>.ico. Electron's Windows tray asks the image for an
//            HICON at the small-icon size (GetSystemMetrics(SM_CXSMICON):
//            16 at 100 %, 20 at 125 %, 24 at 150 %, 32 at 200 %). From an
//            .ico, Windows loads the entry made for that size. From a PNG it
//            gets only the 1x bitmap, and scales it.
//   Linux    tray-<state>.png, and the @2x beside it. Electron hands the
//            StatusNotifierItem host one image, the highest-resolution one it
//            holds, so the panel receives the @2x.
export function trayIconFile(platform, state) {
  if (platform === "darwin") return `tray-${state}Template.png`;
  if (platform === "win32") return `tray-${state}.ico`;
  return `tray-${state}.png`;
}

/** The Retina partner Electron loads beside a PNG, by its own naming rule. */
export function retinaFile(name) {
  return name.replace(/\.png$/, "@2x.png");
}
