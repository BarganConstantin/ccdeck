// Installing Codex from the deck, for the session pane told `agent-missing`
// about a Codex session. Its card offers Install Codex, which is this; Claude
// Code's install beside it is claude-install.mjs.
//
//   GET  /api/codex-install   { ok, state: idle|running|done|failed, id?, reason?, detail?, command, shell, blocked? }
//   POST /api/codex-install   start one: { ok: true, id }, or 409 { ok: false, code }
//
// THE OFFICIAL WAY, AND NOTHING OF OUR OWN. OpenAI's README installs Codex
// with `npm install -g @openai/codex`, on every platform, and that is what
// runs: the same words `command` hands to people who would rather type them.
// Nothing is downloaded by the deck itself; npm fetches the package.
//
// WHICH NPM. The one that came with the Node the deck runs on first, its
// npm-cli.js run by that Node, as the in-app upgrade does (npm-upgrade.mjs);
// then `npm` on the deck's PATH; then on the PATH the user's login shell has
// (login-shell-path.mjs), for a deck started by the desktop app or a service,
// whose PATH never read the shell's startup files where nvm and its kind put
// npm. On Windows npm.cmd by its full path, beside node.exe or on PATH, run
// through cmd.exe as every batch file is (exec-spec.mjs). No npm anywhere:
// the install fails as `npm-missing`, and the card shows the command, to run
// wherever npm is.
//
// DONE MEANS THE DECK CAN RUN IT. npm exiting 0 is not enough: the install
// counts once the deck's own lookup (codexBin, codex-update.mjs) finds
// `codex`, the one the session pane starts. When it does not, npm is asked
// where its global prefix is (`npm prefix -g`) and Codex is looked for in that
// prefix's bin folder (<prefix>/bin/codex; <prefix>\codex.cmd on Windows).
// Found there, the folder goes at the end of the deck's PATH, as the login
// shell's folders do, so the pane and everything else the deck starts from
// then on find it without a restart. The terminal engine, when it runs the
// panes, was started with the PATH of its own start, so it is let go then
// (command-panel-engine.mjs renew) and the next pane starts one that sees the
// folder; its sessions keep running. The folder is the deck's while it runs:
// after a restart the card offers the install again, which npm then finishes
// quickly. Not there either, or not where the deck can see it:
// `installed-but-not-found`.
//
// The job, the run under its deadline, the tail of what npm printed and the
// one-at-a-time rule are claude-install.mjs's, shared. Nothing npm prints is
// logged; its last lines are kept for a failure, for the page that asked.
//
// AGENTS_DECK_NO_INSTALL=1 and AGENTS_DECK_NO_DOWNLOAD=1 turn it off, as they
// do Claude Code's: the status says so, and the page offers the command.
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix as posixPath, win32 as winPath } from "node:path";
import { claudeInstallBlocked, InstallFailure, installJob, outputTail, runInstaller } from "./claude-install.mjs";
import { codexBin } from "./codex-update.mjs";
import { commandPanel } from "./command-panel-engine.mjs";
import { killTree, watchChild } from "./exec-children.mjs";
import { pathLookup, shimPath, spawnSpec } from "./exec-spec.mjs";
import { readBody, send } from "./http-io.mjs";
import { adoptLoginShellPath, mergePath, resolveWithLoginShell } from "./login-shell-path.mjs";
import { npmCliLaunch } from "./npx.mjs";

export const CODEX_INSTALL_ROUTE = "/api/codex-install";

/** The package OpenAI's README installs Codex from. */
export const CODEX_PACKAGE = "@openai/codex";
/** npm's words for the install, exactly as the README spells them. */
export const CODEX_INSTALL_ARGS = Object.freeze(["install", "-g", CODEX_PACKAGE]);
/** And for where its global installs go. */
export const NPM_PREFIX_ARGS = Object.freeze(["prefix", "-g"]);

/** The whole install: npm fetches Codex and its native build, tens of MB. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** `npm prefix -g` reads its config and prints one line. */
export const PREFIX_TIMEOUT_MS = 30_000;
/** A prefix is one path; more than this is not one. */
const PREFIX_MAX = 4 * 1024;
/** The requests carry no body worth reading; a small cap answers 413 above it. */
const BODY_LIMIT = 1024;

/** The command to run by hand, the same on every platform. */
export function codexInstallCommand() {
  return `npm ${CODEX_INSTALL_ARGS.join(" ")}`;
}

const pathOf = (env) => env.PATH ?? env.Path ?? env.path ?? "";

/**
 * What to hand spawn to run `npm <args>`, or null when this machine has no npm
 * the deck can find. POSIX: the npm-cli.js that came with the Node running the
 * deck, run by that Node, then `npm` on PATH. Windows: npm.cmd by its full
 * path, beside node.exe or on PATH, through cmd.exe; never a bare name, whose
 * shim would look for npm in the deck's working folder (exec-spec.mjs shimPath).
 */
export function npmArgv(args, {
  platform = process.platform, env = process.env, execPath = process.execPath, exists = existsSync,
} = {}) {
  const pathEnv = pathOf(env);
  if (platform === "win32") {
    const shim = shimPath("npm.cmd", { execPath, exists, pathEnv });
    return shim ? spawnSpec(shim, [...args], "win32") : null;
  }
  const beside = npmCliLaunch([...args], { platform, execPath, exists });
  if (beside) return beside;
  const npm = pathLookup("npm", platform, { pathEnv, exists });
  return npm ? { file: npm, args: [...args], opts: {} } : null;
}

/** The prefix `npm prefix -g` printed: its last line, when that is one
 *  absolute path. Null for anything else. */
export function prefixOf(stdout, platform = process.platform) {
  const last = String(stdout ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1);
  if (!last || /[\x00-\x1f\x7f]/.test(last)) return null;
  const absolute = platform === "win32" ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(last) : last.startsWith("/");
  return absolute ? last : null;
}

/** The folder npm puts a global install's command in, and Codex's there:
 *  <prefix>/bin/codex on macOS and Linux, <prefix>\codex.cmd on Windows. */
export function codexInPrefix(prefix, platform = process.platform) {
  if (platform === "win32") return { folder: prefix, bin: winPath.join(prefix, "codex.cmd") };
  const folder = posixPath.join(prefix, "bin");
  return { folder, bin: posixPath.join(folder, "codex") };
}

/**
 * `folder` at the end of `env`'s PATH, unless it is there already: after the
 * deck's own folders, never before, so every program the deck finds today is
 * still the one it runs (login-shell-path.mjs mergePath, whose rule this is).
 * True when it was added.
 */
export function addToDeckPath(env, folder, platform = process.platform) {
  if (platform !== "win32") {
    const { path, added } = mergePath(env.PATH ?? "", folder);
    if (added > 0) env.PATH = path;
    return added > 0;
  }
  // Windows spells it Path, and compares folders without case or a last `\`.
  const key = Object.keys(env).find(k => k.toUpperCase() === "PATH") ?? "Path";
  const own = String(env[key] ?? "");
  const same = (dir) => dir.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "").toLowerCase();
  if (!folder || /[\r\n\0;]/.test(folder) || own.split(";").some(dir => same(dir) === same(folder))) return false;
  env[key] = own ? `${own.replace(/;+$/, "")};${folder}` : folder;
  return true;
}

/**
 * What `npm prefix -g` printed (prefixOf), or null when it could not start,
 * exited non-zero, or outlived its deadline (it is then stopped). Only its
 * standard output is read, and only the first few KB of it.
 */
export function readNpmPrefix({ spawnImpl, argv, cwd, env, platform, timeoutMs = PREFIX_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawnImpl(argv.file, argv.args, {
        ...(argv.opts ?? {}),
        cwd, env, shell: false, windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        detached: platform !== "win32",
      });
    } catch {
      resolve(null);
      return;
    }
    watchChild(child, { processGroup: platform !== "win32" });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { killTree(child, "SIGKILL"); finish(null); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => { if (out.length < PREFIX_MAX) out += chunk.toString("utf8"); });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 && out.length <= PREFIX_MAX ? prefixOf(out, platform) : null));
  });
}

/**
 * The deck's one Codex installer. Every dependency is a parameter so the suite
 * runs the whole job with a fake npm, never the network and never a real
 * install.
 */
export function createCodexInstaller({
  platform = process.platform,
  env = process.env,
  home = () => homedir(),
  execPath = process.execPath,
  spawnImpl = nodeSpawn,
  exists = existsSync,
  adopt = () => adoptLoginShellPath({ env, platform }),
  found = () => codexBin({ env, platform, home: home(), exists }) !== null,
  renewEngine = renewTerminalEngine,
  installTimeoutMs = INSTALL_TIMEOUT_MS,
  prefixTimeoutMs = PREFIX_TIMEOUT_MS,
} = {}) {
  const where = { platform, env, execPath, exists };
  const present = (file) => { try { return exists(file); } catch { return false; } };

  const run = async () => {
    // The login shell is asked only when the deck finds no npm by itself.
    const install = await resolveWithLoginShell({
      resolve: () => npmArgv(CODEX_INSTALL_ARGS, where), runnable: Boolean, adopt,
    });
    if (!install) throw new InstallFailure("npm-missing");
    // Run from the home folder, as the same command typed in a new terminal
    // would be, and never from the folder the deck was started in, whose own
    // .npmrc could point npm somewhere else.
    const cwd = home();
    const out = await runInstaller({ spawnImpl, platform, env, cwd, timeoutMs: installTimeoutMs, argv: install });
    const detail = outputTail(out.tail, { home: home(), platform });
    if (!out.started) throw new InstallFailure("start-failed");
    if (out.timedOut) throw new InstallFailure("timed-out", detail);
    if (out.code !== 0) throw new InstallFailure("exit-failed", detail);
    if (found()) return;
    // Installed, but where the deck does not look: npm's global bin folder is
    // not on its PATH. Asked of the same npm, and added if Codex is there.
    const asked = npmArgv(NPM_PREFIX_ARGS, where);
    const prefix = asked ? await readNpmPrefix({ spawnImpl, argv: asked, cwd, env, platform, timeoutMs: prefixTimeoutMs }) : null;
    const at = prefix ? codexInPrefix(prefix, platform) : null;
    if (at && present(at.bin) && addToDeckPath(env, at.folder, platform)) {
      // The terminal engine, which starts the panes when it is on, has its own
      // copy of the PATH from when it started: it is started again with this
      // one before the card says done, or the launch it asks for again would
      // still be told Codex is missing.
      try { await renewEngine(); } catch { /* the deck's own lookup still finds it */ }
    }
    if (!found()) throw new InstallFailure("installed-but-not-found");
  };

  return installJob({
    run,
    blocked: () => claudeInstallBlocked(env),
    describe: () => ({ command: codexInstallCommand(), shell: "terminal" }),
  });
}

/** The deck's terminal engine let go, so the next pane it starts sees the
 *  deck's PATH as it is now (command-panel-engine.mjs renew). The module is
 *  the one the deck already loads at boot; renew starts no engine by itself. */
async function renewTerminalEngine() {
  await commandPanel.renew();
}

let shared = null;
/** The deck's Codex installer, made on first use. */
export function codexInstaller() {
  shared ??= createCodexInstaller();
  return shared;
}

/** GET: where the install stands. */
export async function handleCodexInstallStatus(_req, res, { installer = codexInstaller() } = {}) {
  return send(res, 200, { ok: true, ...installer.status() });
}

/** POST: start one. 409 names why not: one runs already, or downloads are off. */
export async function handleCodexInstallStart(req, res, { installer = codexInstaller() } = {}) {
  try { await readBody(req, res, BODY_LIMIT); } catch { return; /* answered 413 already */ }
  const out = installer.start();
  return send(res, out.ok ? 200 : 409, out);
}
