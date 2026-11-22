// ccdeck's plugin file in opencode's plugins folder: when it is written, what
// it is made of, and when it is taken out.
//
// Two halves. The installer (src/server/opencode-plugin.mjs) writes
// `<XDG_CONFIG_HOME or ~/.config>/opencode/plugins/ccdeck.js` on a machine with
// opencode, atomically and only when it changed, never over a ccdeck.js that is
// not ours, and takes ours out under its off switch; `--uninstall` removes only
// ours too. The
// generated file must stand alone — opencode loads it on Bun with nothing of
// ccdeck reachable — so it is imported here from a temp folder and made to run
// a real forwarder, with paths chosen to break any config that was spliced into
// code rather than written as JSON.
import { describe, it, expect, afterAll } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// installer.mjs resolves the Claude config dir when it is first imported, and
// the default forwarder installs hook.js there — so HOME, USERPROFILE and
// CLAUDE_CONFIG_DIR point into a temp directory before anything is loaded.
const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-opencode-"));
const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
process.env.HOME = join(ROOT, "home");
process.env.USERPROFILE = join(ROOT, "home");
process.env.CLAUDE_CONFIG_DIR = join(ROOT, "home", ".claude");
mkdirSync(process.env.HOME, { recursive: true });

const {
  installOpencodePlugin, uninstallOpencodePlugin, opencodePluginText, opencodeConfigDir, hasOpencode,
  PLUGIN_MARKER, OPENCODE_PLUGIN_FILE,
  // @ts-expect-error — .mjs server module, no types
} = await import("../../server/opencode-plugin.mjs");
// @ts-expect-error — .mjs server module, no types
const { CLAUDE_DIR } = await import("../../server/installer.mjs");
if (!String(CLAUDE_DIR).startsWith(ROOT)) {
  throw new Error(`refusing to run: installer resolved ${CLAUDE_DIR}, outside ${ROOT}`);
}

afterAll(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTempDir(ROOT);
});

let seq = 0;
/** A fresh home with nothing of opencode in it, and an env that names it. */
function machine() {
  const home = join(ROOT, `m${++seq}`);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  return { home, bin, env: { PATH: bin } as Record<string, string> };
}
const FORWARDER = async () => ({ hookPath: "/h/.claude/agent-dag/hook.js", runtime: "/usr/local/bin/node", claudeDir: "/h/.claude" });
const pluginAt = (home: string) => join(home, ".config", "opencode", "plugins", OPENCODE_PLUGIN_FILE);
/** The config the file carries, read back off its one marked line. */
function configOf(text: string) {
  const lines = text.split("\n");
  const at = lines.indexOf("// ccdeck:config");
  expect(at, "the marked config line is gone").toBeGreaterThan(-1);
  const line = lines[at + 1];
  expect(line.startsWith("const CONFIG = ") && line.endsWith(";")).toBe(true);
  return JSON.parse(line.slice("const CONFIG = ".length, -1));
}

describe("where opencode keeps its plugins, and whether it is here", () => {
  it("is XDG_CONFIG_HOME/opencode when set, ~/.config/opencode otherwise", () => {
    expect(opencodeConfigDir({ env: {}, home: "/u/me" })).toBe(join("/u/me", ".config", "opencode"));
    expect(opencodeConfigDir({ env: { XDG_CONFIG_HOME: "/x/cfg" }, home: "/u/me" })).toBe(join("/x/cfg", "opencode"));
    // An empty XDG_CONFIG_HOME is unset, as xdg-basedir (and so opencode) reads it.
    expect(opencodeConfigDir({ env: { XDG_CONFIG_HOME: "" }, home: "/u/me" })).toBe(join("/u/me", ".config", "opencode"));
  });

  it("finds opencode by its config folder or on PATH, on POSIX and Windows", () => {
    const m = machine();
    expect(hasOpencode({ env: m.env, home: m.home })).toBe(false);
    writeFileSync(join(m.bin, "opencode"), "#!/bin/sh\n");
    expect(hasOpencode({ env: m.env, home: m.home })).toBe(true);
    const n = machine();
    mkdirSync(join(n.home, ".config", "opencode"), { recursive: true });
    expect(hasOpencode({ env: n.env, home: n.home })).toBe(true);
    const seen = new Set(["C:\\Users\\me\\scoop\\shims\\opencode.exe"]);
    expect(hasOpencode({ env: { PATH: "C:\\Windows;C:\\Users\\me\\scoop\\shims" }, home: "C:\\Users\\me", platform: "win32", exists: (p: string) => seen.has(p) })).toBe(true);
    expect(hasOpencode({ env: { Path: "C:\\Windows" }, home: "C:\\Users\\me", platform: "win32", exists: () => false })).toBe(false);
  });
});

describe("installOpencodePlugin", () => {
  it("writes nothing on a machine without opencode", async () => {
    const m = machine();
    expect(await installOpencodePlugin({ env: m.env, home: m.home, forwarder: FORWARDER })).toEqual({ state: "absent" });
    expect(existsSync(join(m.home, ".config"))).toBe(false);
  });

  it("writes the marked plugin when opencode is on PATH, creating plugins/", async () => {
    const m = machine();
    writeFileSync(join(m.bin, "opencode"), "");
    const res = await installOpencodePlugin({ env: m.env, home: m.home, forwarder: FORWARDER });
    expect(res).toEqual({ state: "installed", path: pluginAt(m.home) });
    const text = readFileSync(pluginAt(m.home), "utf8");
    expect(text.startsWith(`${PLUGIN_MARKER}, format 1.`)).toBe(true);
    expect(configOf(text)).toEqual({ file: "/usr/local/bin/node", args: ["/h/.claude/agent-dag/hook.js", "--provider", "opencode"], verbatim: false, claudeDir: "/h/.claude" });
  });

  it("honours XDG_CONFIG_HOME", async () => {
    const m = machine();
    const xdg = join(m.home, "xdg");
    mkdirSync(join(xdg, "opencode"), { recursive: true });
    const res = await installOpencodePlugin({ env: { ...m.env, XDG_CONFIG_HOME: xdg }, home: m.home, forwarder: FORWARDER });
    expect(res).toEqual({ state: "installed", path: join(xdg, "opencode", "plugins", "ccdeck.js") });
    expect(existsSync(join(m.home, ".config"))).toBe(false);
  });

  it("leaves an unchanged file alone, and replaces a changed one by rename", async () => {
    const m = machine();
    mkdirSync(join(m.home, ".config", "opencode"), { recursive: true });
    await installOpencodePlugin({ env: m.env, home: m.home, forwarder: FORWARDER });
    const first = statSync(pluginAt(m.home));
    expect(await installOpencodePlugin({ env: m.env, home: m.home, forwarder: FORWARDER })).toEqual({ state: "unchanged", path: pluginAt(m.home) });
    const again = statSync(pluginAt(m.home));
    expect(again.ino).toBe(first.ino);
    expect(again.mtimeMs).toBe(first.mtimeMs);
    const moved = async () => ({ ...(await FORWARDER()), runtime: "/opt/node-24/bin/node" });
    expect((await installOpencodePlugin({ env: m.env, home: m.home, forwarder: moved })).state).toBe("installed");
    expect(configOf(readFileSync(pluginAt(m.home), "utf8")).file).toBe("/opt/node-24/bin/node");
    if (process.platform !== "win32") expect(statSync(pluginAt(m.home)).ino).not.toBe(first.ino);
  });

  it("never overwrites a ccdeck.js that is not ours, and says so", async () => {
    const m = machine();
    mkdirSync(join(m.home, ".config", "opencode", "plugins"), { recursive: true });
    const theirs = "// my own ccdeck forwarder\nexport const MyPlugin = async () => ({})\n";
    writeFileSync(pluginAt(m.home), theirs);
    let asked = false;
    const res = await installOpencodePlugin({ env: m.env, home: m.home, forwarder: async () => { asked = true; return FORWARDER(); } });
    expect(res).toEqual({ state: "conflict", path: pluginAt(m.home) });
    expect(readFileSync(pluginAt(m.home), "utf8")).toBe(theirs);
    expect(asked).toBe(false);
  });

  it("is off under AGENTS_DECK_NO_OPENCODE=1, and takes an earlier start's plugin back out", async () => {
    const m = machine();
    mkdirSync(join(m.home, ".config", "opencode"), { recursive: true });
    const off = { ...m.env, AGENTS_DECK_NO_OPENCODE: "1" };
    let asked = false;
    const counting = async () => { asked = true; return FORWARDER(); };
    expect(await installOpencodePlugin({ env: off, home: m.home, forwarder: counting })).toEqual({ state: "off", removed: false });
    expect(existsSync(pluginAt(m.home))).toBe(false);
    await installOpencodePlugin({ env: m.env, home: m.home, forwarder: FORWARDER });
    expect(existsSync(pluginAt(m.home))).toBe(true);
    asked = false;
    expect(await installOpencodePlugin({ env: off, home: m.home, forwarder: counting })).toEqual({ state: "off", removed: true });
    expect(existsSync(pluginAt(m.home))).toBe(false);
    expect(existsSync(join(m.home, ".config", "opencode", "plugins")), "the folder is opencode's and stays").toBe(true);
    expect(asked).toBe(false);
  });

  it("leaves a ccdeck.js that is not ours under the off switch too", async () => {
    const m = machine();
    mkdirSync(join(m.home, ".config", "opencode", "plugins"), { recursive: true });
    const theirs = "// my own ccdeck forwarder\nexport const MyPlugin = async () => ({})\n";
    writeFileSync(pluginAt(m.home), theirs);
    expect(await installOpencodePlugin({ env: { ...m.env, AGENTS_DECK_NO_OPENCODE: "1" }, home: m.home, forwarder: FORWARDER }))
      .toEqual({ state: "off", removed: false });
    expect(readFileSync(pluginAt(m.home), "utf8")).toBe(theirs);
  });

  // AGENTS_DECK_NO_INSTALL=1 is about managed tools and network traffic. The
  // Claude hooks ignore it, and the plugin follows them: it is how the sessions
  // reach the board, and AGENTS_DECK_NO_OPENCODE is its own switch.
  it("installs under AGENTS_DECK_NO_INSTALL=1 when opencode is here, which is not its switch", async () => {
    const m = machine();
    writeFileSync(join(m.bin, "opencode"), "");
    const res = await installOpencodePlugin({ env: { ...m.env, AGENTS_DECK_NO_INSTALL: "1" }, home: m.home, forwarder: FORWARDER });
    expect(res).toEqual({ state: "installed", path: pluginAt(m.home) });
    expect(readFileSync(pluginAt(m.home), "utf8").startsWith(PLUGIN_MARKER)).toBe(true);
    // And nothing at all where opencode is absent, with it or without it.
    const n = machine();
    expect(await installOpencodePlugin({ env: { ...n.env, AGENTS_DECK_NO_INSTALL: "1" }, home: n.home, forwarder: FORWARDER })).toEqual({ state: "absent" });
  });

  it("answers a failure rather than throwing it", async () => {
    const m = machine();
    mkdirSync(join(m.home, ".config", "opencode"), { recursive: true });
    // `plugins` is a file, so nothing can be written under it.
    writeFileSync(join(m.home, ".config", "opencode", "plugins"), "");
    const res = await installOpencodePlugin({ env: m.env, home: m.home, forwarder: FORWARDER });
    expect(res.state).toBe("failed");
    expect(res.path).toBe(pluginAt(m.home));
    const broken = await installOpencodePlugin({ env: m.env, home: machine().home, forwarder: async () => { throw new Error("no hook"); } });
    expect(broken.state).toBe("absent");
    const n = machine();
    mkdirSync(join(n.home, ".config", "opencode"), { recursive: true });
    expect((await installOpencodePlugin({ env: n.env, home: n.home, forwarder: async () => { throw new Error("no hook"); } })).state).toBe("failed");
  });

  it("installs hook.js itself and points the plugin at it, with no Claude hooks job before it", async () => {
    const m = machine();
    mkdirSync(join(m.home, ".config", "opencode"), { recursive: true });
    const res = await installOpencodePlugin({ env: m.env, home: m.home });
    expect(res.state).toBe("installed");
    const hook = join(CLAUDE_DIR, "agent-dag", "hook.js");
    expect(existsSync(hook)).toBe(true);
    expect(existsSync(join(CLAUDE_DIR, "agent-dag", "package.json"))).toBe(true);
    const config = configOf(readFileSync(res.path, "utf8"));
    expect(config.args).toEqual([hook, "--provider", "opencode"]);
    expect(config.claudeDir).toBe(CLAUDE_DIR);
  });

  it("runs a Windows .cmd launcher through cmd.exe, verbatim, still as one argv", async () => {
    const m = machine();
    mkdirSync(join(m.home, ".config", "opencode"), { recursive: true });
    const launcher = async () => ({ hookPath: "C:\\Users\\me\\.claude\\agent-dag\\hook.js", runtime: "C:\\Users\\me\\.claude\\agent-dag\\ccdeck-node.cmd", claudeDir: "C:\\Users\\me\\.claude" });
    const res = await installOpencodePlugin({ env: m.env, home: m.home, platform: "win32", forwarder: launcher });
    const config = configOf(readFileSync(res.path, "utf8"));
    expect(config.verbatim).toBe(true);
    expect(config.file).toMatch(/cmd(\.exe)?$/i);
    expect(config.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(config.args[3]).toBe('""C:\\Users\\me\\.claude\\agent-dag\\ccdeck-node.cmd" "C:\\Users\\me\\.claude\\agent-dag\\hook.js" "--provider" "opencode""');
  });
});

describe("uninstallOpencodePlugin", () => {
  it("removes ours, keeps somebody else's, and says which", async () => {
    const m = machine();
    mkdirSync(join(m.home, ".config", "opencode"), { recursive: true });
    expect(await uninstallOpencodePlugin({ env: m.env, home: m.home })).toEqual({ state: "absent", path: pluginAt(m.home) });
    await installOpencodePlugin({ env: m.env, home: m.home, forwarder: FORWARDER });
    // An off switch does not stop an uninstall.
    expect(await uninstallOpencodePlugin({ env: { ...m.env, AGENTS_DECK_NO_OPENCODE: "1", AGENTS_DECK_NO_INSTALL: "1" }, home: m.home }))
      .toEqual({ state: "removed", path: pluginAt(m.home) });
    expect(existsSync(pluginAt(m.home))).toBe(false);
    expect(existsSync(join(m.home, ".config", "opencode", "plugins")), "the folder is opencode's and stays").toBe(true);
    writeFileSync(pluginAt(m.home), "export default {}\n");
    expect(await uninstallOpencodePlugin({ env: m.env, home: m.home })).toEqual({ state: "foreign", path: pluginAt(m.home) });
    expect(readFileSync(pluginAt(m.home), "utf8")).toBe("export default {}\n");
  });
});

describe("the generated file", () => {
  it("imports nothing but node:child_process and exports one default plugin", async () => {
    const text = opencodePluginText({ file: "node", args: ["/h.js", "--provider", "opencode"], verbatim: false, claudeDir: "/c" });
    const imports = [...text.matchAll(/^\s*import\b.*$/gm)].map(m => m[0]);
    expect(imports).toEqual(['import { spawn } from "node:child_process";']);
    expect(text).not.toMatch(/\brequire\(|\bimport\(/);
    expect(text).not.toMatch(/console\./);
    const dir = mkdtempSync(join(ROOT, "gen-"));
    const file = join(dir, "ccdeck.mjs");
    writeFileSync(file, text);
    const mod = await import(pathToFileURL(file).href);
    // OpenCode 1 calls every export of a module it does not recognise as one
    // plugin, so the default must be the only one.
    expect(Object.keys(mod)).toEqual(["default"]);
    expect(mod.default.id).toBe("ccdeck-events");
    expect(typeof mod.default.server).toBe("function");
    expect(typeof mod.default.setup).toBe("function");
    expect(mod.default).not.toHaveProperty("tui");
  });

  // Every character that has ever broken a path spliced into code: quotes of
  // both kinds, `$(` and a backtick, backslashes, a newline, U+2028 and
  // non-ASCII. Windows refuses quotes, newlines and backslashes inside a name,
  // so it gets the rest.
  const HOSTILE = process.platform === "win32"
    ? "dir $(id) `x` ţară 日本 \u2028"
    : "dir \"q\" 'q' $(id) `x` \\back\\ new\nline ţară 日本 \u2028";

  it("carries hostile paths as data and hands them to the forwarder intact", async () => {
    const config = { file: "/a\"b/$(x)/node", args: ["C:\\x\\hook.js\n", "--provider", "opencode"], verbatim: false, claudeDir: "/c/'q'/\u2028/" };
    const text = opencodePluginText(config);
    expect(configOf(text)).toEqual(config);
    // One config line, whatever the paths hold.
    expect(text.split("\n").filter(l => l.startsWith("const CONFIG = ")).length).toBe(1);
    expect(text).not.toContain("\u2028");

    // A real run: the generated file, imported from disk, spawning a real node
    // on a recorder script that sits in a folder named with all of the above.
    const base = mkdtempSync(join(ROOT, "run-"));
    const dir = join(base, HOSTILE);
    const claudeDir = join(base, `claude ${HOSTILE}`);
    mkdirSync(dir, { recursive: true });
    const recorder = join(dir, "hook.js");
    const out = join(base, "seen.jsonl");
    writeFileSync(recorder, [
      "const fs = require('fs');",
      "let input = '';",
      "process.stdin.on('data', c => { input += c; });",
      "process.stdin.on('end', () => {",
      `  fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(1), dir: process.env.CLAUDE_CONFIG_DIR, input }) + '\\n');`,
      "});",
    ].join("\n"));
    writeFileSync(join(dir, "package.json"), '{ "type": "commonjs" }\n');
    if (process.platform !== "win32") chmodSync(recorder, 0o644);
    const file = join(base, "ccdeck.mjs");
    writeFileSync(file, opencodePluginText({ file: process.execPath, args: [recorder, "--provider", "opencode"], verbatim: false, claudeDir }));
    const mod = await import(pathToFileURL(file).href);
    const hooks = await mod.default.server({ directory: dir, worktree: dir, client: { session: { get: async () => ({}) } } });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_1", directory: dir } } } });
    await hooks["tool.execute.before"]({ tool: "read", sessionID: "ses_1", callID: "c1" }, { args: { filePath: join(dir, "a.ts") } });

    const deadline = Date.now() + 15_000;
    let lines: string[] = [];
    while (Date.now() < deadline) {
      lines = existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").filter(Boolean) : [];
      if (lines.length >= 2) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(lines.length).toBe(2);
    const seen = lines.map(l => JSON.parse(l));
    for (const s of seen) {
      expect(s.argv).toEqual([recorder, "--provider", "opencode"]);
      expect(s.dir).toBe(claudeDir);
    }
    expect(JSON.parse(seen[0].input)).toEqual({ hook_event_name: "SessionStart", session_id: "ses_1", cwd: dir });
    expect(JSON.parse(seen[1].input)).toEqual({
      hook_event_name: "PreToolUse", session_id: "ses_1", cwd: dir,
      tool_name: "Read", tool_input: { file_path: join(dir, "a.ts") }, tool_use_id: "c1",
    });
  }, 30_000);
});

describe("the deck's start and its uninstall", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  it("starts the install once, after the hooks job, and keeps its answer with the other jobs", () => {
    const src = read("../../../bin/cli/startup.js");
    const body = src.slice(src.indexOf("export function startupWork("), src.indexOf("\n}", src.indexOf("export function startupWork(")));
    expect(body.match(/installOpencodePlugin\(/g)?.length).toBe(1);
    expect(body).toMatch(/const opencode = hooks\s*\.then\(/);
    expect(body).toMatch(/return \{[^}]*\bopencode\b[^}]*\};/);
  });

  it("takes the plugin out on --uninstall, and counts a failure as a refusal", () => {
    const src = read("../../../bin/cli/uninstall.js");
    expect(src.match(/uninstallOpencodePlugin\(/g)?.length).toBe(1);
    const at = src.indexOf("uninstallOpencodePlugin()");
    expect(src.slice(at, at + 600)).toMatch(/state === "failed"[\s\S]*refused = true/);
    // Before the running decks are stopped, like every other removal.
    expect(at).toBeLessThan(src.indexOf("await stopLiveDecks()"));
  });
});
