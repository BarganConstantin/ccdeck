// Retiring the old finish-sound hook from a machine that already has it (#704).
//
// The deck used to make its "turn finished" sound by writing a `Stop` entry into
// the user's settings.json that ran `notify.mjs` out of <claude config
// dir>/agent-dag/. #704 moved the sound into the browser and DELETED that script
// from the package. So the dangerous half of this change is not the half that
// was written — it is the machine that was working yesterday: its settings.json
// still carries the entry, the file the entry names is gone with the upgrade,
// and Claude Code runs the command at the end of every turn. Removing our own
// entry is therefore part of the change and not a follow-up, and it has to
// happen on an ordinary boot without the user asking for anything.
//
// These are the five machines that boot into it.
//
//   1. Ours and only ours. The entry goes; nothing else in the file moves.
//   2. The user's own `afplay` hook and nothing of ours. Not ours to touch —
//      the deck never installed it and retiring the deck's mechanism is no
//      licence to delete somebody's hook because it plays a sound.
//   3. Both, plus a parked file. This is the real upgrade: turning the sound on
//      PARKED the user's own hook in ~/.agents-deck/parked-sound-hooks.json, and
//      after this change nothing anywhere else will ever be in a position to
//      hand it back. Ours out, theirs back in, park deleted.
//   4. Neither. Not one byte written — a machine that never had the feature must
//      not have its settings.json rewritten by a change that only removes it.
//   5. The boot after. Nothing left to trigger on, so nothing happens, which is
//      what "exactly once" means here: there is no marker file, the trigger IS
//      the state, and retirement removes the state.
//
// Driven through `installHooks`, which is the real trigger — retirement rides on
// the read and the write the hook install already does, so there is one write on
// the boot that retires and no second writer to race with. A test that called
// the retirement function directly would pass on the day the boot stopped
// calling it.
//
// PLAIN NODE. Nothing renders; every path is pointed inside a temp directory
// before either server module is imported, and the guard below refuses to run
// if that ever stops being true.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Both modules resolve their paths at import time: settings.json and the install
// dir from $CLAUDE_CONFIG_DIR (falling back to ~/.claude), and the parked-hooks
// file from os.homedir(), which reads $HOME on POSIX and %USERPROFILE% on
// Windows. All of them are pointed at a temp directory BEFORE anything is
// loaded, so nothing here can reach the developer's own ~/.claude, ~/.codex or
// ~/.agents-deck on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-retire-"));
const FAKE_CLAUDE = join(FAKE_HOME, ".claude");
const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
const prevCodexHome = process.env.CODEX_HOME;
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE;
process.env.CODEX_HOME = join(FAKE_HOME, ".codex");

// @ts-expect-error — .mjs server module, no types
const retirement = await import("../../server/retire-sound-hook.mjs");
// @ts-expect-error — .mjs server module, no types
const installerMod = await import("../../server/installer.mjs");
const { retireSoundHook, SETTINGS_PATH, PARKED_PATH, NOTIFY_PATH, LEGACY_NOTIFY_PATH } = retirement;
const { installHooks, CLAUDE_DIR } = installerMod;

// Belt and braces. If any of these ever stopped honouring the environment, this
// file would be rewriting the developer's own settings and deleting their parked
// hooks — so fail before a single test gets the chance.
for (const p of [SETTINGS_PATH, PARKED_PATH, NOTIFY_PATH, LEGACY_NOTIFY_PATH, CLAUDE_DIR]) {
  if (!String(p).startsWith(FAKE_HOME)) {
    throw new Error(`refusing to run: a deck module resolved ${p}, outside ${FAKE_HOME}`);
  }
}

mkdirSync(FAKE_CLAUDE, { recursive: true });

const restoreEnv = (
  key: "HOME" | "USERPROFILE" | "CLAUDE_CONFIG_DIR" | "CODEX_HOME",
  was: string | undefined,
) => {
  if (was === undefined) delete process.env[key];
  else process.env[key] = was;
};

afterAll(() => {
  restoreEnv("HOME", prevHome);
  restoreEnv("USERPROFILE", prevUserProfile);
  restoreEnv("CLAUDE_CONFIG_DIR", prevConfigDir);
  restoreEnv("CODEX_HOME", prevCodexHome);
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

const SETTINGS = String(SETTINGS_PATH);
const PARKED = String(PARKED_PATH);
const NOTIFY = String(NOTIFY_PATH);
const LEGACY = String(LEGACY_NOTIFY_PATH);

const boot = () => installHooks({ provider: "claude" });
const raw = () => readFileSync(SETTINGS, "utf8");
const settings = () => JSON.parse(raw());
const stop = (): Record<string, unknown>[] => settings()?.hooks?.Stop ?? [];

/** The deck's own sound entry, exactly as a real one on disk is shaped: the
 *  mark, and a command naming the script in the deck's install directory. */
const ourEntry = (script = NOTIFY) => ({
  "__agent-dag-sound": true,
  hooks: [{ type: "command", command: `"${process.execPath}" "${script}"`, timeout: 5 }],
});

/** A hook a user wrote by hand — one OS-specific line ending in `|| true`. */
const USER_SOUND_HOOK = {
  hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff || true" }],
};
const USER_AUDIT_HOOK = { hooks: [{ type: "command", command: "audit.sh" }] };

/** Everything a user would hate to lose, so "untouched" is a claim with a
 *  subject rather than an absence of assertions. */
function writeSettings(hooks: Record<string, unknown[]>): void {
  writeFileSync(SETTINGS, JSON.stringify({
    model: "opus",
    env: { MY_VAR: "mine" },
    permissions: { allow: ["Bash(git*)"] },
    hooks,
  }, null, 2) + "\n", "utf8");
}

/** The script an installed deck put in its own directory. */
function writeInstalledScript(path = NOTIFY): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "// the sound script the package no longer ships\n", "utf8");
}

function writePark(entries: unknown[]): void {
  mkdirSync(dirname(PARKED), { recursive: true });
  writeFileSync(PARKED, JSON.stringify(entries, null, 2) + "\n", "utf8");
}

/** A machine with nothing of ours anywhere. */
beforeEach(() => {
  rmSync(SETTINGS, { force: true });
  rmSync(join(CLAUDE_DIR, "agent-dag"), { recursive: true, force: true });
  rmSync(PARKED, { force: true });
});

/** What the user still has after the deck's forwarders are added: the model, the
 *  env, the permissions and every hook of theirs, on every event. */
function expectUserFileIntact(): void {
  const after = settings();
  expect(after.model).toBe("opus");
  expect(after.env).toEqual({ MY_VAR: "mine" });
  expect(after.permissions).toEqual({ allow: ["Bash(git*)"] });
  expect(after.hooks.PreToolUse).toContainEqual(USER_AUDIT_HOOK);
}

describe("a machine with the deck's own sound hook on it", () => {
  it("takes the entry out on the first ordinary boot, without being asked", async () => {
    writeSettings({ Stop: [ourEntry()], PreToolUse: [USER_AUDIT_HOOK] });
    writeInstalledScript();

    const res = await boot();

    expect(res.retire).toMatchObject({ pending: true, changed: true, removed: 1, restored: 0 });
    // The entry that would otherwise run a script this release deleted.
    expect(raw()).not.toContain("__agent-dag-sound");
    expect(raw()).not.toContain("notify.mjs");
    expectUserFileIntact();
  });

  it("deletes the script it installed, and only after settings.json is written", async () => {
    writeSettings({ Stop: [ourEntry()] });
    writeInstalledScript();
    writeInstalledScript(LEGACY);   // a machine that never upgraded past #577

    await boot();

    expect(existsSync(NOTIFY)).toBe(false);
    expect(existsSync(LEGACY)).toBe(false);
  });

  it("recognises the entry when the mark is gone and only the path is left", async () => {
    // The author's own machine, and the reason the mark is not the only rule: two
    // Stop entries naming the installed script with `__agent-dag-sound` on
    // neither. A mark-only rule leaves them, and there is no switch anywhere any
    // more that could turn them off.
    const unmarked = { hooks: [{ type: "command", command: `"${process.execPath}" "${LEGACY}"`, timeout: 5 }] };
    writeSettings({ Stop: [unmarked, unmarked] });
    writeInstalledScript(LEGACY);

    const res = await boot();

    expect(res.retire.removed).toBe(2);
    expect(raw()).not.toContain("notify.js");
    expect(existsSync(LEGACY)).toBe(false);
  });

  it("reads the path out of either platform's quoting, not just this one's", async () => {
    // The command in settings.json is quoted for the shell that will run it, and
    // the two rules are different: POSIX single quotes, cmd.exe doubled double
    // quotes. A rule that recognised only the spelling produced on the machine
    // the test runs on would leave every Windows entry behind — and Windows is
    // where this repo's hook bugs live.
    const posixQuoted = { hooks: [{ type: "command", command: `'${process.execPath}' '${NOTIFY}'` }] };
    const windowsQuoted = { hooks: [{ type: "command", command: `"${process.execPath}" "${NOTIFY}"` }] };
    writeSettings({ Stop: [posixQuoted, windowsQuoted] });
    writeInstalledScript();

    const res = await boot();

    expect(res.retire.removed).toBe(2);
    expect(raw()).not.toContain("notify.mjs");
  });

  it("leaves the deck's own event forwarder exactly where it is", async () => {
    // Retirement and the hook install both write the `Stop` group and both know
    // a mark, and the marks are one hyphenated suffix apart. Taking out
    // `__agent-dag` along with `__agent-dag-sound` would silently stop every
    // event this deck exists to draw, on the boot that was meant to be a repair.
    writeSettings({ Stop: [ourEntry()] });
    writeInstalledScript();

    await boot();

    const forwarders = stop().filter(g => g["__agent-dag"] === true);
    expect(forwarders).toHaveLength(1);
    expect(JSON.stringify(forwarders[0])).toContain("hook.js");
  });

  it("keeps the script when some other event still names it", async () => {
    // Retirement only ever wrote a `Stop` entry, so a copy under another event is
    // the user's doing — a hand-edit, a sync tool, a merge. Deleting the file it
    // names would turn their stale sound into "Cannot find module" at the end of
    // every one of those events, which is strictly worse than the sound.
    //
    // `PreCompact` on purpose: it is not one of the events the deck installs a
    // forwarder into, so the group in the file afterwards is the user's and only
    // the user's, and the assertion is about the sweep rather than the installer.
    const elsewhere = { hooks: [{ type: "command", command: `"${process.execPath}" "${NOTIFY}"` }] };
    writeSettings({ Stop: [ourEntry()], PreCompact: [elsewhere] });
    writeInstalledScript();

    const res = await boot();

    expect(res.retire.removed).toBe(1);
    expect(settings().hooks.PreCompact).toEqual([elsewhere]);
    expect(existsSync(NOTIFY)).toBe(true);
  });

  it("survives a Stop group that is not a list at all", async () => {
    // settings.json is a file people edit. `"Stop": {}` is not something the deck
    // ever wrote and not something retirement can act on, and the answer is to
    // leave it exactly there rather than to throw or to replace it with an array.
    //
    // Through retireSoundHook rather than a boot, because the hook install has an
    // opinion about this shape of its own — it normalises the group so it has
    // somewhere to put the forwarder — and that opinion is not the one under
    // test here.
    writeSettings({ Stop: ({} as unknown) as unknown[] });
    writeInstalledScript();

    const res = await retireSoundHook();

    expect(res).toMatchObject({ ok: true, removed: 0 });
    expect(settings().hooks.Stop).toEqual({});
    // The script is litter either way — nothing in the file names it — so it
    // still goes, which is what makes this a case about not throwing rather
    // than a case about doing nothing.
    expect(existsSync(NOTIFY)).toBe(false);
  });

  it("keeps the entry, and the script, when the file cannot be parsed", async () => {
    // One trailing comma. This module rewrites the whole file, so guessing at it
    // would replace every permission and env var in it with nothing — and the
    // trigger state stays on disk, so the next boot after the repair retires it.
    const corrupt = '{\n  "model": "opus",\n}\n';
    writeFileSync(SETTINGS, corrupt, "utf8");
    writeInstalledScript();

    await expect(boot()).rejects.toThrow(/Refusing to overwrite/);

    expect(raw()).toBe(corrupt);
    expect(existsSync(NOTIFY)).toBe(true);
  });
});

describe("a machine with only a sound hook the user wrote themselves", () => {
  it("leaves it exactly where they put it", async () => {
    writeSettings({ Stop: [USER_SOUND_HOOK], PreToolUse: [USER_AUDIT_HOOK] });

    const res = await boot();

    // Nothing of the retired mechanism is on this machine, so retirement has no
    // subject — and an `afplay` line is not one. It plays a sound; that is the
    // whole of what it has in common with what was removed.
    expect(res.retire.pending).toBe(false);
    expect(stop()).toContainEqual(USER_SOUND_HOOK);
    expectUserFileIntact();
  });
});

describe("a machine with both — the upgrade this was written for", () => {
  it("takes ours out and hands theirs back, then deletes the park", async () => {
    // Exactly what turning the sound on left behind: our entry in settings.json
    // and their own hook moved into a file under ~/.agents-deck that nothing
    // else on the machine knows how to open.
    writeSettings({ Stop: [ourEntry()], PreToolUse: [USER_AUDIT_HOOK] });
    writeInstalledScript();
    writePark([USER_SOUND_HOOK]);

    const res = await boot();

    expect(res.retire).toMatchObject({ pending: true, removed: 1, restored: 1 });
    expect(raw()).not.toContain("__agent-dag-sound");
    // Byte for byte the hook they wrote, back on the event they wrote it on.
    expect(stop()).toContainEqual(USER_SOUND_HOOK);
    // The park existed to hold it. It is in settings.json now, so the holding
    // file is not a second copy to be restored again — it is litter.
    expect(existsSync(PARKED)).toBe(false);
    expectUserFileIntact();
  });

  it("hands back every parked hook, including one for another platform", async () => {
    // settings.json is commonly synced between machines, so the toggle parked
    // the Windows one as well as the macOS one. Both are the user's, and
    // choosing which of someone's hooks to give back is not the deck's call.
    const windows = {
      hooks: [{ type: "command", command: "powershell.exe -NoProfile -Command \"(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\tada.wav').PlaySync()\" || true" }],
    };
    writeSettings({ Stop: [ourEntry()] });
    writePark([windows, USER_SOUND_HOOK]);

    const res = await boot();

    expect(res.retire.restored).toBe(2);
    expect(stop()).toContainEqual(windows);
    expect(stop()).toContainEqual(USER_SOUND_HOOK);
  });

  it("does not hand the same hook back twice when it is already in the file", async () => {
    // Two decks booting at once: B read the park before A deleted it and read
    // settings after A had written the restore into it. Without this the user
    // gets their afplay hook twice and hears two sounds per turn forever.
    writeSettings({ Stop: [USER_SOUND_HOOK] });
    writePark([USER_SOUND_HOOK]);

    const res = await boot();

    expect(res.retire.restored).toBe(0);
    expect(stop().filter(g => JSON.stringify(g) === JSON.stringify(USER_SOUND_HOOK))).toHaveLength(1);
    expect(existsSync(PARKED)).toBe(false);
  });

  it("never hands back a parked entry that is one of ours", async () => {
    // The park is not supposed to hold one — the old toggle set aside hooks that
    // looked hand-written and skipped its own — but the file is years old on some
    // machines and is synced between them, and an entry naming our script with
    // the mark missing is precisely the shape a "looks hand-written" filter would
    // have swept up. Restoring it would put the broken hook back, pointing at a
    // script this release deletes, on the boot that was meant to repair it.
    writeSettings({ Stop: [ourEntry()] });
    writeInstalledScript();
    writePark([ourEntry(LEGACY), USER_SOUND_HOOK]);

    const res = await boot();

    expect(res.retire.restored).toBe(1);
    expect(stop()).toContainEqual(USER_SOUND_HOOK);
    expect(raw()).not.toContain("__agent-dag-sound");
    expect(raw()).not.toContain("notify.js");
  });

  it("still removes our entry when the parked file will not parse", async () => {
    // Two independent repairs and only one of them is urgent: our entry names a
    // script that is about to stop existing, and their hooks are safe in a file
    // that is left exactly as it is for them to fix.
    const truncated = '[\n  {\n    "hooks": [\n      { "type": "command", "comm';
    writeSettings({ Stop: [ourEntry()] });
    mkdirSync(dirname(PARKED), { recursive: true });
    writeFileSync(PARKED, truncated, "utf8");

    const res = await boot();

    expect(res.retire.removed).toBe(1);
    expect(res.retire.parkError).toMatchObject({ reason: "parked_unreadable", parkedPath: PARKED });
    expect(raw()).not.toContain("__agent-dag-sound");
    // Not deleted, not written over: the only copy of hooks a user wrote by hand.
    expect(readFileSync(PARKED, "utf8")).toBe(truncated);
  });
});

describe("a machine that never had the feature", () => {
  it("writes nothing at all on account of retirement", async () => {
    writeSettings({ PreToolUse: [USER_AUDIT_HOOK] });
    await boot();                       // the forwarders go in, which is a write
    const afterInstall = raw();

    const res = await boot();

    // Nothing left for the hook install to change either, so the whole boot is a
    // read. `pending: false` is the claim: retirement did not look past its
    // three questions, and it certainly did not touch the file.
    expect(res.retire).toEqual({ pending: false, changed: false, removed: 0, restored: 0, parkError: null });
    expect(res.changed).toBe(false);
    expect(raw()).toBe(afterInstall);
  });
});

describe("the boot after the one that retired it", () => {
  it("finds nothing to do, and does none of it again", async () => {
    writeSettings({ Stop: [ourEntry()], PreToolUse: [USER_AUDIT_HOOK] });
    writeInstalledScript();
    writePark([USER_SOUND_HOOK]);

    const first = await boot();
    expect(first.retire.pending).toBe(true);
    const afterRetirement = raw();

    const second = await boot();

    // There is no marker file to consult and none to go stale: retirement is
    // triggered by the state it removes, so once the entry, the park and the
    // script are gone the trigger is three `existsSync` calls that answer no.
    expect(second.retire).toEqual({ pending: false, changed: false, removed: 0, restored: 0, parkError: null });
    expect(second.changed).toBe(false);
    // And in particular the hook it handed back is handed back once, not on
    // every boot from here to the end of the install.
    expect(raw()).toBe(afterRetirement);
    expect(stop().filter(g => JSON.stringify(g) === JSON.stringify(USER_SOUND_HOOK))).toHaveLength(1);
  });
});
