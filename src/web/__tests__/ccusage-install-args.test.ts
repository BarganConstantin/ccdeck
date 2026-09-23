// The managed ccusage install ran `npm install ccusage@latest --prefix
// ~/.agents-deck/ccusage` with `shell: true` on Windows, because npm there is a
// .cmd shim that spawn cannot launch any other way. Node's shell mode joins the
// file and its arguments with single spaces and no quoting, so on a profile like
// C:\Users\John Smith the command line read `--prefix C:\Users\John
// Smith\.agents-deck\ccusage`: npm took the prefix as C:\Users\John and the rest
// as a second package to install, exited non-zero, and the install never
// happened — every boot printed "install failed" and every usage-history modal
// fell back to the slow `npx -y ccusage@latest` path. These tests pin the
// command line the install gets on Windows and on POSIX.
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdTokens, spawnedArgv } from "./spawned-argv";

// Nothing is executed: every spawn is recorded and, unless a case has scripted
// an answer for it, refused — so a regression cannot install anything onto the
// machine running the suite.
//
// `script.reply` is how the cases at the bottom drive a child to completion:
// the daily update check and the usage read are both about what happens AFTER
// a child answers, which a spawn that only throws can never reach.
const { calls, script } = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[]; opts: Record<string, unknown> }[],
  script: {
    reply: null as null | ((cmd: string, args: string[]) => { stdout?: string; code?: number } | null),
  },
}));
vi.mock("node:child_process", () => {
  /** The two event surfaces a spawned child has, with nothing else on them. */
  function emitter() {
    const subs: Record<string, ((...a: unknown[]) => void)[]> = {};
    return {
      on(event: string, cb: (...a: unknown[]) => void) { (subs[event] ??= []).push(cb); return this; },
      emit(event: string, ...a: unknown[]) { for (const cb of subs[event] ?? []) cb(...a); },
    };
  }
  /** A child that says its piece on the next tick and exits — after the caller
   *  has had its turn to subscribe, which is the order a real one gives it. */
  function fakeChild(stdout: string, code: number) {
    const self = { ...emitter(), stdout: emitter(), stderr: emitter(), pid: 4242, kill() {} };
    setTimeout(() => {
      if (stdout) self.stdout.emit("data", stdout);
      self.emit("close", code);
    }, 0);
    return self;
  }
  return {
  spawn: (cmd: string, args: string[] = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    const scripted = script.reply?.(cmd, args);
    if (scripted) return fakeChild(scripted.stdout ?? "", scripted.code ?? 0);
    throw new Error("test: spawn blocked");
  },
  spawnSync: (cmd: string, args: string[] = [], opts = {}) => {
    calls.push({ cmd, args, opts });
    return { status: 1, stdout: "", stderr: "test: spawnSync blocked" };
  },
  // exec.mjs (spawnSpec's module) imports this; unused here, but a mocked
  // module must still carry every export its importers name.
  execFile: () => { throw new Error("test: execFile blocked"); },
  };
});

// The bug only shows up when the home path contains a space, so the fake home
// has one. homedir() reads $HOME on POSIX and %USERPROFILE% on Windows; both
// point at the temp directory BEFORE the module loads, so no test here can read
// or write the developer's real managed install on any platform.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck ccusage "));
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
// #433: primeCcusage now uses a ccusage the user already has — at
// AGENTS_DECK_CCUSAGE or on PATH — rather than fetching a second copy of it.
// This file is about the install it starts when there is no such thing, so
// there must be no such thing, whatever the developer running the suite has
// installed globally.
process.env.PATH = FAKE_HOME;
delete process.env.AGENTS_DECK_CCUSAGE;

// @ts-expect-error — .mjs server module, no types
const { installSpec, primeCcusage } = await import("../../server/ccusage.mjs");

const PREFIX = join(FAKE_HOME, ".agents-deck", "ccusage");
const INSTALL_ARGS = ["install", "ccusage@latest", "--prefix", PREFIX,
  "--no-save", "--no-audit", "--no-fund", "--loglevel", "error"];

afterAll(() => {
  for (const [key, was] of [["HOME", prev.HOME], ["USERPROFILE", prev.USERPROFILE],
    ["AGENTS_DECK_NO_INSTALL", prev.NO_INSTALL], ["PATH", prev.PATH],
    ["AGENTS_DECK_CCUSAGE", prev.CCUSAGE]] as const) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(FAKE_HOME);
});

beforeEach(() => { calls.length = 0; script.reply = null; });

// Where npm.cmd is, pretended to. The Windows shim lookup asks the real
// filesystem (#456), so its answer is a property of the machine running the
// suite: an absolute path on a Windows runner, and the bare `npm.cmd` fallback
// on a Linux or macOS one, where no npm.cmd can ever be found. `deps` is the
// seam installSpec already carries for exactly this. Pinning it means this file
// asserts one command line on all three platforms, and asserts the one that
// matters — a shim launched by bare name computes `%~dp0` from the deck's
// working directory and goes looking for npm-cli.js there.
const WIN_NODE_DIR = "C:\\Program Files\\nodejs";
const WIN_NPM = `${WIN_NODE_DIR}\\npm.cmd`;
const WIN_DEPS = {
  execPath: `${WIN_NODE_DIR}\\node.exe`,
  pathEnv: "C:\\Windows\\system32",
  exists: (p: string) => p === WIN_NPM,
};

describe("the ccusage install command line", () => {
  it("keeps a home path with a space in one argument on Windows", () => {
    expect(PREFIX).toContain(" "); // the whole point of this file

    const { file, args, opts } = installSpec("latest", "win32", WIN_DEPS);

    // Routed through cmd.exe the way Node's own shell mode does it, but with
    // each argument quoted here rather than pasted together.
    expect(file.toLowerCase()).toContain("cmd");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(opts.windowsVerbatimArguments).toBe(true);
    // And never `shell: true`, which is what concatenated them in the first place.
    expect(opts.shell).toBeUndefined();

    // npm.cmd sees the prefix as a single argument, spaces and all — and is
    // named by its full path, which is #456's half of the same command line.
    expect(cmdTokens(args[3])).toEqual([WIN_NPM, ...INSTALL_ARGS]);
    // The regression: unquoted, npm read --prefix as the first word only and
    // the remainder as another package to install.
    expect(args[3]).not.toContain(`--prefix ${PREFIX}`);
  });

  it("falls back to the bare shim name when nothing on that machine answers", () => {
    // The deliberate half of #456's fix: a layout the lookup cannot see is left
    // exactly as well off as it was before there was a lookup, with cmd.exe's
    // own PATH search still getting its turn. Worth its own line because a
    // POSIX runner — where no npm.cmd can ever be found — used to reach this
    // branch and only this one, while appearing to assert the other.
    const { args } = installSpec("latest", "win32", { ...WIN_DEPS, exists: () => false });
    expect(cmdTokens(args[3])).toEqual(["npm.cmd", ...INSTALL_ARGS]);
  });

  it("spawns npm directly, with the argument vector intact, off Windows", () => {
    for (const platform of ["linux", "darwin"]) {
      const { file, args, opts } = installSpec("latest", platform);
      expect(file).toBe("npm");
      expect(args).toEqual(INSTALL_ARGS);
      expect(opts).toEqual({}); // no shell, no verbatim arguments
    }
  });

  it("is what the install actually spawns", () => {
    expect(primeCcusage()).toEqual({ state: "installing" });

    const spec = installSpec("latest", process.platform);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(spec.file);
    expect(calls[0].args).toEqual(spec.args);
    expect(calls[0].opts.shell).toBeUndefined();
    // Belt and braces: the install this test provokes was aimed at the temp
    // home, so nothing here could have touched the real one.
    expect(JSON.stringify(calls[0].args)).toContain(JSON.stringify(FAKE_HOME).slice(1, -1));
  });
});

// ── the daily update check, and what a usage read really spawns ─────────────
//
// ccusage prices usage from a model table it BUNDLES, so a deck stuck on an old
// copy prints wrong dollar figures with no error anywhere — which is what makes
// the once-a-day `npm view ccusage version` part of the product rather than
// housekeeping. It had never run in a test: every suite with a managed install
// writes a fresh marker first, on purpose, so the check cannot fire in the
// middle of what that file is about. Here it is the subject (#1169).
//
// The same read is where #1160's console flash lives. Since e778710 a Windows
// deck spawns `@ccusage/ccusage-win32-<arch>/bin/ccusage.exe` directly instead
// of `node cli.js`, because cli.js starts that binary without hiding its
// console and the deck has none of its own to lend it — a window flashing up on
// every usage read. `nativeCcusage` is tested with an injected resolver;
// nothing asserted what runOnce then hands to spawn, which is the half that
// decides whether the window comes back.
const HOUR = 3600_000;
const MARKER = join(PREFIX, ".last-update-check");
const NODE_MODULES = join(PREFIX, "node_modules");
const PKG_DIR = join(NODE_MODULES, "ccusage");
const NATIVE_PKG = join(NODE_MODULES, "@ccusage", "ccusage-win32-x64");
const NATIVE_EXE = join(NATIVE_PKG, "bin", "ccusage.exe");
if (!PKG_DIR.startsWith(FAKE_HOME)) throw new Error(`refusing to run: ${PKG_DIR} escaped ${FAKE_HOME}`);

/**
 * A managed install resolveEntry is happy with, returning the entry it wrote.
 *
 * `checkedAgo` dates the update marker: 0 means "just now", which is every
 * other suite's way of keeping the daily check out of what it is about, and
 * anything past a day makes the check due. `withNativeExe` adds the
 * platform-specific binary npm unpacks beside the package on Windows — a real
 * package directory with a real package.json, since what finds it is Node's own
 * resolver rather than anything this suite controls.
 *
 * The entry goes in a directory of its own each time for that same reason: the
 * resolver memoises an answer against the directory it searched from, and these
 * cases differ only in what is on disk underneath an otherwise identical path.
 */
let installs = 0;
function installManagedTree({ version = "17.0.0", checkedAgo = 0, withNativeExe = false } = {}) {
  const dist = `dist-${++installs}`;
  const entry = join(PKG_DIR, dist, "index.js");
  rmSync(NODE_MODULES, { recursive: true, force: true });
  mkdirSync(join(PKG_DIR, dist), { recursive: true });
  writeFileSync(join(PKG_DIR, "package.json"),
    JSON.stringify({ name: "ccusage", version, bin: { ccusage: `./${dist}/index.js` } }));
  writeFileSync(entry, "");
  if (withNativeExe) {
    mkdirSync(join(NATIVE_PKG, "bin"), { recursive: true });
    writeFileSync(join(NATIVE_PKG, "package.json"),
      JSON.stringify({ name: "@ccusage/ccusage-win32-x64", version: "17.0.0" }));
    writeFileSync(NATIVE_EXE, "");
  }
  writeFileSync(MARKER, String(Date.now()));
  const when = (Date.now() - checkedAgo) / 1000;
  utimesSync(MARKER, when, when);
  return entry;
}

describe("the once-a-day check for a newer ccusage", () => {
  type Ccusage = { fetchCcusageDaily: (o?: { force?: boolean }) => Promise<{ ok: boolean }> };
  /** A module with no memory: the once-per-process flag, the cache and the
   *  forced-read floor are all module state, and "once per process" is half of
   *  what is under test. */
  async function freshCcusage(): Promise<Ccusage> {
    vi.resetModules();
    // @ts-expect-error — .mjs server module, no types
    return await import("../../server/ccusage.mjs") as Ccusage;
  }

  /** Which of the three children a recorded spawn is, on either platform. */
  const kindOf = (c: typeof calls[number]) => {
    const argv = spawnedArgv(c);
    return argv.includes("view") ? "view" : argv.includes("install") ? "install" : "read";
  };
  const spawnsOf = (kind: string) => calls.filter(c => kindOf(c) === kind);

  /** ccusage answering a `daily --json` with an empty but well-formed range,
   *  so one child settles the read and the reply below stays about npm. */
  const EMPTY_RANGE = JSON.stringify({ daily: [], session: [], totals: null });

  /** Let the unawaited half run: the view child's close handler, and the
   *  install it may start. */
  async function until(done: () => boolean) {
    for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 10));
  }

  it("asks npm for the latest version, and installs it when it is newer", async () => {
    installManagedTree({ version: "17.0.0", checkedAgo: 25 * HOUR });
    script.reply = (cmd, args) => (kindOf({ cmd, args, opts: {} }) === "view"
      ? { stdout: "17.1.0\n" }
      : { stdout: EMPTY_RANGE });
    const ccusage = await freshCcusage();

    expect(await ccusage.fetchCcusageDaily()).toMatchObject({ ok: true });
    expect(spawnsOf("view")).toHaveLength(1);
    expect(spawnedArgv(spawnsOf("view")[0]).slice(1)).toEqual(["view", "ccusage", "version"]);

    await until(() => spawnsOf("install").length > 0);
    // The same command line the deliberate install gets, aimed at the version
    // npm just named — the ONLY difference between the two paths.
    const wanted = installSpec("17.1.0", process.platform);
    expect(spawnsOf("install")).toHaveLength(1);
    expect(spawnsOf("install")[0].cmd).toBe(wanted.file);
    expect(spawnsOf("install")[0].args).toEqual(wanted.args);
    expect(spawnedArgv(spawnsOf("install")[0])).toContain(`ccusage@17.1.0`);
    expect(spawnedArgv(spawnsOf("install")[0])).toContain(PREFIX);

    // And the check is dated now, so tomorrow's is the next one — a marker left
    // alone is an `npm view` on every usage read.
    expect(Math.abs(statSync(MARKER).mtimeMs - Date.now())).toBeLessThan(10_000);
  });

  it("installs nothing when the copy on disk is already the latest", async () => {
    installManagedTree({ version: "17.0.0", checkedAgo: 25 * HOUR });
    script.reply = (cmd, args) => (kindOf({ cmd, args, opts: {} }) === "view"
      ? { stdout: "17.0.0\n" }
      : { stdout: EMPTY_RANGE });
    const ccusage = await freshCcusage();

    await ccusage.fetchCcusageDaily();
    expect(spawnsOf("view")).toHaveLength(1);
    await until(() => spawnsOf("install").length > 0);
    expect(spawnsOf("install")).toEqual([]);
  });

  it("asks once per process, however many reads follow", async () => {
    // Every usage read goes through getRunner, so a check that fired per call
    // would put an npm spawn on the panel's path — the boot cost #476 removed.
    installManagedTree({ version: "17.0.0", checkedAgo: 25 * HOUR });
    script.reply = (cmd, args) => (kindOf({ cmd, args, opts: {} }) === "view"
      ? { stdout: "17.0.0\n" }
      : { stdout: EMPTY_RANGE });
    const ccusage = await freshCcusage();

    await ccusage.fetchCcusageDaily();
    await ccusage.fetchCcusageDaily({ force: true });
    expect(spawnsOf("read").length, "the second read was answered from the cache").toBe(2);
    expect(spawnsOf("view")).toHaveLength(1);
  });

  it("does not ask again in this process even when the marker goes stale under it", async () => {
    // The marker is shared — a second deck on the same machine writes it, and a
    // clock that steps backwards ages it with nobody touching it. Re-checking
    // then would put an npm spawn on the usage path for the rest of the day,
    // which is what the in-process flag exists to stop; the marker's own age
    // cannot answer this one.
    installManagedTree({ version: "17.0.0", checkedAgo: 25 * HOUR });
    script.reply = (cmd, args) => (kindOf({ cmd, args, opts: {} }) === "view"
      ? { stdout: "17.0.0\n" }
      : { stdout: EMPTY_RANGE });
    const ccusage = await freshCcusage();

    await ccusage.fetchCcusageDaily();
    expect(spawnsOf("view")).toHaveLength(1);

    const stale = (Date.now() - 25 * HOUR) / 1000;
    utimesSync(MARKER, stale, stale);
    await ccusage.fetchCcusageDaily({ force: true });
    expect(spawnsOf("view")).toHaveLength(1);
  });

  it("asks nothing at all until the marker is a day old", async () => {
    installManagedTree({ version: "17.0.0", checkedAgo: 23 * HOUR });
    script.reply = () => ({ stdout: EMPTY_RANGE });
    const ccusage = await freshCcusage();

    await ccusage.fetchCcusageDaily();
    expect(spawnsOf("view")).toEqual([]);
  });
});

describe("what a usage read spawns on Windows", () => {
  const real = {
    platform: Object.getOwnPropertyDescriptor(process, "platform")!,
    arch: Object.getOwnPropertyDescriptor(process, "arch")!,
  };
  const pretend = (platform: string, arch: string) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    Object.defineProperty(process, "arch", { value: arch, configurable: true });
  };
  afterEach(() => {
    Object.defineProperty(process, "platform", real.platform);
    Object.defineProperty(process, "arch", real.arch);
  });

  /** One usage read on a pretended machine, with the marker fresh so the daily
   *  check above cannot put an npm child in the middle of it. */
  async function read(platform: string, arch: string) {
    pretend(platform, arch);
    script.reply = () => ({ stdout: JSON.stringify({ daily: [], session: [], totals: null }) });
    vi.resetModules();
    // @ts-expect-error — .mjs server module, no types
    const { fetchCcusageDaily } = await import("../../server/ccusage.mjs");
    await fetchCcusageDaily();
    expect(calls, "exactly one child, so the assertions below are about it").toHaveLength(1);
    return calls[0];
  }

  it("runs the packaged exe itself, hidden, with no cli.js in the vector", async () => {
    const entry = installManagedTree({ withNativeExe: true });
    const spawned = await read("win32", "x64");
    // Compared as the same FILE rather than the same string: the resolver that
    // finds the exe is Node's own and answers with the real path, and macOS's
    // temp directory is a symlink (/var/folders → /private/var/folders), so the
    // two spellings differ on a Mac and agree everywhere else.
    expect(realpathSync(spawned.cmd)).toBe(realpathSync(NATIVE_EXE));
    // The arguments are ccusage's own and nothing else: cli.js as args[0] would
    // make the exe read the wrapper as a subcommand and fail every read.
    expect(spawned.args[0]).toBe("daily");
    expect(spawned.args).not.toContain(entry);
    // What the whole change is for.
    expect(spawned.opts.windowsHide).toBe(true);
  });

  it("falls back to `node cli.js` when that build did not ship the exe", async () => {
    const entry = installManagedTree({ withNativeExe: false });
    const spawned = await read("win32", "x64");
    expect(spawned.cmd).toBe(process.execPath);
    expect(spawned.args[0]).toBe(entry);
  });

  it("leaves every other platform on the wrapper it has always used", async () => {
    // The exe is present here on purpose: nothing flashes on a Mac, and a
    // Windows binary spawned there would simply not run.
    const entry = installManagedTree({ withNativeExe: true });
    const spawned = await read("darwin", "x64");
    expect(spawned.cmd).toBe(process.execPath);
    expect(spawned.args[0]).toBe(entry);
  });
});
