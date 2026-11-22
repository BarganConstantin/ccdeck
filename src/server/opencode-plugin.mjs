// ccdeck's plugin in opencode's global plugins folder, put there at deck start
// and taken out by `--uninstall`, or by a start with its off switch set.
//
// opencode — both lines, OpenCode 1 (`opencode-ai`) and OpenCode 2
// (`@opencode/cli`), whichever account or model it runs on — loads every
// `*.js` in `<XDG_CONFIG_HOME or ~/.config>/opencode/plugins/`; Windows too,
// under %USERPROFILE%\.config. Ours is `ccdeck.js`, built from
// opencode-plugin-body.mjs, and it forwards each session event to the deck by
// running the hook.js the Claude hooks use (installer.mjs), with
// `--provider opencode`.
//
// A FILE IN SOMEBODY ELSE'S FOLDER, so the rules are the Claude hooks' rules
// for settings.json, narrowed to one file: written only on a machine that has
// opencode, through a temp file and a rename, and only when its bytes changed;
// never over a `ccdeck.js` that is not ours — someone's own forwarder may have
// that name, and that is reported, not overwritten — and removed only when it
// carries our marker.
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hookRuntime } from "./app-host.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";
import { pathLookup, spawnSpec } from "./exec-spec.mjs";
import { CLAUDE_DIR, installHookScript } from "./installer.mjs";
import { ccdeckOpencodePlugin } from "./opencode-plugin-body.mjs";

export const OPENCODE_PLUGIN_FILE = "ccdeck.js";

/** Off switch of its own, read at deck start; a start with it set takes the
 *  plugin out. */
export const NO_OPENCODE_ENV = "AGENTS_DECK_NO_OPENCODE";

/**
 * The first line of every file this writes, and how one is recognised as ours.
 * The format number is for a later deck that needs to tell an older file apart;
 * ownership is the prefix, whatever number follows it.
 */
export const PLUGIN_MARKER = "// ccdeck-managed opencode plugin";
export const PLUGIN_FORMAT = 1;

/** opencode's global config directory: what xdg-basedir answers, which is
 *  what opencode asks — XDG_CONFIG_HOME when set, else ~/.config, on every
 *  platform — and `opencode` under it. */
export function opencodeConfigDir({ env = process.env, home = homedir() } = {}) {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

export function opencodePluginPath(options = {}) {
  return join(opencodeConfigDir(options), "plugins", OPENCODE_PLUGIN_FILE);
}

/** Whether opencode is on this machine: its config directory, which its first
 *  run creates, or an `opencode` on PATH. No child process — this runs at boot. */
export function hasOpencode({ env = process.env, home = homedir(), platform = process.platform, exists = existsSync } = {}) {
  try {
    if (exists(opencodeConfigDir({ env, home }))) return true;
  } catch { /* unreadable is not there */ }
  return pathLookup("opencode", platform, { pathEnv: env.PATH ?? env.Path ?? "", exists }) !== null;
}

export const isOurPlugin = (text) => typeof text === "string" && text.startsWith(PLUGIN_MARKER);

// Written as char codes: the characters themselves are line terminators to
// any editor or parser that would read this file.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/**
 * The plugin file's text for one forwarder.
 *
 * `config` is `{ file, args, verbatim, claudeDir }`: what the plugin spawns, as
 * an argv — the node and hook.js, or cmd.exe's line for a `.cmd` launcher (the
 * desktop app's on Windows), built by spawnSpec — and the Claude config dir the
 * deck registered in. It goes into the file as JSON, at the one marked line,
 * and nowhere else: a path is never spliced into code. JSON is JavaScript
 * except for U+2028 and U+2029 before ES2019, so those two are escaped too.
 */
export function opencodePluginText(config) {
  const json = JSON.stringify(config).replaceAll(LS, "\\u2028").replaceAll(PS, "\\u2029");
  return [
    `${PLUGIN_MARKER}, format ${PLUGIN_FORMAT}.`,
    "// Written by ccdeck at each start: edits are overwritten, and `ccdeck --uninstall` removes",
    "// the file. It forwards opencode's session events to the ccdeck dashboard and changes",
    "// nothing in opencode.",
    'import { spawn } from "node:child_process";',
    "",
    "// ccdeck:config",
    `const CONFIG = ${json};`,
    "",
    ccdeckOpencodePlugin.toString(),
    "",
    "export default ccdeckOpencodePlugin({ spawn, config: CONFIG, env: process.env });",
    "",
  ].join("\n");
}

/** What the plugin runs: the installed hook.js — copied or refreshed here,
 *  because a machine without Claude Code gets no Claude hooks job to do it —
 *  run by the deck's hook runtime, exactly as the Claude hook command runs it. */
async function installedForwarder() {
  const hookPath = await installHookScript(join(CLAUDE_DIR, "agent-dag"));
  return { hookPath, runtime: hookRuntime(), claudeDir: CLAUDE_DIR };
}

/**
 * Put the plugin in place, or say why not. Never throws: the answer is one of
 *  - `{ state: "off", removed }`     AGENTS_DECK_NO_OPENCODE=1: an earlier start's
 *                                    plugin is taken out (ours by its marker; a
 *                                    foreign ccdeck.js stays), so opencode's
 *                                    sessions do leave the board
 *  - `{ state: "absent" }`           no opencode on this machine
 *  - `{ state: "conflict", path }`   a ccdeck.js that is not ours is there; left alone
 *  - `{ state: "unchanged", path }`  already in place, byte for byte
 *  - `{ state: "installed", path }`  written
 *  - `{ state: "failed", path, why }`
 *
 * The off switch removes, as Copilot's does (copilot-hooks.mjs): a plugin left
 * behind would go on feeding the board the switch was meant to keep it off.
 * AGENTS_DECK_NO_INSTALL=1 does not stop it, as it does not stop the Claude
 * hooks: the plugin is how the sessions reach the board, not a managed tool and
 * not network traffic. The options are the suite's.
 */
export async function installOpencodePlugin({
  env = process.env,
  home = homedir(),
  platform = process.platform,
  exists = existsSync,
  forwarder = installedForwarder,
} = {}) {
  if (env[NO_OPENCODE_ENV] === "1") {
    const gone = await uninstallOpencodePlugin({ env, home });
    return { state: "off", removed: gone.state === "removed" };
  }
  if (!hasOpencode({ env, home, platform, exists })) return { state: "absent" };
  const path = opencodePluginPath({ env, home });
  try {
    const current = await readFile(path, "utf8").catch((err) => {
      if (err?.code === "ENOENT") return null;
      throw err;
    });
    if (current !== null && !isOurPlugin(current)) return { state: "conflict", path };
    const { hookPath, runtime, claudeDir } = await forwarder();
    const spec = spawnSpec(runtime, [hookPath, "--provider", "opencode"], platform);
    const text = opencodePluginText({
      file: spec.file,
      args: spec.args,
      verbatim: spec.opts?.windowsVerbatimArguments === true,
      claudeDir,
    });
    if (current === text) return { state: "unchanged", path };
    // opencode's folders are its user's alone; one made here is too, as Copilot's.
    await mkdir(join(opencodeConfigDir({ env, home }), "plugins"), { recursive: true, mode: 0o700 });
    await writeFileAtomic(path, text);
    return { state: "installed", path };
  } catch (err) {
    return { state: "failed", path, why: err?.code ?? String(err?.message ?? err) };
  }
}

/**
 * Take the plugin out: `{ state: "removed" | "absent" | "foreign" | "failed", path }`.
 * "foreign" is a ccdeck.js without our marker, which stays. Off switches do not
 * apply — an uninstall always takes back what is ours. Never throws.
 */
export async function uninstallOpencodePlugin({ env = process.env, home = homedir() } = {}) {
  const path = opencodePluginPath({ env, home });
  try {
    let current;
    try {
      current = await readFile(path, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return { state: "absent", path };
      throw err;
    }
    if (!isOurPlugin(current)) return { state: "foreign", path };
    await unlink(path);
    return { state: "removed", path };
  } catch (err) {
    if (err?.code === "ENOENT") return { state: "absent", path };
    return { state: "failed", path, why: err?.code ?? String(err?.message ?? err) };
  }
}
