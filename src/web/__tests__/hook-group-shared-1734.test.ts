// A hook the user added through Claude Code, filed inside the deck's own group.
//
// The installer writes one group per event, `{ "__agent-dag": true, hooks:
// [<forwarder>] }`, with no matcher. Claude Code's own hook editor adds a
// matcher-less hook — any Stop, SubagentStop, UserPromptSubmit or SessionEnd
// hook, a match-everything PreToolUse one — to the first group for that event
// whose matcher is missing or empty, and on a machine where the user has no hook
// of their own for that event yet, that group is ours.
//
// Ownership used to be decided per GROUP: marked, or holding one command that
// named our hook.js, and the whole group went. So the next ordinary start
// rewrote settings.json without the user's hook, printed nothing, and a sound
// went quiet or a PreToolUse guard stopped guarding. `--uninstall` did the same.
// Now it is decided per COMMAND: our forwarder leaves, everything beside it
// stays where it was, in a group with the same matcher and without our mark.
//
// TEMP HOME, set before the installer is imported, because it resolves the
// Claude config dir at module load. The pattern is unmarked-hook-entries'.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-shared-group-"));
// Named `.claude`, like the default one, because that name is half of what
// used to make a group ours: a command naming `.claude/agent-dag/hook.js`.
const FAKE_CLAUDE = join(DIR, ".claude");
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE;
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — plain .mjs module, no types
const installer = await import("../../server/installer.mjs");
const { CLAUDE_DIR, installHooks, uninstallHooks } = installer as {
  CLAUDE_DIR: string;
  installHooks: (o: { provider: string }) => Promise<{ changed: boolean }>;
  uninstallHooks: (o: { provider: string }) => Promise<{ ok: boolean; changed: boolean }>;
};

// Belt and braces: an installer that stopped honouring the environment would be
// rewriting the developer's own settings.json from here.
if (!resolve(CLAUDE_DIR).startsWith(resolve(DIR))) {
  throw new Error(`refusing to run: installer resolved ${CLAUDE_DIR}, outside ${DIR}`);
}

const SETTINGS = join(CLAUDE_DIR, "settings.json");

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(DIR);
});

type Hook = { type?: string; command?: unknown; timeout?: number };
type Group = { matcher?: string; hooks?: Hook[]; [k: string]: unknown };
type Settings = { model?: string; hooks: Record<string, Group[]> };

const read = (): Settings => JSON.parse(readFileSync(SETTINGS, "utf8"));
const write = (s: unknown) => writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n");
const commands = (groups: Group[] = []) => groups.flatMap(g => (g.hooks ?? []).map(h => String(h.command)));
// Either separator: on Windows the forwarder's path is spelled with backslashes.
const forwarders = (groups: Group[] = []) => commands(groups).filter(c => /agent-dag[\\/]hook\.js/.test(c));

const AFPLAY = { type: "command", command: "afplay x" };
const GUARD = { type: "command", command: "/usr/local/bin/my-guard.sh" };

beforeEach(() => {
  rmSync(SETTINGS, { force: true });
  mkdirSync(CLAUDE_DIR, { recursive: true });
  // A real setting, so a rewrite that lost the rest of the file shows here too.
  write({ model: "opus" });
});

/** What Claude Code's editor does with a matcher-less Stop hook on a machine
 *  that has only ours: it pushes it into the first group with no matcher. */
async function userAddsStopHookTheWayClaudeCodeDoes() {
  await installHooks({ provider: "claude" });
  const s = read();
  expect(s.hooks.Stop).toHaveLength(1);
  expect(s.hooks.Stop[0].matcher).toBeUndefined();
  s.hooks.Stop[0].hooks!.push(AFPLAY);
  write(s);
}

describe("a matcher-less hook Claude Code filed inside our group", () => {
  it("is still there after the next start, beside exactly one forwarder", async () => {
    await userAddsStopHookTheWayClaudeCodeDoes();

    await installHooks({ provider: "claude" });

    const stop = read().hooks.Stop;
    expect(commands(stop).filter(c => c === "afplay x")).toHaveLength(1);
    expect(forwarders(stop)).toHaveLength(1);
    // In a group of its own now, carrying no mark: the next pass must not read
    // the user's hook as ours by the group it sits in.
    const theirs = stop.find(g => commands([g]).includes("afplay x"))!;
    expect(theirs).toEqual({ hooks: [AFPLAY] });
    // Before ours, where it was, and ours still last.
    expect(stop[stop.length - 1]).toMatchObject({ "__agent-dag": true });
    expect(read().model).toBe("opus");
  });

  it("converges: the start after that writes nothing", async () => {
    await userAddsStopHookTheWayClaudeCodeDoes();
    await installHooks({ provider: "claude" });
    const settled = readFileSync(SETTINGS, "utf8");

    expect(await installHooks({ provider: "claude" })).toMatchObject({ changed: false });
    expect(readFileSync(SETTINGS, "utf8")).toBe(settled);
  });

  it("survives --uninstall, after a start or straight out of the shared group", async () => {
    await userAddsStopHookTheWayClaudeCodeDoes();
    await installHooks({ provider: "claude" });
    expect(await uninstallHooks({ provider: "claude" })).toMatchObject({ ok: true, changed: true });
    expect(read().hooks.Stop).toEqual([{ hooks: [AFPLAY] }]);
    expect(forwarders(Object.values(read().hooks).flat())).toEqual([]);

    // The same machine, uninstalled before any start had split the group.
    write({ model: "opus" });
    await userAddsStopHookTheWayClaudeCodeDoes();
    expect(await uninstallHooks({ provider: "claude" })).toMatchObject({ ok: true, changed: true });
    expect(read().hooks.Stop).toEqual([{ hooks: [AFPLAY] }]);
    expect(forwarders(Object.values(read().hooks).flat())).toEqual([]);
  });
});

describe("a group with its own matcher that also runs our forwarder", () => {
  /** The user's guard and our forwarder in one `Bash` group, between two
   *  groups that are the user's alone. */
  async function seedSharedBashGroup() {
    await installHooks({ provider: "claude" });
    const s = read();
    const forwarder = s.hooks.PreToolUse[0].hooks![0];
    s.hooks.PreToolUse = [
      { matcher: "Edit", hooks: [{ type: "command", command: "first.sh" }] },
      { matcher: "Bash", hooks: [GUARD, forwarder] },
      { matcher: "Write", hooks: [{ type: "command", command: "last.sh" }] },
    ];
    write(s);
  }

  it("keeps the guard, its matcher and the order of the user's groups on a start", async () => {
    await seedSharedBashGroup();

    await installHooks({ provider: "claude" });

    const pre = read().hooks.PreToolUse;
    expect(pre.slice(0, 3)).toEqual([
      { matcher: "Edit", hooks: [{ type: "command", command: "first.sh" }] },
      { matcher: "Bash", hooks: [GUARD] },
      { matcher: "Write", hooks: [{ type: "command", command: "last.sh" }] },
    ]);
    expect(pre).toHaveLength(4);
    expect(pre[3]).toMatchObject({ "__agent-dag": true });
    expect(forwarders(pre)).toHaveLength(1);
  });

  it("keeps the guard on --uninstall, and takes only the forwarder", async () => {
    await seedSharedBashGroup();

    expect(await uninstallHooks({ provider: "claude" })).toMatchObject({ ok: true, changed: true });

    expect(read().hooks.PreToolUse).toEqual([
      { matcher: "Edit", hooks: [{ type: "command", command: "first.sh" }] },
      { matcher: "Bash", hooks: [GUARD] },
      { matcher: "Write", hooks: [{ type: "command", command: "last.sh" }] },
    ]);
  });
});
