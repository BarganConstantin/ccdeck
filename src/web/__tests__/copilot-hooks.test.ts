// GitHub Copilot CLI sessions reach the board through ONE file the deck owns in
// Copilot's user hooks directory, ccdeck.json (src/server/copilot-hooks.mjs).
//
// What is pinned here: where that file goes (COPILOT_HOME, ~/.copilot, the
// Windows home), when it is written at all (Copilot present, not switched off,
// and on Windows a node Copilot can start without a shell), its schema against GitHub's hooks reference (version 1, one array per
// PascalCase event, `exec` + `args`, `timeoutSec`), that every path in it is
// data — through JSON and through the real /bin/sh that starts it — that a
// rewrite with nothing new writes nothing, that no other file in that directory
// is touched, and that uninstall takes back exactly our file.
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// Every directory the installer can reach is under ROOT, set BEFORE the module
// (and installer.mjs, which it loads lazily and which resolves the Claude config
// dir once at import) can read the real ones.
const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-copilot-hooks-"));
const prevEnv = {
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CCDECK_HOME: process.env.CCDECK_HOME, CODEX_HOME: process.env.CODEX_HOME, COPILOT_HOME: process.env.COPILOT_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
process.env.HOME = join(ROOT, "home");
process.env.USERPROFILE = join(ROOT, "home");
process.env.CLAUDE_CONFIG_DIR = join(ROOT, "home", ".claude");
process.env.CCDECK_HOME = join(ROOT, "home", ".ccdeck");
process.env.CODEX_HOME = join(ROOT, "home", ".codex");
process.env.XDG_CONFIG_HOME = join(ROOT, "home", ".config");
delete process.env.COPILOT_HOME;
afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(ROOT);
});

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/copilot-hooks.mjs");
const {
  COPILOT_EVENTS, COPILOT_HOOKS_FILE, copilotHome, copilotHooksPath, copilotHookEntry, copilotHooksText,
  hasCopilotInstalled, installCopilotHooks, isOurHooksFile, uninstallCopilotHooks, windowsHookExec,
} = mod;

type Entry = { type: string; exec: string; args: string[]; timeoutSec: number; [k: string]: unknown };
type HooksFile = { version: number; hooks: Record<string, Entry[]> };

/** A fresh home with a ~/.copilot in it, and an environment pointing at it. */
function machine(opts: { copilotDir?: boolean } = {}) {
  const home = mkdtempSync(join(ROOT, "m-"));
  if (opts.copilotDir !== false) mkdirSync(join(home, ".copilot"), { recursive: true });
  const env: Record<string, string> = { PATH: join(home, "no-bin") };
  return { home, env, file: join(home, ".copilot", "hooks", COPILOT_HOOKS_FILE) };
}

/** installCopilotHooks with a stand-in forwarder and node, so nothing outside
 *  the machine's home is written. On this platform's own paths, so the entries
 *  are the ones this leg's Copilot would run. */
const PLATFORM = process.platform;
// The stand-in nodes count as there for the Windows leg's check that the node
// can be started (windowsHookExec); everything else is asked of the disk.
const STAND_IN_NODES = new Set(["/opt/node/bin/node", "/usr/local/bin/node"]);
function install(m: ReturnType<typeof machine>, extra: Record<string, unknown> = {}) {
  return installCopilotHooks({
    env: m.env, home: m.home, platform: PLATFORM,
    exists: (p: string) => STAND_IN_NODES.has(p) || existsSync(p),
    runtime: () => "/opt/node/bin/node",
    installHook: async () => join(m.home, ".claude", "agent-dag", "hook.js"),
    ...extra,
  });
}

// The deck's ten event names (the team contract), which are also Copilot's
// PascalCase names: the PascalCase spelling is what makes Copilot send the
// snake_case payload (hooks reference, "Hook event input payloads").
const CONTRACT = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "SubagentStart", "SubagentStop", "Stop", "SessionEnd", "Notification",
];

describe("where Copilot's hooks file goes", () => {
  it("is ~/.copilot/hooks/ccdeck.json by default", () => {
    expect(copilotHome({ env: {}, home: "/home/u", platform: "linux" })).toBe("/home/u/.copilot");
    expect(copilotHooksPath({ env: {}, home: "/home/u", platform: "linux" })).toBe("/home/u/.copilot/hooks/ccdeck.json");
  });

  it("follows COPILOT_HOME, resolved, and ignores one that is only blanks", () => {
    expect(copilotHooksPath({ env: { COPILOT_HOME: " /srv/cp " }, home: "/home/u", platform: "linux" }))
      .toBe("/srv/cp/hooks/ccdeck.json");
    expect(copilotHome({ env: { COPILOT_HOME: "rel/cp" }, home: "/home/u", platform: "linux" }))
      .toBe(posix.resolve("rel/cp"));
    expect(copilotHome({ env: { COPILOT_HOME: "   " }, home: "/home/u", platform: "linux" })).toBe("/home/u/.copilot");
  });

  it("is %USERPROFILE%\\.copilot\\hooks on Windows", () => {
    expect(copilotHooksPath({ env: {}, home: "C:\\Users\\Ana", platform: "win32" }))
      .toBe("C:\\Users\\Ana\\.copilot\\hooks\\ccdeck.json");
    expect(copilotHooksPath({ env: { COPILOT_HOME: "D:\\cp" }, home: "C:\\Users\\Ana", platform: "win32" }))
      .toBe("D:\\cp\\hooks\\ccdeck.json");
  });
});

describe("whether Copilot CLI is on the machine", () => {
  const none = () => false;

  it("says yes for its config directory", () => {
    const seen = (p: string) => p === "/home/u/.copilot";
    expect(hasCopilotInstalled({ env: { PATH: "/usr/bin" }, home: "/home/u", platform: "linux", exists: seen })).toBe(true);
  });

  it("says yes for a `copilot` on PATH that has never run", () => {
    const seen = (p: string) => p === "/opt/npm/bin/copilot";
    expect(hasCopilotInstalled({ env: { PATH: "/usr/bin:/opt/npm/bin" }, home: "/home/u", platform: "linux", exists: seen })).toBe(true);
  });

  it("finds npm's copilot.cmd on a Windows Path", () => {
    const seen = (p: string) => p === "C:\\npm\\copilot.cmd";
    expect(hasCopilotInstalled({ env: { Path: "C:\\Windows;C:\\npm" }, home: "C:\\Users\\Ana", platform: "win32", exists: seen })).toBe(true);
  });

  it("says no when neither is there", () => {
    expect(hasCopilotInstalled({ env: { PATH: "/usr/bin" }, home: "/home/u", platform: "linux", exists: none })).toBe(false);
  });
});

describe("the hooks file's schema", () => {
  const posix = JSON.parse(copilotHooksText("/opt/node/bin/node", "/home/u/.claude/agent-dag/hook.js", "linux")) as HooksFile;
  const win = JSON.parse(copilotHooksText("C:\\nodejs\\node.exe", "C:\\Users\\Ana\\.claude\\agent-dag\\hook.js", "win32")) as HooksFile;

  it("is version 1 with one array per event, exactly the deck's ten", () => {
    for (const file of [posix, win]) {
      expect(file.version).toBe(1);
      expect(Object.keys(file).sort()).toEqual(["hooks", "version"]);
      expect(Object.keys(file.hooks).sort()).toEqual([...CONTRACT].sort());
      expect([...COPILOT_EVENTS].sort()).toEqual([...CONTRACT].sort());
      for (const list of Object.values(file.hooks)) expect(Array.isArray(list) && list.length === 1).toBe(true);
    }
  });

  it("leaves out PermissionRequest and ErrorOccurred, which are not waits or ends", () => {
    for (const file of [posix, win]) {
      expect(file.hooks).not.toHaveProperty("PermissionRequest");
      expect(file.hooks).not.toHaveProperty("ErrorOccurred");
    }
  });

  it("runs every entry as exec + args, never a shell string, with a 3 s timeout", () => {
    for (const file of [posix, win]) {
      for (const [event, [entry]] of Object.entries(file.hooks)) {
        expect(entry.type).toBe("command");
        expect(Object.keys(entry).sort()).toEqual(["args", "exec", "timeoutSec", "type"]);
        expect(entry.timeoutSec).toBe(3);
        // `exec` must not be combined with bash/powershell/command (hooks reference).
        expect(entry).not.toHaveProperty("bash");
        expect(entry).not.toHaveProperty("powershell");
        expect(entry).not.toHaveProperty("command");
        expect(entry.args.slice(-5)).toEqual([expect.stringMatching(/hook\.js$/), "--provider", "copilot", "--event", event]);
      }
    }
  });

  it("starts node itself on Windows", () => {
    const entry = win.hooks.PreToolUse[0];
    expect(entry.exec).toBe("C:\\nodejs\\node.exe");
    expect(entry.args).toEqual(["C:\\Users\\Ana\\.claude\\agent-dag\\hook.js", "--provider", "copilot", "--event", "PreToolUse"]);
  });

  it("goes through /bin/sh on POSIX with a fixed script and the paths as positional arguments", () => {
    const entry = posix.hooks.PreToolUse[0];
    expect(entry.exec).toBe("/bin/sh");
    expect(entry.args[0]).toBe("-c");
    expect(entry.args[2]).toBe("ccdeck-hook");
    expect(entry.args.slice(3)).toEqual(["/opt/node/bin/node", "/home/u/.claude/agent-dag/hook.js", "--provider", "copilot", "--event", "PreToolUse"]);
    const scripts = new Set(Object.values(posix.hooks).map(([e]) => e.args[1]));
    expect(scripts.size).toBe(1);
    expect(entry.args[1]).not.toContain("/opt/node");
    expect(entry.args[1]).not.toContain("hook.js");
  });

  it("recognises its own file and no other", () => {
    expect(isOurHooksFile(copilotHooksText("/n", "/h/agent-dag/hook.js", "linux"))).toBe(true);
    expect(isOurHooksFile(copilotHooksText("C:\\n.exe", "C:\\h\\agent-dag\\hook.js", "win32"))).toBe(true);
    expect(isOurHooksFile(JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: "command", bash: "./mine.sh" }] } }))).toBe(false);
    expect(isOurHooksFile(JSON.stringify({ version: 1, hooks: {} }))).toBe(false);
    expect(isOurHooksFile("{ not json")).toBe(false);
    // One entry of the user's own added to ours makes it not ours to replace.
    const mixed = JSON.parse(copilotHooksText("/n", "/h/agent-dag/hook.js", "linux"));
    mixed.hooks.Stop.push({ type: "command", bash: "say done" });
    expect(isOurHooksFile(JSON.stringify(mixed))).toBe(false);
  });
});

// Paths a real machine can have, and the ones a naive builder breaks on.
const HOSTILE = [
  "/home/a$(id)b/.claude/agent-dag/hook.js",
  "/home/a`id`b/.claude/agent-dag/hook.js",
  "/home/$USER/.claude/agent-dag/hook.js",
  "/home/it's mine/.claude/agent-dag/hook.js",
  '/home/say "hi"/.claude/agent-dag/hook.js',
  "/home/a\\b/.claude/agent-dag/hook.js",
  "/home/a b;rm -rf x/.claude/agent-dag/hook.js",
  "/home/a&b|c>d/.claude/agent-dag/hook.js",
  "/home/a\nb/.claude/agent-dag/hook.js",
  "/home/Ana Gonçalves ✓ 日本/.claude/agent-dag/hook.js",
  "C:\\Users\\O'Brien & Co\\.claude\\agent-dag\\hook.js",
];

describe("every path in the file is data", () => {
  it("survives JSON exactly, as one argument each, on both platforms", () => {
    for (const platform of ["linux", "darwin", "win32"]) {
      for (const hook of HOSTILE) {
        for (const node of ["/opt/no de/$(x)/node", "C:\\Program Files\\nodejs\\", hook.replace("hook.js", "node")]) {
          const file = JSON.parse(copilotHooksText(node, hook, platform)) as HooksFile;
          const entry = file.hooks.SessionStart[0];
          const tail = ["--provider", "copilot", "--event", "SessionStart"];
          if (platform === "win32") expect([entry.exec, ...entry.args]).toEqual([node, hook, ...tail]);
          else expect(entry.args.slice(3)).toEqual([node, hook, ...tail]);
          expect(isOurHooksFile(JSON.stringify(file))).toBe(true);
        }
      }
    }
  });

  // The argv Copilot starts on Windows, spawned the same way (no shell), here
  // on every platform: what hook.js receives is exactly what the file says.
  it("reaches hook.js unchanged when started directly", () => {
    const dir = join(mkdtempSync(join(ROOT, "direct-")), "it's $(id) & `x` 100% ünï");
    mkdirSync(dir, { recursive: true });
    const hook = join(dir, "hook.js");
    writeFileSync(hook, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const entry = copilotHookEntry(process.execPath, hook, "Stop", "win32") as Entry;
    const run = spawnSync(entry.exec, entry.args, { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(["--provider", "copilot", "--event", "Stop"]);
    expect(entry.args[0]).toBe(hook);
  });
});

// Through the real /bin/sh the POSIX entry names. A Windows leg has none and
// starts node directly (the case above), so this block is POSIX only.
describe.skipIf(process.platform === "win32")("the POSIX entry, run by a real /bin/sh", () => {
  const base = mkdtempSync(join(ROOT, "sh-"));

  /** A hook.js under a hostile directory that writes down the argv it got. */
  function hostileHook(name: string) {
    const dir = join(base, name, ".claude", "agent-dag");
    mkdirSync(dir, { recursive: true });
    const hook = join(dir, "hook.js");
    writeFileSync(hook, "require('fs').writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)))");
    return hook;
  }

  function fire(entry: Entry, env: Record<string, string>) {
    const out = join(mkdtempSync(join(base, "out-")), "argv.json");
    const run = spawnSync(entry.exec, entry.args, { encoding: "utf8", input: "{}", env: { ...env, ARGV_OUT: out } });
    return { status: run.status, argv: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null };
  }

  it("hands hook.js its arguments with every hostile path left as data", () => {
    for (const name of ["a$(touch pwned)b", "a`touch pwned`b", "it's \"quoted\"", "back\\slash", "sp ace;semi&amp", "ünï ✓"]) {
      const hook = hostileHook(name);
      const entry = copilotHookEntry(process.execPath, hook, "PreToolUse", "linux") as Entry;
      const got = fire(entry, { PATH: "/usr/bin:/bin" });
      expect(got.status, name).toBe(0);
      expect(got.argv, name).toEqual(["--provider", "copilot", "--event", "PreToolUse"]);
      expect(existsSync(join(base, "pwned"))).toBe(false);
    }
  });

  // Copilot denies the tool call when a PreToolUse hook fails to start, so a
  // vanished node or hook.js must end quietly instead.
  it("exits 0 and runs nothing when hook.js is gone", () => {
    const entry = copilotHookEntry(process.execPath, join(base, "gone", "hook.js"), "PreToolUse", "linux") as Entry;
    expect(fire(entry, { PATH: "/usr/bin:/bin" })).toEqual({ status: 0, argv: null });
  });

  it("exits 0 when the recorded node is gone and PATH has none", () => {
    const hook = hostileHook("no-node");
    const shOnly = mkdtempSync(join(base, "bin-"));
    symlinkSync("/bin/sh", join(shOnly, "sh"));
    const entry = copilotHookEntry(join(base, "removed", "node"), hook, "PreToolUse", "linux") as Entry;
    expect(fire(entry, { PATH: shOnly })).toEqual({ status: 0, argv: null });
  });

  it("uses the node on PATH when the recorded one is gone", () => {
    const hook = hostileHook("path-node");
    const bin = mkdtempSync(join(base, "bin-"));
    symlinkSync(process.execPath, join(bin, "node"));
    chmodSync(join(bin, "node"), 0o755);
    const entry = copilotHookEntry(join(base, "removed", "node"), hook, "Stop", "linux") as Entry;
    expect(fire(entry, { PATH: `${bin}:/usr/bin:/bin` })).toEqual({ status: 0, argv: ["--provider", "copilot", "--event", "Stop"] });
  });
});

describe("installing the hooks file", () => {
  it("writes ccdeck.json where Copilot reads it, with this boot's node and hook path", async () => {
    const m = machine();
    expect(await install(m)).toEqual({ state: "installed", path: m.file });
    const entry = (JSON.parse(readFileSync(m.file, "utf8")) as HooksFile).hooks.SessionEnd[0];
    expect([entry.exec, ...entry.args]).toEqual(expect.arrayContaining(["/opt/node/bin/node", join(m.home, ".claude", "agent-dag", "hook.js")]));
  });

  it("writes nothing when nothing changed, and rewrites when the node moved", async () => {
    const m = machine();
    await install(m);
    const before = statSync(m.file);
    const bytes = readFileSync(m.file, "utf8");
    await new Promise(r => setTimeout(r, 20));
    expect(await install(m)).toEqual({ state: "unchanged", path: m.file });
    expect(readFileSync(m.file, "utf8")).toBe(bytes);
    expect(statSync(m.file).ino).toBe(before.ino);
    expect(statSync(m.file).mtimeMs).toBe(before.mtimeMs);
    expect(await install(m, { runtime: () => "/usr/local/bin/node" })).toEqual({ state: "installed", path: m.file });
    expect(readFileSync(m.file, "utf8")).toContain("/usr/local/bin/node");
  });

  it("follows COPILOT_HOME", async () => {
    const m = machine({ copilotDir: false });
    const cp = join(m.home, "elsewhere", "copilot");
    mkdirSync(cp, { recursive: true });
    m.env.COPILOT_HOME = cp;
    expect(await install(m)).toEqual({ state: "installed", path: join(cp, "hooks", "ccdeck.json") });
    expect(existsSync(join(m.home, ".copilot"))).toBe(false);
  });

  it("touches no other file in Copilot's hooks directory", async () => {
    const m = machine();
    const dir = join(m.home, ".copilot", "hooks");
    mkdirSync(dir, { recursive: true });
    const mine = JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: "command", bash: "./guard.sh" }] } });
    writeFileSync(join(dir, "guard.json"), mine);
    writeFileSync(join(dir, "notes.txt"), "keep");
    await install(m);
    expect(readFileSync(join(dir, "guard.json"), "utf8")).toBe(mine);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("keep");
  });

  it("refuses to replace a ccdeck.json the deck did not write", async () => {
    const m = machine();
    mkdirSync(join(m.home, ".copilot", "hooks"), { recursive: true });
    const theirs = JSON.stringify({ version: 1, hooks: { agentStop: [{ type: "command", bash: "notify-send done" }] } });
    writeFileSync(m.file, theirs);
    expect(await install(m)).toEqual({ state: "foreign", path: m.file });
    expect(readFileSync(m.file, "utf8")).toBe(theirs);
  });

  it("does nothing where Copilot CLI is absent", async () => {
    const m = machine({ copilotDir: false });
    let installed = false;
    expect(await install(m, { installHook: async () => { installed = true; return "/x/hook.js"; } })).toEqual({ state: "absent" });
    expect(installed).toBe(false);
    expect(existsSync(join(m.home, ".copilot"))).toBe(false);
  });

  it("installs for a copilot on PATH that has never been run, creating its hooks directory", async () => {
    const m = machine({ copilotDir: false });
    const bin = join(m.home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "copilot"), "");
    m.env.PATH = bin;
    expect((await install(m)).state).toBe("installed");
    expect(existsSync(m.file)).toBe(true);
  });

  it("is off with AGENTS_DECK_NO_COPILOT=1, and takes an earlier boot's file back out", async () => {
    const m = machine();
    await install(m);
    m.env.AGENTS_DECK_NO_COPILOT = "1";
    let installed = false;
    expect(await install(m, { installHook: async () => { installed = true; return "/x/hook.js"; } })).toEqual({ state: "off", removed: true });
    expect(existsSync(m.file)).toBe(false);
    expect(installed).toBe(false);
    expect(await install(m)).toEqual({ state: "off", removed: false });
  });

  // AGENTS_DECK_NO_INSTALL=1 is about managed tools and network traffic. The
  // Claude hooks ignore it, and this file follows them: it is how the sessions
  // reach the board, and AGENTS_DECK_NO_COPILOT is its own switch.
  it("installs under AGENTS_DECK_NO_INSTALL=1, which is not its switch", async () => {
    const m = machine();
    m.env.AGENTS_DECK_NO_INSTALL = "1";
    expect(await install(m)).toEqual({ state: "installed", path: m.file });
    expect(isOurHooksFile(readFileSync(m.file, "utf8"))).toBe(true);
    expect(await install(m, { runtime: () => "/usr/local/bin/node" })).toEqual({ state: "installed", path: m.file });
    expect(readFileSync(m.file, "utf8")).toContain("/usr/local/bin/node");
  });

  it("answers a failure rather than throwing", async () => {
    const m = machine();
    const res = await install(m, { installHook: async () => { throw new Error("disk full\nmore"); } });
    expect(res).toEqual({ state: "failed", path: m.file, reason: "disk full" });
    expect(existsSync(m.file)).toBe(false);
  });

  it("puts the deck's own hook.js in place when nothing else has", async () => {
    // The real forwarder install, under this file's CLAUDE_CONFIG_DIR.
    const m = machine();
    const res = await installCopilotHooks({ env: m.env, home: m.home, platform: PLATFORM, runtime: () => process.execPath });
    expect(res.state).toBe("installed");
    const hook = join(process.env.CLAUDE_CONFIG_DIR!, "agent-dag", "hook.js");
    expect(hook.startsWith(ROOT)).toBe(true);
    expect(existsSync(hook)).toBe(true);
    expect(readFileSync(join(process.env.CLAUDE_CONFIG_DIR!, "agent-dag", "package.json"), "utf8")).toContain("commonjs");
    const file = JSON.parse(readFileSync(m.file, "utf8")) as HooksFile;
    expect(file.hooks.Stop[0].args).toContain(hook);
  });
});

// Copilot starts `exec` without a shell, Node refuses a .cmd or .bat without
// one, and a PreToolUse hook that fails to start DENIES the tool call. In the
// desktop app the hook runtime is its ccdeck-node.cmd launcher. The Windows
// answers, on every leg: platform, runtime, Path and `exists` are injected, and
// the file goes to a real path of this machine's.
describe("a Windows entry never starts a .cmd", () => {
  const NODE = "C:\\Program Files\\nodejs\\node.exe";
  const LAUNCHER = "C:\\Users\\Ana\\AppData\\Local\\ccdeck\\ccdeck-node.cmd";
  const HOOK = "C:\\Users\\Ana\\.claude\\agent-dag\\hook.js";

  /** A Windows machine with Copilot on its Path, and node.exe there or not. */
  function windows(opts: { node?: boolean; also?: string[] } = {}) {
    const m = machine();
    const seen = new Set(["C:\\npm\\copilot.cmd", ...(opts.node === false ? [] : [NODE]), ...(opts.also ?? [])]);
    const env = { Path: "C:\\Windows;C:\\npm;C:\\Program Files\\nodejs" };
    const exists = (p: string) => seen.has(p);
    const run = (runtime: string, extra: Record<string, unknown> = {}) => installCopilotHooks({
      env, home: "C:\\Users\\Ana", platform: "win32", path: m.file, exists,
      runtime: () => runtime, installHook: async () => HOOK, ...extra,
    });
    const execs = () => new Set(Object.values((JSON.parse(readFileSync(m.file, "utf8")) as HooksFile).hooks).map(([e]) => e.exec));
    return { m, env, exists, run, execs };
  }

  it("starts the node.exe on Path in place of the desktop app's .cmd launcher", async () => {
    const w = windows();
    expect(await w.run(LAUNCHER)).toEqual({ state: "installed", path: w.m.file });
    const file = JSON.parse(readFileSync(w.m.file, "utf8")) as HooksFile;
    for (const [event, [entry]] of Object.entries(file.hooks)) {
      expect(entry.exec, event).toBe(NODE);
      expect(entry.args, event).toEqual([HOOK, "--provider", "copilot", "--event", event]);
    }
    // A .bat is the same refusal, in any case.
    expect(await w.run("C:\\tools\\Node.BAT")).toEqual({ state: "unchanged", path: w.m.file });
  });

  it("asks Path for node.exe by that name, so a node.cmd ahead of it is never the answer", async () => {
    const w = windows({ also: ["C:\\npm\\node.cmd"] });
    await w.run(LAUNCHER);
    expect(w.execs()).toEqual(new Set([NODE]));
  });

  it("falls back to the node.exe on Path when the recorded runtime is not there", async () => {
    const w = windows();
    await w.run("C:\\Users\\Ana\\.nvm\\v20.0.0\\node.exe");
    expect(w.execs()).toEqual(new Set([NODE]));
  });

  it("uses a node.exe runtime that is there unchanged", async () => {
    const own = "D:\\nvm\\v24.11.0\\node.exe";
    const w = windows({ also: [own] });
    expect(await w.run(own)).toEqual({ state: "installed", path: w.m.file });
    expect(w.execs()).toEqual(new Set([own]));
  });

  it("writes nothing when no node can be started, and takes an earlier file of ours back out", async () => {
    const w = windows({ node: false });
    // An earlier boot's file, written while a node.exe was still on Path.
    mkdirSync(dirname(w.m.file), { recursive: true });
    writeFileSync(w.m.file, copilotHooksText(NODE, HOOK, "win32"));
    let installed = false;
    const res = await w.run(LAUNCHER, { installHook: async () => { installed = true; return HOOK; } });
    expect(res).toEqual({ state: "no-node", removed: true });
    expect(existsSync(w.m.file)).toBe(false);
    expect(installed).toBe(false);
    expect(await w.run(LAUNCHER)).toEqual({ state: "no-node", removed: false });
    expect(existsSync(w.m.file)).toBe(false);
  });

  it("leaves a ccdeck.json of the user's own where it is when no node can be started", async () => {
    const w = windows({ node: false });
    mkdirSync(dirname(w.m.file), { recursive: true });
    const theirs = JSON.stringify({ version: 1, hooks: { agentStop: [{ type: "command", powershell: "./done.ps1" }] } });
    writeFileSync(w.m.file, theirs);
    expect(await w.run(LAUNCHER)).toEqual({ state: "no-node", removed: false });
    expect(readFileSync(w.m.file, "utf8")).toBe(theirs);
  });

  it("answers the same through windowsHookExec on its own", () => {
    const w = windows();
    for (const launcher of [LAUNCHER, "C:\\x\\ccdeck-node.CMD", "C:\\x\\run.Bat"]) {
      expect(windowsHookExec(launcher, { env: w.env, exists: () => true }), launcher).toBe("C:\\Windows\\node.exe");
    }
    expect(windowsHookExec(NODE, { env: w.env, exists: w.exists })).toBe(NODE);
    expect(windowsHookExec("", { env: w.env, exists: w.exists })).toBe(NODE);
    expect(windowsHookExec(LAUNCHER, { env: { Path: "C:\\Windows" }, exists: w.exists })).toBeNull();
  });

  it("leaves the POSIX entry as it was: the recorded node, through /bin/sh", async () => {
    const m = machine();
    const hook = join(m.home, ".claude", "agent-dag", "hook.js");
    // Made here: on a Windows leg the POSIX dirname of this machine's path is ".".
    mkdirSync(dirname(m.file), { recursive: true });
    await installCopilotHooks({ env: m.env, home: m.home, platform: "linux", path: m.file, runtime: () => "/gone/node", installHook: async () => hook });
    expect(readFileSync(m.file, "utf8")).toBe(copilotHooksText("/gone/node", hook, "linux"));
  });
});

describe("uninstalling", () => {
  it("removes our file and nothing else", async () => {
    const m = machine();
    await install(m);
    const other = join(m.home, ".copilot", "hooks", "guard.json");
    writeFileSync(other, "{}");
    expect(await uninstallCopilotHooks({ env: m.env, home: m.home, platform: PLATFORM })).toEqual({ ok: true, removed: true, path: m.file });
    expect(existsSync(m.file)).toBe(false);
    expect(readFileSync(other, "utf8")).toBe("{}");
  });

  it("reports nothing to remove when there is no file", async () => {
    const m = machine();
    expect(await uninstallCopilotHooks({ env: m.env, home: m.home, platform: PLATFORM })).toEqual({ ok: true, removed: false, path: m.file });
  });

  it("leaves a ccdeck.json of the user's own where it is", async () => {
    const m = machine();
    mkdirSync(join(m.home, ".copilot", "hooks"), { recursive: true });
    writeFileSync(m.file, "{\"version\":1,\"hooks\":{\"agentStop\":[{\"bash\":\"say hi\"}]}}");
    expect(await uninstallCopilotHooks({ env: m.env, home: m.home, platform: PLATFORM }))
      .toEqual({ ok: true, removed: false, foreign: true, path: m.file });
    expect(existsSync(m.file)).toBe(true);
  });
});
