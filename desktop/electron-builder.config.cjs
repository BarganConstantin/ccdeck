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
  files: ["main.mjs", "deck-link.mjs", "deck-host.mjs", "updater.mjs", "updater-mac.mjs", "dist/icons/**", "dist/lib/**", "package.json"],
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
  // One name shape for every download, with the CPU in it, so the macOS
  // manifest and the ccdeck.dev links can name a file without guessing.
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
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
  },
};
