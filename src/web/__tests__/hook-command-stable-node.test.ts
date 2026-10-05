// The node the Claude Code hook command names has to outlive a Node upgrade.
//
// `process.execPath` has its symbolic links resolved — Node documents it, and
// it is true on Linux (/proc/self/exe) and on macOS alike — so a Homebrew node
// reports /opt/homebrew/Cellar/node/<version>/bin/node, a tarball install
// behind ~/.local/bin/node reports the versioned directory it unpacked into,
// and that is what went into settings.json for all ten events. `brew upgrade`
// deletes the old keg by default; switching `current` and removing the old
// directory does the same to the tarball. From then on `sh -c` exits 127 on
// every hook, Claude Code shows `<Event> hook error` on every tool call, and no
// event reaches any deck until somebody starts ccdeck again by hand. The login
// item named the same path, so it could not bring the deck back to repair it.
//
// The fix asks for a spelling of the SAME binary that survives an upgrade of
// the same install: a PATH entry whose real path is the running node, or
// Homebrew's opt/ link for a Cellar keg. Each case below builds that layout in a
// temp directory out of DIRECTORY links — junctions on Windows, which need no
// privilege — so it runs on every leg of the matrix.
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const WIN = process.platform === "win32";
const NODE = WIN ? "node.exe" : "node";
const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-stable-node-"));

// Everything the installer resolves at load is pointed into ROOT first, so the
// settings.json it writes is a temp file and never the developer's own.
const HOME = join(ROOT, "home");
const CONFIG = join(ROOT, "claude");
mkdirSync(HOME, { recursive: true });
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, PATH: process.env.PATH };
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CLAUDE_CONFIG_DIR = CONFIG;

// @ts-expect-error — plain .mjs module, no types
const { installHooks, CLAUDE_DIR } = await import("../../server/installer.mjs");
// @ts-expect-error — plain .mjs module, no types
const { stableNodePath } = await import("../../server/stable-node.mjs");
// @ts-expect-error — plain .mjs module, no types
const { installService } = await import("../../server/login-service.mjs");

if (!String(CLAUDE_DIR).startsWith(CONFIG)) {
  throw new Error(`refusing to run: installer resolved ${CLAUDE_DIR}, outside ${CONFIG}`);
}

// Links that point OUT of ROOT, at the running node's own directory: taken
// away one by one before ROOT is, so no recursive delete ever stands in front
// of the real install.
const outward: string[] = [];

afterAll(() => {
  for (const at of outward) { try { unlinkSync(at); } catch { /* never made */ } }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTempDir(ROOT);
});

/** A directory link that works without privileges on every platform. */
const link = (target: string, at: string) => symlinkSync(target, at, "junction");

/** A stand-in node binary: the lookup only ever asks where a file really is. */
function fakeNode(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, NODE);
  writeFileSync(file, "");
  return file;
}

describe("the node a hook command names", () => {
  it("is the PATH's stable spelling of a versioned install, which an upgrade does not take away", () => {
    // The tarball layout of the machine this was measured on:
    //   ~/.local/share/node/current -> node-v24.21.0-linux-x64, PATH names current/bin
    const base = mkdtempSync(join(ROOT, "tarball-"));
    const v1 = fakeNode(join(base, "node-v1", "bin"));
    link(join(base, "node-v1"), join(base, "current"));
    const env = { PATH: [join(base, "unrelated"), join(base, "current", "bin")].join(delimiter) };

    const named = stableNodePath({ execPath: v1, env, platform: process.platform });
    expect(named).toBe(join(base, "current", "bin", NODE));

    // The upgrade: a new version, `current` moved onto it, the old one deleted.
    fakeNode(join(base, "node-v2", "bin"));
    // unlink takes the link and never what it points at: libuv removes a
    // junction as the reparse point it is.
    unlinkSync(join(base, "current"));
    link(join(base, "node-v2"), join(base, "current"));
    rmSync(join(base, "node-v1"), { recursive: true });
    expect(existsSync(v1), "the versioned path the old command named").toBe(false);
    expect(existsSync(named), "the path the hook command names now").toBe(true);
  });

  it("is Homebrew's opt/ link for a Cellar keg, when PATH has nothing better", () => {
    const real = mkdtempSync(join(ROOT, "brew-"));
    fakeNode(join(real, "Cellar", "node", "24.1.0", "bin"));
    mkdirSync(join(real, "opt"));
    link(join(real, "Cellar", "node", "24.1.0"), join(real, "opt", "node"));
    // Reached through a link, the way a Mac's temp folder is /var for
    // /private/var: the answer keeps the prefix it was given.
    const prefix = join(ROOT, "brew-linked");
    link(real, prefix);
    // On Windows the stand-in is node.exe, and the opt/ rule is a Homebrew
    // rule about a file called `node` — so the leg asks about the platform the
    // layout belongs to, with a `node` beside it.
    if (WIN) writeFileSync(join(real, "Cellar", "node", "24.1.0", "bin", "node"), "");
    const keg = join(prefix, "Cellar", "node", "24.1.0", "bin", WIN ? "node" : NODE);
    const named = stableNodePath({ execPath: keg, env: { PATH: "" }, platform: "darwin" });
    expect(named).toBe(join(prefix, "opt", "node", "bin", "node"));
  });

  it("stays the running binary when nothing names it more stably", () => {
    const base = mkdtempSync(join(ROOT, "plain-"));
    const own = fakeNode(join(base, "bin"));
    // A different node earlier on PATH is a different program, not a spelling
    // of this one; a relative entry would resolve against each session's cwd.
    fakeNode(join(base, "other", "bin"));
    const env = { PATH: [join(base, "other", "bin"), "bin", ""].join(delimiter) };
    expect(stableNodePath({ execPath: own, env, platform: process.platform })).toBe(own);
    expect(stableNodePath({ execPath: join(base, "gone", NODE), env, platform: process.platform })).toBe(join(base, "gone", NODE));
  });
});

describe("what installHooks writes into settings.json", () => {
  it("names the node through the PATH entry that links to it, not the resolved versioned path", async () => {
    // A directory on PATH that links to the running node's own directory: the
    // shape ~/.local/bin, /opt/homebrew/bin and nodejs\ on nvm-windows all
    // have. process.execPath is the far end of it.
    const linked = join(ROOT, "linked-bin");
    link(dirname(process.execPath), linked);
    outward.push(linked);
    process.env.PATH = [linked, saved.PATH ?? ""].join(delimiter);
    try {
      await installHooks({ provider: "claude" });
    } finally {
      process.env.PATH = saved.PATH;
    }
    const settings = JSON.parse(readFileSync(join(CONFIG, "settings.json"), "utf8"));
    const command: string = settings.hooks.SessionStart[0].hooks[0].command;
    expect(command).toContain(join(linked, NODE));
    expect(command).not.toContain(process.execPath);
  });
});

describe("what the login item runs the deck with", () => {
  it("is the same stable node, so it can start the deck that repairs anything else", () => {
    const linked = join(ROOT, "linked-login");
    link(dirname(process.execPath), linked);
    outward.push(linked);
    let body = "";
    // The launchd job, whose program is one <string> with no shell quoting
    // around it — so the path reads back exactly on every leg.
    const out = installService({
      platform: "darwin", home: "/Users/u",
      env: { HOME: "/Users/u", PATH: [linked, "/usr/bin"].join(delimiter) },
      script: "/s/agent-dag.js", logPath: "/Users/u/Library/Logs/ccdeck/deck.log",
      fs: { mkdirSync() {}, writeFileSync: (_p: string, b: string) => { body = String(b); } },
      run: () => ({ status: 0 }),
    });
    expect(out.ok).toBe(true);
    const program = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(body)?.[1];
    expect(program).toBe(join(linked, NODE));
  });
});
