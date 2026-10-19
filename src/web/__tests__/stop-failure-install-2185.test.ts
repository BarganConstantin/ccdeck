// #2185: the StopFailure entry, and the version gate in front of it.
//
// StopFailure is what Claude Code sends instead of Stop when a turn ends on an
// API error, and it arrived in 2.1.78. An older Claude Code does not skip an
// event name it does not know: until 2.1.101 one made it ignore the whole
// settings.json, the user's permissions and every hook of ours with them. So
// the installer adds the entry only where every Claude Code it finds on disk is
// 2.1.78 or newer, and takes its own entry back out where that stops being so.
//
// Two halves. The versions are read off disk with every dependency injected, so
// an npm, a native and a Homebrew install are laid out for each platform with
// none of them on the machine running the suite. The installer then runs
// against a temp HOME with the versions handed in, the way the
// hook-group-shared-1734 cases run it.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, posix, win32 } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — .mjs server module, no types
import { claudeCodeVersions, claudeVersionAtLeast } from "../../server/claude-dir.mjs";

// ---------------------------------------------------------------- the versions

describe("which version is newer", () => {
  it("reads the three numbers, and not the suffix", () => {
    expect(claudeVersionAtLeast("2.1.78", "2.1.78")).toBe(true);
    expect(claudeVersionAtLeast("2.1.79", "2.1.78")).toBe(true);
    expect(claudeVersionAtLeast("2.1.303", "2.1.78")).toBe(true);
    expect(claudeVersionAtLeast("2.2.0", "2.1.78")).toBe(true);
    expect(claudeVersionAtLeast("3.0.0", "2.1.78")).toBe(true);
    expect(claudeVersionAtLeast("2.1.77", "2.1.78")).toBe(false);
    expect(claudeVersionAtLeast("2.0.99", "2.1.78")).toBe(false);
    expect(claudeVersionAtLeast("1.9.999", "2.1.78")).toBe(false);
    expect(claudeVersionAtLeast("2.1.78-beta.1", "2.1.78")).toBe(true);
  });

  it("is never true of something that is not a version", () => {
    for (const v of ["", "latest", "2.1", "v2.1.80", "2.1.80 ", null, undefined, 2]) {
      expect(claudeVersionAtLeast(v as never, "2.1.78"), String(v)).toBe(false);
    }
  });
});

type Disk = {
  /** Files, by path, with what they hold. */
  files?: Record<string, string>;
  /** Symlinks, by path, to the path they resolve to. */
  links?: Record<string, string>;
  /** Directories, by path, with the names in them. */
  dirs?: Record<string, string[]>;
};

/** claudeCodeVersions on a disk that holds exactly this and nothing else. */
function versionsOn(platform: "linux" | "darwin" | "win32", home: string, env: Record<string, string>, d: Disk) {
  const files = d.files ?? {};
  const links = d.links ?? {};
  const dirs = d.dirs ?? {};
  return claudeCodeVersions({
    platform, env, home,
    exists: (p: string) => p in files || p in links || p in dirs,
    realpath: (p: string) => {
      if (p in links) return links[p];
      if (p in files || p in dirs) return p;
      throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    },
    readText: (p: string) => {
      if (p in files) return files[p];
      throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    },
    list: (p: string) => {
      if (p in dirs) return dirs[p];
      throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    },
  });
}

const pkg = (version: string, name = "@anthropic-ai/claude-code") => JSON.stringify({ name, version });
const NIX = "/home/dorin";
const MAC = "/Users/dorin";
const WIN = "C:\\Users\\dorin";

describe("the Claude Code versions on this machine, read off disk", () => {
  it("names the native install by the version its link points into", () => {
    expect(versionsOn("linux", NIX, { PATH: "/usr/bin" }, {
      links: { [`${NIX}/.local/bin/claude`]: `${NIX}/.local/share/claude/versions/2.1.80` },
      files: { [`${NIX}/.local/share/claude/versions/2.1.80`]: "" },
    })).toEqual(["2.1.80"]);
  });

  it("names an npm install by its package.json, found from the bin's link", () => {
    const prefix = `${NIX}/.npm-global`;
    expect(versionsOn("linux", NIX, { PATH: `/usr/bin:${prefix}/bin` }, {
      links: { [`${prefix}/bin/claude`]: `${prefix}/lib/node_modules/@anthropic-ai/claude-code/cli.js` },
      files: {
        [`${prefix}/lib/node_modules/@anthropic-ai/claude-code/cli.js`]: "",
        [`${prefix}/lib/node_modules/@anthropic-ai/claude-code/package.json`]: pkg("2.1.90"),
      },
    })).toEqual(["2.1.90"]);
  });

  it("names the Homebrew cask by the version directory it keeps the binary in", () => {
    expect(versionsOn("darwin", MAC, { PATH: "/usr/bin" }, {
      links: { "/opt/homebrew/bin/claude": "/opt/homebrew/Caskroom/claude-code/2.1.85/claude" },
      files: { "/opt/homebrew/Caskroom/claude-code/2.1.85/claude": "" },
    })).toEqual(["2.1.85"]);
  });

  it("does not take a node manager's NODE version for Claude Code's", () => {
    // mise keeps every node under installs/node/<node version>; with the
    // package's own package.json gone there is nothing that names Claude Code's.
    const node = `${NIX}/.local/share/mise/installs/node/22.14.0`;
    const env = { PATH: `${node}/bin` };
    const cli = `${node}/lib/node_modules/@anthropic-ai/claude-code/cli.js`;
    expect(versionsOn("linux", NIX, env, { links: { [`${node}/bin/claude`]: cli }, files: { [cli]: "" } })).toEqual([]);
    // A copy, not a link: still nothing.
    expect(versionsOn("linux", NIX, env, { files: { [`${node}/bin/claude`]: "" } })).toEqual([]);
    // And with the package.json there, its version — not 22.14.0.
    expect(versionsOn("linux", NIX, env, {
      links: { [`${node}/bin/claude`]: cli },
      files: { [cli]: "", [`${node}/lib/node_modules/@anthropic-ai/claude-code/package.json`]: pkg("2.1.60") },
    })).toEqual(["2.1.60"]);
  });

  it("does not believe a package.json of some other package", () => {
    const dir = `${NIX}/tools/claude`;
    expect(versionsOn("linux", NIX, { PATH: `${dir}/bin` }, {
      links: { [`${dir}/bin/claude`]: `${dir}/lib/cli.js` },
      files: { [`${dir}/lib/cli.js`]: "", [`${dir}/package.json`]: pkg("9.9.9", "some-wrapper") },
    })).toEqual([]);
  });

  it("lists every install it finds, once each, so an old one anywhere is seen", () => {
    const prefix = "/usr/local";
    expect(versionsOn("linux", NIX, { PATH: `/usr/bin:${prefix}/bin:${NIX}/.local/bin` }, {
      links: {
        [`${NIX}/.local/bin/claude`]: `${NIX}/.local/share/claude/versions/2.1.80`,
        [`${prefix}/bin/claude`]: `${prefix}/lib/node_modules/@anthropic-ai/claude-code/cli.js`,
      },
      files: {
        [`${NIX}/.local/share/claude/versions/2.1.80`]: "",
        [`${prefix}/lib/node_modules/@anthropic-ai/claude-code/cli.js`]: "",
        [`${prefix}/lib/node_modules/@anthropic-ai/claude-code/package.json`]: pkg("2.1.50"),
      },
    }).sort()).toEqual(["2.1.50", "2.1.80"]);
  });

  it("names the Windows native copy by the newest version the installer kept", () => {
    const bin = win32.join(WIN, ".local", "bin", "claude.exe");
    const versions = win32.join(WIN, ".local", "share", "claude", "versions");
    expect(versionsOn("win32", WIN, { PATH: "", APPDATA: win32.join(WIN, "AppData", "Roaming") }, {
      files: { [bin]: "" },
      dirs: { [versions]: ["2.1.9", "2.1.90", "2.1.70", "not-a-version"] },
    })).toEqual(["2.1.90"]);
  });

  it("names the Windows npm shim by the package beside it", () => {
    const npm = win32.join(WIN, "AppData", "Roaming", "npm");
    expect(versionsOn("win32", WIN, { PATH: "", APPDATA: win32.join(WIN, "AppData", "Roaming") }, {
      files: {
        [win32.join(npm, "claude.cmd")]: "",
        [win32.join(npm, "node_modules", "@anthropic-ai", "claude-code", "package.json")]: pkg("2.1.81"),
      },
    })).toEqual(["2.1.81"]);
  });

  it("is nothing on a machine with no claude, or none that says which it is", () => {
    expect(versionsOn("linux", NIX, { PATH: "/usr/bin" }, {})).toEqual([]);
    expect(versionsOn("linux", NIX, { PATH: "/usr/bin" }, { files: { "/usr/local/bin/claude": "" } })).toEqual([]);
    // A native bin that is a plain file, with no versions directory beside it.
    expect(versionsOn("linux", NIX, { PATH: "/usr/bin" }, { files: { [posix.join(NIX, ".local/bin/claude")]: "" } })).toEqual([]);
  });
});

// ------------------------------------------------------------- the installer

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-stop-failure-install-"));
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
  installHooks: (o: { provider: string; claudeVersions?: string[] }) => Promise<{ changed: boolean; events: string[] }>;
  uninstallHooks: (o: { provider: string }) => Promise<{ ok: boolean; changed: boolean }>;
};

// An installer that stopped honouring the environment would be rewriting the
// developer's own settings.json from here.
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

type Hook = { type?: string; command?: unknown };
type Group = { matcher?: string; hooks?: Hook[]; [k: string]: unknown };
type Settings = { model?: string; hooks: Record<string, Group[]> };

const read = (): Settings => JSON.parse(readFileSync(SETTINGS, "utf8"));
const write = (s: unknown) => writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n");
const commands = (groups: Group[] = []) => groups.flatMap(g => (g.hooks ?? []).map(h => String(h.command)));
const forwarders = (groups: Group[] = []) => commands(groups).filter(c => /agent-dag[\\/]hook\.js/.test(c));
const install = (claudeVersions: string[]) => installHooks({ provider: "claude", claudeVersions });

const MINE = { type: "command", command: "/usr/local/bin/notify-me.sh" };

beforeEach(() => {
  rmSync(SETTINGS, { force: true });
  mkdirSync(CLAUDE_DIR, { recursive: true });
  write({ model: "opus" });
});

describe("the StopFailure entry", () => {
  it("is installed beside Stop where Claude Code is 2.1.78 or newer", async () => {
    const r = await install(["2.1.78"]);
    expect(r.events).toContain("StopFailure");
    expect(forwarders(read().hooks.StopFailure)).toHaveLength(1);
    expect(forwarders(read().hooks.Stop)).toHaveLength(1);
    expect(read().model).toBe("opus");
  });

  it("is left out where any Claude Code found is older, or none says which it is", async () => {
    for (const versions of [["2.1.77"], ["2.1.303", "2.1.50"], []]) {
      write({ model: "opus" });
      const r = await install(versions);
      expect(r.events, versions.join(",")).not.toContain("StopFailure");
      expect(read().hooks.StopFailure, versions.join(",")).toBeUndefined();
      // Everything else is there as it always was.
      expect(forwarders(read().hooks.Stop)).toHaveLength(1);
    }
  });

  it("arrives on the first start after Claude Code is updated past the gate", async () => {
    await install(["2.1.70"]);
    expect(read().hooks.StopFailure).toBeUndefined();
    await install(["2.1.80"]);
    expect(forwarders(read().hooks.StopFailure)).toHaveLength(1);
  });

  it("converges: the start after that writes nothing", async () => {
    await install(["2.1.80"]);
    const settled = readFileSync(SETTINGS, "utf8");
    expect(await install(["2.1.80"])).toMatchObject({ changed: false });
    expect(readFileSync(SETTINGS, "utf8")).toBe(settled);
  });

  it("is taken back out when the Claude Code found is rolled back below the gate", async () => {
    await install(["2.1.80"]);
    await install(["2.1.70"]);
    // The key is the part an older Claude Code cannot read, so it goes too.
    expect(Object.keys(read().hooks)).not.toContain("StopFailure");
    expect(forwarders(read().hooks.Stop)).toHaveLength(1);
  });

  it("leaves the user's own StopFailure hook where it was, when ours goes", async () => {
    await install(["2.1.80"]);
    const s = read();
    s.hooks.StopFailure.unshift({ matcher: "rate_limit", hooks: [MINE] });
    write(s);

    await install(["2.1.70"]);
    expect(read().hooks.StopFailure).toEqual([{ matcher: "rate_limit", hooks: [MINE] }]);
  });

  it("keeps the user's own beside ours on a machine past the gate", async () => {
    write({ model: "opus", hooks: { StopFailure: [{ matcher: "authentication_failed", hooks: [MINE] }] } });
    await install(["2.1.80"]);
    const groups = read().hooks.StopFailure;
    expect(commands(groups)).toContain(MINE.command);
    expect(forwarders(groups)).toHaveLength(1);
  });

  it("goes with --uninstall like every other entry of ours", async () => {
    write({ model: "opus", hooks: { StopFailure: [{ hooks: [MINE] }] } });
    await install(["2.1.80"]);
    expect(await uninstallHooks({ provider: "claude" })).toMatchObject({ ok: true, changed: true });
    expect(read().hooks.StopFailure).toEqual([{ hooks: [MINE] }]);
    expect(forwarders(Object.values(read().hooks).flat())).toEqual([]);
  });
});
