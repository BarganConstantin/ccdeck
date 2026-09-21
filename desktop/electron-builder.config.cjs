// How the desktop app is packaged (#1160). electron-builder 26.
//
// The app id is permanent: macOS keys notification permission to it and
// Windows keys the Start menu entry and toasts to it, so changing it later
// orphans every install.
module.exports = {
  appId: "dev.ccdeck.app",
  productName: "ccdeck",
  directories: {
    output: "dist/app",
    // icon.png (1024) lives here; electron-builder makes .icns and .ico from it.
    buildResources: "dist/icons",
  },
  files: ["main.mjs", "updater-mac.mjs", "dist/icons/**", "package.json"],
  // Signed by scripts/sign-mac.cjs with ccdeck's own certificate, never by
  // electron-builder — see that file for why.
  afterPack: "./scripts/sign-mac.cjs",
  mac: {
    identity: null,
    category: "public.app-category.developer-tools",
    // Not notarised (no Apple Developer ID), so hardened runtime buys nothing
    // and would enforce library validation against Electron's own frameworks.
    hardenedRuntime: false,
    extendInfo: {
      // A menu-bar app first: the Dock tile appears only while a window is
      // open (main.mjs shows and hides it).
      LSUIElement: true,
    },
  },
};
