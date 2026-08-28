// Reported (#541): `ccdeck --uninstall` printed "no Claude hooks to remove",
// exited 0, and left all ten `__agent-dag` forwarders sitting in the file.
//
// The cause was one line. uninstallHooks read settings.json through a
// readJsonSafe helper that turned every parse and IO failure into `null`, and
// `null` fell straight through the `if (!current?.hooks)` guard into the same
// `{changed: false}` a genuinely clean machine produces. So a settings.json with
// one stray comma — the exact file readSettingsForWrite exists to protect — was
// indistinguishable from a machine that had never installed the deck, and the
// user was told the thing they had just asked for had already happened. Node
// kept spawning on every tool call of every Claude session afterwards, for a
// deck they believed they had removed, and nothing would ever tell them
// otherwise because they had stopped looking.
//
// The other half of the same command already knew better: the sound-hook half
// reads through readSettingsForWrite and refuses out loud. One command, one
// file, two opposite verdicts, and the load-bearing one was the one that lied.
//
// So these tests pin the three things that were wrong at once, because fixing
// only the first would still ship a bug. The outcome has to be DISTINGUISHABLE
// from success — `changed: false` is the literal truth about the disk and the
// wrong answer to the question — which is why every case below asserts on `ok`
// and not on `changed`. The file has to survive byte for byte, since this
// function rewrites the whole of it and a settings.json holds every permission,
// env var and hand-written hook the user has. And the CLI has to SAY so, with
// the path, the parser's own complaint and a note that our hooks are still in
// there, on stderr and with a non-zero exit, so a script that chains off it
// stops rather than carrying on.
//
// They drive the real functions against a real temp directory rather than
// asserting on source text: the defect was a return value nobody could tell
// apart from another return value, and only running it can show that.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The installer resolves the Claude config dir once, at import time:
// CLAUDE_CONFIG_DIR when set, otherwise ~/.claude via os.homedir(), which reads
// $HOME on POSIX and %USERPROFILE% on Windows. All three are pointed at a temp
// directory BEFORE the module is loaded — and handed to the CLI child process
// below — so on no platform can this file reach the developer's own settings.
// CODEX_HOME is cleared for the same reason, so hasCodexInstalled() asks about
// a ~/.codex inside the temp home rather than a real one.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-uninstall-unreadable-"));
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
delete process.env.CODEX_HOME;

// @ts-expect-error — .mjs server module, no types
const installer = await import("../../server/installer.mjs");
const { uninstallHooks, CLAUDE_DIR } = installer as {
  uninstallHooks: (o?: { provider?: string }) => Promise<{
    ok?: boolean;
    reason?: string;
    changed: boolean;
    provider: string;
    settingsPath: string;
    why?: string;
    message?: string;
  }>;
  CLAUDE_DIR: string;
};

// Belt and braces. If homedir() or the CLAUDE_CONFIG_DIR override ever stopped
// being honoured, this file would be deleting hooks out of the developer's own
// settings.json — so fail before a single case gets the chance.
if (!String(CLAUDE_DIR).startsWith(FAKE_HOME)) {
  throw new Error(`refusing to run: installer resolved ${CLAUDE_DIR}, outside ${FAKE_HOME}`);
}

const SETTINGS = join(CLAUDE_DIR, "settings.json");
mkdirSync(CLAUDE_DIR, { recursive: true });

const DECK_CLI = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));
const CHILD_ENV = {
  ...process.env,
  HOME: FAKE_HOME,
  USERPROFILE: FAKE_HOME,
  CLAUDE_CONFIG_DIR: FAKE_CLAUDE,
};

/** Run the real `ccdeck --uninstall` and hand back everything it produced —
 *  including a non-zero status, which is now half of what is under test. */
const runUninstall = () =>
  spawnSync(process.execPath, [DECK_CLI, "--uninstall"], {
    env: CHILD_ENV,
    encoding: "utf8",
    timeout: 30_000,
  });

/** One of ours, as installHooks writes it. */
const OUR_ENTRY = {
  "__agent-dag": true,
  hooks: [{ type: "command", command: "node hook.js --provider claude", timeout: 2 }],
};
/** One of theirs, which is never ours to remove. */
const USER_ENTRY = { hooks: [{ type: "command", command: "audit.sh" }] };

// Valid-looking to a human, rejected by JSON.parse: one trailing comma, with
// our forwarders in it so "left in place" has something to be true of.
const CORRUPT = [
  "{",
  '  "model": "opus",',
  '  "permissions": { "allow": ["Bash(git*)"] },',
  '  "hooks": {',
  '    "PreToolUse": [{ "__agent-dag": true, "hooks": [{ "type": "command", "command": "node hook.js" }] }],',
  "  },",
  "}",
  "",
].join("\n");

const restore = (key: keyof typeof prevEnv, was: string | undefined) => {
  if (was === undefined) delete process.env[key];
  else process.env[key] = was;
};

beforeEach(() => {
  rmSync(SETTINGS, { force: true });
});

afterAll(() => {
  for (const key of Object.keys(prevEnv) as (keyof typeof prevEnv)[]) restore(key, prevEnv[key]);
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("uninstallHooks against a settings.json it cannot parse", () => {
  it("answers with a refusal rather than the same shape a clean machine produces", async () => {
    writeFileSync(SETTINGS, CORRUPT, "utf8");

    const res = await uninstallHooks({ provider: "claude" });

    // The whole defect in one assertion: this used to be `{changed: false}` and
    // nothing else, which is exactly what a machine with none of our hooks
    // returns. A caller had no way to tell the two apart, so it reported the
    // wrong one.
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("settings_unreadable");
    expect(res.changed).toBe(false);
  });

  it("names the file and quotes the parser, since only the user can repair it", async () => {
    writeFileSync(SETTINGS, CORRUPT, "utf8");

    const res = await uninstallHooks({ provider: "claude" });

    // toContain on a string asserts a substring, so a Windows path with its
    // backslashes is matched as-is rather than read as a regex.
    expect(res.settingsPath).toBe(SETTINGS);
    expect(res.message).toContain(SETTINGS);
    // The parser's own complaint, carried through so the user is told WHERE the
    // file went wrong and not merely that it did. `why` is the bare reason,
    // without the path and without a remedy sentence, so the CLI can phrase its
    // own advice — "run ccdeck again" is the wrong instruction for an uninstall.
    expect(res.why).toMatch(/JSON/i);
    expect(res.message).toContain(res.why!);
  });

  it("leaves the file exactly as it found it, hooks and hand-written settings alike", async () => {
    writeFileSync(SETTINGS, CORRUPT, "utf8");

    await uninstallHooks({ provider: "claude" });

    // Not one byte. This function rewrites the whole file, and a settings.json
    // holds every permission, env var, model pin and user hook there is — so a
    // read it cannot trust is a write it must not attempt.
    expect(readFileSync(SETTINGS, "utf8")).toBe(CORRUPT);
  });

  it("refuses a file that parses but is not a JSON object", async () => {
    // JSON.parse is happy with all three; none is a settings file, and treating
    // any of them as `{}` would have replaced the user's file with our hooks
    // alone on the next write.
    for (const text of ['["not", "settings"]', '"a string"', "null"]) {
      writeFileSync(SETTINGS, text, "utf8");

      const res = await uninstallHooks({ provider: "claude" });

      expect(res.ok).toBe(false);
      expect(res.reason).toBe("settings_unreadable");
      expect(readFileSync(SETTINGS, "utf8")).toBe(text);
    }
  });
});

describe("uninstallHooks against a settings.json it can read", () => {
  it("still takes our forwarders out and leaves the user's own alone", async () => {
    writeFileSync(SETTINGS, JSON.stringify({
      model: "opus",
      hooks: { PreToolUse: [OUR_ENTRY, USER_ENTRY], Stop: [OUR_ENTRY] },
    }, null, 2) + "\n", "utf8");

    const res = await uninstallHooks({ provider: "claude" });

    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    const after = JSON.parse(readFileSync(SETTINGS, "utf8"));
    expect(after.hooks.PreToolUse).toEqual([USER_ENTRY]);
    // An event group we emptied is deleted rather than left as `[]`.
    expect(after.hooks.Stop).toBeUndefined();
    expect(after.model).toBe("opus");
  });

  it("reports changed:false only when the file genuinely holds none of ours", async () => {
    const plain = JSON.stringify({ hooks: { PreToolUse: [USER_ENTRY] } }, null, 2) + "\n";
    writeFileSync(SETTINGS, plain, "utf8");

    const res = await uninstallHooks({ provider: "claude" });

    // The answer the refusal above must never be confused with: ok, nothing of
    // ours was there, and nothing was written.
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(readFileSync(SETTINGS, "utf8")).toBe(plain);
  });

  it("treats a settings.json that is not there at all as nothing to remove", async () => {
    // ENOENT is the one read failure that really does mean "empty", and it has
    // to stay on the success side or every machine without a settings.json
    // would be told its uninstall failed.
    const res = await uninstallHooks({ provider: "claude" });

    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
  });
});

describe("`ccdeck --uninstall` when settings.json will not parse", () => {
  it("exits non-zero and says what is still installed, instead of claiming there was nothing", async () => {
    writeFileSync(SETTINGS, CORRUPT, "utf8");

    const run = runUninstall();
    const out = `${run.stdout}${run.stderr}`;

    // The sentence the user actually got, and the reason they stopped looking.
    expect(run.stdout).not.toContain("no Claude hooks to remove");
    // Named, diagnosed, and explicit about what is still firing.
    expect(run.stderr).toContain(SETTINGS);
    expect(run.stderr).toContain("NOT removed");
    expect(run.stderr).toContain("__agent-dag");
    expect(run.stderr).toContain("--uninstall");
    // Non-zero, so `ccdeck --uninstall && …` and every CI step around it stops
    // here rather than carrying on as though the hooks were gone.
    expect(run.status).not.toBe(0);
    // And after all that, the file is still theirs.
    expect(readFileSync(SETTINGS, "utf8")).toBe(CORRUPT);
    // Nothing crashed on the way — a stack trace is not a diagnosis.
    expect(out).not.toContain("Error: ");
  }, 30_000);

  it("still reports and exits clean when the file parses", async () => {
    writeFileSync(SETTINGS, JSON.stringify({
      hooks: { PreToolUse: [OUR_ENTRY] },
    }, null, 2) + "\n", "utf8");

    const run = runUninstall();

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`hooks removed from ${SETTINGS}`);
    expect(readFileSync(SETTINGS, "utf8")).not.toContain("__agent-dag");
  }, 30_000);
});
