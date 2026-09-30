// #1777: a deck started at login could not update itself on a Homebrew or nvm
// setup, because the login job carried no PATH and npm was run by bare name.
//
// A login item runs with the service manager's PATH, not the shell's —
// launchd's is /usr/bin:/bin:/usr/sbin:/sbin, and the systemd user manager's
// has no nvm, fnm or Volta directory in it. installService wrote only
// AGENTS_DECK_DETACHED and the scope directories into the job, and on POSIX the
// in-app update and the managed ccusage install spawned the bare name `npm`.
// So on exactly the installs where the global prefix is the user's own, and
// the update is therefore offered, it failed with `spawn npm ENOENT` on every
// retry, and a claude installed with npm could not find `node` for its own
// `#!/usr/bin/env node`. Reproduced before the fix:
//
//     installService({ platform: "darwin", env: { PATH: "/opt/homebrew/bin:…" },
//                      execPath: "/opt/homebrew/bin/node", … })
//       -> EnvironmentVariables: AGENTS_DECK_DETACHED only
//
// Now the job carries a PATH — node's own directory first, then the installing
// shell's PATH, each directory once — and on POSIX npm is launched as the
// `npm-cli.js` beside the running node, the way npxLaunch already runs npx,
// with the bare name kept as the fallback.
//
// NOTHING HERE REGISTERS A LOGIN ITEM: installService is handed an `fs` that
// records what it would write and a `run` that records the service-manager
// command instead of executing it. Nothing is spawned.
import { describe, it, expect } from "vitest";

// @ts-expect-error — plain .mjs module, no types
const { installService } = await import("../../server/login-service.mjs");
// @ts-expect-error — plain .mjs module, no types
const { upgradeSpec } = await import("../../server/npm-upgrade.mjs");
// @ts-expect-error — plain .mjs module, no types
const { installSpec } = await import("../../server/ccusage-install.mjs");

type Spec = { file: string; args: string[]; opts: Record<string, unknown>; plain?: string[] };

/** What installService would write on `platform`, with nothing done. */
function jobBody(platform: "darwin" | "linux" | "win32", { execPath, PATH, home }: { execPath: string; PATH: string; home: string }) {
  const written: string[] = [];
  const calls: string[] = [];
  const out = installService({
    platform, home,
    env: { HOME: home, PATH },
    execPath,
    script: "/s/agent-dag.js",
    logPath: `${home}/Library/Logs/ccdeck/deck.log`,
    fs: { mkdirSync() {}, writeFileSync: (_p: string, b: string | Buffer) => { written.push(String(b)); } },
    run: (file: string) => { calls.push(file); return { status: 0 }; },
  });
  expect(out.ok).toBe(true);
  expect(calls).toHaveLength(1); // recorded, never run
  return written.join("\n");
}

/** The value a plist gives `key`, or null when it has none. */
function plistValue(plist: string, key: string): string | null {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
  return m ? m[1] : null;
}

describe("the login job carries a PATH", () => {
  it("on macOS, with node's own directory first", () => {
    const plist = jobBody("darwin", { execPath: "/opt/homebrew/bin/node", PATH: "/opt/homebrew/bin:/usr/bin:/bin", home: "/Users/u" });
    const path = plistValue(plist, "PATH");
    expect(path, "no PATH in the job's EnvironmentVariables").not.toBeNull();
    expect(path!.startsWith("/opt/homebrew/bin")).toBe(true);
    // Each directory once: node's own was already on the shell's PATH.
    expect(path).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    // Next to what was already there, not instead of it.
    expect(plistValue(plist, "AGENTS_DECK_DETACHED")).toBe("1");
  });

  it("on Linux, for an nvm node the shell's PATH did not even name", () => {
    const unit = jobBody("linux", { execPath: "/home/u/.nvm/versions/node/v22/bin/node", PATH: "/usr/bin:/bin", home: "/home/u" });
    const line = /^Environment="PATH=([^"]*)"$/m.exec(unit)?.[1] ?? null;
    expect(line, "no PATH Environment= line in the unit").not.toBeNull();
    expect(line!.startsWith("/home/u/.nvm/versions/node/v22/bin")).toBe(true);
    expect(line).toBe("/home/u/.nvm/versions/node/v22/bin:/usr/bin:/bin");
    expect(unit).toContain('Environment="AGENTS_DECK_DETACHED=1"');
  });

  it("drops empty entries, which a shell reads as the current directory", () => {
    const unit = jobBody("linux", { execPath: "/usr/local/bin/node", PATH: ":/usr/bin::/usr/local/bin:", home: "/home/u" });
    expect(/^Environment="PATH=([^"]*)"$/m.exec(unit)?.[1]).toBe("/usr/local/bin:/usr/bin");
  });

  it("keeps the systemd escaping for a directory with a space or a `%` in it", () => {
    const unit = jobBody("linux", { execPath: "/home/u/My Tools/node/bin/node", PATH: "/home/u/100%bin:/usr/bin", home: "/home/u" });
    expect(unit).toContain('Environment="PATH=/home/u/My Tools/node/bin:/home/u/100%%bin:/usr/bin"');
  });

  it("is not written into a Windows task, which has no environment block", () => {
    // Task Scheduler runs the job with the user's own persistent variables.
    const xml = jobBody("win32", { execPath: "C:\\nodejs\\node.exe", PATH: "C:\\nodejs;C:\\Windows", home: "C:\\Users\\u" });
    expect(xml).not.toContain("PATH");
  });
});

describe("npm is launched beside the running node on POSIX", () => {
  const NODE = "/home/u/.nvm/versions/node/v22/bin/node";
  const CLI = "/home/u/.nvm/versions/node/v22/lib/node_modules/npm/bin/npm-cli.js";
  const deps = { execPath: NODE, exists: (p: string) => p === CLI };
  const UPGRADE = ["install", "-g", "ccdeck@latest", "--no-audit", "--no-fund", "--loglevel", "error"];

  for (const platform of ["linux", "darwin"]) {
    it(`for the in-app update, on ${platform}`, () => {
      const spec: Spec = upgradeSpec("ccdeck", platform, deps);
      expect(spec.file).toBe(NODE);
      expect(spec.args).toEqual([CLI, ...UPGRADE]);
      expect(spec.opts).toEqual({});
      expect(spec.plain).toEqual(UPGRADE);
    });

    it(`for the managed ccusage install, on ${platform}`, () => {
      const spec: Spec = installSpec("latest", platform, deps);
      expect(spec.file).toBe(NODE);
      expect(spec.args[0]).toBe(CLI);
      expect(spec.args.slice(1, 3)).toEqual(["install", "ccusage@latest"]);
      expect(spec.opts).toEqual({});
    });

    it(`and by bare name when there is no npm-cli.js to be found, on ${platform}`, () => {
      const blind = { execPath: NODE, exists: () => false };
      expect(upgradeSpec("ccdeck", platform, blind)).toMatchObject({ file: "npm", args: UPGRADE, opts: {} });
      expect(installSpec("latest", platform, blind).file).toBe("npm");
    });
  }
});
