// Idempotent hook installer. One provider installs, two uninstall:
//  - "claude"  → $CLAUDE_CONFIG_DIR/settings.json (Claude Code, ~/.claude by default)
//  - "codex"   → $CODEX_HOME/hooks.json           (uninstall only — see PROVIDERS)
// Hooks post to the discovery dir at <claude config dir>/agent-dag/, and Codex
// sessions reach the same server through the rollout watcher instead, so one
// running server still sees both CLIs. Re-runs are safe; entries are tagged
// with __agent-dag and de-duped.
import { hookRuntime } from "./app-host.mjs";
import { readFile, mkdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCodeVersions, claudeConfigDir, claudeVersionAtLeast } from "./claude-dir.mjs";
// The first Claude Code that knows StopFailure — see stop-failure.mjs.
import { STOP_FAILURE, STOP_FAILURE_SINCE } from "./stop-failure.mjs";
import { CODEX_HOME } from "./codex-dir.mjs";
import { configuredCodexHomes, readCodexSelection } from "./codex-selection.mjs";
import { shellQuoteArg } from "./exec.mjs";
// The read-before-rewrite and the atomic replace every settings writer goes
// through — see atomic-write.mjs.
import { readSettingsForWrite, writeFileAtomic, createTemp, renameWithRetry } from "./atomic-write.mjs";
// Skill activity's typed-command entry, its off switch and its version gate —
// see skill-hook.mjs for why it is not in CLAUDE_EVENTS.
import { USER_PROMPT_EXPANSION, skillHookDecision, skillHookEnabled } from "./skill-hook.mjs";
// The discovery dir every deck registers in and every hook reads — see
// discovery.mjs, which keeps this deck's record there.
import { AGENT_DAG_DIR } from "./discovery.mjs";

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

/**
 * The events Claude Code added after the ones above, each beside the first
 * version that knows it — added only where EVERY Claude Code the deck finds on
 * the machine is at least that version.
 *
 * Not an event the older CLI would merely ignore. Until 2.1.101 an event name
 * Claude Code did not recognise made it ignore the whole settings.json: the
 * user's permissions, env and hooks, and every one of ours with them (Claude
 * Code's changelog, 2.1.101). StopFailure arrived in 2.1.78, so a machine still
 * on anything before that would lose its settings to the entry meant to tell it
 * more.
 *
 * So the version is read off disk (claudeCodeVersions — never a `claude
 * --version`, which is seconds at boot), and a machine where the deck can find
 * no version gets none of these: the deck it had before, and a line in the
 * README saying why. Every boot reinstalls, so a Claude Code updated past the
 * gate picks the entry up on the deck's next start — and one rolled back below
 * it has the entry taken back out, the same way.
 */
const VERSIONED_CLAUDE_EVENTS = [
  { event: STOP_FAILURE, since: STOP_FAILURE_SINCE },
];

/** Which of `versioned` this machine's Claude Code knows: those whose `since`
 *  every found version is at least, and none when no version was found. */
function eventsKnownTo(versions, versioned = VERSIONED_CLAUDE_EVENTS) {
  const found = Array.isArray(versions) ? versions : [];
  if (found.length === 0) return [];
  return versioned.filter(v => found.every(ver => claudeVersionAtLeast(ver, v.since))).map(v => v.event);
}

const PROVIDERS = {
  claude: {
    settingsPath: join(CLAUDE_DIR, "settings.json"),
    hookInstallDir: join(CLAUDE_DIR, "agent-dag"),
    events: CLAUDE_EVENTS,
    versioned: VERSIONED_CLAUDE_EVENTS,
    // UserPromptExpansion, for Skill activity (#2181): on unless turned off,
    // and gated on every Claude Code found being 2.1.116 or newer (skill-hook.mjs).
    skillHook: true,
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
 * never validated) or homedir(), and `node` is process.execPath or the PATH
 * entry that links to it (stable-node.mjs) — so a config
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
 *
 * WHEN THE NODE IT NAMES IS GONE. stable-node.mjs finds a spelling of the node
 * that outlives an upgrade where there is one, and nvm, fnm and Volta have
 * none: the command named ~/.nvm/versions/node/<v>/bin/node, `nvm uninstall`
 * took it away, and every tool call of every session showed a hook error from
 * then on. So on POSIX the arguments go to a fixed /bin/sh script that runs the
 * recorded node while it is executable, the node on Claude Code's own PATH once
 * it is not, and nothing when there is no node at all — exit 0 and no output,
 * which Claude Code does not report. The script is a constant and the paths
 * reach it as positional arguments, quoted once by the same escaper, so none of
 * them is ever spliced into shell code; and it is /bin/sh by its path, the
 * shell Claude Code itself runs the line with, so neither a PATH without it
 * nor a login shell that is not POSIX changes what the script means. The cost
 * is one `sh` exec before node's own start. Windows keeps the direct command.
 */
const NODE_FALLBACK = 'n=$1; shift; [ -x "$n" ] || n=$(command -v node) || exit 0; exec "$n" "$@"';

export function hookCommand(installedHookPath, provider, node = process.execPath,
                            platform = process.platform) {
  const q = (s) => shellQuoteArg(s, platform);
  const args = `${q(node)} ${q(installedHookPath)} --provider ${q(provider)}`;
  return platform === "win32" ? args : `/bin/sh -c ${q(NODE_FALLBACK)} ccdeck-hook ${args}`;
}

function isMarked(g) {
  if (g[MARK_KEY] === true) return true;
  for (const k of LEGACY_MARKS) if (g[k] === true) return true;
  return false;
}

/**
 * Whether one command is our forwarder. In a group we marked, any path ending
 * in one of our directories' hook.js — the config dir may be relocated and so
 * not be called `.claude` at all. Anywhere else only the `.claude`/`.codex`
 * spelling, which is what an entry from before the mark, or one written by
 * hand, looks like.
 */
function isOurCommand(h, marked) {
  const c = typeof h?.command === "string" ? h.command : "";
  for (const dir of LEGACY_DIRS) {
    if (c.includes(`.claude/${dir}/hook.js`) || c.includes(`.claude\\${dir}\\hook.js`)) return true;
    if (c.includes(`.codex/${dir}/hook.js`) || c.includes(`.codex\\${dir}\\hook.js`)) return true;
    if (marked && (c.includes(`/${dir}/hook.js`) || c.includes(`\\${dir}\\hook.js`))) return true;
  }
  return false;
}

/** What withoutOurCommands answers for a group with nothing left in it. */
const DROP = Symbol("drop");

/**
 * One group with our forwarders taken out of it: `g` itself when nothing in it
 * was ours, DROP when nothing is left, and otherwise a copy holding the rest
 * with its matcher and without our marks.
 *
 * PER COMMAND, NOT PER GROUP (#1734). This used to decide for the whole group —
 * marked, or one command naming our hook.js — and drop all of it. But the group
 * we write has no matcher, and Claude Code's own hook editor files a new
 * matcher-less hook into the first group for that event whose matcher is
 * missing or empty, which on a machine with no hook of the user's own for that
 * event is ours. The next start then rewrote settings.json without the user's
 * sound or PreToolUse guard, and said nothing. Only our forwarder is ours.
 *
 * A marked group whose `hooks` is not a list is dropped, as it always was; an
 * unmarked one is left exactly where it is, as it always was.
 */
function withoutOurCommands(g) {
  if (!g || typeof g !== "object") return g;
  const marked = isMarked(g);
  if (!Array.isArray(g.hooks)) return marked ? DROP : g;
  const kept = g.hooks.filter(h => !isOurCommand(h, marked));
  if (!marked && kept.length === g.hooks.length) return g;
  if (kept.length === 0) return DROP;
  const rest = {};
  for (const [k, v] of Object.entries(g)) {
    if (k === MARK_KEY || LEGACY_MARKS.includes(k)) continue;
    rest[k] = k === "hooks" ? kept : v;
  }
  return rest;
}

/** Whether a group holds anything of ours — a forwarder, or our mark. */
function isOurEntry(g) {
  return withoutOurCommands(g) !== g;
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
  return group.map(withoutOurCommands).filter(g => g !== DROP);
}

/**
 * Whether a settings file still holds exactly the bytes a pass read at its
 * start: false when another writer has changed it since, and false when it
 * cannot be read back at all. installHooks and uninstallHooks both ask it at
 * the last moment before they write, and both decline on false.
 *
 * A READ THE GUARD COULD NOT PERFORM IS NOT PROOF NOTHING CHANGED (#788).
 * This used to be `.catch(() => ({ raw: before }))`, which substituted the
 * snapshot and so answered "unchanged" for every failed re-read. ENOENT is
 * the one case that substitution would be right for, and it does not reach
 * here at all — readSettingsForWrite returns `{ raw: null }` for it without
 * throwing. What does reach here is EACCES/EBUSY on a file written
 * microseconds ago, which is the condition atomic-write.mjs's rename retry
 * names:
 * "a virus scanner or the search indexer opens files the instant they are
 * written, so the target is briefly untouchable on a perfectly healthy
 * machine". Precisely when another deck has just written it.
 */
async function unchangedSince(settingsPath, before) {
  let onDisk;
  let unreadable = false;
  try { ({ raw: onDisk } = await readSettingsForWrite(settingsPath)); }
  catch { unreadable = true; }
  return !(unreadable || onDisk !== before);
}

/**
 * Take the retired finish-sound hook out of `current`, the settings object
 * installHooks is about to write, and hand back what is left to do once that
 * write has landed. installHooks says why it rides along on that write.
 *
 * Imported here rather than at the top of the file because retire-sound-hook.mjs
 * imports this module — it takes writeFileAtomic and readSettingsForWrite from
 * here — and a static import would close that into a cycle. Claude only: the
 * entry was one line in Claude Code's settings.json and there was never a Codex
 * one.
 *
 * The equality test is not ceremony. Retirement DELETES two files — the parked
 * hooks and the installed script — at absolute paths it resolved for itself,
 * from claudeConfigDir() and os.homedir(), at its own import. installHooks
 * writes `cfg.settingsPath`. In the product those are the same settings.json
 * and the paths belong together. When they are not the same file, the two
 * modules are looking at different homes, and acting on that difference means
 * deleting files belonging to a machine this install is not writing to. That
 * is not hypothetical: it happened to the author's own ~/.agents-deck while
 * this very change was being written, from a test whose environment teardown
 * ran a describe too early. Disagreement is a reason to do nothing.
 */
async function soundHookRetirement(provider, cfg, current) {
  let retire = { pending: false, changed: false, removed: 0, restored: 0 };
  let completeSoundHookRetirement = null;
  if (provider === "claude") {
    const retirement = await import("./retire-sound-hook.mjs");
    if (retirement.SETTINGS_PATH === cfg.settingsPath) {
      completeSoundHookRetirement = retirement.completeSoundHookRetirement;
      retire = await retirement.retireSoundHookIn(current);
    }
  }
  return { retire, completeSoundHookRetirement };
}

/**
 * Where the settings.json bytes from before the UserPromptExpansion entry was
 * first added are kept: beside hook.js, in the directory that is ours. Written
 * once per enabling — the pass that adds the entry where none of ours was —
 * with mode 0600, because settings.json can hold API keys in its `env`.
 * `--uninstall` leaves it, as it leaves hook.js: it is the user's own data.
 */
export const SKILL_HOOK_BACKUP = "settings.before-skill-hook.json";

/** Whether a group list holds a forwarder of ours. */
function holdsOurs(groups) {
  return Array.isArray(groups) && groups.some(isOurEntry);
}

/** Whether the entry can be added without guessing: `hooks` absent or a plain
 *  object, and any UserPromptExpansion already there a list. Anything else is
 *  a file shaped in a way this deck did not write and Claude Code may not read,
 *  and adding to it is not a decision to take on the user's behalf. */
function skillHookFits(settings) {
  const hooks = settings.hooks;
  if (hooks === undefined) return true;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const now = hooks[USER_PROMPT_EXPANSION];
  return now === undefined || Array.isArray(now);
}

/** The backup, through a temp file and a rename like every settings write,
 *  created 0600 and kept 0600. */
async function writeBackup(path, text) {
  const { tmp, handle } = await createTemp(path, { mode: 0o600 });
  try {
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Whether this pass adds Skill activity's entry: the gate's decision
 * (skill-hook.mjs), then two refusals of the installer's own — a settings file
 * whose hooks are not in a shape to add to, and a backup that could not be
 * written. Either leaves the entry out; neither stops the rest of the install.
 * `options` is the suite's: skillHookDecision's options, in place of this
 * machine's environment and disk.
 */
async function decideSkillHook(options, settings, before, backupPath) {
  const decision = await skillHookDecision(options ?? {});
  if (!decision.install) return decision;
  if (!skillHookFits(settings)) return { ...decision, install: false, state: "skipped", reason: "settings-shape" };
  // The bytes the write is about to replace, kept before anything is changed,
  // the first time the entry goes in. Nothing to keep when there was no file.
  if (before !== null && !holdsOurs(settings.hooks?.[USER_PROMPT_EXPANSION])) {
    try {
      await writeBackup(backupPath, before);
    } catch {
      return { ...decision, install: false, state: "skipped", reason: "backup-failed" };
    }
    return { ...decision, backup: backupPath };
  }
  return decision;
}

/**
 * Whether Claude Code reports typed slash commands to this deck now, for the
 * Skills tab: "on" when our UserPromptExpansion entry is in settings.json,
 * "off" when the deck was started with the entry turned off, and "skipped"
 * when the gate or the file kept it out (the boot report says which). Read
 * from the file rather than remembered from the boot, because the launcher
 * installed it in another process and the file is what Claude Code reads.
 */
export async function skillHookState(env = process.env, settingsPath = PROVIDERS.claude.settingsPath) {
  if (!skillHookEnabled(env)) return "off";
  try {
    return holdsOurs(JSON.parse(await readFile(settingsPath, "utf8"))?.hooks?.[USER_PROMPT_EXPANSION]) ? "on" : "skipped";
  } catch {
    return "skipped";
  }
}

/** Install hooks for a single provider. Returns {settingsPath, hookPath, events, changed}.
 *  `claudeVersions` is the suite's: the Claude Code versions to gate the
 *  versioned events on, in place of the ones on this machine's disk.
 *  `skillHook` is the suite's too: skillHookDecision's options (the switch,
 *  the installs found, the probe), in place of this machine's. The answer
 *  carries the decision as `skillHook` for the claude provider. */
export async function installHooks({ provider = "claude", beforeWrite = null, claudeVersions = null, skillHook = null } = {}) {
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

  // Decided before `hooks` is touched, so the shape check sees the file as read.
  const skill = cfg.skillHook
    ? await decideSkillHook(skillHook, current, before, join(cfg.hookInstallDir, SKILL_HOOK_BACKUP))
    : null;

  current.hooks = current.hooks ?? {};

  const versioned = cfg.versioned ?? [];
  const known = versioned.length ? eventsKnownTo(claudeVersions ?? claudeCodeVersions(), versioned) : [];
  if (skill?.install) known.push(USER_PROMPT_EXPANSION);
  // Every event whose entry is ours only while a gate says so.
  const gated = [...versioned.map(v => v.event), ...(skill ? [USER_PROMPT_EXPANSION] : [])];
  const events = [...cfg.events, ...known];
  for (const evt of events) {
    const cleaned = dedupeOurEntries(current.hooks[evt]);
    cleaned.push(buildHookEntry(command));
    current.hooks[evt] = cleaned;
  }
  // A gated event this machine's Claude Code does not know — or, for Skill
  // activity's, one turned off — loses our entry, and the key goes with
  // it when nothing of the user's is left under it: that key is the thing an
  // older Claude Code cannot read.
  // A value under that key that is not a list, or a list with nothing of ours
  // in it, is left exactly as it is: it is not this deck's to delete.
  for (const event of gated) {
    const was = current.hooks[event];
    if (known.includes(event) || !Array.isArray(was)) continue;
    const cleaned = dedupeOurEntries(was);
    if (cleaned.length === was.length && cleaned.every((g, i) => g === was[i])) continue;
    if (cleaned.length === 0) delete current.hooks[event];
    else current.hooks[event] = cleaned;
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
  const { retire, completeSoundHookRetirement } = await soundHookRetirement(provider, cfg, current);

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
    // So an unreadable re-read declines, like a changed one. Declining is safe
    // for the reason above: every boot reinstalls and the next pass converges.
    // Being wrong the other way is not — it is the lost update this guard
    // exists to prevent, with the user's own sound hook gone from settings.json
    // and from the park that was its only other copy.
    if (!(await unchangedSince(cfg.settingsPath, before))) {
      return {
        settingsPath: cfg.settingsPath, hookPath, events, provider,
        changed: false, raced: true, retire: { ...retire, pending: false },
        // Nothing was written, so an entry decided on is not on disk.
        ...(skill ? { skillHook: skill.install ? { ...skill, install: false, state: "skipped", reason: "raced" } : skill } : {}),
      };
    }
    await writeFileAtomic(cfg.settingsPath, next);
  }
  // After the write, never before it: the notify script an older deck installed
  // is what a live session's cached command still names until the new entry is
  // on disk, and deleting it early turns a stale sound into a missing module.
  if (retire.pending) await completeSoundHookRetirement(retire, current);
  return { settingsPath: cfg.settingsPath, hookPath, events, provider, changed, retire, ...(skill ? { skillHook: skill } : {}) };
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
    const was = current.hooks[evt];
    const cleaned = dedupeOurEntries(was);
    // A count alone no longer sees every change: a group that loses our
    // forwarder but keeps the user's own hooks is still there, as a new object.
    if (cleaned.length !== (was?.length ?? 0) || cleaned.some((g, i) => g !== was[i])) changed = true;
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
    if (!(await unchangedSince(cfg.settingsPath, before))) {
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

/** Whether an available configured or persisted Codex home can be watched. */
export async function hasCodexInstalled(options = {}) {
  try {
    const selection = await readCodexSelection(options);
    return selection.profiles.some(profile => profile.available);
  } catch {
    // Invalid selection metadata must not crash startup or invent managed homes.
    return configuredCodexHomes(options.env, options.home, options.platform).some(directory => existsSync(directory));
  }
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

// CLAUDE_EVENTS used to ride along here (#383). It is the events list of the
// `claude` entry in PROVIDERS and has never had a reader outside this file; it
// was easy to miss because the three directories beside it ARE imported and
// because the long justification that sat below it belonged to the SECOND
// export, not this one (it is in atomic-write.mjs now, with that export). Which
// events the deck asks Claude Code for is answered by installHooks writing
// settings.json, which is what the tests read.
export { AGENT_DAG_DIR, CLAUDE_DIR, CODEX_DIR };
// This deck's discovery record, which moved to discovery.mjs. Exported from this
// file before they moved, and still: bin/deck.js and the CLI import them from
// here.
export { codexHomesField, codexHomeField, discoveryPath, ensureDiscovery, keepDiscovery, removeDiscovery, writeDiscovery } from "./discovery.mjs";
