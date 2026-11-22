// GitHub Copilot CLI sessions on the board, through Copilot CLI's own hooks.
//
// Copilot CLI runs every `*.json` in its user hooks directory —
// `$COPILOT_HOME/hooks/`, else `~/.copilot/hooks/` (`%USERPROFILE%\.copilot\hooks\`
// on Windows) — beside the repository's hooks, and runs all of them
// (docs.github.com, "GitHub Copilot hooks reference", Hooks locations). So the
// deck owns ONE file there, ccdeck.json, and touches nothing else in that
// directory. Each entry runs the deck's installed forwarder, the hook.js the
// Claude Code hooks use, with `--provider copilot`; hook.js turns what Copilot
// sends into the deck's event shape (see fromCopilot there).
//
// The entries use Copilot's PascalCase event names, which switch its payload to
// the snake_case, Claude-compatible fields the deck already reads
// (hook_event_name, session_id, tool_name, tool_input, tool_use_id,
// transcript_path) — measured on Copilot CLI 1.0.114.
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { posix as posixPath, win32 as winPath } from "node:path";
import { hookRuntime } from "./app-host.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";
import { pathLookup } from "./exec-spec.mjs";
import { AGENT_DAG_DIR, installHookScript } from "./installer.mjs";

/** The file in Copilot's hooks directory that is ours, and only this one. The
 *  name is the mark: Copilot's schema has no field for an owner, and a key it
 *  does not know could get an entry dropped as malformed. */
export const COPILOT_HOOKS_FILE = "ccdeck.json";

/**
 * Copilot's event name for each event the deck takes, and the deck's name for
 * it. They are the same names: PascalCase is what selects the Claude-compatible
 * payload. Left out on purpose:
 *
 *  - PermissionRequest fires before Copilot's own rules decide, auto-approved
 *    calls included (seen with --allow-all-tools), so it is not a wait. The
 *    wait is the `permission_prompt` Notification.
 *  - ErrorOccurred fires for every retry of a failed model call, and the last
 *    one, after which the turn is over, carries `recoverable: true` like the
 *    rest (1.0.114). Nothing in it says the turn ended.
 */
export const COPILOT_EVENTS = Object.freeze([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionEnd",
  "Notification",
]);

/**
 * What runs hook.js on POSIX: /bin/sh with this fixed script and every path as a
 * positional argument, so no path is ever read as shell code.
 *
 * Not the plain `[node, hook.js]` exec it could be, because Copilot DENIES THE
 * TOOL CALL when a PreToolUse command hook fails to start (docs: preToolUse is
 * fail-closed; measured on 1.0.114 with an exec that does not exist: "Denied by
 * preToolUse hook … (hook errored)"). A node removed by `nvm uninstall`, or a
 * hook.js removed with the Claude config dir, would then stop every Copilot
 * tool call on the machine. The script ends quietly in both cases instead, and
 * otherwise uses the recorded node or the one on PATH — installer.mjs's
 * NODE_FALLBACK, plus the check on hook.js.
 */
const POSIX_LAUNCH = 'n=$1; shift; [ -f "$1" ] || exit 0; [ -x "$n" ] || n=$(command -v node) || exit 0; exec "$n" "$@"';

/**
 * Seconds Copilot waits before it kills the hook. hook.js ends itself within
 * CAP_MS (1.9s) of starting, the same budget the Claude entry's `timeout: 3` is
 * set against; a timeout is fail-open in Copilot, so this only bounds a wait.
 */
const TIMEOUT_SEC = 3;

const pathFor = (platform) => (platform === "win32" ? winPath : posixPath);

/** Copilot's config directory: $COPILOT_HOME when set, else ~/.copilot. */
export function copilotHome({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const { join, resolve } = pathFor(platform);
  const override = typeof env.COPILOT_HOME === "string" ? env.COPILOT_HOME.trim() : "";
  return override ? resolve(override) : join(home, ".copilot");
}

/** Where the deck's hooks file goes. */
export function copilotHooksPath(opts = {}) {
  const { join } = pathFor(opts.platform ?? process.platform);
  return join(copilotHome(opts), "hooks", COPILOT_HOOKS_FILE);
}

/**
 * Whether Copilot CLI is on this machine: its config directory exists, or a
 * `copilot` answers on PATH (a fresh install that has never run). Either is
 * enough; a false yes costs one small file nobody reads.
 */
export function hasCopilotInstalled({
  env = process.env, home = homedir(), platform = process.platform, exists = existsSync,
} = {}) {
  if (exists(copilotHome({ env, home, platform }))) return true;
  const pathEnv = env.PATH ?? env.Path ?? env.path ?? "";
  return pathLookup("copilot", platform, { pathEnv, exists }) !== null;
}

/**
 * The program Copilot is to start for hook.js on Windows, or null when there is
 * none it can start.
 *
 * Copilot starts `exec` without a shell, and Node, which Copilot runs on,
 * refuses to spawn a .cmd or .bat without one. preToolUse is fail-closed, so an
 * exec that does not start DENIES every Copilot tool call. The desktop app's
 * hook runtime is exactly such a file, its ccdeck-node.cmd launcher
 * (desktop/deck-host.mjs). A launcher, or a runtime that is not there, gives way
 * to the absolute node.exe on PATH, asked for by that name so a node.cmd on
 * PATH is never the answer either; with none there, no file at all.
 */
export function windowsHookExec(runtime, { env = process.env, exists = existsSync } = {}) {
  const there = (p) => { try { return exists(p); } catch { return false; } };
  if (typeof runtime === "string" && runtime && !/\.(cmd|bat)$/i.test(runtime) && there(runtime)) return runtime;
  const pathEnv = env.PATH ?? env.Path ?? env.path ?? "";
  return pathLookup("node.exe", "win32", { pathEnv, exists });
}

/** One entry: hook.js for `event`, as an argv Copilot starts without a shell. */
export function copilotHookEntry(node, hookPath, event, platform = process.platform) {
  const args = [hookPath, "--provider", "copilot", "--event", event];
  // Windows has no /bin/sh, and Copilot starts `exec` directly there too.
  return platform === "win32"
    ? { type: "command", exec: node, args, timeoutSec: TIMEOUT_SEC }
    : { type: "command", exec: "/bin/sh", args: ["-c", POSIX_LAUNCH, "ccdeck-hook", node, ...args], timeoutSec: TIMEOUT_SEC };
}

/** The whole file, as the text written to disk. Paths only ever reach it
 *  through JSON.stringify. */
export function copilotHooksText(node, hookPath, platform = process.platform) {
  const hooks = {};
  for (const event of COPILOT_EVENTS) hooks[event] = [copilotHookEntry(node, hookPath, event, platform)];
  return JSON.stringify({ version: 1, hooks }, null, 2) + "\n";
}

/**
 * Whether `text` is a hooks file this deck wrote: version 1, and every entry
 * runs a hook.js with `--provider copilot`. A file of the user's own that
 * happens to share the name is not, and is never overwritten or removed.
 */
export function isOurHooksFile(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return false; }
  const hooks = parsed?.hooks;
  if (parsed?.version !== 1 || !hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const entries = Object.values(hooks).flatMap(v => (Array.isArray(v) ? v : [null]));
  return entries.length > 0 && entries.every(e => {
    const args = Array.isArray(e?.args) ? e.args : [];
    const at = args.indexOf("--provider");
    return at > 0 && args[at + 1] === "copilot" && /[\\/]hook\.js$/.test(String(args[at - 1]));
  });
}

/** The deck's installed hook.js, put in place the way the Claude hooks put it. */
function installForwarder() {
  return installHookScript(AGENT_DAG_DIR);
}

/**
 * Write the deck's hooks file for Copilot CLI, when Copilot is here and nobody
 * turned it off. Never rejects: the answer says what happened.
 *
 *   { state: "off", removed }  AGENTS_DECK_NO_COPILOT=1: an earlier boot's file
 *                              is taken out, so the sessions do leave the board
 *   { state: "absent" }        no Copilot CLI on this machine
 *   { state: "no-node", removed }  Windows only: no node Copilot can start
 *                              (windowsHookExec); an earlier boot's file is taken
 *                              out rather than left to deny every tool call
 *   { state: "foreign", path } a ccdeck.json the deck did not write is in the way
 *   { state: "installed" | "unchanged", path }
 *   { state: "failed", path, reason }
 *
 * AGENTS_DECK_NO_INSTALL=1 does not stop it, as it does not stop the Claude
 * hooks: this file is how the sessions reach the board, not a managed tool and
 * not network traffic. AGENTS_DECK_NO_COPILOT is its off switch.
 *
 * Every boot rewrites it with this boot's node and hook path, and writes only
 * when the bytes differ, through a temp file and a rename, so Copilot never
 * reads half a file. `path` is the suite's, so a Windows install can be checked
 * on a machine whose filesystem is not Windows.
 */
export async function installCopilotHooks({
  env = process.env, home = homedir(), platform = process.platform, exists = existsSync,
  runtime = () => hookRuntime(env), installHook = installForwarder,
  path = copilotHooksPath({ env, home, platform }),
} = {}) {
  if (env.AGENTS_DECK_NO_COPILOT === "1") {
    const gone = await uninstallCopilotHooks({ env, home, platform, path });
    return { state: "off", removed: gone.removed === true };
  }
  if (!hasCopilotInstalled({ env, home, platform, exists })) return { state: "absent" };
  try {
    const node = platform === "win32" ? windowsHookExec(runtime(), { env, exists }) : runtime();
    if (node === null) {
      const gone = await uninstallCopilotHooks({ env, home, platform, path });
      return { state: "no-node", removed: gone.removed === true };
    }
    const current = await readFile(path, "utf8").catch(err => (err?.code === "ENOENT" ? null : Promise.reject(err)));
    if (current !== null && !isOurHooksFile(current)) return { state: "foreign", path };
    const hookPath = await installHook();
    const next = copilotHooksText(node, hookPath, platform);
    if (current === next) return { state: "unchanged", path };
    // Copilot's own directories are its user's alone; one made here is too.
    await mkdir(pathFor(platform).dirname(path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(path, next);
    return { state: "installed", path };
  } catch (err) {
    return { state: "failed", path, reason: String(err?.message ?? err).split("\n")[0] };
  }
}

/**
 * Take the deck's hooks file back out: `{ ok: true, removed }`, or
 * `{ ok: false, path, reason }` when it could not be read or removed. A
 * ccdeck.json the deck did not write is the user's and is left alone
 * (`foreign: true`): nothing of the deck's is in it.
 */
export async function uninstallCopilotHooks({
  env = process.env, home = homedir(), platform = process.platform,
  path = copilotHooksPath({ env, home, platform }),
} = {}) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, removed: false, path };
    return { ok: false, removed: false, path, reason: String(err?.message ?? err).split("\n")[0] };
  }
  if (!isOurHooksFile(text)) return { ok: true, removed: false, foreign: true, path };
  try {
    await unlink(path);
  } catch (err) {
    if (err?.code !== "ENOENT") return { ok: false, removed: false, path, reason: String(err?.message ?? err).split("\n")[0] };
  }
  return { ok: true, removed: true, path };
}
