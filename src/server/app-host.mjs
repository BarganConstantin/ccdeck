// When the deck runs inside the ccdeck desktop app (#1160).
//
// The app starts this deck with its own binary acting as Node
// (ELECTRON_RUN_AS_NODE=1) and tells it so, because three things the deck does
// for itself are the app's to do there, and doing them anyway goes wrong:
//
//   UPDATES. The deck would ask npm for a newer ccdeck and `npm i -g` it — a
//   second, global copy the app never runs, reinstalled every thirty minutes by
//   the away-update because the app's own version never changes. The app
//   updates itself from GitHub Releases instead.
//
//   START AT LOGIN. The deck offers a login item that runs `process.execPath
//   bin/agent-dag.js` — here the app's binary, started at login with no window
//   and no tray, beside the app's own login item. The app owns that switch.
//
//   THE CLAUDE CODE HOOK. Its command is `<node> hook.js`, and `process.execPath`
//   is the app's binary, which without ELECTRON_RUN_AS_NODE opens the app. The
//   app hands the deck a launcher that finds a Node to run the hook with.
//
// Environment, not flags: the supervisor re-spawns the worker with its own
// argv, and the environment is what both of them inherit unchanged.

/** "1" when the desktop app started this deck. */
export const APP_ENV = "CCDECK_APP";

/** The program the Claude Code hook command runs hook.js with, when it must
 *  not be `process.execPath`. */
export const HOOK_RUNTIME_ENV = "CCDECK_HOOK_RUNTIME";

export function inApp(env = process.env) {
  return env[APP_ENV] === "1";
}

export function hookRuntime(env = process.env, execPath = process.execPath) {
  const given = env[HOOK_RUNTIME_ENV];
  return typeof given === "string" && given.trim() ? given : execPath;
}
