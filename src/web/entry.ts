// The page's entry, and on purpose nothing more than a pointer to the app
// (#2162).
//
// The app starts in main.tsx, which vite.config.ts builds into a chunk of its
// own, `app-<hash>.js`, with everything it imports — React included. The lazy
// panels import React and the shared code from that chunk, so no chunk ever
// imports this one, and the page runs the app once whatever URL this file was
// loaded under. When the entry held the app, a 3.42.0 page loaded it as
// `assets/index-v2.js`, and opening the Telemetry Radar fetched it again as
// `index-<hash>.js`, the name the Radar's chunk imported it by: a second React
// (Minified React error #321) and a second root on #root (a removeChild
// NotFoundError in the first).
//
// Anything written here runs once per URL the entry is loaded under, so it
// stays this one import.
import "./main";
