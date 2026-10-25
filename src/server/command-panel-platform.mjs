// Whether this deck's platform has the Command Panel: what /api/prefs says as
// `terminalSupported`, which decides whether Settings offers the panel's
// switch (TerminalSection.tsx). Asked once, by startServer.
//
// LINUX AND MACOS: commandPanelSupported (command-panel-engine.mjs), as it has
// always been. Nothing below is loaded, read or asked there, whatever startServer
// was given.
//
// WINDOWS: not supported. The production gate stays closed: the deck's own
// engine answers every route `unsupported` without looking at anything, and
// no client the deck builds can verify an engine there (pro-engine-install.mjs
// knows no Windows target).
//
// THE ONE EXCEPTION, AND IT IS TEST-ONLY: the Windows preview, a local
// development and test configuration for a VM, never a production feature.
// It holds only when ALL of these do:
//   - process.platform is "win32";
//   - startServer was given `terminal.windowsPreview === true`. Only the
//     private QA preload passes it (the private repo's
//     scripts/qa/engine-preload.mjs, and only when its lab's own config asks
//     for the preview). bin/deck.js, bin/agent-dag.js and the desktop app
//     pass startServer no `terminal` at all, and nothing here reads an
//     environment variable, a setting, a CLI flag, a file or a request;
//   - startServer was also given an explicit `terminal.engine`: the engine
//     that preload built, with a fresh test key it holds in memory and passes
//     as that engine's `publicKey`. The deck's own ENGINE_PUBLIC_KEYS stay
//     empty and are never added to;
//   - the test-only module preview/command-panel-windows.mjs, outside
//     src/server, can be loaded. It is not in the published package
//     (package.json `files`) nor in the desktop app's resources
//     (electron-builder.config.cjs), so on a production install the option is
//     refused whatever is passed, and the deck's log says so once.
// Then, and only then, Settings offers the switch on Windows. Everything the
// switch then reaches goes to that explicit engine, as on every platform a
// startServer caller's `terminal.engine` always has (terminal-routes.mjs).
import { commandPanelSupported } from "./command-panel-engine.mjs";
import { PRODUCT } from "./brand.mjs";

/** The test-only module, beside the package rather than in it. Imported by
 *  this literal name below, so a walk of what the deck can load
 *  (terminal-js-offpath.test.ts) follows it rather than meeting a computed one. */
export const WINDOWS_PREVIEW_MODULE = new URL("../../preview/command-panel-windows.mjs", import.meta.url);

/** What the deck's log says when the preview was asked for and is refused. No
 *  path: the reason only. */
export const WINDOWS_PREVIEW_REFUSED = Object.freeze({
  "no-engine": "the Windows Command Panel preview was asked for without an engine, so it is off; the Command Panel is unavailable on this platform.",
  absent: "the Windows Command Panel preview was asked for, but this build does not include it; the Command Panel is unavailable on this platform.",
  "not-preview": "the Windows Command Panel preview was asked for, but the module found is not the preview; the Command Panel is unavailable on this platform.",
});

const answer = (supported, windowsPreview) => Object.freeze({ supported, windowsPreview });

/**
 * This deck's Command Panel platform, for startServer's `terminal` option:
 * `{ supported, windowsPreview }`. `platform`, `load` and `log` are there for
 * tests; the deck uses the defaults.
 */
export async function commandPanelPlatform(terminal, {
  platform = process.platform,
  load = () => import("../../preview/command-panel-windows.mjs"),
  log = (line) => console.error(`${PRODUCT}: ${line}`),
} = {}) {
  if (platform !== "win32") return answer(commandPanelSupported(platform), false);
  if (terminal?.windowsPreview !== true) return answer(false, false);
  const engine = terminal.engine;
  if (!engine || typeof engine !== "object" || typeof engine.route !== "function" || typeof engine.attach !== "function") {
    log(WINDOWS_PREVIEW_REFUSED["no-engine"]);
    return answer(false, false);
  }
  let preview;
  try {
    preview = await load(WINDOWS_PREVIEW_MODULE);
  } catch {
    log(WINDOWS_PREVIEW_REFUSED.absent);
    return answer(false, false);
  }
  if (preview?.WINDOWS_PREVIEW !== true) {
    log(WINDOWS_PREVIEW_REFUSED["not-preview"]);
    return answer(false, false);
  }
  return answer(true, true);
}
