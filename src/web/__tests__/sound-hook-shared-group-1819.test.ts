// A Stop hook the user added through Claude Code, filed inside the old
// finish-sound toggle's own group.
//
// The toggle wrote one matcher-less `Stop` group, `{ "__agent-dag-sound": true,
// hooks: [<node> <agent-dag/notify.mjs>] }`. Claude Code's hook editor files a
// new matcher-less Stop hook into the first matcher-less Stop group it finds,
// and while the toggle was on that group was often the deck's. Retirement used
// to decide ownership for the whole GROUP — marked, or one command naming our
// script — and drop every command in it, so the boot that retired the toggle,
// and `--uninstall`, took the user's hook with it and printed nothing.
//
// Now it is decided per COMMAND, the rule installer.mjs follows for its own
// forwarder (#1734): our sound command leaves, everything beside it stays, in a
// group with the same matcher, in the same order, without our mark.
//
// TEMP HOME, set before the module is imported, because it resolves
// settings.json from $CLAUDE_CONFIG_DIR and the parked-hooks file from
// os.homedir() at load. The guard below refuses to run if either escapes.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-sound-shared-"));
const FAKE_CLAUDE = join(FAKE_HOME, ".claude");
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE;
process.env.CODEX_HOME = join(FAKE_HOME, ".codex");

// @ts-expect-error — .mjs server module, no types
const retirement = await import("../../server/retire-sound-hook.mjs");
const { retireSoundHookIn, retireSoundHook, SETTINGS_PATH, PARKED_PATH, NOTIFY_PATH } = retirement as {
  retireSoundHookIn: (s: Settings) => Promise<{ changed: boolean; removed: number; restored: number }>;
  retireSoundHook: () => Promise<{ ok: boolean; removed: number; restored: number }>;
  SETTINGS_PATH: string;
  PARKED_PATH: string;
  NOTIFY_PATH: string;
};

// Belt and braces: these are the developer's own settings and parked hooks if
// the module ever stops honouring the environment.
for (const p of [SETTINGS_PATH, PARKED_PATH, NOTIFY_PATH]) {
  if (!resolve(String(p)).startsWith(resolve(FAKE_HOME))) {
    throw new Error(`refusing to run: retire-sound-hook resolved ${p}, outside ${FAKE_HOME}`);
  }
}

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(FAKE_HOME);
});

type Hook = { type?: string; command?: unknown; timeout?: number };
type Group = { matcher?: string; hooks?: Hook[]; [k: string]: unknown };
type Settings = { model?: string; hooks?: Record<string, Group[]> };

const SETTINGS = String(SETTINGS_PATH);
const PARKED = String(PARKED_PATH);

/** The deck's own sound command, shaped the way the toggle wrote it. */
const OUR_SOUND = { type: "command", command: `"${process.execPath}" "${NOTIFY_PATH}"`, timeout: 5 };
/** The same command in a settings.json synced from a Windows machine. */
const OUR_SOUND_FROM_WINDOWS = {
  type: "command",
  command: `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\bob\\.claude\\agent-dag\\notify.mjs"`,
  timeout: 5,
};
const AFPLAY = { type: "command", command: "afplay /System/Library/Sounds/Glass.aiff" };
const LOG = { type: "command", command: "/usr/local/bin/log-turn.sh" };

const read = (): Settings => JSON.parse(readFileSync(SETTINGS, "utf8"));
const write = (s: Settings) => writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n");

beforeEach(() => {
  rmSync(SETTINGS, { force: true });
  rmSync(PARKED, { force: true });
  mkdirSync(FAKE_CLAUDE, { recursive: true });
});

describe("a hook Claude Code filed inside the sound toggle's group", () => {
  it("stays, alone in the group and without the mark, when retirement runs", async () => {
    const settings: Settings = { hooks: { Stop: [{ "__agent-dag-sound": true, hooks: [OUR_SOUND, AFPLAY] }] } };

    const res = await retireSoundHookIn(settings);

    expect(res.changed).toBe(true);
    expect(settings.hooks?.Stop).toEqual([{ hooks: [AFPLAY] }]);
  });

  it("keeps its matcher and its place among the user's other groups", async () => {
    const before = { matcher: "", hooks: [LOG] };
    const after = { hooks: [{ type: "command", command: "last.sh" }] };
    const settings: Settings = {
      hooks: { Stop: [before, { matcher: "", "__agent-dag-sound": true, hooks: [AFPLAY, OUR_SOUND, LOG] }, after] },
    };

    await retireSoundHookIn(settings);

    expect(settings.hooks?.Stop).toEqual([before, { matcher: "", hooks: [AFPLAY, LOG] }, after]);
  });

  it("survives `--uninstall`, which runs the same retirement on the file", async () => {
    write({ model: "opus", hooks: { Stop: [{ "__agent-dag-sound": true, hooks: [OUR_SOUND, AFPLAY] }] } });

    const res = await retireSoundHook();

    expect(res).toMatchObject({ ok: true, removed: 1, restored: 0 });
    expect(read()).toEqual({ model: "opus", hooks: { Stop: [{ hooks: [AFPLAY] }] } });
  });

  it("stays beside an unmarked entry too, where only the script says it is ours", async () => {
    const settings: Settings = { hooks: { Stop: [{ hooks: [OUR_SOUND, AFPLAY] }] } };

    await retireSoundHookIn(settings);

    expect(settings.hooks?.Stop).toEqual([{ hooks: [AFPLAY] }]);
  });

  it("stays when our command was synced from another platform and only the mark knows it", async () => {
    // A Windows path on a POSIX machine is not a path here at all; the mark is
    // what says the command beside the user's is ours to take out.
    const settings: Settings = {
      hooks: { Stop: [{ "__agent-dag-sound": true, hooks: [OUR_SOUND_FROM_WINDOWS, AFPLAY] }] },
    };

    await retireSoundHookIn(settings);

    expect(settings.hooks?.Stop).toEqual([{ hooks: [AFPLAY] }]);
  });

  it("is handed back from the park without our command beside it", async () => {
    // The toggle parked whole groups, so a hook sitting beside our script in an
    // unmarked group went into the park with it.
    mkdirSync(dirname(PARKED), { recursive: true });
    writeFileSync(PARKED, JSON.stringify([{ hooks: [OUR_SOUND, AFPLAY] }]));
    const settings: Settings = { hooks: { Stop: [{ "__agent-dag-sound": true, hooks: [OUR_SOUND] }] } };

    const res = await retireSoundHookIn(settings);

    expect(res).toMatchObject({ removed: 1, restored: 1 });
    expect(settings.hooks?.Stop).toEqual([{ hooks: [AFPLAY] }]);
    expect(existsSync(PARKED)).toBe(true);   // deleted only after the write lands
  });
});

describe("a group that is ours alone", () => {
  it("still goes whole, and Stop with it when nothing else is left", async () => {
    const settings: Settings = { model: "opus", hooks: { Stop: [{ "__agent-dag-sound": true, hooks: [OUR_SOUND] }] } };

    const res = await retireSoundHookIn(settings);

    expect(res).toMatchObject({ changed: true, removed: 1 });
    expect(settings).toEqual({ model: "opus", hooks: {} });
  });
});
