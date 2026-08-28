// Reported: the deck's sound toggle read ~/.claude/settings.json with a
// JSON.parse wrapped in a bare catch, so a file made unparseable by a trailing
// comma or a Notepad BOM looked exactly like a missing one. Clicking the switch
// then wrote that empty object back with only the sound entry in it, and every
// permission, env var and user hook in the file was gone — atomically, and
// reporting ok.
//
// #704 removed the toggle: the deck plays its own tones and writes no hook. What
// it did NOT remove is a writer of this file, because the entry the toggle used
// to install is still sitting in the settings.json of every machine that ever
// turned the sound on, naming a script this release deletes. Retiring it is a
// rewrite of the whole file, made without the user asking, on the boot after an
// upgrade — which is the same bargain as before with the stakes raised, since
// nobody clicked anything and nobody is watching. So the refusal is what these
// tests pin, on the module that does the writing now: a settings.json it cannot
// parse is left byte for byte as it was found, said out loud, and the entry
// stays in it until the user repairs the file.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The module resolves its paths at import time: settings.json from
// $CLAUDE_CONFIG_DIR (falling back to ~/.claude) and the parked-hooks file from
// os.homedir(), which reads $HOME on POSIX and %USERPROFILE% on Windows. All
// three are pointed at a temp directory BEFORE the module is loaded, so nothing
// here can reach the real ~/.claude on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-sound-"));
const FAKE_CLAUDE = join(FAKE_HOME, ".claude");
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE;

// @ts-expect-error — .mjs server module, no types
const mod = await import("../../server/retire-sound-hook.mjs");
const { retireSoundHook, SETTINGS_PATH, PARKED_PATH, NOTIFY_PATH } = mod;

// Belt and braces. If either path ever stopped honouring the environment, this
// file would be rewriting the developer's own settings — so fail before a
// single test gets the chance.
for (const p of [SETTINGS_PATH, PARKED_PATH, NOTIFY_PATH]) {
  if (!String(p).startsWith(FAKE_HOME)) {
    throw new Error(`refusing to run: retire-sound-hook resolved ${p}, outside ${FAKE_HOME}`);
  }
}

mkdirSync(FAKE_CLAUDE, { recursive: true });

const restore = (key: "HOME" | "USERPROFILE" | "CLAUDE_CONFIG_DIR", was: string | undefined) => {
  if (was === undefined) delete process.env[key];
  else process.env[key] = was;
};

afterAll(() => {
  restore("HOME", prevHome);
  restore("USERPROFILE", prevUserProfile);
  restore("CLAUDE_CONFIG_DIR", prevConfigDir);
  rmTempDir(FAKE_HOME);
});

const SETTINGS = String(SETTINGS_PATH);
const PARKED = String(PARKED_PATH);
const NOTIFY = String(NOTIFY_PATH);

/** The deck's own entry, as one is actually shaped on disk. */
const OUR_ENTRY = {
  "__agent-dag-sound": true,
  hooks: [{ type: "command", command: `"${process.execPath}" "${NOTIFY}"`, timeout: 5 }],
};
const USER_SOUND_HOOK = {
  hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff || true" }],
};

/** The state an upgraded machine boots into: the entry, and the script it names
 *  sitting in the deck's own install directory. */
function installedTheOldWay(extra: Record<string, unknown[]> = {}) {
  writeFileSync(SETTINGS, JSON.stringify({
    model: "opus",
    env: { FOO: "bar" },
    permissions: { allow: ["Bash(git*)"] },
    hooks: { Stop: [OUR_ENTRY], ...extra },
  }, null, 2) + "\n", "utf8");
  mkdirSync(dirname(NOTIFY), { recursive: true });
  writeFileSync(NOTIFY, "// the script the package no longer ships\n", "utf8");
}

beforeEach(() => {
  rmSync(PARKED, { force: true });
  rmTempDir(dirname(NOTIFY));
});

// The reported reproduction: a settings.json a human would call valid, rejected
// by JSON.parse over one trailing comma, carrying the things worth losing.
const CORRUPT = [
  "{",
  '  "permissions": { "allow": ["Bash(git*)"] },',
  '  "env": { "FOO": "bar" },',
  '  "hooks": { "PreToolUse": [{ "hooks": [{ "type": "command", "command": "audit.sh" }] }] },',
  "}",
  "",
].join("\n");

describe("retirement and a settings.json it cannot parse", () => {
  it("refuses, and keeps every byte of the file", async () => {
    writeFileSync(SETTINGS, CORRUPT, "utf8");

    const res = await retireSoundHook();

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("settings_unreadable");
    expect(res.message).toMatch(/Refusing to overwrite/);
    expect(res.settingsPath).toBe(SETTINGS_PATH);
    expect(readFileSync(SETTINGS, "utf8")).toBe(CORRUPT);
  });

  it("leaves the script alone as well, because the entry still names it", async () => {
    // The ordering the whole module is built around, read from the failure end:
    // deleting a script an entry still points at turns a stale sound into a
    // "Cannot find module" at the end of every turn. A refusal deletes nothing.
    writeFileSync(SETTINGS, CORRUPT, "utf8");
    mkdirSync(dirname(NOTIFY), { recursive: true });
    writeFileSync(NOTIFY, "// still named by something\n", "utf8");

    expect((await retireSoundHook()).ok).toBe(false);

    expect(existsSync(NOTIFY)).toBe(true);
  });

  it("keeps the parked hooks parked for later, rather than restoring into a file it cannot read", async () => {
    writeFileSync(SETTINGS, CORRUPT, "utf8");
    mkdirSync(dirname(PARKED), { recursive: true });
    writeFileSync(PARKED, JSON.stringify([USER_SOUND_HOOK], null, 2) + "\n", "utf8");

    const res = await retireSoundHook();

    expect(res.ok).toBe(false);
    expect(readFileSync(SETTINGS, "utf8")).toBe(CORRUPT);
    // Still there — the restore works once they repair the file, and that is the
    // only reason the parked copy exists at all.
    expect(JSON.parse(readFileSync(PARKED, "utf8"))).toEqual([USER_SOUND_HOOK]);
  });

  it("says the same thing on a second attempt, instead of drifting into 'nothing to do'", async () => {
    // The refusal must be repeatable. A first run that quietly recorded itself
    // as done would leave the entry in the file forever, which is the failure
    // mode a marker file would have introduced.
    writeFileSync(SETTINGS, CORRUPT, "utf8");

    expect((await retireSoundHook()).reason).toBe("settings_unreadable");
    expect((await retireSoundHook()).reason).toBe("settings_unreadable");
    expect(readFileSync(SETTINGS, "utf8")).toBe(CORRUPT);
  });
});

describe("retirement and a settings.json it can read", () => {
  it("keeps the rest of the file when it removes its own hook", async () => {
    installedTheOldWay({ PreToolUse: [{ hooks: [{ type: "command", command: "audit.sh" }] }] });

    const res = await retireSoundHook();

    expect(res).toMatchObject({ ok: true, removed: 1, restored: 0 });
    const written = JSON.parse(readFileSync(SETTINGS, "utf8"));
    expect(written.model).toBe("opus");
    expect(written.env).toEqual({ FOO: "bar" });
    expect(written.permissions).toEqual({ allow: ["Bash(git*)"] });
    expect(written.hooks.PreToolUse).toHaveLength(1);
    // Ours was the only Stop entry, so the empty array goes rather than being
    // left behind as a key that says nothing.
    expect(written.hooks.Stop).toBeUndefined();
  });

  it("reads a file saved with a UTF-8 BOM, which is how Notepad writes one", async () => {
    // A BOM makes JSON.parse throw on JSON that is otherwise perfectly fine, so
    // before the fix this exact file was one of the ones that got destroyed. It
    // has to parse, not merely survive.
    const bom = String.fromCharCode(0xfeff);
    writeFileSync(SETTINGS, bom + JSON.stringify({
      model: "sonnet",
      hooks: { Stop: [OUR_ENTRY] },
    }, null, 2), "utf8");

    expect((await retireSoundHook()).ok).toBe(true);

    const written = JSON.parse(readFileSync(SETTINGS, "utf8"));
    expect(written.model).toBe("sonnet");
    expect(written.hooks.Stop).toBeUndefined();
  });

  it("treats a missing file as a machine with nothing to retire — ENOENT is not corruption", async () => {
    rmSync(SETTINGS, { force: true });

    const res = await retireSoundHook();

    expect(res).toMatchObject({ ok: true, removed: 0, restored: 0 });
    // And it is not CREATED to hold a removal there was nothing to make.
    expect(existsSync(SETTINGS)).toBe(false);
  });

  it("hands parked hooks back even when settings.json has since gone missing", async () => {
    // ENOENT is an empty object, not a refusal, so the restore has somewhere to
    // land. The user's own hooks come back whatever happened to the file they
    // were taken out of — that is the promise, and it does not have conditions.
    rmSync(SETTINGS, { force: true });
    mkdirSync(dirname(PARKED), { recursive: true });
    writeFileSync(PARKED, JSON.stringify([USER_SOUND_HOOK], null, 2) + "\n", "utf8");

    const res = await retireSoundHook();

    expect(res).toMatchObject({ ok: true, restored: 1 });
    expect(JSON.parse(readFileSync(SETTINGS, "utf8")).hooks.Stop).toEqual([USER_SOUND_HOOK]);
    expect(existsSync(PARKED)).toBe(false);
  });
});
