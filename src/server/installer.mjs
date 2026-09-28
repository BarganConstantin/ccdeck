// Idempotent hook installer. One provider installs, two uninstall:
//  - "claude"  → $CLAUDE_CONFIG_DIR/settings.json (Claude Code, ~/.claude by default)
//  - "codex"   → $CODEX_HOME/hooks.json           (uninstall only — see PROVIDERS)
// Hooks post to the discovery dir at <claude config dir>/agent-dag/, and Codex
// sessions reach the same server through the rollout watcher instead, so one
// running server still sees both CLIs. Re-runs are safe; entries are tagged
// with __agent-dag and de-duped.
import { hookRuntime } from "./app-host.mjs";
import { readFile, mkdir, unlink, chmod, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeConfigDir } from "./claude-dir.mjs";
import { CODEX_HOME } from "./codex-dir.mjs";
import { canonicalLogPath } from "./log-writer.mjs";
import { shellQuoteArg } from "./exec.mjs";
// The read-before-rewrite and the atomic replace every settings writer goes
// through — see atomic-write.mjs.
import { readSettingsForWrite, stripBom, writeFileAtomic } from "./atomic-write.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..", "..");

// Honours CLAUDE_CONFIG_DIR, exactly as CODEX_DIR honours CODEX_HOME below.
// Without it the hooks land in a settings.json Claude Code never opens.
const CLAUDE_DIR = claudeConfigDir();
// Both directories now come from the module that owns the rule rather than from
// a copy of it here — claude-dir.mjs and codex-dir.mjs. The local name stays
// because CODEX_DIR is what the rest of this file and its tests call it, and it
// says what the value is FOR here: the directory hooks.json is taken out of.
const CODEX_DIR = CODEX_HOME;

// Single shared discovery dir — both providers' hook scripts post here so one
// running agent-dag server can match either ecosystem's events. It follows the
// Claude config dir, so hook/hook.js has to resolve that dir the same way: it
// reads what this writes, and a disagreement means the hooks find no server.
const AGENT_DAG_DIR = join(CLAUDE_DIR, "agent-dag");

const CLAUDE_EVENTS = [
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
];

const PROVIDERS = {
  claude: {
    settingsPath: join(CLAUDE_DIR, "settings.json"),
    hookInstallDir: join(CLAUDE_DIR, "agent-dag"),
    events: CLAUDE_EVENTS,
    ensureDir: CLAUDE_DIR,
  },
  // Uninstall-only. Codex hooks do not fire reliably on Windows, so the deck
  // stopped installing them and reads Codex's rollout files instead — nothing
  // calls installHooks with this provider any more. The entry stays because a
  // machine that ran an older deck still has our forwarders in hooks.json, and
  // uninstallHooks needs the path to take them back out. It reads nothing else:
  // it walks the events already in the file rather than a list of our own.
  codex: {
    settingsPath: join(CODEX_DIR, "hooks.json"),
  },
};

const MARK_KEY = "__agent-dag";
// Legacy marks from earlier names — purged on every install/uninstall so
// duplicate forwarders don't pile up when the project gets renamed.
const LEGACY_MARKS = ["__ccgraph", "__agent-flow"];
const LEGACY_DIRS = ["ccgraph", "agent-flow", "agent-dag"];

/**
 * The `command` string Claude Code stores for our forwarder, and runs THROUGH A
 * SHELL on every tool call.
 *
 * The settings.json hook format is a string, not an argv, so this is one of the
 * two places in the codebase that has to build a shell command line by hand —
 * see shellQuoteArg, which is where the escaping rules and their one Windows
 * residual are written down.
 *
 * It used to wrap both paths in double quotes, which on POSIX escapes nothing:
 * `$(…)`, a backtick and `\` are all still live inside them. Both paths come
 * from outside — `installedHookPath` is built from $CLAUDE_CONFIG_DIR (resolved,
 * never validated) or homedir(), and `node` is process.execPath — so a config
 * dir called `/tmp/a$(id)b` was shell code, written into the user's own settings
 * file and executed on every hook fire for as long as it stayed there. The
 * quieter half of the same bug cost nothing but the feature: an ordinary `$` in
 * a path expanded to nothing, the hook pointed at a file that was not there, and
 * hooks stopped firing with no error to explain it.
 *
 * `provider` is a key of PROVIDERS — "claude" or "codex", never anything a
 * caller chose — and is quoted anyway, because that is not a property worth
 * re-deriving at every reading.
 *
 * Exported, with the node path AND the platform injectable, so the escaping can
 * be checked against a path the test names rather than against whatever ran the
 * suite — and against the rule of a platform that suite is not running on. The
 * two rules are genuinely different (POSIX single quotes, cmd.exe doubled
 * double quotes), so without the second parameter the only assertion a test can
 * make is the one its own OS happens to produce, which is how this went five
 * releases with the Windows half of it never once executed.
 */
export function hookCommand(installedHookPath, provider, node = process.execPath,
                            platform = process.platform) {
  const q = (s) => shellQuoteArg(s, platform);
  return `${q(node)} ${q(installedHookPath)} --provider ${q(provider)}`;
}

function isOurEntry(g) {
  if (!g || typeof g !== "object") return false;
  if (g[MARK_KEY] === true) return true;
  for (const k of LEGACY_MARKS) if (g[k] === true) return true;
  const cmds = Array.isArray(g.hooks) ? g.hooks : [];
  for (const h of cmds) {
    const c = typeof h?.command === "string" ? h.command : "";
    for (const dir of LEGACY_DIRS) {
      if (c.includes(`.claude/${dir}/hook.js`) || c.includes(`.claude\\${dir}\\hook.js`)) return true;
      if (c.includes(`.codex/${dir}/hook.js`) || c.includes(`.codex\\${dir}\\hook.js`)) return true;
    }
  }
  return false;
}

async function ensureDir(p) {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

/**
 * Install one of the packaged hook scripts without ever exposing a partial one.
 *
 * copyFile truncates the destination and then fills it, and the destination here
 * is a script every live Claude Code session runs on each tool call. Starting the
 * deck while sessions are open — the normal way this is used — puts a hook
 * invocation inside that window sooner or later, and what it executes is an
 * empty or half-written program: a dropped event at best, a SyntaxError in the
 * user's session at worst. Renaming a finished copy over the name closes it, so
 * a session opens either the old script or the new one and both are whole.
 *
 * Re-installs are the common case and almost always produce the same bytes, so
 * identical content skips the write and the file is not replaced at all.
 */
async function installScript(src, dst) {
  return installText(await readFile(src, "utf8"), dst);
}

async function installText(text, dst) {
  const current = await readFile(dst, "utf8").catch(() => null);
  if (current === text) return false;
  await writeFileAtomic(dst, text);
  return true;
}

/**
 * What makes the installed hook.js a CommonJS file wherever the config dir is.
 *
 * Node decides whether a `.js` file is CommonJS or an ES module from the nearest
 * package.json above it, and hook.js is CommonJS. With none in agent-dag/, that
 * nearest one is whatever the user has further up: a `"type": "module"` in
 * ~/package.json, or in the repo a relocated CLAUDE_CONFIG_DIR lives in, loads
 * the hook as an ES module, and it dies on its first `require` before main()
 * has installed a single handler. Exit 1 and `require is not defined in ES
 * module scope` on every tool call, and no deck receives anything (#1172). One
 * file here answers the question before Node looks any further.
 *
 * Written before the hook, so a first install never has a hook.js without it,
 * and through the same atomic write, because a half-written package.json is a
 * load error of its own for every hook that starts while it is being written.
 */
const HOOK_PACKAGE_JSON = '{ "type": "commonjs" }\n';

async function installHookScript(installDir) {
  await ensureDir(installDir);
  await installText(HOOK_PACKAGE_JSON, join(installDir, "package.json"));
  const src = join(PKG_ROOT, "hook", "hook.js");
  const dst = join(installDir, "hook.js");
  await installScript(src, dst);
  return dst;
}

/**
 * The entry Claude Code and Codex run, and the one number in it that is a
 * promise about time.
 *
 * `timeout` is in SECONDS and it is a kill: when it expires the host CLI takes
 * the hook down where it stands, which on a PreToolUse means the deck is handed
 * a truncated body and the user waits the whole of it before the tool call
 * proceeds. So the declared value has to be strictly larger than the worst the
 * hook can spend on itself, and it was not. hook.js caps itself at CAP_MS =
 * 1900ms, that cap now runs from Node's start rather than from main()'s, and
 * what is still outside it is only the `sh -c` fork/exec — but 1900 + a fork
 * under load does not fit in 2000. Measured through the installed command
 * shape with a deck that stops answering mid-run: 1.84s idle, 1.98-2.19s with
 * the box loaded (#1018).
 *
 * 3 is a backstop, not a budget: the hook ends itself first in every case it
 * can see, and this is what covers the ones it cannot — a payload large enough
 * that parsing it starves the timer, or a filesystem thread that cannot be
 * interrupted at all. hook-budget.test.ts pins this number against hook.js's
 * own cap so raising one without the other fails.
 */
function buildHookEntry(command) {
  return {
    [MARK_KEY]: true,
    hooks: [{ type: "command", command, timeout: 3 }],
  };
}

function dedupeOurEntries(group) {
  if (!Array.isArray(group)) return [];
  return group.filter(g => !isOurEntry(g));
}

/** Install hooks for a single provider. Returns {settingsPath, hookPath, events, changed}. */
export async function installHooks({ provider = "claude", beforeWrite = null } = {}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`unknown provider: ${provider}`);
  // An uninstall-only provider has no event list. Saying so beats the
  // TypeError that installing an undefined list would otherwise raise several
  // frames deep, after the hook script had already been written to disk.
  if (!cfg.events) throw new Error(`provider ${provider} is uninstall-only: hooks are not installed for it`);

  // Read before writing anything, so a settings file we cannot parse aborts
  // the install without leaving half of it behind.
  const { settings: current, raw: before } = await readSettingsForWrite(cfg.settingsPath);

  const hookPath = await installHookScript(cfg.hookInstallDir);
  // Through the desktop app's launcher when it started this deck — its own
  // binary opens the app rather than running a script (app-host.mjs).
  const command = hookCommand(hookPath, provider, hookRuntime());
  await ensureDir(cfg.ensureDir);
  // Discovery dir is shared across providers — always make sure it exists.
  await ensureDir(AGENT_DAG_DIR);

  current.hooks = current.hooks ?? {};

  for (const evt of cfg.events) {
    const cleaned = dedupeOurEntries(current.hooks[evt]);
    cleaned.push(buildHookEntry(command));
    current.hooks[evt] = cleaned;
  }

  // Retiring the finish-sound hook rides in here, on this read and this write,
  // and this is the seam it needs rather than a convenient one. #704 moved the
  // sound into the browser and deleted the script the old `Stop` entry ran, so
  // an install that upgrades a machine which HAS that entry leaves a hook
  // pointing at a file that is no longer in the package — an error at the end of
  // every turn, on a machine that was working before the upgrade. It therefore
  // has to happen without the user asking for it, and a normal boot is the only
  // moment that qualifies.
  //
  // Riding along buys the two properties it would otherwise have to invent.
  // There is ONE write of settings.json on the boot that retires, compared
  // against the exact bytes read a few lines up — so a second deck doing the
  // same work at the same time writes the same payload, and every later boot
  // finds nothing to do and changes nothing. And the mutate-then-let-the-caller-
  // write split is what keeps the script deletion after the write: until the new
  // file has landed, a live Claude Code session's next turn still runs the old
  // command.
  //
  // Imported here rather than at the top of the file because retire-sound-hook.mjs
  // imports this module — it takes writeFileAtomic and readSettingsForWrite
  // from here — and a static import would close that into a cycle. Claude only: the entry
  // was one line in Claude Code's settings.json and there was never a Codex one.
  //
  // The equality test is not ceremony. Retirement DELETES two files — the parked
  // hooks and the installed script — at absolute paths it resolved for itself,
  // from claudeConfigDir() and os.homedir(), at its own import. This function
  // writes `cfg.settingsPath`. In the product those are the same settings.json
  // and the paths belong together. When they are not the same file, the two
  // modules are looking at different homes, and acting on that difference means
  // deleting files belonging to a machine this install is not writing to. That
  // is not hypothetical: it happened to the author's own ~/.agents-deck while
  // this very change was being written, from a test whose environment teardown
  // ran a describe too early. Disagreement is a reason to do nothing.
  let retire = { pending: false, changed: false, removed: 0, restored: 0 };
  let completeSoundHookRetirement = null;
  if (provider === "claude") {
    const retirement = await import("./retire-sound-hook.mjs");
    if (retirement.SETTINGS_PATH === cfg.settingsPath) {
      completeSoundHookRetirement = retirement.completeSoundHookRetirement;
      retire = await retirement.retireSoundHookIn(current);
    }
  }

  // Every launch reinstalls, and on all but the first the entries are already
  // there and identical. Writing anyway is pure downside: it is one more chance
  // to be interrupted mid-write, and one more window in which a change Claude
  // Code made to the file between our read and our write gets discarded. So
  // compare against the exact bytes we read and, when they match, do nothing.
  const next = JSON.stringify(current, null, 2) + "\n";
  const changed = next !== before;
  if (changed) {
    // COMPARE AGAINST THE FILE, NOT AGAINST THE SNAPSHOT, at the last moment.
    //
    // Everything above was computed from bytes read at the top of this
    // function, and two decks booting together — the ordinary case on a machine
    // where one was already running — interleave inside that window. The one
    // that loses is unrecoverable rather than merely stale: deck A restores the
    // user's own sound hooks from the parked file and deletes the park, and
    // deck B then writes a settings object computed before that restore, with
    // an empty park behind it. The user's hook is gone from settings.json and
    // from the only other copy of it.
    //
    // So the file is re-read immediately before the write and, if another
    // writer has touched it, this pass declines. Declining is safe by
    // construction: every boot reinstalls, so the next one recomputes against
    // the new bytes and converges — and the entries this function adds are
    // identical on both decks, which is why the loser has nothing of its own to
    // lose.
    // The seam the suite needs, and the only way to test this deterministically:
    // the window between the read at the top and the write below is filled with
    // real fs work, so a test that raced it by wall clock would pass or fail by
    // how fast the machine is. Production passes nothing.
    if (beforeWrite) await beforeWrite();
    // A READ THE GUARD COULD NOT PERFORM IS NOT PROOF NOTHING CHANGED (#788).
    // This used to be `.catch(() => ({ raw: before }))`, which substituted the
    // snapshot and so answered "unchanged" for every failed re-read. ENOENT is
    // the one case that substitution would be right for, and it does not reach
    // here at all — readSettingsForWrite returns `{ raw: null }` for it without
    // throwing. What does reach here is EACCES/EBUSY on a file written
    // microseconds ago, which is the condition atomic-write.mjs's rename retry
    // names:
    // "a virus scanner or the search indexer opens files the instant they are
    // written, so the target is briefly untouchable on a perfectly healthy
    // machine". Precisely when another deck has just written it.
    //
    // So an unreadable re-read declines, like a changed one. Declining is safe
    // for the reason above: every boot reinstalls and the next pass converges.
    // Being wrong the other way is not — it is the lost update this guard
    // exists to prevent, with the user's own sound hook gone from settings.json
    // and from the park that was its only other copy.
    let onDisk;
    let unreadable = false;
    try { ({ raw: onDisk } = await readSettingsForWrite(cfg.settingsPath)); }
    catch { unreadable = true; }
    if (unreadable || onDisk !== before) {
      return {
        settingsPath: cfg.settingsPath, hookPath, events: cfg.events, provider,
        changed: false, raced: true, retire: { ...retire, pending: false },
      };
    }
    await writeFileAtomic(cfg.settingsPath, next);
  }
  // After the write, never before it: the notify script an older deck installed
  // is what a live session's cached command still names until the new entry is
  // on disk, and deleting it early turns a stale sound into a missing module.
  if (retire.pending) await completeSoundHookRetirement(retire, current);
  return { settingsPath: cfg.settingsPath, hookPath, events: cfg.events, provider, changed, retire };
}

/**
 * Take our forwarders back out of one provider's settings file.
 *
 * Returns `{ok: true, changed}` when the file was read — `changed` says whether
 * anything of ours was in it — and `{ok: false, reason: "settings_unreadable"}`
 * when it was not. Callers must look at `ok` FIRST: `changed: false` on a
 * refusal is the literal truth about the disk and a lie about the question
 * being asked, because the hooks are still in there.
 *
 * That conflation is what this used to ship. The read was readJsonSafe, which
 * turned every parse and IO failure into `null`, so a settings.json with one
 * stray comma — the exact file readSettingsForWrite was written to protect —
 * came back indistinguishable from a clean machine with none of our hooks in
 * it. `--uninstall` printed "no Claude hooks to remove" and exited 0 while all
 * ten `__agent-dag` entries sat in the file, spawning node on every tool call
 * of every session, for a deck the user had been told was gone. The other half
 * of the same command already knew better: the sound-hook half read through
 * readSettingsForWrite and said so out loud, so one command gave two opposite
 * verdicts about one file and the load-bearing one was the one that lied.
 *
 * So the read is the same read the install does, and for the same reason. A
 * file we cannot parse is a file whose contents we cannot reproduce, and this
 * function rewrites the whole thing — every permission, env var, model pin and
 * hand-written hook in it. Refusing leaves it byte for byte as it was found and
 * hands the user something they can act on; guessing would either destroy it or
 * quietly do nothing. Only ENOENT is genuinely empty, and readSettingsForWrite
 * already answers that with `{}`, which falls through to `changed: false`.
 */
export async function uninstallHooks({ provider = "claude", beforeWrite = null } = {}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`unknown provider: ${provider}`);
  let current;
  let before;
  try {
    ({ settings: current, raw: before } = await readSettingsForWrite(cfg.settingsPath));
  } catch (err) {
    if (err?.code !== "SETTINGS_UNREADABLE") throw err;
    // Same shape retireSoundHook answers with, so bin/deck.js reports both
    // halves of `--uninstall` the same way instead of one of them inventing a
    // second vocabulary for the identical condition on the identical file.
    return {
      ok: false,
      reason: "settings_unreadable",
      changed: false,
      provider,
      settingsPath: cfg.settingsPath,
      why: err.why ?? err.message,
      message: err.message,
    };
  }
  if (!current?.hooks) return { ok: true, changed: false, provider, settingsPath: cfg.settingsPath };
  let changed = false;
  for (const evt of Object.keys(current.hooks)) {
    const cleaned = dedupeOurEntries(current.hooks[evt]);
    if (cleaned.length !== (current.hooks[evt]?.length ?? 0)) changed = true;
    if (cleaned.length === 0) delete current.hooks[evt];
    else current.hooks[evt] = cleaned;
  }
  if (changed) {
    // THE SAME GUARD ITS SIBLING HAS, for the same file (#788). `installHooks`
    // grew a compare-against-the-file check at the last moment and this
    // function — which rewrites the same settings.json from a snapshot read
    // just as long ago — never got one.
    //
    // The race is `ccdeck --uninstall` against a deck that is starting.
    // Uninstall reads settings.json with the user's own hooks still parked. In
    // the window before its write — resolveWriteTarget, temp create, write,
    // fsync, stat, rename — the booting deck restores those hooks and deletes
    // the park. Uninstall then writes its stale object over the restore,
    // bin/deck.js re-reads the clobbered file, readParked hits ENOENT, and it
    // reports `restored: 0`. The hooks are gone from both copies and the CLI
    // exits 0 saying the uninstall succeeded.
    //
    // Declining here is not as cheap as declining an install — nothing retries
    // an uninstall — so it says so in the result rather than answering `ok`
    // with `changed: false`, which would read as "there was nothing to remove".
    // The seam the suite needs, and `installHooks` states the argument for it:
    // the window this guard covers is filled with real fs work, so a test that
    // raced it by wall clock would pass or fail by how fast the machine is.
    // Production passes nothing.
    if (beforeWrite) await beforeWrite();
    let onDisk;
    let unreadable = false;
    try { ({ raw: onDisk } = await readSettingsForWrite(cfg.settingsPath)); }
    catch { unreadable = true; }
    if (unreadable || onDisk !== before) {
      return {
        ok: false, reason: "raced", changed: false, provider,
        settingsPath: cfg.settingsPath,
        why: "another writer changed settings.json while the uninstall was running",
        message: `${cfg.settingsPath} changed while uninstalling — nothing was removed. Run --uninstall again.`,
      };
    }
    await writeFileAtomic(cfg.settingsPath, JSON.stringify(current, null, 2) + "\n");
  }
  return { ok: true, changed, provider, settingsPath: cfg.settingsPath };
}

/** True when ~/.codex/ exists — the CLI's default answer to whether the Codex
 *  rollout watcher is worth starting, and whether there are hooks to remove. */
export function hasCodexInstalled() {
  return existsSync(CODEX_DIR);
}

/**
 * Whether an older deck's Codex forwarders are still in hooks.json, found
 * without touching the file: `{ settingsPath, count }` when they are, null when
 * they are not or when the file cannot be read.
 *
 * #253 stopped installing Codex hooks and #317 deleted the recipe, but a
 * machine that ran a deck from before either still has up to nine marked
 * entries in $CODEX_HOME/hooks.json, each pointing at a copy of the forwarder
 * that is still on disk. Wherever Codex honours that file, every one of them
 * posts to `/api/event` — which takes a post without a token — while the
 * rollout watcher reads the same session off disk, so the session is ingested
 * twice: both copies reach the event ring and events.jsonl, and only the ones
 * that land inside the reducer's redelivery windows are folded on the card.
 * uninstallHooks takes them out, and `--uninstall` is its only caller; nothing
 * else ever looked (#983).
 *
 * READ ONLY, and that is the decision rather than an oversight. This runs on
 * every boot, and a boot writes nothing under the Codex directory — bin/deck.js
 * says so where it decides whether to watch Codex at all. The one retirement a
 * boot does perform on another tool's file, the finish-sound hook above, rides
 * on a write of Claude Code's settings.json that the boot was making anyway,
 * and installHooks says that riding along is what makes it safe: one write,
 * compared against the bytes just read, converging on every later boot. A sweep
 * of hooks.json would have none of that. It would be the deck's first
 * unasked-for write to a file it no longer manages, made on every machine that
 * has Codex, to cure a condition only upgraded machines have. So this finds
 * them, the banner names them with the command that removes them, and the user
 * decides — the shape `--uninstall` already gives the LAN key: named, not
 * removed, unless somebody asked.
 *
 * A file that cannot be read answers null rather than throwing. The boot must
 * not die over a Codex file, and "your hooks are in there" said of a file
 * nobody could parse would be a guess; `--uninstall` reports that case itself,
 * out loud, when it is run.
 */
export async function leftoverCodexHooks() {
  const settingsPath = PROVIDERS.codex.settingsPath;
  let settings;
  try {
    ({ settings } = await readSettingsForWrite(settingsPath));
  } catch {
    return null;
  }
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object") return null;
  let count = 0;
  for (const group of Object.values(hooks)) {
    if (!Array.isArray(group)) continue;
    for (const g of group) if (isOurEntry(g)) count++;
  }
  return count > 0 ? { settingsPath, count } : null;
}

/**
 * The events log as the record spells it: an absolute path, or null when this
 * deck writes none. Shared by the writer and by ensureDiscovery's comparison,
 * so a file this process wrote can never read back as somebody else's.
 */
function persistField(persist) {
  return typeof persist === "string" && persist !== "" ? persist : null;
}

/**
 * The Codex tree as the record spells it: the canonical path of the CODEX_HOME
 * this process reads, or null for a --no-codex deck, which reads none. Shared by
 * the writer and by ensureDiscovery's comparison for the reason persistField
 * is, and exported for a start's own shape in bin/deck.js — so a start asking
 * "does the running deck read my tree" spells the tree exactly the way the
 * record it compares against does. Worked out on every call rather than once at
 * load: it is one realpath on a five-second heartbeat, and a tree that did not
 * exist when the deck started — the first `codex login` creates it — is then
 * named the way it is named once it does.
 */
export function codexHomeField(codex) {
  return codex !== false ? canonicalLogPath(CODEX_DIR) : null;
}

// Every deck's token lives in this directory, and writeFileAtomic's temp file is
// created beside its target with whatever the umask allows — 0644 on most
// machines — so for the moment before the rename the token would sit in a
// world-readable file. 0700 on the directory closes that window from the outside:
// another user cannot traverse into it whatever the mode of a file inside says.
// The dir usually predates this code, so the mode is re-asserted rather than only
// set at creation, where it would be masked by the umask anyway. Windows ignores
// both — NTFS ACLs inherit from the per-user profile directory.
async function ensureDiscoveryDir() {
  if (!existsSync(AGENT_DAG_DIR)) await mkdir(AGENT_DAG_DIR, { recursive: true, mode: 0o700 });
  await chmod(AGENT_DAG_DIR, 0o700).catch(() => {});
}

/**
 * Register this deck, in one step no reader can land inside.
 *
 * The record used to go down with a plain writeFile, which truncates the target
 * and then fills it, so the file existed and was empty for a moment on every
 * rewrite. Everything that reads this directory parses each record whole —
 * electWriters in hook/hook.js, readLiveDecks in live-decks.mjs and
 * sweepStaleDiscovery in index.mjs — and a record that fails to parse is a deck
 * missing from that cycle: the event it should have logged is either logged by
 * nobody or logged twice by the decks that remain, which is the exact failure
 * the single-writer election exists to prevent, reached through the file the
 * election reads. A rename is atomic on Linux, macOS and Windows alike, so a
 * reader now sees the previous record or the new one and never half of either.
 *
 * The token is the deck's proof of identity, so the file holding it is the
 * deck's key material: readable and writable by its owner, nobody else. The mode
 * is pinned after the write because writeFileAtomic can only carry over a mode
 * the target already had — a first registration, or one left by an earlier run
 * under a recycled pid, would otherwise keep whatever the umask handed it.
 */
export async function writeDiscovery({ port, workspace, token, persist = null, codex = true, claude = true, version = "", parent = null }) {
  await ensureDiscoveryDir();
  const file = discoveryPath();
  const data = {
    pid: process.pid,
    port,
    workspace: workspace ?? "",
    // Without this the hooks refuse to post: a file naming a port it cannot
    // authenticate is exactly the stale-file case they now decline to trust.
    token: token ?? "",
    // Absolute path of the events log this deck appends to, or null under
    // --no-persist. The hook reads it to elect a single writer per file:
    // several decks receive the same event by design, and without this they
    // each appended their own copy to the one log they share. See
    // electWriters in hook/hook.js.
    persist: persistField(persist),
    // Is this deck tailing Codex's rollout files? Those events never pass
    // through a hook, so the decks elect a writer for them among themselves —
    // and a deck running --no-codex must be left out of that election rather
    // than win it and record a rollout it is not even reading. See
    // writesCodexLog in src/server/log-writer.mjs.
    codex: codex !== false,
    // And WHOSE rollouts. `codex: true` says this deck tails them and never said
    // from where, while CODEX_HOME moves the whole tree — #375 was five modules
    // disagreeing about where it points. Two decks sharing one events.jsonl can
    // therefore be reading two different trees, and the election grouped them
    // anyway, because an unscoped deck's workspace contains every cwd and this
    // was the one field that could have told them apart. The lower-port deck won
    // a rollout it had never opened, the deck reading it stood down, and the
    // shared log recorded nothing of that session (#982).
    //
    // Canonical rather than as spelled, for the reason canonicalLogPath gives
    // the log path above (#793): a symlinked ~/.codex, an 8.3-shortened
    // USERPROFILE or /tmp against /private/tmp would otherwise put two decks
    // reading one tree into two groups and elect them both — the duplicate the
    // election exists to end. Only this published copy is canonicalised.
    // codex-dir.mjs goes on reading and writing through the spelling the user
    // chose, which it has to for a symlinked home (see codexHome() there).
    codexHome: codexHomeField(codex),
    // Does this deck run Browser Watch? The watch elects a single writer among
    // the decks on a machine, and it elected on port alone — so an older ccdeck
    // that predates the feature won the election by having the lower port and
    // then wrote nothing, while the deck that HAS the watch stood down. Measured
    // on this machine: a v1.46 deck from an npx cache held 4317, answered the
    // watch route with the SPA's index.html, and Browser Watch silently
    // recorded nothing for as long as both were up. No error, no log line — the
    // panel showed findings on screen and the disk stayed empty.
    //
    // Same shape as `codex` above, and for the same reason: a deck that is not
    // doing the work must be left out of the election rather than win it. An
    // older deck has no such field, so it is excluded by construction.
    watch: true,
    // Is the Claude side of this deck switched on? Same shape as `codex` above
    // and there for a second reader: a bare `ccdeck` that finds this deck
    // running attaches to it instead of starting a rival, and it may only do
    // that when the deck on the port is the deck it would itself have built. A
    // `--no-claude` deck has no hooks, no accounts panel and no switcher, and
    // until this field existed it was indistinguishable from one that has all
    // three. An older deck has no such field, so it never passes for one and is
    // replaced instead — see secondStart.
    claude: claude !== false,
    // What this deck IS, so a launcher that attaches can say whether the deck
    // it found is the version the user just asked for. Never a decision: a
    // rival deck on a random port is worse than an older deck said out loud.
    version: typeof version === "string" ? version : "",
    // The supervisor above this worker, or null when nothing is supervising.
    //
    // Only `ccdeck --stop` reads it, and only on the path where the polite
    // request failed. A worker killed on its own leaves its supervisor alive,
    // and a supervisor that puts crashed workers back would answer that kill by
    // starting the deck again — so the ladder has to end the parent first and
    // the child second, which it cannot do without being told who the parent is.
    parent: Number.isInteger(parent) ? parent : null,
    startedAt: new Date().toISOString(),
  };
  await writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
  await chmod(file, 0o600).catch(() => {});
  return file;
}

export async function removeDiscovery(file) {
  try { await unlink(file); } catch {}
}

/** Where this process registers itself. One file per deck, named by pid. */
export function discoveryPath() {
  return join(AGENT_DAG_DIR, `${process.pid}.json`);
}

/**
 * Make sure this deck's discovery file is on disk and says what it should.
 *
 * Registration was a single write at boot, so anything that took the file away
 * afterwards — a sweep on another machine's clock, a half-finished restart, a
 * user tidying the directory — left a deck that was listening, serving and
 * completely invisible: hook.js enumerates this directory and nothing else, so
 * the deck received zero events while looking perfectly healthy. Re-asserting
 * is cheap (one small read), so the deck checks rather than assumes.
 *
 * A file this process wrote is left alone, mode and contents included — only its
 * mtime moves, stamped on every check; see the note where it is. Anything else —
 * no file, unreadable, another pid, a stale port, token, events log, Codex
 * setting or Codex tree, Claude setting, or a version left by the deck this
 * process replaced — is replaced. Every field another deck decides by is compared, the
 * log path included: leave one out and a record missing it would pass as ours
 * forever, which for the log path means no deck can tell which of them share a
 * file and they all write their own copy of every event again. The Codex tree
 * is compared strictly for the same reason: a record from before the field
 * existed has none, and `undefined` must read as "rewrite", never as a
 * --no-codex deck's null.
 */
export async function ensureDiscovery({ port, workspace, token, persist = null, codex = true, claude = true, version = "", parent = null }) {
  const file = discoveryPath();
  try {
    const d = JSON.parse(stripBom(await readFile(file, "utf8")));
    if (d
      && d.pid === process.pid
      && d.port === port
      && (d.workspace ?? "") === (workspace ?? "")
      && (d.token ?? "") === (token ?? "")
      && (d.persist ?? null) === persistField(persist)
      && d.codex === (codex !== false)
      && d.codexHome === codexHomeField(codex)
      && d.claude === (claude !== false)
      && (d.version ?? "") === (typeof version === "string" ? version : "")
      && (d.parent ?? null) === (Number.isInteger(parent) ? parent : null)) {
      // STAMPED, though nothing in it changed. The mtime is how a reader tells a
      // record some deck is still keeping from one whose deck is gone while its
      // pid lives on under another process: hook.js unlinks a record whose port
      // lets both challenge deadlines pass only once this stamp is a minute old
      // (#1069), which a deck running this check every five seconds never lets
      // happen. Best-effort — a stamp that cannot be written leaves the record
      // exactly as every deck before this one left it.
      const now = new Date();
      await utimes(file, now, now).catch(() => {});
      return { file, rewritten: false };
    }
  } catch { /* missing, unreadable or corrupt — rewritten below */ }
  await writeDiscovery({ port, workspace, token, persist, codex, claude, version, parent });
  return { file, rewritten: true };
}

/**
 * Keep this deck registered for as long as it runs, and tell the caller when
 * that stops being true.
 *
 * `onState` hears the first outcome, every change of health, and every
 * re-registration after the first — never a steady state. A deck that cannot
 * write the file has to say so: silently listening while no hook can find it
 * is the failure this exists to end, not a state worth hiding.
 *
 * The interval is unref'd, so it never keeps a finished process alive, and
 * `stop()` must be called before the file is removed on shutdown — otherwise
 * the next tick would put it straight back.
 *
 * `stop()` ANSWERS WITH THE CHECK ALREADY IN FLIGHT, and shutdown has to await
 * it. Clearing the interval stops the next tick; it does nothing about the one
 * that started a moment ago and is currently inside writeFileAtomic. That tick
 * finishes after the unlink and re-creates the file — exactly the "leave the
 * file behind for the hooks to find once nothing is listening" that stopping
 * first is supposed to prevent, reached by the one route stopping first does
 * not cover. The window is a rename and an fsync on POSIX; on Windows it is
 * that plus renameWithRetry's ladder, up to 200ms of sleeping while a scanner
 * holds the target — the platform the retry was written for is the platform
 * where the race is twenty times wider.
 *
 * `run()` never rejects (every failure is a state), so awaiting this cannot
 * throw and cannot outlast one bounded check.
 */
export function keepDiscovery({ port, workspace, token, persist = null, codex = true, claude = true, version = "", parent = null, intervalMs = 5000, onState = null } = {}) {
  // null until the first outcome, which therefore always differs and is always
  // reported — the caller learns where it stands before anything else happens.
  let healthy = null;

  const run = async () => {
    let state;
    try {
      const { rewritten } = await ensureDiscovery({ port, workspace, token, persist, codex, claude, version, parent });
      state = { ok: true, rewritten, file: discoveryPath(), error: null };
    } catch (err) {
      state = { ok: false, rewritten: false, file: discoveryPath(), error: err };
    }
    const worthSaying = healthy !== state.ok || state.rewritten;
    healthy = state.ok;
    if (worthSaying && onState) { try { onState(state); } catch { /* not our problem */ } }
    return state;
  };

  // One check at a time. Registration is a write and a write is now a rename,
  // which costs an fsync — long enough that a tick can land inside the boot-time
  // check bin/deck.js runs by hand. That second check reads a file the first has
  // not renamed into place yet, concludes the deck is unregistered and writes it
  // again, and the two writes race over one record: the deck reports itself
  // unregistered on a machine where nothing whatsoever is wrong. A caller that
  // asks mid-check gets the answer the check already in flight is fetching.
  let inFlight = null;
  const check = () => (inFlight ??= run().finally(() => { inFlight = null; }));

  const timer = setInterval(() => { check(); }, intervalMs);
  timer.unref?.();

  const stop = () => {
    clearInterval(timer);
    return inFlight ?? Promise.resolve(null);
  };

  return { file: discoveryPath(), check, stop };
}

// CLAUDE_EVENTS used to ride along here (#383). It is the events list of the
// `claude` entry in PROVIDERS and has never had a reader outside this file; it
// was easy to miss because the three directories beside it ARE imported and
// because the long justification that sat below it belonged to the SECOND
// export, not this one (it is in atomic-write.mjs now, with that export). Which
// events the deck asks Claude Code for is answered by installHooks writing
// settings.json, which is what the tests read.
export { AGENT_DAG_DIR, CLAUDE_DIR, CODEX_DIR };
// The atomic write and its read-before-rewrite, which moved to atomic-write.mjs.
// Exported from this file before they moved, and still: eight modules import
// them from here.
export { readSettingsForWrite, writeFileAtomic, renameWithRetry, createTemp, resolveWriteTarget, stripBom } from "./atomic-write.mjs";
