// Skill activity's UserPromptExpansion entry, its off switch and its gate.
//
// Up to Claude Code 2.1.100 an unknown hook event name made it ignore the WHOLE
// settings.json; 2.1.101 stopped that, and UserPromptExpansion itself arrived in
// 2.1.116 (skill-hook.mjs has the evidence). So the entry goes in only when the
// deck was not started with AGENTS_DECK_SKILL_HOOK turned off AND every Claude
// Code found says it is 2.1.116 or newer — and it never may cost the user a
// byte of their own settings.
//
// The installs are real files under a temp directory: npm layouts read off disk,
// and wrapper scripts the gate has to ask `--version`, run for real by full
// path. The installer runs against a temp HOME and CLAUDE_CONFIG_DIR, the way
// stop-failure-install-2185 runs it.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { parseWindowsArgv } from "./windows-command-line";

// Resolved, because the version is read through the install's realpath and
// macOS's temp directory is a link (/var → /private/var): the fakes have to be
// recognised under the name the deck will see them by.
const DIR = realpathSync(mkdtempSync(join(tmpdir(), "ccdeck-skill-hook-fp03-")));
const FAKE = join(DIR, "fake");
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  AGENTS_DECK_SKILL_HOOK: process.env.AGENTS_DECK_SKILL_HOOK,
  AGENTS_DECK_CLAUDE: process.env.AGENTS_DECK_CLAUDE,
};
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, ".claude");
process.env.CODEX_HOME = join(DIR, "codex");
// The default under test is the one a person gets: nothing set. And no
// configured claude of the machine running the suite gets asked anything.
delete process.env.AGENTS_DECK_SKILL_HOOK;
delete process.env.AGENTS_DECK_CLAUDE;

// @ts-expect-error — plain .mjs module, no types
const installer = await import("../../server/installer.mjs");
// @ts-expect-error — plain .mjs module, no types
const gate = await import("../../server/skill-hook.mjs");
// @ts-expect-error — plain .mjs module, no types
const claudeDir = await import("../../server/claude-dir.mjs");

type Install = { bin: string; version?: string };
type Decision = { install: boolean; state: string; reason?: string; since: string; versions: (string | null)[]; backup?: string };
type RunResult = { ok: boolean; stdout?: string; stderr?: string };
type SkillOptions = {
  env?: Record<string, string | undefined>; enabled?: boolean; installs?: Install[];
  runImpl?: (cmd: string, args: string[], o: object) => Promise<RunResult>; timeout?: number;
};
type InstallResult = { changed: boolean; raced?: boolean; events: string[]; skillHook?: Decision };

const { CLAUDE_DIR, installHooks, uninstallHooks, skillHookState, SKILL_HOOK_BACKUP } = installer as {
  CLAUDE_DIR: string;
  SKILL_HOOK_BACKUP: string;
  skillHookState: (env?: Record<string, string | undefined>) => Promise<"on" | "off" | "skipped">;
  installHooks: (o: { provider: string; claudeVersions?: string[]; skillHook?: SkillOptions; beforeWrite?: () => Promise<void> }) => Promise<InstallResult>;
  uninstallHooks: (o: { provider: string; beforeWrite?: () => Promise<void> }) => Promise<{ ok: boolean; changed: boolean }>;
};
const {
  SKILL_HOOK_SINCE, USER_PROMPT_EXPANSION_SINCE, UNKNOWN_EVENT_TOLERATED_SINCE, SKILL_HOOK_ENV,
  skillHookEnabled, skillHookDecision, parseClaudeVersionOutput, skillHookStatus,
} = gate as {
  SKILL_HOOK_SINCE: string; USER_PROMPT_EXPANSION_SINCE: string; UNKNOWN_EVENT_TOLERATED_SINCE: string; SKILL_HOOK_ENV: string;
  skillHookEnabled: (env?: Record<string, string | undefined>) => boolean;
  skillHookDecision: (o?: SkillOptions) => Promise<Decision>;
  parseClaudeVersionOutput: (t: unknown) => string | undefined;
  skillHookStatus: (d: Decision | null, dash?: string) => { ok: boolean; detail: string } | null;
};
const { claudeCodeInstalls } = claudeDir as {
  claudeCodeInstalls: (o: { env: Record<string, string>; home: string; exists: (p: string) => boolean }) => Install[];
};

// An installer that stopped honouring the environment would be rewriting the
// developer's own settings.json from here.
if (!resolve(CLAUDE_DIR).startsWith(resolve(DIR))) {
  throw new Error(`refusing to run: installer resolved ${CLAUDE_DIR}, outside ${DIR}`);
}

const SETTINGS = join(CLAUDE_DIR, "settings.json");
const BACKUP = join(CLAUDE_DIR, "agent-dag", SKILL_HOOK_BACKUP);
const WIN = process.platform === "win32";

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(DIR);
});

// ------------------------------------------------------------ fake Claude Codes

let seq = 0;

/** An npm install of Claude Code at `version`, laid out the way `npm i -g`
 *  lays it out, and the directory to put on PATH for it. */
function npmInstall(version: string): string {
  const prefix = join(FAKE, `npm-${++seq}`);
  if (WIN) {
    // npm's Windows shim, with the package in the node_modules beside it.
    const pkg = join(prefix, "node_modules", "@anthropic-ai", "claude-code");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version }));
    writeFileSync(join(prefix, "claude.cmd"), "@echo off\r\nexit /b 1\r\n");
    return prefix;
  }
  const pkg = join(prefix, "lib", "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version }));
  // Empty and not executable: it is never meant to run.
  writeFileSync(join(pkg, "cli.js"), "");
  mkdirSync(join(prefix, "bin"));
  symlinkSync(join(pkg, "cli.js"), join(prefix, "bin", "claude"));
  return join(prefix, "bin");
}

/** A `claude` whose layout names no version — a wrapper — that answers
 *  `--version` with `output` and exits `code`, after `sleep` seconds, and
 *  writes the arguments it was given to the file returned. */
function wrapper(output: string, { code = 0, sleep = 0 } = {}): { dir: string; argv: string } {
  const dir = join(FAKE, `wrap-${++seq}`);
  mkdirSync(dir, { recursive: true });
  const argv = join(dir, "argv.txt");
  if (WIN) {
    const wait = sleep ? `ping -n ${sleep + 1} 127.0.0.1 >nul\r\n` : "";
    writeFileSync(join(dir, "claude.cmd"), `@echo off\r\necho %*> "${argv}"\r\n${wait}echo ${output}\r\nexit /b ${code}\r\n`);
  } else {
    const bin = join(dir, "claude");
    const wait = sleep ? `sleep ${sleep}\n` : "";
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\n${wait}printf '%s\\n' '${output}'\nexit ${code}\n`);
    chmodSync(bin, 0o755);
  }
  return { dir, argv };
}

/** The arguments a wrapper was started with, as the program itself reads them.
 *  On POSIX printf wrote one per line. On Windows the .cmd echoed its `%*`, and
 *  the deck reaches a .cmd through cmd.exe with every argument quoted (viaCmd
 *  in exec.mjs), so that line still holds the quotes: parsing it the way a
 *  program parses its command line takes them off, as Claude Code's own shim
 *  does when it hands `%*` on to node. */
function argvOf(w: { argv: string }): string[] {
  const text = readFileSync(w.argv, "utf8").replace(/\r?\n$/, "");
  return WIN ? parseWindowsArgv(text.trim()) : text.split("\n");
}

/** What the deck finds with exactly these directories on PATH, and nothing
 *  from the machine running the suite: the absolute candidates the deck also
 *  checks (/usr/local/bin/claude, ~/.local/bin/claude…) are only seen inside
 *  the temp directory. */
function found(...pathDirs: string[]): Install[] {
  return claudeCodeInstalls({
    env: { PATH: pathDirs.join(delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    home: join(DIR, "nobody-home"),
    exists: (p: string) => resolve(p).startsWith(resolve(FAKE)) && existsSync(p),
  });
}

/** A run() that must never be called. */
const noSpawn = () => vi.fn(async () => { throw new Error("spawned"); });

// ---------------------------------------------------------------- the gate

describe("the version the gate asks for", () => {
  it("is 2.1.116: the later of the event's arrival and the end of whole-file rejection", () => {
    expect(USER_PROMPT_EXPANSION_SINCE).toBe("2.1.116");
    expect(UNKNOWN_EVENT_TOLERATED_SINCE).toBe("2.1.101");
    expect(SKILL_HOOK_SINCE).toBe("2.1.116");
  });
});

describe("the switch", () => {
  it("is on unless the variable says otherwise: only unset, empty or exactly 1 leaves it on", () => {
    expect(SKILL_HOOK_ENV).toBe("AGENTS_DECK_SKILL_HOOK");
    expect(skillHookEnabled({})).toBe(true);
    expect(skillHookEnabled({ AGENTS_DECK_SKILL_HOOK: "" })).toBe(true);
    expect(skillHookEnabled({ AGENTS_DECK_SKILL_HOOK: "1" })).toBe(true);
    for (const v of ["0", "false", "off", "no", "true", "yes", " 1", "1 ", "01", "on"]) {
      expect(skillHookEnabled({ AGENTS_DECK_SKILL_HOOK: v }), JSON.stringify(v)).toBe(false);
    }
  });

  it("off, decides without looking at the machine or running anything", async () => {
    const runImpl = noSpawn();
    const d = await skillHookDecision({ enabled: false, installs: [{ bin: "/nowhere/claude" }], runImpl });
    expect(d).toMatchObject({ install: false, state: "off", reason: "turned-off" });
    expect(runImpl).not.toHaveBeenCalled();
  });
});

describe("Claude Code's own --version line", () => {
  it("is believed only in the shape Claude Code prints", () => {
    expect(parseClaudeVersionOutput("2.1.116 (Claude Code)\n")).toBe("2.1.116");
    expect(parseClaudeVersionOutput("\n  2.1.306 (Claude Code)  \r\n")).toBe("2.1.306");
    expect(parseClaudeVersionOutput("2.1.120-beta.1 (Claude Code)")).toBe("2.1.120-beta.1");
    for (const t of ["", "2.1.116", "claude 2.1.116", "Claude Code (dev build)", "v2.1.116 (Claude Code)",
      "2.1 (Claude Code)", "update available\n2.1.116 (Claude Code)", null, undefined, 42]) {
      expect(parseClaudeVersionOutput(t), String(t)).toBeUndefined();
    }
  });
});

describe("the decision on a machine laid out on disk", () => {
  it("refuses below the gate, both where the whole file would be lost and where the entry is merely unknown", async () => {
    for (const v of ["2.0.77", "2.1.78", "2.1.100", "2.1.101", "2.1.114"]) {
      const d = await skillHookDecision({ enabled: true, installs: found(npmInstall(v)), runImpl: noSpawn() });
      expect(d, v).toMatchObject({ install: false, state: "skipped", reason: "too-old", versions: [v] });
    }
  });

  it("installs at the gate and above, read off disk with nothing run", async () => {
    for (const v of ["2.1.116", "2.1.117", "2.1.306", "2.2.0", "3.0.0"]) {
      const runImpl = noSpawn();
      const d = await skillHookDecision({ enabled: true, installs: found(npmInstall(v)), runImpl });
      expect(d, v).toMatchObject({ install: true, state: "on", versions: [v] });
      expect(runImpl, v).not.toHaveBeenCalled();
    }
  });

  it("refuses when ANY Claude Code found is older, since an old one still reads the same file", async () => {
    const d = await skillHookDecision({ enabled: true, installs: found(npmInstall("2.1.306"), npmInstall("2.1.114")), runImpl: noSpawn() });
    expect(d).toMatchObject({ install: false, reason: "too-old" });
    expect([...d.versions].sort()).toEqual(["2.1.114", "2.1.306"]);
  });

  it("refuses when Claude Code is missing, and runs nothing", async () => {
    const empty = join(FAKE, `empty-${++seq}`);
    mkdirSync(empty, { recursive: true });
    const runImpl = noSpawn();
    expect(found(empty)).toEqual([]);
    expect(await skillHookDecision({ enabled: true, installs: found(empty), runImpl }))
      .toMatchObject({ install: false, state: "skipped", reason: "no-claude" });
    expect(runImpl).not.toHaveBeenCalled();
  });

  it("refuses an unparseable version in the package, once the binary cannot say either", async () => {
    // "banana" is no version, so the gate asks the binary; this one is an empty
    // file that cannot run, which is no answer.
    const d = await skillHookDecision({ enabled: true, installs: found(npmInstall("banana")) });
    expect(d).toMatchObject({ install: false, state: "skipped", reason: "version-unknown", versions: [null] });
  });
});

describe("a claude whose layout does not say, asked --version", () => {
  it("installs when it answers as Claude Code at or above the gate, asked by full path with only --version", async () => {
    for (const out of ["2.1.116 (Claude Code)", "2.1.306 (Claude Code)"]) {
      const w = wrapper(out);
      const d = await skillHookDecision({ enabled: true, installs: found(w.dir) });
      expect(d, out).toMatchObject({ install: true, state: "on" });
      expect(argvOf(w)).toEqual(["--version"]);
    }
  });

  it("refuses when it answers as an older Claude Code", async () => {
    for (const out of ["2.1.100 (Claude Code)", "2.1.114 (Claude Code)"]) {
      const d = await skillHookDecision({ enabled: true, installs: found(wrapper(out).dir) });
      expect(d, out).toMatchObject({ install: false, reason: "too-old" });
    }
  });

  it("refuses an unparseable answer, a failed one and a slow one", async () => {
    const cases = [
      wrapper("Claude Code (dev build)"),
      wrapper("2.1.300"),
      wrapper("my-wrapper 9.9.9"),
      wrapper("2.1.300 (Claude Code)", { code: 1 }),
    ];
    for (const w of cases) {
      expect(await skillHookDecision({ enabled: true, installs: found(w.dir) }))
        .toMatchObject({ install: false, state: "skipped", reason: "version-unknown", versions: [null] });
    }
    const slow = wrapper("2.1.300 (Claude Code)", { sleep: 5 });
    const t0 = Date.now();
    expect(await skillHookDecision({ enabled: true, installs: found(slow.dir), timeout: 300 }))
      .toMatchObject({ install: false, reason: "version-unknown" });
    expect(Date.now() - t0).toBeLessThan(4_000);
  });

  it("refuses when one install says and another cannot", async () => {
    const d = await skillHookDecision({ enabled: true, installs: found(npmInstall("2.1.306"), wrapper("dev").dir) });
    expect(d).toMatchObject({ install: false, reason: "version-unknown" });
  });
});

describe("the claude AGENTS_DECK_CLAUDE names", () => {
  const binOf = (dir: string) => join(dir, WIN ? "claude.cmd" : "claude");

  it("is one more Claude Code reading the file: an old one there refuses, whatever else is found", async () => {
    const old = binOf(wrapper("2.1.100 (Claude Code)").dir);
    const d = await skillHookDecision({ env: { AGENTS_DECK_CLAUDE: old }, enabled: true, installs: found(npmInstall("2.1.306")) });
    expect(d).toMatchObject({ install: false, reason: "too-old" });
    expect([...d.versions].sort()).toEqual(["2.1.100", "2.1.306"]);
  });

  it("is enough on its own when it answers at the gate", async () => {
    const w = wrapper("2.1.116 (Claude Code)");
    const d = await skillHookDecision({ env: { AGENTS_DECK_CLAUDE: binOf(w.dir) }, enabled: true, installs: [] });
    expect(d).toMatchObject({ install: true, state: "on", versions: ["2.1.116"] });
    expect(argvOf(w)).toEqual(["--version"]);
  });

  it("is not asked anything when the entry is turned off", async () => {
    const w = wrapper("2.1.306 (Claude Code)");
    const d = await skillHookDecision({ env: { AGENTS_DECK_CLAUDE: binOf(w.dir), AGENTS_DECK_SKILL_HOOK: "0" }, installs: [] });
    expect(d).toMatchObject({ install: false, state: "off" });
    expect(existsSync(w.argv)).toBe(false);
  });
});

// ------------------------------------------------------------- the installer

type Hook = { type?: string; command?: unknown; timeout?: number };
type Group = { matcher?: string; hooks?: Hook[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, Group[]>; [k: string]: unknown };

const text = (): string => readFileSync(SETTINGS, "utf8");
const read = (): Settings => JSON.parse(text());
const canonical = (s: unknown) => JSON.stringify(s, null, 2) + "\n";
const writeText = (t: string) => writeFileSync(SETTINGS, t);
const forwarders = (groups: Group[] = []) =>
  groups.flatMap(g => (g.hooks ?? []).map(h => String(h.command))).filter(c => /agent-dag[\\/]hook\.js/.test(c));

/** Every StopFailure decision below is pinned, so nothing reads this machine's
 *  own Claude Code: claudeVersions is the StopFailure gate's input. */
const PINNED = ["2.1.306"];
const ON = (installs: Install[] = found(npmInstall("2.1.306"))): SkillOptions => ({ enabled: true, installs, runImpl: noSpawn() });
const OFF: SkillOptions = { enabled: false };
const install = (skillHook?: SkillOptions, extra: object = {}) =>
  installHooks({ provider: "claude", claudeVersions: PINNED, ...(skillHook ? { skillHook } : {}), ...extra });

const MINE_UPE: Group = { matcher: "deploy", hooks: [{ type: "command", command: "/usr/local/bin/audit-deploy.sh" }] };

/** A settings.json in Claude Code's own layout, with something of the user's
 *  under every kind of key — including their own UserPromptExpansion hook, and
 *  keys no version of the deck knows. */
const ORIGINAL = canonical({
  model: "opus",
  permissions: { allow: ["Bash(git status)"], deny: ["Read(./.env)"], defaultMode: "acceptEdits" },
  env: { MY_FLAG: "1" },
  futureKey: { nested: [1, 2.5, { deep: true, none: null }], text: "ünïcødé ✓ \"quoted\"" },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/guard.sh", timeout: 10 }] }],
    UserPromptExpansion: [MINE_UPE],
    SomeFutureEvent: [{ hooks: [{ type: "command", command: "/usr/local/bin/future.sh" }] }],
  },
  statusLine: { type: "command", command: "~/.claude/statusline.sh" },
});

/** The settings with our UserPromptExpansion forwarder taken out, and the key
 *  with it if nothing of the user's is left. */
function withoutOurExpansion(s: Settings): Settings {
  const copy: Settings = JSON.parse(JSON.stringify(s));
  const groups = copy.hooks?.UserPromptExpansion;
  if (!groups) return copy;
  const kept = groups.filter(g => g["__agent-dag"] !== true);
  if (kept.length === 0) delete copy.hooks!.UserPromptExpansion;
  else copy.hooks!.UserPromptExpansion = kept;
  return copy;
}

/** The lines `b` has that `a` does not, once their common head and tail are
 *  set aside, and the lines of `a` in that same window. */
function changedWindow(a: string, b: string) {
  const al = a.split("\n"), bl = b.split("\n");
  let head = 0;
  while (head < al.length && head < bl.length && al[head] === bl[head]) head++;
  let tail = 0;
  while (tail < al.length - head && tail < bl.length - head && al[al.length - 1 - tail] === bl[bl.length - 1 - tail]) tail++;
  return { a: al.slice(head, al.length - tail), b: bl.slice(head, bl.length - tail) };
}

beforeEach(() => {
  rmSync(SETTINGS, { force: true });
  rmSync(BACKUP, { force: true });
  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeText(ORIGINAL);
  delete process.env.AGENTS_DECK_SKILL_HOOK;
});

describe("the default", () => {
  it("installs the UserPromptExpansion entry at the gate, after the user's own, and says nothing about it", async () => {
    // Nothing set, as a person gets it. The installs are this suite's, so the
    // answer does not depend on the Claude Code of the machine running it.
    const r = await installHooks({ provider: "claude", claudeVersions: PINNED, skillHook: { installs: found(npmInstall("2.1.306")), runImpl: noSpawn() } });
    expect(r.skillHook).toMatchObject({ install: true, state: "on", backup: BACKUP });
    expect(r.events).toContain("UserPromptExpansion");
    expect(read().hooks!.UserPromptExpansion[0]).toEqual(MINE_UPE);
    expect(forwarders(read().hooks!.UserPromptExpansion)).toHaveLength(1);
    expect(forwarders(read().hooks!.Stop)).toHaveLength(1);
    expect(skillHookStatus(r.skillHook!)).toBeNull();
  });

  it("is still held to the gate: below 2.1.116 nothing goes in, and the boot says why", async () => {
    const r = await installHooks({ provider: "claude", claudeVersions: PINNED, skillHook: { installs: found(npmInstall("2.1.114")), runImpl: noSpawn() } });
    expect(r.skillHook).toMatchObject({ install: false, state: "skipped", reason: "too-old" });
    expect(read().hooks!.UserPromptExpansion).toEqual([MINE_UPE]);
    expect(existsSync(BACKUP)).toBe(false);
    expect(skillHookStatus(r.skillHook!, "-")!.detail).toBe("not installed - needs Claude Code 2.1.116 or newer everywhere (found: 2.1.114)");
  });

  it("reads the switch from the environment the deck was started with", async () => {
    process.env.AGENTS_DECK_SKILL_HOOK = "0";
    const r = await installHooks({ provider: "claude", claudeVersions: PINNED, skillHook: { installs: found(npmInstall("2.1.306")), runImpl: noSpawn() } });
    expect(r.skillHook).toMatchObject({ install: false, state: "off", reason: "turned-off" });
    expect(forwarders(read().hooks!.UserPromptExpansion)).toEqual([]);
    expect(read().hooks!.UserPromptExpansion).toEqual([MINE_UPE]);
    expect(skillHookStatus(r.skillHook!)).toBeNull();
  });
});

describe("the state the Skills tab shows", () => {
  it("is read from settings.json: on with our entry there, skipped without it, off when turned off", async () => {
    expect(await skillHookState({})).toBe("skipped"); // the user's own UserPromptExpansion is not ours
    await install(ON());
    expect(await skillHookState({})).toBe("on");
    expect(await skillHookState({ AGENTS_DECK_SKILL_HOOK: "0" })).toBe("off");
    await install(ON(found(npmInstall("2.1.114"))));
    expect(await skillHookState({})).toBe("skipped");
  });

  it("is skipped, never a throw, for a settings.json that is missing or unreadable", async () => {
    rmSync(SETTINGS, { force: true });
    expect(await skillHookState({})).toBe("skipped");
    writeText('{ "hooks": ');
    expect(await skillHookState({})).toBe("skipped");
  });
});

// Turned off with AGENTS_DECK_SKILL_HOOK (any value but 1), a deck changes
// nothing of Skill activity's in Claude Code's settings. A deck's very first
// start writes its own standard hooks — every version has, and that is not
// this setting's doing — so "no change" is held two ways: on a first start
// every off value writes the same bytes, with nothing under UserPromptExpansion
// of ours, and on every start after that, the steady state a machine is in,
// nothing under the config dir is written at all. The one write the off state
// makes is turning it off: our own entry, taken back out.

/** Values that turn the entry off. */
const OFF_VALUES = ["0", "false", "off", "true"];
/** Below 2.1.101, where the whole file was at stake; just below the gate; at
 *  it; above it. */
const VERSIONS = ["2.1.100", "2.1.115", "2.1.116", "2.1.306"];
const SEEDS: Record<string, string> = { "the user's own hooks": ORIGINAL, "no hooks yet": canonical({ model: "opus" }) };

function setFlag(value: string | undefined) {
  if (value === undefined) delete process.env.AGENTS_DECK_SKILL_HOOK;
  else process.env.AGENTS_DECK_SKILL_HOOK = value;
}

/** A start of the deck as bin/cli/startup.js makes one — the switch read from
 *  the environment the deck was started with — on a machine whose only Claude
 *  Code is `version`, with a probe that must never run. */
function boot(version: string, runImpl = noSpawn()) {
  return installHooks({ provider: "claude", claudeVersions: [version], skillHook: { installs: found(npmInstall(version)), runImpl } });
}

/** What any write under the Claude config dir would show: each entry's kind,
 *  size, mode and mtime, and on POSIX its inode — a rename over a name gives it
 *  a new one even with the same bytes. A directory's own mtime moves when a
 *  file is created in it, even a temp file deleted again, so "." is in it too. */
function tree(root = CLAUDE_DIR): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (p: string) => {
    const s = lstatSync(p);
    out[relative(root, p) || "."] = [s.isDirectory() ? "dir" : "file", s.size, (s.mode & 0o777).toString(8), s.mtimeMs, WIN ? "-" : s.ino].join(" ");
    if (s.isDirectory()) for (const name of readdirSync(p).sort()) add(join(p, name));
  };
  add(root);
  return out;
}

const temps = () => Object.keys(tree()).filter(k => k.endsWith(".tmp"));

describe("the off state", () => {
  it("on a first start writes the same bytes for every off value, and nothing of Skill activity's, for every Claude Code version", async () => {
    for (const [seed, seedText] of Object.entries(SEEDS)) {
      for (const version of VERSIONS) {
        let first: string | undefined;
        for (const value of OFF_VALUES) {
          const label = `${seed}, Claude Code ${version}, AGENTS_DECK_SKILL_HOOK=${JSON.stringify(value)}`;
          rmSync(BACKUP, { force: true });
          writeText(seedText);
          setFlag(value);
          const runImpl = noSpawn();
          const r = await boot(version, runImpl);
          expect(r.skillHook, label).toMatchObject({ install: false, state: "off", reason: "turned-off" });
          expect(r.events, label).not.toContain("UserPromptExpansion");
          expect(runImpl, label).not.toHaveBeenCalled();
          expect(forwarders(read().hooks?.UserPromptExpansion), label).toEqual([]);
          // The user's own entry under that key, or its absence, is as it was.
          expect(read().hooks?.UserPromptExpansion, label).toEqual(JSON.parse(seedText).hooks?.UserPromptExpansion);
          expect(existsSync(BACKUP), label).toBe(false);
          expect(temps(), label).toEqual([]);
          // Every off value writes the same bytes.
          first ??= text();
          expect(text(), label).toBe(first);
        }
      }
    }
  });

  it("on every start after that writes nothing under the config dir: same bytes, mode and inode, no backup, no temp file", async () => {
    for (const [seed, seedText] of Object.entries(SEEDS)) {
      for (const version of VERSIONS) {
        for (const value of OFF_VALUES) {
          const label = `${seed}, Claude Code ${version}, AGENTS_DECK_SKILL_HOOK=${JSON.stringify(value)}`;
          rmSync(BACKUP, { force: true });
          writeText(seedText);
          setFlag(value);
          await boot(version); // the first start: the deck's own standard hooks
          if (!WIN) chmodSync(SETTINGS, 0o640); // a mode of the user's, which a rewrite would have to carry
          const bytes = readFileSync(SETTINGS);
          const files = tree();
          const runImpl = noSpawn();
          const r = await boot(version, runImpl);
          expect(r, label).toMatchObject({ changed: false });
          expect(r.skillHook, label).toMatchObject({ install: false, state: "off" });
          expect(runImpl, label).not.toHaveBeenCalled();
          expect(readFileSync(SETTINGS).equals(bytes), label).toBe(true);
          expect(tree(), label).toEqual(files);
          expect(existsSync(BACKUP), label).toBe(false);
        }
      }
    }
  });

  it("turning it off is its one write: only our entry comes out, every other byte stays, nothing else is written", async () => {
    setFlag("0");
    await boot("2.1.306"); // off: the deck's own standard hooks
    const before = text();
    setFlag(undefined);
    expect((await boot("2.1.306")).skillHook).toMatchObject({ install: true, state: "on", backup: BACKUP });
    const withEntry = text();
    if (!WIN) chmodSync(SETTINGS, 0o640);
    const files = tree();

    setFlag("0");
    const runImpl = noSpawn();
    const r = await boot("2.1.306", runImpl);
    expect(r).toMatchObject({ changed: true, skillHook: { install: false, state: "off" } });
    expect(runImpl).not.toHaveBeenCalled();
    // Lines are only taken out, and only ours: the comma after the user's own
    // group, then our group. What is left is the file from before the entry.
    const w = changedWindow(withEntry, text());
    expect(w.b).toEqual([]);
    expect(w.a[0]).toBe("      },");
    expect(w.a.join("\n")).toContain('"__agent-dag": true');
    expect(w.a.join("\n")).not.toContain("audit-deploy.sh");
    expect(text()).toBe(before);
    expect(read().hooks!.UserPromptExpansion).toEqual([MINE_UPE]);
    if (!WIN) expect(statSync(SETTINGS).mode & 0o777).toBe(0o640);
    // settings.json is the one thing written. (The config dir's own entry, ".",
    // may move: the new file is renamed into it.) The backup made with the entry is
    // the user's data and stays exactly as it was; no temp file is left.
    const now = tree();
    expect(Object.keys({ ...files, ...now }).filter(k => k !== "." && files[k] !== now[k])).toEqual(["settings.json"]);
    expect(existsSync(BACKUP)).toBe(true);
    expect(temps()).toEqual([]);
    // And the start after that writes nothing at all.
    const settled = tree();
    expect(await boot("2.1.306")).toMatchObject({ changed: false });
    expect(tree()).toEqual(settled);
  });
});

describe("the entry, on", () => {
  it("is added at the gate, after the user's own, and the start after that writes nothing", async () => {
    const r = await install(ON(found(npmInstall("2.1.116"))));
    expect(r.skillHook).toMatchObject({ install: true, state: "on" });
    expect(r.events).toContain("UserPromptExpansion");
    const groups = read().hooks!.UserPromptExpansion;
    expect(groups[0]).toEqual(MINE_UPE);
    expect(forwarders(groups)).toHaveLength(1);
    const settled = text();
    expect(await install(ON(found(npmInstall("2.1.116"))))).toMatchObject({ changed: false });
    expect(text()).toBe(settled);
  });

  it("is not added below the gate, and the boot says why", async () => {
    const r = await install(ON(found(npmInstall("2.1.114"))));
    expect(r.skillHook).toMatchObject({ install: false, reason: "too-old" });
    expect(forwarders(read().hooks!.UserPromptExpansion)).toEqual([]);
    expect(read().hooks!.UserPromptExpansion).toEqual([MINE_UPE]);
    const said = skillHookStatus(r.skillHook!, "-");
    expect(said).toMatchObject({ ok: false });
    expect(said!.detail).toContain("2.1.116");
    expect(said!.detail).toContain("2.1.114");
  });

  it("with Claude Code missing, installs everything else and not this", async () => {
    const r = await install(ON([]));
    expect(r.skillHook).toMatchObject({ install: false, reason: "no-claude" });
    expect(forwarders(read().hooks!.UserPromptExpansion)).toEqual([]);
    expect(forwarders(read().hooks!.SessionStart)).toHaveLength(1);
  });

  it("keeps every byte of the user's settings: the only change is the entry itself", async () => {
    await install(OFF);
    const before = text();
    await install(ON());
    const after = text();
    // Structurally: the entry out again is exactly the file before.
    expect(canonical(withoutOurExpansion(JSON.parse(after)))).toBe(before);
    // Textually: nothing of the file before is removed or rewritten. Lines are
    // only inserted, inside the UserPromptExpansion list, after the user's own
    // group: the comma that closes it, then our group.
    const w = changedWindow(before, after);
    expect(w.a).toEqual([]);
    expect(w.b[0]).toBe("      },");
    expect(w.b.join("\n")).toContain('"__agent-dag": true');
    expect(w.b.join("\n")).not.toContain("guard.sh");
  });

  it("enabling then disabling restores the file byte for byte, and the backup holds the bytes it replaced", async () => {
    await install(OFF);
    const before = text();
    const r = await install(ON());
    expect(r.skillHook?.backup).toBe(BACKUP);
    expect(readFileSync(BACKUP, "utf8")).toBe(before);
    if (!WIN) expect(statSync(BACKUP).mode & 0o777).toBe(0o600);
    await install(OFF);
    expect(text()).toBe(before);
  });

  it("install then --uninstall restores the original byte for byte", async () => {
    await install(ON());
    expect(await uninstallHooks({ provider: "claude" })).toMatchObject({ ok: true, changed: true });
    expect(text()).toBe(ORIGINAL);
  });

  it("--uninstall takes out only our forwarder, and the user's own UserPromptExpansion hook stays", async () => {
    await install(ON());
    await uninstallHooks({ provider: "claude" });
    expect(read().hooks!.UserPromptExpansion).toEqual([MINE_UPE]);
  });

  it("is taken back out when Claude Code is rolled back below the gate, and the key goes when nothing else is under it", async () => {
    writeText(canonical({ model: "opus" }));
    await install(ON(found(npmInstall("2.1.200"))));
    expect(forwarders(read().hooks!.UserPromptExpansion)).toHaveLength(1);
    await install(ON(found(npmInstall("2.1.100"))));
    expect(Object.keys(read().hooks!)).not.toContain("UserPromptExpansion");
    expect(read().model).toBe("opus");
  });

  it("is taken out of a file an ungated build wrote it into, once it is turned off", async () => {
    // What e12e0f97 left on every machine it ran on: ours, unconditionally.
    writeText(canonical({ model: "opus" }));
    await install(ON());
    const ungated = text();
    expect(forwarders(JSON.parse(ungated).hooks.UserPromptExpansion)).toHaveLength(1);
    await install(OFF);
    expect(Object.keys(read().hooks!)).not.toContain("UserPromptExpansion");
  });

  it("leaves a UserPromptExpansion that is not a list exactly where it is, and adds nothing to it", async () => {
    writeText(canonical({ model: "opus", hooks: { UserPromptExpansion: "not-a-list" } }));
    const r = await install(ON());
    expect(r.skillHook).toMatchObject({ install: false, reason: "settings-shape" });
    expect(read().hooks!.UserPromptExpansion).toBe("not-a-list");
    expect(forwarders(read().hooks!.Stop)).toHaveLength(1);
    // And off, it is not ours to delete either.
    await install(OFF);
    expect(read().hooks!.UserPromptExpansion).toBe("not-a-list");
  });

  it("leaves an empty UserPromptExpansion list of the user's alone when off", async () => {
    writeText(canonical({ model: "opus", hooks: { UserPromptExpansion: [] } }));
    await install(OFF);
    expect(read().hooks!.UserPromptExpansion).toEqual([]);
  });
});

describe("a settings.json the deck cannot read", () => {
  const BAD = ['{ "model": "opus", ', "", "[1, 2]", '{"hooks": {"Stop": [}', "null", '"just a string"'];

  it("is refused and left untouched, on or off, with no backup written", async () => {
    for (const bad of BAD) {
      for (const opts of [ON(), OFF]) {
        writeText(bad);
        await expect(install(opts), JSON.stringify(bad)).rejects.toMatchObject({ code: "SETTINGS_UNREADABLE" });
        expect(text(), JSON.stringify(bad)).toBe(bad);
        expect(existsSync(BACKUP)).toBe(false);
      }
    }
  });

  it("is refused by --uninstall too, and left untouched", async () => {
    writeText(BAD[0]);
    expect(await uninstallHooks({ provider: "claude" })).toMatchObject({ ok: false, reason: "settings_unreadable" });
    expect(text()).toBe(BAD[0]);
  });
});

describe("writers racing the install", () => {
  it("a write landing between the read and the write is kept, and this pass declines without adding the entry", async () => {
    await install(OFF);
    const theirs = canonical({ ...read(), model: "sonnet" });
    const r = await install(ON(), { beforeWrite: async () => { writeText(theirs); } });
    expect(r).toMatchObject({ changed: false, raced: true });
    expect(r.skillHook).toMatchObject({ install: false, state: "skipped", reason: "raced" });
    expect(text()).toBe(theirs);
    // The next start converges on both.
    const next = await install(ON());
    expect(next.skillHook).toMatchObject({ state: "on" });
    expect(read().model).toBe("sonnet");
    expect(forwarders(read().hooks!.UserPromptExpansion)).toHaveLength(1);
  });

  it("three installs at once converge on exactly what one install writes", async () => {
    await install(ON());
    const one = text();
    writeText(ORIGINAL);
    await Promise.all([install(ON()), install(ON()), install(ON())]);
    // A loser declines rather than writing over the winner; one more start
    // finds nothing left to do.
    await install(ON());
    expect(text()).toBe(one);
    const s = read();
    for (const [evt, groups] of Object.entries(s.hooks!)) {
      if (evt === "SomeFutureEvent") continue;
      expect(forwarders(groups), evt).toHaveLength(1);
    }
    expect(s.hooks!.UserPromptExpansion[0]).toEqual(MINE_UPE);
    expect(s.futureKey).toEqual(JSON.parse(ORIGINAL).futureKey);
    expect(s.permissions).toEqual(JSON.parse(ORIGINAL).permissions);
  });

  it("an install and an uninstall at once leave valid JSON and the user's settings whole", async () => {
    await install(ON());
    await Promise.all([install(ON()), uninstallHooks({ provider: "claude" }), install(OFF)]);
    const s = read();
    const o = JSON.parse(ORIGINAL);
    for (const key of ["model", "permissions", "env", "futureKey", "statusLine"]) expect(s[key], key).toEqual(o[key]);
    expect(s.hooks!.PreToolUse[0]).toEqual(o.hooks.PreToolUse[0]);
    expect(s.hooks!.UserPromptExpansion[0]).toEqual(MINE_UPE);
    expect(s.hooks!.SomeFutureEvent).toEqual(o.hooks.SomeFutureEvent);
    for (const groups of Object.values(s.hooks!)) expect(forwarders(groups).length).toBeLessThanOrEqual(1);
  });
});

describe("the boot report's row", () => {
  it("is nothing when on or turned off, and says why not otherwise", () => {
    const base = { since: "2.1.116", versions: [] as (string | null)[] };
    expect(skillHookStatus(null)).toBeNull();
    expect(skillHookStatus({ ...base, install: false, state: "off", reason: "turned-off" })).toBeNull();
    expect(skillHookStatus({ ...base, install: true, state: "on", versions: ["2.1.306"] }, "-")).toBeNull();
    for (const reason of ["no-claude", "version-unknown", "too-old", "settings-shape", "backup-failed", "raced"]) {
      const said = skillHookStatus({ ...base, install: false, state: "skipped", reason, versions: [null] }, "-");
      expect(said, reason).toMatchObject({ ok: false });
      expect(said!.detail, reason).toMatch(/^not installed - /);
    }
  });
});
