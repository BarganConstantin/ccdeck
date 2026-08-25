// The finish sound was the one script the deck installed and then never looked
// at again, and the copy it installed did not say what language it was written
// in (#577).
//
// The deck copies two scripts into <claude config dir>/agent-dag/ and asks
// Claude Code to execute both from live sessions: hook.js, the event forwarder,
// and notify.js, the sound. installHooks re-asserts hook.js on every boot, so a
// machine that upgrades the deck upgrades the forwarder. notify.js had exactly
// one installer — the body of `setSoundHook(true)` — and nothing at boot, in the
// upgrade path or in installHooks ever opened it again. The copy on disk was
// whatever shipped in the release the user last TOGGLED THE SOUND ON WITH.
//
// That is not a drift nobody would notice. #548 replaced a `printf "\a"` player
// that spawned a BEL into `stdio: "ignore"` — silent by construction, and on a
// headless box the only candidate in the list — with a real bell. It could not
// reach one machine that already had the toggle on, which is exactly the set of
// machines it was written for. The author's own laptop, months and many releases
// later, still had the pre-#548 file on disk byte for byte while its hook.js was
// current to the byte.
//
// The settings.json entry was frozen with it. `dedupeOurEntries` recognises the
// `__agent-dag` mark the forwarders carry and not the `__agent-dag-sound` mark
// this entry carries, so installHooks rebuilt hooks.Stop around our sound entry
// and carried it through untouched — including the absolute `process.execPath`
// and the absolute $CLAUDE_CONFIG_DIR baked into it by whichever machine last
// clicked the toggle. A settings.json synced from a second computer therefore
// named that computer's node inside that computer's home directory, the toggle
// in the deck reported the sound as on, and nothing here ever wrote the file
// that command pointed at.
//
// The second half is the format. `hook/notify.js` opens with an `import`
// statement, which in the package is settled by package.json's
// `"type": "module"` two directories up. Installed, it landed in a directory
// with no package.json between it and the filesystem root, so the extension
// alone decided — and a `.js` with nothing above it is CommonJS. Node's
// module-syntax detection covered it up on v20.19.0+ and v22.7.0+, where
// detection is on by default; on 18.x, 19.x, 20.0–20.18.x, 21.x and 22.0–22.6.x,
// all inside this package's `engines: >=18`, the end of every turn was
// `SyntaxError: Cannot use import statement outside a module` printed into the
// user's session where the sound should have been.
//
// So the file is `notify.mjs` now: ESM on every Node that has ever had ESM, with
// no package.json consulted and no detection involved. The other spelling of the
// fix — a `{"type":"module"}` package.json beside the script — would have broken
// hook.js, which lives in that same directory and is deliberately CommonJS
// because that is what the directory's layout means. One of the cases below
// pins that, by loading hook.js from the installed directory after the sound has
// been installed next to it.
//
// The shape of this file follows from why the suite missed both halves.
// finish-sound-bell.test.ts is the one test that executes this script, and it
// imports the REPO copy through a generated `.mjs` driver — which resolves under
// the package's own `"type": "module"`, the single layout in which the format
// was never in doubt. Everything here asks about the INSTALLED copy instead: in
// the installed directory, reached only through the module's own exported paths,
// with no declaring package.json above it, on a temp HOME. The Node that runs it
// is told not to guess, so the case fails on a modern laptop the same way it
// failed on an old CI runner.
//
// PLAIN NODE. Nothing renders, and no sound is ever played: every child runs
// with an empty PATH, so there is no player for the hook to start.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Both server modules resolve their paths at import time: settings.json and the
// install dir from $CLAUDE_CONFIG_DIR (falling back to ~/.claude), and the
// parked-hooks file from os.homedir(), which reads $HOME on POSIX and
// %USERPROFILE% on Windows. All of them are pointed inside a temp directory
// BEFORE anything is loaded, so nothing here can reach the developer's own
// ~/.claude on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-soundreinstall-"));
const FAKE_CLAUDE = join(FAKE_HOME, ".claude");
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
const prevCodexHome = process.env.CODEX_HOME;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE;
delete process.env.CODEX_HOME;

// @ts-expect-error — .mjs server module, no types
const soundMod = await import("../../server/sound-hook.mjs");
// @ts-expect-error — .mjs server module, no types
const installerMod = await import("../../server/installer.mjs");
const {
  setSoundHook, soundHookCommand, SETTINGS_PATH, PARKED_PATH, NOTIFY_PATH, LEGACY_NOTIFY_PATH,
} = soundMod;
const { installHooks, CLAUDE_DIR } = installerMod;

// Belt and braces. If any of these ever stopped honouring the environment, this
// file would be rewriting the developer's own settings and hook scripts — so
// fail before a single test gets the chance.
for (const p of [SETTINGS_PATH, PARKED_PATH, NOTIFY_PATH, LEGACY_NOTIFY_PATH, CLAUDE_DIR]) {
  if (!String(p).startsWith(FAKE_HOME)) {
    throw new Error(`refusing to run: resolved ${p}, outside ${FAKE_HOME}`);
  }
}

const INSTALL_DIR = join(CLAUDE_DIR, "agent-dag");
const INSTALLED_FORWARDER = join(INSTALL_DIR, "hook.js");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PACKAGED_NOTIFY = join(REPO_ROOT, "hook", "notify.mjs");
const PACKAGED_TEXT = readFileSync(PACKAGED_NOTIFY, "utf8");

// The premise the module-format cases rest on, checked rather than assumed. The
// installed script is CommonJS-by-default only while no package.json sits above
// it, and a temp directory nested inside somebody's project would quietly hand
// the whole layout a `"type"` it does not have in a real install — turning the
// interesting cases green for a reason that has nothing to do with the fix.
for (let dir = INSTALL_DIR, up = dirname(dir); ; dir = up, up = dirname(dir)) {
  if (existsSync(join(dir, "package.json"))) {
    throw new Error(
      `refusing to run: ${join(dir, "package.json")} sits above the install dir, so a .js there ` +
      `would not be CommonJS by default and these cases would not mean what they say`,
    );
  }
  if (up === dir) break;
}

mkdirSync(FAKE_CLAUDE, { recursive: true });

/** An existing but empty directory rather than the empty string, because
 *  node.exe still has to load its own system libraries on Windows and a machine
 *  with a broken environment is not what is under test. */
const NO_PLAYERS = join(FAKE_HOME, "empty-path");
mkdirSync(NO_PLAYERS, { recursive: true });

/**
 * A copy of the environment with PATH replaced, in this platform's own spelling.
 *
 * Windows writes it `Path`, and an object that kept that key while adding `PATH`
 * would hand the child both — the real one among them — and afplay, paplay or
 * canberra-gtk-play would resolve after all. The suite must not make noise, and
 * more to the point a hook that found a player would exit before proving the
 * thing under test, which is that node could load the file at all.
 */
function withoutPath(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^path$/i.test(key) || value === undefined) continue;
    env[key] = value;
  }
  env.PATH = NO_PLAYERS;
  return env;
}

/**
 * The flag that turns Node's module-syntax detection off, where there is one.
 *
 * Detection is what hid this bug, so a case that runs on a laptop with it on is
 * a case that cannot fail. Asking `allowedNodeEnvironmentFlags` rather than
 * comparing version numbers is the only spelling that stays true in both
 * directions: the flag does not exist before v20.18, where detection does not
 * exist either and the plain run already reproduces the failure, and it may be
 * retired again once every supported Node detects, at which point this quietly
 * goes back to a plain run instead of dying on an unknown option.
 */
const NO_DETECT = process.allowedNodeEnvironmentFlags.has("--no-experimental-detect-module")
  ? ["--no-experimental-detect-module"]
  : [];

/** Run a script the way Claude Code runs a hook: our own node, no PATH, stdin
 *  closed. Throws on a non-zero exit, so a SyntaxError fails the case. */
function runScript(script: string, args: string[] = [], nodeArgs: string[] = []): string {
  return execFileSync(process.execPath, [...nodeArgs, script, ...args], {
    env: withoutPath(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
  });
}

/**
 * Run the `command` string out of settings.json through a shell, which is what
 * Claude Code does with it.
 *
 * execSync rather than a hand-built argv precisely because the string is meant
 * for a shell: `/bin/sh -c` on POSIX and `cmd.exe /d /s /c` on Windows, chosen
 * by Node rather than by an assumption here. That also makes this the one case
 * that proves the quoting in the entry survives the shell that will see it.
 */
function runSettingsCommand(command: string, extraEnv: Record<string, string> = {}): void {
  execSync(command, {
    env: { ...withoutPath(), ...extraEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
  });
}

const boot = () => installHooks({ provider: "claude" });
const readSettings = () => JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));

/** Our Stop entry, or undefined when the sound is off. */
function soundEntry(): { hooks?: { command?: string; timeout?: number }[] } | undefined {
  const group = readSettings()?.hooks?.Stop;
  return Array.isArray(group) ? group.find((g: Record<string, unknown>) => g["__agent-dag-sound"] === true) : undefined;
}

const soundCommand = () => soundEntry()?.hooks?.[0]?.command;

/** A machine with nothing of ours on it. */
function wipe(): void {
  rmSync(SETTINGS_PATH, { force: true });
  rmSync(INSTALL_DIR, { recursive: true, force: true });
  rmSync(PARKED_PATH, { force: true });
}

const restoreEnv = (key: "HOME" | "USERPROFILE" | "CLAUDE_CONFIG_DIR" | "CODEX_HOME", was: string | undefined) => {
  if (was === undefined) delete process.env[key];
  else process.env[key] = was;
};

beforeEach(wipe);

afterAll(() => {
  restoreEnv("HOME", prevHome);
  restoreEnv("USERPROFILE", prevUserProfile);
  restoreEnv("CLAUDE_CONFIG_DIR", prevConfigDir);
  restoreEnv("CODEX_HOME", prevCodexHome);
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("a deck booting on a machine whose finish sound is switched on", () => {
  it("re-installs the sound script, the way it has always re-installed the forwarder", async () => {
    await setSoundHook(true);
    // The machine from the report: the sound was switched on several releases
    // ago, and the file on disk is whatever shipped that day.
    writeFileSync(NOTIFY_PATH, "// the release the toggle was clicked in\n", "utf8");

    await boot();

    expect(readFileSync(NOTIFY_PATH, "utf8")).toBe(PACKAGED_TEXT);
  });

  it("puts the script back when it has been deleted out from under the entry", async () => {
    await setSoundHook(true);
    rmSync(NOTIFY_PATH, { force: true });

    await boot();

    expect(existsSync(NOTIFY_PATH)).toBe(true);
    expect(readFileSync(NOTIFY_PATH, "utf8")).toBe(PACKAGED_TEXT);
  });

  it("still writes settings.json only when settings.json would change", async () => {
    await setSoundHook(true);
    await boot();

    // The entry is rebuilt from scratch on every boot rather than inspected, so
    // the guard that keeps a boot from rewriting the user's settings.json for
    // nothing is that the rebuilt entry is byte-identical to the one already
    // there. A field added to one of the two builders and not the other would
    // make every launch a write, which is a window for losing a change Claude
    // Code made to the file in between.
    expect((await boot()).changed).toBe(false);
  });
});

describe("a deck booting on a machine whose finish sound is switched off", () => {
  it("does not install the sound script the user has not asked for", async () => {
    await boot();

    expect(existsSync(NOTIFY_PATH)).toBe(false);
    expect(existsSync(LEGACY_NOTIFY_PATH)).toBe(false);
    expect(JSON.stringify(readSettings())).not.toContain("__agent-dag-sound");
  });

  it("does not bring it back for a user who switched the sound off", async () => {
    await setSoundHook(true);
    await setSoundHook(false);
    // Off means off. Re-asserting an installed script is the deck keeping its
    // own artefact current; re-creating one the user retired would be the deck
    // overruling them, and it would be indistinguishable from the toggle being
    // broken.
    expect(existsSync(NOTIFY_PATH)).toBe(true);
    rmSync(NOTIFY_PATH, { force: true });

    await boot();

    expect(existsSync(NOTIFY_PATH)).toBe(false);
    expect(soundEntry()).toBeUndefined();
  });
});

describe("the settings.json entry and the script it names", () => {
  it("agrees with the file on disk after a boot", async () => {
    await setSoundHook(true);
    await boot();

    expect(soundCommand()).toBe(soundHookCommand(NOTIFY_PATH));
    expect(readFileSync(NOTIFY_PATH, "utf8")).toBe(PACKAGED_TEXT);
  });

  it("runs, through the shell that will be given it, and exits cleanly", async () => {
    await setSoundHook(true);
    await boot();

    // The strongest form of "agrees": the string Claude Code hands a shell at
    // the end of a turn is executed here, exactly as written, and the process
    // it starts exits 0. A frozen entry naming a path that no longer exists, or
    // a script node refuses to parse, fails this and nothing else has to be
    // asserted about either.
    expect(() => runSettingsCommand(String(soundCommand()))).not.toThrow();
  });

  it("is re-derived from this machine when settings.json came from another one", async () => {
    // A synced settings.json, with a second computer's node binary inside that
    // computer's home directory — and this computer's deck reporting the sound
    // as on, because the mark is all `soundHookStatus` reads.
    const elsewhere = soundHookCommand("/home/someone-else/.claude/agent-dag/notify.js", "/opt/other/bin/node");
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      hooks: { Stop: [{ "__agent-dag-sound": true, hooks: [{ type: "command", command: elsewhere, timeout: 5 }] }] },
    }, null, 2) + "\n", "utf8");

    await boot();

    expect(soundCommand()).toBe(soundHookCommand(NOTIFY_PATH));
    expect(JSON.stringify(readSettings())).not.toContain("someone-else");
    expect(JSON.stringify(readSettings())).not.toContain("/opt/other/bin/node");
    expect(readFileSync(NOTIFY_PATH, "utf8")).toBe(PACKAGED_TEXT);
  });

  it("leaves exactly one of ours behind, whatever a merge left in the file", async () => {
    const stale = { "__agent-dag-sound": true, hooks: [{ type: "command", command: "node /old/notify.js", timeout: 5 }] };
    const mine = { hooks: [{ type: "command", command: "audit.sh" }] };
    writeFileSync(SETTINGS_PATH, JSON.stringify({ hooks: { Stop: [stale, mine, stale] } }, null, 2) + "\n", "utf8");

    await boot();

    const stop = readSettings().hooks.Stop as Record<string, unknown>[];
    expect(stop.filter(g => g["__agent-dag-sound"] === true)).toHaveLength(1);
    // The user's own Stop hook is not ours to touch, on this path or any other.
    expect(stop.some(g => JSON.stringify(g) === JSON.stringify(mine))).toBe(true);
  });
});

describe("upgrading a machine that has the pre-#577 notify.js installed", () => {
  /** What a deck before this fix left behind: the old name, with old bytes, and
   *  a settings entry pointing at it. */
  async function installTheOldWay(): Promise<void> {
    mkdirSync(INSTALL_DIR, { recursive: true });
    writeFileSync(LEGACY_NOTIFY_PATH, "// the pre-#548 player\n", "utf8");
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      hooks: {
        Stop: [{
          "__agent-dag-sound": true,
          hooks: [{ type: "command", command: soundHookCommand(LEGACY_NOTIFY_PATH), timeout: 5 }],
        }],
      },
    }, null, 2) + "\n", "utf8");
  }

  it("installs the script under a name that declares its own format", async () => {
    await installTheOldWay();

    await boot();

    expect(NOTIFY_PATH.endsWith(".mjs")).toBe(true);
    expect(readFileSync(NOTIFY_PATH, "utf8")).toBe(PACKAGED_TEXT);
  });

  it("stops naming the old file, and only then deletes it", async () => {
    await installTheOldWay();

    await boot();

    expect(soundCommand()).toBe(soundHookCommand(NOTIFY_PATH));
    expect(soundCommand()).not.toContain(LEGACY_NOTIFY_PATH);
    // Swept, but only because the entry above no longer points at it. A live
    // session holding the old command would otherwise get "Cannot find module"
    // at the end of its next turn instead of a stale sound.
    expect(existsSync(LEGACY_NOTIFY_PATH)).toBe(false);
  });
});

describe("the installed script, run by a Node that does not guess the module format", () => {
  it("loads and exits cleanly", async () => {
    await setSoundHook(true);
    await boot();

    // The whole of the second half of the report. On every Node in this
    // package's `engines` range before v20.19.0 and v22.7.0 — 18.x, 19.x,
    // 20.0–20.18.x, 21.x, 22.0–22.6.x — a `.js` in this directory is CommonJS
    // and an `import` statement in it is a SyntaxError at the end of every turn.
    // Detection is turned off here so the case reproduces that on any Node the
    // suite happens to be running under, rather than only on the old ones.
    expect(() => runScript(NOTIFY_PATH, [], NO_DETECT)).not.toThrow();
  });

  it("is what the settings.json command loads too", async () => {
    await setSoundHook(true);
    await boot();

    // Same run, reached the way Claude Code reaches it, with detection off in
    // the child via NODE_OPTIONS — the entry could name a correct file and
    // still be a stack trace at the end of every turn if the format were
    // decided by anything other than the name.
    const env = NO_DETECT.length ? { NODE_OPTIONS: NO_DETECT.join(" ") } : {};
    expect(() => runSettingsCommand(String(soundCommand()), env)).not.toThrow();
  });

  it("does not change how hook.js loads out of the same directory", async () => {
    await setSoundHook(true);
    await boot();

    // The constraint that ruled out the other fix. A `{"type":"module"}`
    // package.json beside the sound script would have declared the format for
    // the whole directory, and the forwarder living in it is CommonJS — a
    // `require` at its tenth line, correct exactly where it is installed. It
    // must keep loading, on a Node told not to detect anything, after the sound
    // has been installed next to it.
    expect(existsSync(INSTALLED_FORWARDER)).toBe(true);
    expect(() => runScript(INSTALLED_FORWARDER, ["--provider", "claude"], NO_DETECT)).not.toThrow();
  });
});
