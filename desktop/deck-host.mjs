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
//   THE SHELL'S ENVIRONMENT. launchd hands GUI apps /usr/bin:/bin:/usr/sbin:/sbin,
//   where `claude`, `node`, `uv` and `cswap` are not — so the deck could not
//   find Claude Code — and none of the user's exports. The login shell's PATH
//   is read once and passed on, the way terminal-born tools expect to be run,
//   and so are the variables README's environment table documents: the
//   opt-outs (AGENTS_DECK_NO_REPORTS above all) and the directories that say
//   which deck this is. Read by name, never wholesale.
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

/**
 * The variables a terminal deck would have had from the user's shell: README's
 * environment table, row for row — restated rather than imported, because
 * this runs before any deck module is loaded, and held to the deck's own list
 * (login-service.mjs SCOPE_VARS and SETTING_VARS) by a test.
 *
 * BY NAME. The login shell also holds tokens, keys and whatever else a profile
 * exports, and the deck has no business inheriting any of it.
 */
export const SHELL_VARS = Object.freeze([
  "CLAUDE_CONFIG_DIR", "CCDECK_HOME", "CODEX_HOME", "CCDECK_CODEX_HOMES", "AGENT_DAG_PORT",
  "AGENTS_DECK_NO_INSTALL", "AGENTS_DECK_NO_DOWNLOAD", "AGENTS_DECK_NO_UPDATE_CHECK", "AGENTS_DECK_NO_STATUS",
  "AGENTS_DECK_NO_FRESHEN", "AGENTS_DECK_NO_NOTIFY", "AGENTS_DECK_NO_LAN", "AGENTS_DECK_NO_REPORTS",
  "AGENTS_DECK_CSWAP", "AGENTS_DECK_CLAUDE", "AGENTS_DECK_CCUSAGE", "CLAUDE_SWAP_BACKUP", "AGENTS_DECK_LHM_PORT",
]);

const MARK = "__CCDECK_ENV__";

/**
 * The login shell's PATH and its values of SHELL_VARS — only the ones it sets —
 * or the current PATH and nothing else when it cannot be read.
 */
export function shellEnv({ env = process.env, platform = process.platform, run = execFileSync } = {}) {
  if (platform === "win32") return { PATH: env.PATH ?? env.Path ?? "" };
  const shell = env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const names = ["PATH", ...SHELL_VARS];
  try {
    // -i and -l so the profile files that set them are read; one line per
    // name behind a marker keeps anything a profile prints out of the answer.
    // The names are this file's constants, so nothing a value holds is ever
    // part of the command.
    const script = `printf '${MARK}%s\\n' ${names.map(k => `"${k}=$${k}"`).join(" ")}`;
    const out = String(run(shell, ["-ilc", script], { encoding: "utf8", timeout: 5000 }));
    const got = {};
    for (const chunk of out.split(MARK).slice(1)) {
      const line = chunk.split("\n")[0];
      const at = line.indexOf("=");
      const name = line.slice(0, at);
      const value = line.slice(at + 1);
      // Only what was asked for, and only when set: "" written into the
      // deck's environment would be a setting, not the absent one.
      if (at > 0 && names.includes(name) && value.trim() !== "") got[name] = value;
    }
    return { ...got, PATH: got.PATH?.trim() || env.PATH || "" };
  } catch { /* a profile that fails is not a reason to start without PATH */ }
  return { PATH: env.PATH ?? "" };
}

/**
 * Give `env` the shell's value of every SHELL_VARS name it has no value for,
 * and return it. A value the app already has wins: started from a terminal, it
 * holds that terminal's settings, which are the more specific of the two.
 */
export function withShellSettings(env, shell) {
  for (const k of SHELL_VARS) {
    if (!env[k]?.trim() && shell?.[k]) env[k] = shell[k];
  }
  return env;
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
