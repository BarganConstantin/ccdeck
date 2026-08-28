// Reported: turning the sound on parked the user's own afplay/PowerShell Stop
// hooks in ~/.agents-deck/parked-sound-hooks.json and stripped them out of
// settings.json — but readParked() treated any unreadable file as "nothing was
// ever parked", so a torn parked file was written over by the next toggle and
// the status endpoint said parked:0. The hooks were gone from both files, and
// the deck reported ok.
//
// #704 deleted the toggle, and with it the writer. It did not delete the debt.
// Every machine that ever turned the sound on still has that file, holding hooks
// a person wrote by hand, and retirement is now the LAST code that will ever be
// in a position to hand them back: after it runs the park is deleted, and after
// this release ships nothing else knows the file exists. So the reading half of
// the report matters more than it did, not less. A file that will not parse must
// stop the restore and be left for repair — never counted as empty, never
// deleted, never quietly written over — because there is no second copy and no
// next toggle to try again.
//
// These pin that, plus the two things retirement adds to it: our own entry comes
// out whether or not the park can be read (two independent repairs, and only one
// of them is urgent), and a park that survives its own deletion does not hand
// the same hooks back a second time on the next boot.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The module resolves its paths at import time: settings.json from
// $CLAUDE_CONFIG_DIR (falling back to ~/.claude) and the parked-hooks file from
// os.homedir(), which reads $HOME on POSIX and %USERPROFILE% on Windows. All of
// them are pointed at a temp directory BEFORE the module is loaded, so nothing
// here can reach the real ~/.claude or ~/.agents-deck on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-park-"));
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
const mod = await import("../../server/retire-sound-hook.mjs");
const { retireSoundHook, SETTINGS_PATH, PARKED_PATH, NOTIFY_PATH } = mod;

// Belt and braces. If either path ever stopped honouring the environment, this
// file would be rewriting the developer's own settings and deleting their parked
// hooks — so fail before a single test gets the chance.
for (const p of [SETTINGS_PATH, PARKED_PATH, NOTIFY_PATH]) {
  if (!String(p).startsWith(FAKE_HOME)) {
    throw new Error(`refusing to run: retire-sound-hook resolved ${p}, outside ${FAKE_HOME}`);
  }
}

const SETTINGS = String(SETTINGS_PATH);
const PARKED = String(PARKED_PATH);
const NOTIFY = String(NOTIFY_PATH);
// The directory the parked file lives in, i.e. <fake home>/.agents-deck.
const PARK_DIR = dirname(PARKED);

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
  rmTempDir(FAKE_HOME);
});

// A hook a user wrote by hand: one OS-specific command ending in `|| true`, the
// exact thing the toggle set aside and the exact thing that went missing.
const USER_SOUND_HOOK = {
  hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff || true" }],
};
const USER_AUDIT_HOOK = { hooks: [{ type: "command", command: "audit.sh" }] };

/** The deck's own entry, as one is actually shaped on disk. */
const OUR_ENTRY = {
  "__agent-dag-sound": true,
  hooks: [{ type: "command", command: `"${process.execPath}" "${NOTIFY}"`, timeout: 5 }],
};

/** The machine an upgrade boots on: our entry in settings.json, and the user's
 *  own hook in the parked file where the toggle put it. */
function installedWithAParkedHook(): string {
  const before = JSON.stringify({
    model: "opus",
    permissions: { allow: ["Bash(git*)"] },
    hooks: { Stop: [OUR_ENTRY], PreToolUse: [USER_AUDIT_HOOK] },
  }, null, 2) + "\n";
  writeFileSync(SETTINGS, before, "utf8");
  return before;
}

const park = (text: string) => {
  mkdirSync(PARK_DIR, { recursive: true });
  writeFileSync(PARKED, text, "utf8");
};

// A read-only directory is the one way to fail the delete without also failing
// the read that precedes it. It is a no-op on Windows, where chmod only toggles
// the read-only bit, and for root, who is allowed anyway — so probe it instead
// of assuming, and skip that test rather than report a false pass.
const readOnlyDirBlocksWrites = (() => {
  const probe = mkdtempSync(join(FAKE_HOME, "ro-probe-"));
  try {
    chmodSync(probe, 0o555);
    writeFileSync(join(probe, "x"), "x");
    return false;
  } catch {
    return true;
  } finally {
    chmodSync(probe, 0o755);
    rmTempDir(probe);
  }
})();

beforeEach(() => {
  rmTempDir(PARK_DIR);
  rmSync(SETTINGS, { force: true });
});

describe("retirement and a parked file it cannot parse", () => {
  // What a kill or a full disk mid-write leaves behind: valid JSON up to the
  // point the process died, and hooks the user wrote inside it.
  const TRUNCATED = '[\n  {\n    "hooks": [\n      { "type": "command", "comm';

  it("refuses the restore rather than answering 'restored: 0' about hooks that are in there", async () => {
    installedWithAParkedHook();
    park(TRUNCATED);

    const res = await retireSoundHook();

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("parked_unreadable");
    expect(res.parkedPath).toBe(PARKED_PATH);
    expect(res.restored).toBe(0);
  });

  it("leaves the file for repair instead of deleting the only copy", async () => {
    // The one unrecoverable act available to this module. Everything else it
    // does wrong can be undone by hand from a file that is still on disk.
    installedWithAParkedHook();
    park(TRUNCATED);

    await retireSoundHook();

    expect(readFileSync(PARKED, "utf8")).toBe(TRUNCATED);
  });

  it("still takes our own entry out, because that is the urgent half", async () => {
    // Two independent repairs. Our entry names a script this release deletes and
    // Claude Code runs it at the end of every turn; the parked file is a copy of
    // hooks that are safe where they are. Holding the first hostage to the
    // second would leave a working machine broken over a file nobody has read
    // in months.
    installedWithAParkedHook();
    park(TRUNCATED);

    const res = await retireSoundHook();

    expect(res.removed).toBe(1);
    const after = JSON.parse(readFileSync(SETTINGS, "utf8"));
    expect(JSON.stringify(after)).not.toContain("__agent-dag-sound");
    expect(after.hooks.PreToolUse).toEqual([USER_AUDIT_HOOK]);
  });

  it("tries again on the next boot, having recorded nothing as done", async () => {
    installedWithAParkedHook();
    park(TRUNCATED);
    expect((await retireSoundHook()).reason).toBe("parked_unreadable");

    // Repaired by hand, exactly as the message asks.
    park(JSON.stringify([USER_SOUND_HOOK], null, 2) + "\n");
    const res = await retireSoundHook();

    expect(res).toMatchObject({ ok: true, restored: 1 });
    expect(JSON.parse(readFileSync(SETTINGS, "utf8")).hooks.Stop).toContainEqual(USER_SOUND_HOOK);
    expect(existsSync(PARKED)).toBe(false);
  });

  it("refuses a JSON object as firmly as a truncated one — that file is not ours", async () => {
    installedWithAParkedHook();
    park('{ "hooks": "this is somebody else\'s file" }\n');

    const res = await retireSoundHook();

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("parked_unreadable");
    expect(readFileSync(PARKED, "utf8")).toContain("somebody else");
  });

  it("treats a missing parked file as nothing parked, because that is what it is", async () => {
    installedWithAParkedHook();
    rmSync(PARKED, { force: true });

    const res = await retireSoundHook();

    expect(res).toMatchObject({ ok: true, removed: 1, restored: 0 });
  });
});

describe("a parked file that outlives its own deletion", () => {
  it.skipIf(!readOnlyDirBlocksWrites)("does not hand the same hooks back a second time", async () => {
    // The restore lands in settings.json and then the park is deleted, in that
    // order, because the reverse loses the hooks to a crash in between. Which
    // means the delete can fail on its own — a read-only ~/.agents-deck, a
    // Windows lock — with the hooks already safely restored. The next boot then
    // reads the same park and must recognise that everything in it is already
    // in the file. Without that, every boot from here on adds another copy and
    // the user hears one more sound per turn each time.
    installedWithAParkedHook();
    park(JSON.stringify([USER_SOUND_HOOK], null, 2) + "\n");
    chmodSync(PARK_DIR, 0o555);
    try {
      const first = await retireSoundHook();
      expect(first).toMatchObject({ ok: true, restored: 1 });
      // Undeleted, and still holding the hook that is now also in settings.json.
      expect(existsSync(PARKED)).toBe(true);

      const second = await retireSoundHook();

      expect(second.restored).toBe(0);
      const stop = JSON.parse(readFileSync(SETTINGS, "utf8")).hooks.Stop as unknown[];
      expect(stop.filter(g => JSON.stringify(g) === JSON.stringify(USER_SOUND_HOOK))).toHaveLength(1);
    } finally {
      chmodSync(PARK_DIR, 0o755);
    }
  });
});

describe("the hooks that come back", () => {
  it("come back byte for byte, on the event the user wrote them on", async () => {
    installedWithAParkedHook();
    park(JSON.stringify([USER_SOUND_HOOK], null, 2) + "\n");

    const res = await retireSoundHook();

    expect(res).toMatchObject({ ok: true, removed: 1, restored: 1 });
    const after = JSON.parse(readFileSync(SETTINGS, "utf8"));
    expect(after.hooks.Stop).toEqual([USER_SOUND_HOOK]);
    // And nothing else in the file moved to make room for them.
    expect(after.model).toBe("opus");
    expect(after.permissions).toEqual({ allow: ["Bash(git*)"] });
    expect(after.hooks.PreToolUse).toEqual([USER_AUDIT_HOOK]);
  });

  it("deletes the file and not the directory it sits in", async () => {
    // ~/.agents-deck is not the sound feature's directory. It holds the
    // self-update markers, the ccusage install and the claude-swap state, and a
    // retirement that removed the folder rather than the file would re-arm every
    // once-an-hour check and re-run every install on the next boot — for a
    // feature that has nothing to do with any of them.
    installedWithAParkedHook();
    park(JSON.stringify([USER_SOUND_HOOK], null, 2) + "\n");
    const neighbour = join(PARK_DIR, ".self-update-check");
    writeFileSync(neighbour, "checked\n", "utf8");

    expect((await retireSoundHook()).ok).toBe(true);

    expect(existsSync(PARKED)).toBe(false);
    expect(existsSync(PARK_DIR)).toBe(true);
    expect(readFileSync(neighbour, "utf8")).toBe("checked\n");
  });

  it("are not what decides whether the park is deleted — the read is", async () => {
    // An empty park is a machine that had the toggle on and no hooks of its own.
    // There is nothing to restore and the file is still litter, so it goes.
    installedWithAParkedHook();
    park("[]\n");

    const res = await retireSoundHook();

    expect(res).toMatchObject({ ok: true, restored: 0 });
    expect(existsSync(PARKED)).toBe(false);
  });
});
