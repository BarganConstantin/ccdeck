// Running a deck of the app's own, when none is running on the machine (#1160).
//
// The deck is started exactly as `ccdeck` starts it — bin/agent-dag.js, the
// supervisor that restarts it, relaunches it into updates on disk and writes
// its discovery file — with the app's own binary acting as Node
// (ELECTRON_RUN_AS_NODE=1). Nothing in bin/deck.js is reimplemented here; the
// deck only learns that the app is its host (src/server/app-host.mjs).
//
// Two things an app started from the Dock lacks that a terminal has:
//
//   PATH. launchd hands GUI apps /usr/bin:/bin:/usr/sbin:/sbin, where `claude`,
//   `node`, `uv` and `cswap` are not — so the deck could not find Claude Code.
//   The login shell's PATH is read once and passed on, the way terminal-born
//   tools expect to be run.
//
//   A NODE FOR THE HOOK. Claude Code runs the deck's hook with the command the
//   deck wrote into its settings, `<runtime> hook.js`. A launcher at a fixed
//   path in the deck's own directory runs it with the system `node` when there
//   is one — the faster start — and with this app's binary as Node when there
//   is not. It is rewritten at every start, so moving the app does not strand
//   it.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Claude Code's config directory, which CLAUDE_CONFIG_DIR moves — the deck's
 *  own rule (src/server/claude-dir.mjs), restated because this runs before any
 *  deck module is loaded. Restated whole: trimmed and resolved, as the deck
 *  does it. The launcher's path is written into settings.json, and a relative
 *  one there is resolved by Claude Code against each session's own cwd. */
export function claudeDir(env = process.env, home = homedir()) {
  const given = env.CLAUDE_CONFIG_DIR?.trim();
  return given ? resolve(given) : join(home, ".claude");
}

/** The login shell's PATH, or the current one when it cannot be read. */
export function shellPath({ env = process.env, platform = process.platform, run = execFileSync } = {}) {
  if (platform === "win32") return env.PATH ?? env.Path ?? "";
  const shell = env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  try {
    // -i and -l so the profile files that set PATH are read; the marker keeps
    // anything a profile prints out of the answer.
    const out = run(shell, ["-ilc", 'printf "__CCDECK_PATH__%s" "$PATH"'], { encoding: "utf8", timeout: 5000 });
    const path = String(out).split("__CCDECK_PATH__").pop().trim();
    if (path) return path;
  } catch { /* a profile that fails is not a reason to start without PATH */ }
  return env.PATH ?? "";
}

/** The launcher's text for this platform. `app` is the binary to fall back to. */
export function launcherScript(app, platform = process.platform) {
  if (platform === "win32") {
    // cmd: `where` finds node on PATH; %* passes the hook's arguments through.
    return [
      "@echo off",
      "rem Written by the ccdeck app: runs the Claude Code hook with a Node it can find.",
      "where node >nul 2>nul && (node %* & exit /b)",
      "set ELECTRON_RUN_AS_NODE=1",
      `"${app.replace(/"/g, '""')}" %*`,
      "",
    ].join("\r\n");
  }
  const quoted = `'${app.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "# Written by the ccdeck app: runs the Claude Code hook with a Node it can find.",
    'if command -v node >/dev/null 2>&1; then exec node "$@"; fi',
    `ELECTRON_RUN_AS_NODE=1 exec ${quoted} "$@"`,
    "",
  ].join("\n");
}

/** Write the launcher next to the deck's hook, and return its path. */
export function writeLauncher(app, { env = process.env, platform = process.platform } = {}) {
  const dir = join(claudeDir(env), "agent-dag");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, platform === "win32" ? "ccdeck-node.cmd" : "ccdeck-node");
  writeFileSync(path, launcherScript(app, platform));
  if (platform !== "win32") chmodSync(path, 0o755);
  return path;
}

/**
 * Start a deck from `deckRoot` with this app as its host.
 *
 * Detached from nothing — it is the app's child, logs to `logFile`, and is
 * stopped by the app on Quit (the app asks it to, with its token). The port is
 * the deck's default; a deck that finds it taken picks another and writes that
 * into its discovery file, which is where the app looks.
 */
export function startDeck({ deckRoot, appBinary, logFile, path, launcher, env = process.env }) {
  const out = openSync(logFile, "a");
  try {
    return spawn(appBinary, [join(deckRoot, "bin", "agent-dag.js"), "--no-open"], {
      cwd: deckRoot,
      env: {
        ...env,
        PATH: path,
        ELECTRON_RUN_AS_NODE: "1",
        // Already detached as far as the supervisor is concerned: it must not
        // re-spawn itself into the background and leave the app holding nothing.
        AGENTS_DECK_DETACHED: "1",
        CCDECK_APP: "1",
        CCDECK_HOOK_RUNTIME: launcher,
      },
      stdio: ["ignore", out, out],
    });
  } finally {
    // The deck has its own copy of the log's descriptor once spawn returns.
    // Closing the app's copy avoids leaking a handle on every restart and
    // keeping the log file locked against rotation on Windows (#1183).
    closeSync(out);
  }
}
