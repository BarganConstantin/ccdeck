// The ccusage fallback run — `npx -y ccusage@latest daily --json --since <x>`,
// taken when the managed install is missing AND `npm install` failed — was
// spawned with `shell: true`, because npx on Windows is a .cmd shim that spawn
// cannot launch any other way. Node's shell mode joins the file and its
// arguments with single spaces and no quoting and hands the string to
// /bin/sh -c, and the last of those arguments is whatever GET /api/ccusage was
// asked for: `?since=1;id;` ran `id`. The same reasoning the install path
// already carried (see ccusage-install-args.test.ts) applies here with a sharper
// edge, because this argv has an attacker's string in it.
//
// These pin the fallback command line on both platforms and pin that neither
// runner branch is given a shell.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdTokens, spawnedArgv } from "./spawned-argv";

// Nothing real is executed: every spawn is recorded and answered with a fake
// child that prints an empty usage report, so no test here can install or run
// anything on the machine running the suite.
const { calls, fakeChild } = vi.hoisted(() => {
  type Sub = (v?: unknown) => void;
  return {
    calls: [] as { file: string; args: string[]; opts: Record<string, unknown> }[],
    // Just enough of a ChildProcess for runCcusage: the listeners go on
    // synchronously the moment spawn returns, so the output and the exit are
    // delivered a tick later.
    fakeChild: (stdout: string) => {
      const out: Sub[] = [], err: Sub[] = [], self: Record<string, Sub[]> = {};
      setTimeout(() => {
        out.forEach(cb => cb(stdout));
        self.close?.forEach(cb => cb(0));
      }, 0);
      return {
        pid: 4242,
        stdout: { on: (_ev: string, cb: Sub) => { out.push(cb); } },
        stderr: { on: (_ev: string, cb: Sub) => { err.push(cb); } },
        on: (ev: string, cb: Sub) => { (self[ev] ||= []).push(cb); },
        kill: () => {},
        unref: () => {},
      };
    },
  };
});

vi.mock("node:child_process", () => ({
  spawn: (file: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
    calls.push({ file, args, opts });
    return fakeChild(`{"daily":[],"totals":null}`);
  },
  // npm is unavailable, which is exactly the precondition for the npx fallback:
  // the managed install cannot be created, so getRunner falls through to it.
  spawnSync: (file: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
    calls.push({ file, args, opts });
    return { status: 1, stdout: "", stderr: "test: no npm here" };
  },
  // exec.mjs — reached through ccusage.mjs for both spawnSpec and killTree —
  // imports it by name, and a name the mock omits is a load error.
  execFile: () => { throw new Error("test: execFile blocked"); },
}));

// ccusage.mjs resolves ~/.agents-deck/ccusage at import time from os.homedir(),
// which reads $HOME on POSIX and %USERPROFILE% on Windows. Both point at a temp
// directory BEFORE the module loads, so nothing here can see — or write to —
// the developer's real managed install on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-ccusage-shell-"));
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
  PATH: process.env.PATH,
  CCUSAGE: process.env.AGENTS_DECK_CCUSAGE,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
delete process.env.AGENTS_DECK_NO_INSTALL;
// #433 added a third runner — a ccusage the user provided, at
// AGENTS_DECK_CCUSAGE or on PATH — and it is tried before the npx fallback this
// file is about. Both are emptied so the fallback is what gets reached: a
// developer with `npm i -g ccusage` would otherwise never spawn npx here, and
// the file would be checking nothing on their machine.
process.env.PATH = FAKE_HOME;
delete process.env.AGENTS_DECK_CCUSAGE;

// @ts-expect-error — .mjs server module, no types
const { fallbackSpec, fetchCcusageDaily } = await import("../../server/ccusage.mjs");

const PKG_DIR = join(FAKE_HOME, ".agents-deck", "ccusage", "node_modules", "ccusage");

afterAll(() => {
  for (const [key, was] of [["HOME", prev.HOME], ["USERPROFILE", prev.USERPROFILE],
    ["AGENTS_DECK_NO_INSTALL", prev.NO_INSTALL], ["PATH", prev.PATH],
    ["AGENTS_DECK_CCUSAGE", prev.CCUSAGE]] as const) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

beforeEach(() => { calls.length = 0; });

const DAILY = ["daily", "--json", "--since", "20260101"];

// Where npx.cmd is, pretended to. The Windows shim lookup asks the real
// filesystem (#456) and so answers differently per machine: an absolute path on
// a Windows runner, the bare name on a Linux or macOS one that has no npx.cmd
// to find. `deps` is the seam fallbackSpec already carries for exactly this, so
// the command line asserted below is the same one on all three platforms — and
// it is the one that matters, because the absolute path is the fix for #456.
const WIN_NODE_DIR = "C:\\Program Files\\nodejs";
const WIN_NPX = `${WIN_NODE_DIR}\\npx.cmd`;
const WIN_DEPS = {
  execPath: `${WIN_NODE_DIR}\\node.exe`,
  pathEnv: "C:\\Windows\\system32",
  exists: (p: string) => p === WIN_NPX,
};

describe("the ccusage npx fallback command line", () => {
  it("spawns npx directly, with the argument vector intact, off Windows", () => {
    for (const platform of ["linux", "darwin"]) {
      const { file, args, opts } = fallbackSpec(DAILY, platform);
      expect(file).toBe("npx");
      expect(args).toEqual(["-y", "ccusage@latest", ...DAILY]);
      expect(opts).toEqual({}); // no shell, no verbatim arguments
    }
  });

  it("routes the .cmd shim through cmd.exe with every argument quoted on Windows", () => {
    const { file, args, opts } = fallbackSpec(DAILY, "win32", WIN_DEPS);

    expect(file.toLowerCase()).toContain("cmd");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(opts.windowsVerbatimArguments).toBe(true);
    expect(opts.shell).toBeUndefined();
    // `npx.cmd`, not `npx`: only a .cmd/.bat name routes through cmd.exe at all,
    // and a bare `npx` cannot be spawned on Windows without a shell to apply
    // PATHEXT — asking for it would trade the injection for an ENOENT.
    expect(cmdTokens(args[3])).toEqual([WIN_NPX, "-y", "ccusage@latest", ...DAILY]);
  });

  it("falls back to the bare shim name when nothing on that machine answers", () => {
    // The deliberate half of #456's fix: a layout the lookup cannot see is left
    // exactly as well off as it was before there was a lookup, with cmd.exe's
    // own PATH search still getting its turn. Asserted here because the runner
    // this file used to be written against — a POSIX one, where no npx.cmd can
    // ever be found — was silently exercising only this branch.
    const { args } = fallbackSpec(DAILY, "win32", { ...WIN_DEPS, exists: () => false });
    expect(cmdTokens(args[3])).toEqual(["npx.cmd", "-y", "ccusage@latest", ...DAILY]);
  });

  it("keeps a metacharacter inside one argument instead of ending the command", () => {
    // The shape of the original report. Nothing legitimate looks like this — the
    // route refuses it now — but the sink has to be inert on its own, because
    // that is what makes the gate a second lock rather than the only one.
    const nasty = ["daily", "--json", "--since", "1;id;", "--until", "20260101 & whoami"];

    // POSIX: still one element per argument, so /bin/sh never sees a string.
    expect(fallbackSpec(nasty, "linux").args).toEqual(["-y", "ccusage@latest", ...nasty]);

    // Windows: each argument is separately quoted into the cmd.exe line, so the
    // `;`, the `&` and the space stay inside their own token.
    const win = fallbackSpec(nasty, "win32", WIN_DEPS);
    expect(cmdTokens(win.args[3])).toEqual([WIN_NPX, "-y", "ccusage@latest", ...nasty]);
  });
});

describe("what fetchCcusageDaily actually spawns", () => {
  it("never gives the npx fallback a shell", async () => {
    // No managed install and npm fails, which is the only way to reach the npx
    // fallback at all — the precondition the original report named.
    rmSync(join(FAKE_HOME, ".agents-deck"), { recursive: true, force: true });

    await fetchCcusageDaily({ since: "20260201" });

    // The npx fallback, not the failed `npm install` that precedes it. Both
    // carry "ccusage@latest", and on Windows both arrive as one cmd.exe line —
    // so "not an install" has to be asked of the argument vector rather than of
    // the array spawn happened to be handed. `daily` is the fallback's own
    // word; no install command line has ever had it.
    const run = calls.map(c => ({ c, argv: spawnedArgv(c) }))
      .find(({ argv }) => argv.includes("ccusage@latest") && argv.includes("daily"))?.c;
    expect(run).toBeDefined();

    // `--by-agent` since #431 — the run asks ccusage not to merge Claude Code's
    // spend into Codex's. It is on the end of the same vector and changes
    // nothing this test is about: what matters here is that the vector reaches
    // spawn as a vector.
    const spec = fallbackSpec(["daily", "--json", "--since", "20260201", "--by-agent"], process.platform);
    expect(run!.file).toBe(spec.file);
    expect(run!.args).toEqual(spec.args);
    // The regression, in one line: shell mode is what pasted the argv into a
    // string for /bin/sh -c.
    expect(run!.opts.shell).toBeUndefined();
    // And no other spawn this provoked — the failed `npm install` included —
    // asks for one either.
    for (const c of calls) expect(c.opts.shell).toBeUndefined();
  });

  it("never gives the managed install a shell either", async () => {
    mkdirSync(join(PKG_DIR, "src"), { recursive: true });
    writeFileSync(join(PKG_DIR, "package.json"), JSON.stringify({ version: "1.0.0", bin: "./src/cli.js" }));
    writeFileSync(join(PKG_DIR, "src", "cli.js"), "");
    process.env.AGENTS_DECK_NO_INSTALL = "1"; // no background `npm view` in the way

    await fetchCcusageDaily({ since: "20260202" });
    delete process.env.AGENTS_DECK_NO_INSTALL;

    const run = calls.find(c => spawnedArgv(c).some(a => a.endsWith("cli.js")));
    expect(run).toBeDefined();
    // `node <entry> daily --json --since …` — the healthy path, and the reason
    // the hole was closed on most machines most of the time.
    expect(run!.file).toBe(process.execPath);
    expect(run!.args.slice(1)).toEqual(["daily", "--json", "--since", "20260202", "--by-agent"]);
    expect(run!.opts.shell).toBeUndefined();
  });
});
