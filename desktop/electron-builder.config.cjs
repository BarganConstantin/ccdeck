// How the desktop app is packaged (#1160). electron-builder 26.
//
// The app id is permanent: macOS keys notification permission to it and
// Windows keys the Start menu entry and toasts to it, so changing it later
// orphans every install.
module.exports = {
  appId: "dev.ccdeck.app",
  productName: "ccdeck",
  // The AppImage runtime. Left unset, electron-builder still packs the 2020
  // AppImageKit runtime, which dlopens libfuse.so.2 at startup — and Ubuntu
  // 24.04 and up, Fedora 40 and up and Arch no longer ship libfuse2. On those
  // the download does not start and says only "AppImages require FUSE to run",
  // which for most people reads as nothing happening at all. The 1.x toolset
  // links libfuse3 statically, so the runtime needs nothing from the system.
  toolsets: { appimage: "1.0.3" },
  directories: {
    output: "dist/app",
    // icon.png (1024) lives here; electron-builder makes .icns and .ico from it.
    buildResources: "dist/icons",
  },
  files: ["main.mjs", "auto-update.mjs", "update-notice.mjs", "window-update.mjs", "deck-link.mjs", "deck-host.mjs", "nav.mjs", "updater.mjs", "updater-mac.mjs", "dist/icons/**", "dist/lib/**", "package.json"],
  // The deck itself, outside the asar archive, exactly as the npm package
  // ships it: the app runs bin/agent-dag.js with its own binary as Node, and
  // the deck reads its files from disk relative to itself. Build the web
  // bundle (npm run build at the root) before packing.
  extraResources: [
    { from: "../bin", to: "deck/bin" },
    { from: "../hook", to: "deck/hook" },
    { from: "../src/server", to: "deck/src/server" },
    { from: "../dist/web", to: "deck/dist/web" },
    { from: "../package.json", to: "deck/package.json" },
    // The deck's two tones, at the top of Resources where macOS looks up a
    // notification's sound by name (scripts/chimes.mjs).
    { from: "dist/sounds", to: "." },
  ],
  // Signed by scripts/sign-mac.cjs with ccdeck's own certificate, never by
  // electron-builder — see that file for why.
  afterPack: "./scripts/sign-mac.cjs",
  // GitHub Releases, for electron-updater on Windows and Linux (the macOS
  // updater reads latest-mac.json from the same place). The release itself is
  // created by CI on a v* tag; the build never publishes.
  publish: [{ provider: "github", owner: "BarganConstantin", repo: "ccdeck", releaseType: "release" }],
  // One name per OS and CPU and NO version, so ccdeck.dev can link
  // releases/latest/download/ccdeck-mac-arm64.dmg and never go stale. The
  // updaters are unaffected: each release's manifests name the files in that
  // same release, and the version is in the manifest.
  artifactName: "${productName}-${os}-${arch}.${ext}",
  mac: {
    target: ["dmg", "zip"],
    // Made by scripts/icons.mjs with Apple's iconutil, so no icon toolset is
    // downloaded on the Mac runner.
    icon: "dist/icons/icon.icns",
    identity: null,
    category: "public.app-category.developer-tools",
    // Not notarised (no Apple Developer ID), so hardened runtime buys nothing
    // and would enforce library validation against Electron's own frameworks.
    hardenedRuntime: false,
    // No LSUIElement. An app that DECLARES itself an agent and then turns
    // regular when its window opens kept that window in front of other apps on
    // a real Mac — clicking the browser behind it left ccdeck on top. main.mjs
    // switches the activation policy itself instead: accessory with no window,
    // regular while one is open.
  },
  win: {
    target: ["nsis"],
    // Made by scripts/icons.mjs, so no icon toolset is downloaded here either.
    icon: "dist/icons/icon.ico",
  },
  nsis: {
    // Per-user, no admin prompt, so an update can replace it in place.
    oneClick: true,
    perMachine: false,
  },
  linux: {
    target: ["AppImage", "deb"],
    category: "Development",
    maintainer: "ccdeck <https://ccdeck.dev>",
    // The size set scripts/icons.mjs draws, not icon.png. From that one file
    // electron-builder installed one icon, at 1024 — a size hicolor does not
    // declare — so Linux showed no icon at all. Named <size>x<size>.png, which
    // is how electron-builder reads an icon directory.
    icon: "dist/icons/linux",
    // Electron's Wayland app_id is the packaged package.json name,
    // ccdeck-desktop. The entry file is already named for it, but its
    // StartupWMClass said "ccdeck" — the product name — so the hint a desktop
    // matches a running window against named a class no window of ours has.
    // desktopName in package.json makes the filename, the WM class and the
    // app_id one string. Nothing is renamed by this: the name it syncs to is
    // the one the file already had, so no installed entry is orphaned.
    syncDesktopName: true,
  },
  deb: {
    // electron-builder's own list, plus the ALSA library it leaves out: Ubuntu
    // 24.04 renamed it libasound2t64, and without it the app does not start at
    // all ("libasound.so.2: cannot open shared object file"), which a clean
    // 24.04 container showed on the first install. Either name satisfies it.
    depends: [
      "libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils",
      "libatspi2.0-0", "libuuid1", "libsecret-1-0", "libgbm1",
      "libasound2t64 | libasound2",
    ],
  },
};
