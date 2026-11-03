// Whether this deck's platform has the Command Panel: what /api/prefs says as
// `terminalSupported`, which decides whether Settings offers the panel's
// switch (TerminalSection.tsx). Asked once, by startServer.
//
// LINUX AND MACOS: commandPanelSupported (command-panel-engine.mjs), as it has
// always been. Nothing below is loaded, read or asked there, whatever startServer
// was given.
//
// WINDOWS: the same path as the other platforms, commandPanelSupported
// (ENGINE_ON_WINDOWS in engine-package.mjs): the deck's own engine from its npm
// package, verified by the installer with its Windows ACL reader
// (windows-acl.mjs). The engine's sessions there always live in the per-user
// session host, so `sessionHost` is true whenever the panel is supported.
//
// THE PREVIEW OPTION, WHICH IS TEST-ONLY: the Windows preview, a local
// development and test configuration for a VM, never a production feature.
// Without it a Windows deck answers as above. With it, it holds only when ALL
// of these do:
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
// Then the switch is offered on Windows and everything it reaches goes to that
// explicit engine; when any of them fails the option is refused and the Windows
// deck does not offer the panel at all, not even through its own path: a lab
// that asked for the preview is told it is missing, not given the deck's engine.
// (A startServer caller's `terminal.engine` always wins on every platform,
// terminal-routes.mjs.)
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

const answer = (supported, windowsPreview, sessionHost = false) => Object.freeze({ supported, windowsPreview, sessionHost });

/** Whether this answer puts the panel's sessions in the Windows session host
 *  rather than tmux: on Windows always (through the engine, or the preview),
 *  nowhere else. A caller with no answer asks the platform. */
export const panelInSessionHost = (panel, platform = process.platform) =>
  panel ? panel.sessionHost === true || panel.windowsPreview === true : platform === "win32" && commandPanelSupported(platform);

/**
 * This deck's Command Panel platform, for startServer's `terminal` option:
 * `{ supported, windowsPreview, sessionHost }`: `windowsPreview` is the
 * test-only preview, `sessionHost` that sessions live in the per-user session
 * host. `platform`, `load` and `log` are there for
 * tests; the deck uses the defaults.
 */
export async function commandPanelPlatform(terminal, {
  platform = process.platform,
  load = () => import("../../preview/command-panel-windows.mjs"),
  log = (line) => console.error(`${PRODUCT}: ${line}`),
} = {}) {
  if (platform !== "win32") return answer(commandPanelSupported(platform), false);
  if (terminal?.windowsPreview !== true) {
    const supported = commandPanelSupported(platform);
    return answer(supported, false, supported);
  }
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
  return answer(true, true, true);
}
