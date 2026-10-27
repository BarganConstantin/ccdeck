// The ccdeck a terminal on this machine starts, and whether it is older than
// the deck answering.
//
// The desktop app, an npx run and a global npm install each update on their
// own, so the command a terminal starts can be left behind by the deck it
// talks to. A 3.42 `ccdeck` beside a 3.49 deck read `ccdeck tui` as an unknown
// option and opened the browser: it has no `tui`, sends the deck nothing, and
// cannot be taught one after the fact. The deck can say so instead, on every
// platform (#2294 said it on Windows only, from the desktop shell).
//
// READ, NEVER RUN. The first `ccdeck` on PATH is followed to the package that
// owns it and that manifest is read; nothing is spawned. Anything that cannot
// be identified as an installed ccdeck — an .exe ahead of the npm shim on
// Windows, a wrapper script, a version manager's shim — answers null, and the
// app says nothing rather than guess.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { upgradeCommand } from "./install-layout.mjs";
import { isOlder } from "./self-update.mjs";

// The names ccdeck has been published under; every one of them ships the
// `ccdeck` command.
const NAMES = new Set(["ccdeck", "agents-deck", "agent-dag"]);
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

function manifest(file, read) {
  try { return JSON.parse(read(file, "utf8")); } catch { return undefined; }
}

const ours = (pkg) => NAMES.has(pkg?.name) && typeof pkg.version === "string" && VERSION.test(pkg.version);

/** The npm shim PowerShell finds first, read through the package npm put beside it. */
function windowsCli({ env, exists, read }) {
  // Windows environment names are case-insensitive, but injected maps are not.
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path");
  const folders = typeof env[pathKey] === "string" ? env[pathKey].split(";") : [];
  for (const segment of folders) {
    const folder = segment.trim().replace(/^"(.*)"$/, "$1");
    if (!folder) continue;
    // A different executable earlier on PATH cannot safely be identified as
    // the npm CLI. Stop here rather than report a later, shadowed npm install.
    if (exists(win32.join(folder, "ccdeck.exe"))) return null;
    if (!exists(win32.join(folder, "ccdeck.ps1")) && !exists(win32.join(folder, "ccdeck.cmd"))) continue;
    const root = win32.join(folder, "node_modules", "ccdeck");
    const pkg = manifest(win32.join(root, "package.json"), read);
    return ours(pkg) ? { root, version: pkg.version } : null;
  }
  return null;
}

/** The first `ccdeck` on PATH, followed through npm's symlink to its package. */
function unixCli({ env, exists, read, realpath }) {
  const folders = typeof env.PATH === "string" ? env.PATH.split(":") : [];
  for (const folder of folders) {
    if (!folder) continue;
    const bin = posix.join(folder, "ccdeck");
    if (!exists(bin)) continue;
    // Only the first one counts: it is the one a terminal runs, and an npm
    // install behind it is a version nobody types.
    let file;
    try { file = realpath(bin); } catch { return null; }
    // <prefix>/lib/node_modules/ccdeck/bin/agent-dag.js: the manifest is a
    // level or two above the file. The first one met is the owner, ours or not.
    let dir = posix.dirname(file);
    for (let up = 0; up < 3; up++) {
      const pkg = manifest(posix.join(dir, "package.json"), read);
      if (pkg !== undefined) return ours(pkg) ? { root: dir, version: pkg.version } : null;
      dir = posix.dirname(dir);
    }
    return null;
  }
  return null;
}

/** The package root and version of the ccdeck a terminal starts, or null when
 *  there is none or it cannot be identified. */
export function terminalCli({
  env = process.env, platform = process.platform, exists = existsSync, read = readFileSync, realpath = realpathSync,
} = {}) {
  return platform === "win32" ? windowsCli({ env, exists, read }) : unixCli({ env, exists, read, realpath });
}

/**
 * What /api/version says about the terminal's ccdeck: its version and the line
 * that updates it, for that install's shape (upgradeCommand). Null unless it
 * is older than `running` — the deck's own copy, an up-to-date one and a newer
 * one need nothing said.
 */
export function terminalCliNotice({ running, ...opts } = {}) {
  const cli = terminalCli(opts);
  if (!cli || !isOlder(cli.version, running)) return null;
  return { version: cli.version, command: upgradeCommand(cli.root) };
}
