// Several suites boot a real deck, and on a Mac whose checkout has the
// menu-bar app built (native/macos/build.sh), every one of them would put a
// ccdeck icon in the menu bar of whoever ran `vitest` — and route the
// notifications they test through it. This keeps the suite on the
// pre-app path: no launch, and `osascript` for notifications, exactly as the
// existing notify tests expect.
//
// Registered from vite.config.ts as a setup file, for the reason no-lan.ts
// is: it has to apply to the suite somebody forgets to add it to. A suite
// that tests the app path passes its own `env` to menubar.mjs.
process.env.AGENTS_DECK_NO_MENUBAR = "1";
