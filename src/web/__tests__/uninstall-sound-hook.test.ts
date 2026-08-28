// Reported: `agents-deck --uninstall` left the deck's sound hook installed.
// uninstallHooks only recognises the `__agent-dag` mark the event forwarders
// carry, and the sound entry is marked `__agent-dag-sound` with a command
// pointing at notify.mjs — so it survived, and a sound kept playing on every turn
// after the deck was supposedly gone. Worse, turning the toggle on parked the
// user's own afplay/PowerShell Stop hooks in ~/.agents-deck/parked-sound-hooks.json
// and only the running deck UI could put them back; once uninstalled, hooks the
// user wrote themselves were stranded in a file they had never heard of.
//
// #704 retired the whole mechanism — the deck plays its own tones now and writes
// no hook — which changes what makes the state, not what `--uninstall` owes. The
// entry is still in the settings.json of every machine that ever turned the
// sound on, and the parked file is still the only copy of hooks somebody wrote by
// hand. So the fixtures below WRITE that state rather than producing it through
// a toggle that no longer exists, which is also the more honest fixture: it is
// literally what an upgraded machine has on disk.
//
// These tests drive the real CLI and pin both halves: the deck's entry goes, and
// the user's own hooks come back.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { rmTempDir } from "./rm-temp-dir";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Both server modules resolve their paths at import time: settings.json from
// $CLAUDE_CONFIG_DIR (falling back to ~/.claude) and the parked-hooks file from
// os.homedir(), which reads $HOME on POSIX and %USERPROFILE% on Windows. All
// three are pointed at a temp directory BEFORE anything is loaded — and passed
// to the CLI child process below — so nothing here can reach the real ~/.claude
// on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-uninstall-"));
const FAKE_CLAUDE = join(FAKE_HOME, ".claude");
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE;

// @ts-expect-error — .mjs server module, no types
const retirement = await import("../../server/retire-sound-hook.mjs");
// @ts-expect-error — .mjs server module, no types
const installerMod = await import("../../server/installer.mjs");
const { retireSoundHook, SETTINGS_PATH, PARKED_PATH, NOTIFY_PATH } = retirement;
const { installHooks, CLAUDE_DIR } = installerMod;

// Belt and braces. If any of these ever stopped honouring the environment, this
// file would be rewriting the developer's own settings — so fail before a single
// test gets the chance.
for (const p of [SETTINGS_PATH, PARKED_PATH, NOTIFY_PATH, CLAUDE_DIR]) {
  if (!String(p).startsWith(FAKE_HOME)) {
    throw new Error(`refusing to run: resolved ${p}, outside ${FAKE_HOME}`);
  }
}

mkdirSync(FAKE_CLAUDE, { recursive: true });

const SETTINGS = String(SETTINGS_PATH);
const PARKED = String(PARKED_PATH);
const NOTIFY = String(NOTIFY_PATH);

const DECK_CLI = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));
const CHILD_ENV = {
  ...process.env,
  HOME: FAKE_HOME,
  USERPROFILE: FAKE_HOME,
  CLAUDE_CONFIG_DIR: FAKE_CLAUDE,
};

/** Run the real `agents-deck --uninstall`. Throws if it exits non-zero. */
const runUninstall = () =>
  execFileSync(process.execPath, [DECK_CLI, "--uninstall"], {
    env: CHILD_ENV,
    encoding: "utf8",
    timeout: 30_000,
  });

const readSettings = () => JSON.parse(readFileSync(SETTINGS, "utf8"));

// The hook a user writes by hand, and the one the toggle set aside for them.
const USER_SOUND_HOOK = {
  hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff || true" }],
};
const USER_AUDIT_HOOK = { hooks: [{ type: "command", command: "audit.sh" }] };

/** The deck's own sound entry, exactly as one on a real machine is shaped. */
const OUR_ENTRY = {
  "__agent-dag-sound": true,
  hooks: [{ type: "command", command: `"${process.execPath}" "${NOTIFY}"`, timeout: 5 }],
};

/** The state a user who turned the sound on is actually in: our entry in
 *  settings.json, our script in the deck's install directory, and their own
 *  hook in the parked file. */
function soundWasTurnedOn(): void {
  mkdirSync(dirname(NOTIFY), { recursive: true });
  writeFileSync(NOTIFY, "// the sound script an older deck installed\n", "utf8");
  mkdirSync(dirname(PARKED), { recursive: true });
  writeFileSync(PARKED, JSON.stringify([USER_SOUND_HOOK], null, 2) + "\n", "utf8");
}

const restoreEnv = (key: "HOME" | "USERPROFILE" | "CLAUDE_CONFIG_DIR", was: string | undefined) => {
  if (was === undefined) delete process.env[key];
  else process.env[key] = was;
};

afterAll(() => {
  restoreEnv("HOME", prevHome);
  restoreEnv("USERPROFILE", prevUserProfile);
  restoreEnv("CLAUDE_CONFIG_DIR", prevConfigDir);
  rmTempDir(FAKE_HOME);
});

describe("agents-deck --uninstall", () => {
  it("removes the sound hook it installed and gives the user their own back", async () => {
    writeFileSync(SETTINGS, JSON.stringify({
      model: "opus",
      permissions: { allow: ["Bash(git*)"] },
      hooks: { Stop: [OUR_ENTRY], PreToolUse: [USER_AUDIT_HOOK] },
    }, null, 2), "utf8");
    soundWasTurnedOn();

    // The forwarders too, since this is the state a real machine is in and the
    // command has to take both out of one file.
    await installHooks({ provider: "claude" });

    runUninstall();

    const after = readSettings();
    // Nothing of the deck's is left in the file — not the event forwarders, and
    // not the sound entry that used to keep playing after "uninstall".
    expect(JSON.stringify(after)).not.toContain("__agent-dag");
    expect(JSON.stringify(after)).not.toContain("notify.mjs");
    // Their own hook is back where they wrote it, byte for byte.
    expect(after.hooks.Stop).toEqual([USER_SOUND_HOOK]);
    // The parked file was the only place that hook lived while the toggle was
    // on. It is in settings.json now, so what is left is litter and it goes.
    expect(existsSync(PARKED)).toBe(false);
    // And the rest of the file is untouched.
    expect(after.model).toBe("opus");
    expect(after.permissions).toEqual({ allow: ["Bash(git*)"] });
    expect(after.hooks.PreToolUse).toEqual([USER_AUDIT_HOOK]);
  }, 30_000);

  it("keeps the parked hooks parked when settings.json cannot be parsed", async () => {
    rmSync(PARKED, { force: true });
    soundWasTurnedOn();

    // A trailing comma is enough. The file goes bad before the uninstall.
    const corrupt = '{\n  "model": "opus",\n}\n';
    writeFileSync(SETTINGS, corrupt, "utf8");

    const res = await retireSoundHook();

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("settings_unreadable");
    // Nothing written, nothing dropped: the restore still works once they repair
    // the file, which is the only reason the parked copy exists.
    expect(readFileSync(SETTINGS, "utf8")).toBe(corrupt);
    expect(JSON.parse(readFileSync(PARKED, "utf8"))).toEqual([USER_SOUND_HOOK]);
  });

  it("says out loud that it gave hooks back, and takes its script off the disk", async () => {
    // Two things a user cannot see for themselves. The restore happens in a file
    // they did not know existed, so the count is the only evidence it happened —
    // and the script is in a directory the uninstall is otherwise emptying, so
    // leaving it there is a dead file in a folder the deck claims to have left.
    rmSync(PARKED, { force: true });
    writeFileSync(SETTINGS, JSON.stringify({ hooks: { Stop: [OUR_ENTRY] } }, null, 2), "utf8");
    soundWasTurnedOn();

    const out = runUninstall();

    expect(out).toContain("sound hook removed");
    expect(out).toMatch(/restored 1 of your own sound hook\(s\)/);
    expect(existsSync(NOTIFY)).toBe(false);
  }, 30_000);

  it("exits non-zero and names the parked file when it cannot be read", async () => {
    // The half `--uninstall` cannot finish. Our entry does come out — that is
    // printed above the error and is true — but hooks the user wrote by hand are
    // still in a file nothing will ever open again once the deck is gone, so the
    // command must not exit 0 and must not leave the user thinking it is done.
    writeFileSync(SETTINGS, JSON.stringify({ hooks: { Stop: [OUR_ENTRY] } }, null, 2), "utf8");
    mkdirSync(dirname(PARKED), { recursive: true });
    writeFileSync(PARKED, '[\n  { "hooks": [ { "type": "comm', "utf8");

    let status = 0;
    let stderr = "";
    try {
      runUninstall();
    } catch (err) {
      status = (err as { status?: number }).status ?? 0;
      stderr = String((err as { stderr?: Buffer }).stderr ?? "");
    }

    expect(status).toBe(1);
    expect(stderr).toContain("your own sound hooks were NOT restored");
    expect(stderr).toContain(PARKED);
    // Left for repair, exactly as the message says.
    expect(readFileSync(PARKED, "utf8")).toContain('"type": "comm');
  }, 30_000);

  it("says nothing and changes nothing on a machine that never turned it on", async () => {
    rmSync(PARKED, { force: true });
    rmTempDir(dirname(NOTIFY));
    const plain = JSON.stringify({ model: "opus", hooks: { Stop: [USER_SOUND_HOOK] } }, null, 2) + "\n";
    writeFileSync(SETTINGS, plain, "utf8");

    runUninstall();

    // A hook the deck never installed is not the deck's to remove.
    expect(readFileSync(SETTINGS, "utf8")).toBe(plain);
  }, 30_000);
});
