// The daily claude-swap upgrade used to be handed to the first Python tool on
// the machine that answered `--version`, which is the right question for
// choosing something to install WITH and the wrong one for upgrading something
// already installed. `findInstaller()` walked a fixed preference list — uv,
// pipx, the deck's own bundled uv, then each safe `python -m pipx` — and
// returned the first that answered. Nothing asked which of them had actually
// put claude-swap there.
//
// So: a machine with uv on it and a claude-swap that came from somewhere else.
// The most reachable version of that is the `pip install --user` layout #574
// taught `cswapCandidates` to see, which made `cswapVersion()` start answering
// on machines where it used to return null. Once a day from there the marker is
// burned, PyPI names a newer release, uv answers its probe first, and the deck
// detaches
//
//     uv tool upgrade claude-swap
//
// which uv refuses — verified against a real uv 0.12.0 with a package it did not
// install: "error: Failed to upgrade <pkg> / Caused by: `<pkg>` is not
// installed; run `uv tool install <pkg>` to install", exit 1. pipx, asked to
// upgrade someone else's package, is no kinder: "Package is not installed.
// Expected to find <PIPX_HOME>/venvs/claude-swap, but it does not exist."
// `runDetached` uses stdio:"ignore" and waits for no exit, so neither sentence
// reaches anybody, while `ensureCswap` returns state:"upgrading" and the deck
// prints "v0.25.0, upgrading to v0.26.0 in background" — every launch, forever,
// about an upgrade that never once happened. The marker having already been
// touched is what makes it a daily lie rather than a per-boot one.
//
// The existing cswap-upgrade-args.test.ts could not catch this: every case there
// makes exactly one installer answer its probe, and one installer is the single
// shape in which "first to answer" and "owner of the package" cannot disagree.
// This file builds the machine that has more than one, which is the only place
// the two questions come apart.
//
// The layout is the evidence, so most of this drives `cswapOwner` directly as
// the pure function it is: platform, environment, home directory and the
// filesystem all arrive as arguments, so a Windows machine and a Linux one are
// both describable from a Mac and all three CI legs run identical assertions.
// Nothing here reads `process.platform`, and the two end-to-end cases relocate
// both installers' package directories under a temp home with the environment
// variables uv and pipx document, so no real install is looked at, let alone
// touched.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── the machines, as data ───────────────────────────────────────────────────

const LINUX = { platform: "linux", home: "/home/dev" };
const MAC = { platform: "darwin", home: "/Users/dev" };
const WIN = { platform: "win32", home: "C:\\Users\\dev" };

/** Where `uv tool install claude-swap` leaves the tool's venv, per platform. */
const UV_VENV = {
  linux: "/home/dev/.local/share/uv/tools/claude-swap",
  darwin: "/Users/dev/.local/share/uv/tools/claude-swap",
  win32: "C:\\Users\\dev\\AppData\\Roaming\\uv\\data\\tools\\claude-swap",
};

/** Where `pipx install claude-swap` leaves the package's venv, per platform. */
const PIPX_VENV = {
  linux: "/home/dev/.local/share/pipx/venvs/claude-swap",
  darwin: "/Users/dev/Library/Application Support/pipx/venvs/claude-swap",
  win32: "C:\\Users\\dev\\AppData\\Local\\pipx\\pipx\\venvs\\claude-swap",
};

/** The pre-1.5 pipx home, still on plenty of machines, per platform. */
const PIPX_LEGACY = {
  linux: "/home/dev/.local/pipx/venvs/claude-swap",
  darwin: "/Users/dev/.local/pipx/venvs/claude-swap",
  win32: "C:\\Users\\dev\\.local\\pipx\\venvs\\claude-swap",
};

/** Where a `pip install --user` copy of the console script lands. */
const PIP_USER_BIN = {
  linux: "/home/dev/.local/bin/cswap",
  darwin: "/Users/dev/.local/bin/cswap",
  win32: "C:\\Users\\dev\\AppData\\Roaming\\Python\\Python312\\Scripts\\cswap.exe",
};

/**
 * `cswapOwner` against a machine described entirely by arguments.
 *
 * `present` is the set of directories that exist; `links` is what a path
 * resolves to once its symlinks are followed, which is how both installers look
 * on POSIX — `~/.local/bin/cswap` is a link into the venv, and the venv is the
 * thing that names the owner.
 */
function ownerOf({ platform, home }: { platform: string; home: string }, {
  bin = "cswap",
  env = {},
  present = [] as string[],
  links = {} as Record<string, string>,
} = {}) {
  const asked: string[] = [];
  const owner = cswapOwner(bin, platform, env, home, {
    exists: (p: string) => { asked.push(p); return present.includes(p); },
    realpath: (p: string) => links[p] ?? p,
  });
  return { owner, asked };
}

// ── the module ──────────────────────────────────────────────────────────────

// Nothing is executed: `run` answers from a table and `runDetached` only
// records, so a regression shows up as a recorded argv rather than as a real
// upgrade of the claude-swap on the machine running the suite.
const { probeOk, detached } = vi.hoisted(() => ({
  probeOk: { is: (_cmd: string) => false },
  detached: [] as { cmd: string; args: string[] }[],
}));

const ok = (stdout: string) => ({ ok: true, code: 0, killed: false, stdout, stderr: "" });
const fail = () => ({ ok: false, code: "ENOENT", killed: false, stdout: "", stderr: "" });

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    // The installed copy, so ensureCswap takes the "already present" path.
    if (/cswap(\.exe)?$/.test(cmd) && args[0] === "--version") return ok("claude-swap 0.25.0");
    // safePythons: the same answer on all three platforms, so a `python -m pipx`
    // entry is always in the list and the pipx owner has two spellings to pick
    // between exactly as it would on a real machine.
    if (cmd === "xcode-select") return ok("/Library/Developer/CommandLineTools");
    if (cmd === "py" && args[0] === "-0") return ok(" -V:3.12 *");
    if (cmd === "where") return fail();
    return probeOk.is(cmd) ? ok("1.0.0") : fail();
  },
  runDetached: (cmd: string, args: string[]) => { detached.push({ cmd, args }); },
}));

vi.mock("../../server/uv-bootstrap.mjs", () => ({
  existingBootstrappedUv: () => null,
  bootstrapUv: async () => ({ ok: false, reason: "test" }),
}));

// PyPI says there is something newer, without touching the network.
vi.stubGlobal("fetch", async () => ({
  ok: true,
  json: async () => ({ info: { version: "9.9.9" } }),
}));

// The update-check marker is written under homedir(), which reads $HOME on POSIX
// and %USERPROFILE% on Windows; UV_TOOL_DIR and PIPX_HOME move both installers'
// package directories under the same temp tree. All four point somewhere
// disposable BEFORE the module under test loads, so nothing here can read or
// write a real one.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-cswap-owner-"));
const UV_TOOL_DIR = join(FAKE_HOME, "uv-tools");
const PIPX_HOME = join(FAKE_HOME, "pipx");
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
  CSWAP: process.env.AGENTS_DECK_CSWAP,
  UV_TOOL_DIR: process.env.UV_TOOL_DIR,
  PIPX_HOME: process.env.PIPX_HOME,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.UV_TOOL_DIR = UV_TOOL_DIR;
process.env.PIPX_HOME = PIPX_HOME;
delete process.env.AGENTS_DECK_NO_INSTALL;
delete process.env.AGENTS_DECK_CSWAP;

// Imported after the environment is arranged, and re-imported per end-to-end
// case: the module memoizes the resolved binary and the python list.
// @ts-expect-error — .mjs server module, no types
const { cswapOwner } = await import("../../server/cswap-install.mjs");

afterAll(() => {
  for (const [key, was] of [["HOME", prev.HOME], ["USERPROFILE", prev.USERPROFILE],
    ["AGENTS_DECK_NO_INSTALL", prev.NO_INSTALL], ["AGENTS_DECK_CSWAP", prev.CSWAP],
    ["UV_TOOL_DIR", prev.UV_TOOL_DIR], ["PIPX_HOME", prev.PIPX_HOME]] as const) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(FAKE_HOME);
});

beforeEach(() => {
  detached.length = 0;
  rmTempDir(join(FAKE_HOME, ".agents-deck"));
  rmTempDir(UV_TOOL_DIR);
  rmTempDir(PIPX_HOME);
  delete process.env.AGENTS_DECK_CSWAP;
});

/** One whole daily check, on the machine the caller has just laid out. */
async function dailyCheck() {
  vi.resetModules();
  // @ts-expect-error — .mjs server module, no types
  const { ensureCswap } = await import("../../server/cswap-install.mjs");
  const state = await ensureCswap();
  return { state, detached: [...detached] };
}

// ── 1. the machine with more than one installer ─────────────────────────────

describe("deciding who owns the claude-swap that is installed", () => {
  it("names pipx on a machine that also has uv, because pipx is where the package lives", () => {
    for (const machine of [LINUX, MAC, WIN]) {
      const p = machine.platform as keyof typeof PIPX_VENV;
      // uv is installed and would answer a probe first; it simply never
      // installed this package, so its tool directory holds no claude-swap.
      expect(ownerOf(machine, { present: [PIPX_VENV[p]] }).owner, p).toBe("pipx");
      // The pre-1.5 home answers the same, since that is still where the venvs
      // are on a machine that upgraded pipx rather than reinstalling it.
      expect(ownerOf(machine, { present: [PIPX_LEGACY[p]] }).owner, p).toBe("pipx");
    }
  });

  it("names uv when uv is the one that installed it", () => {
    for (const machine of [LINUX, MAC, WIN]) {
      const p = machine.platform as keyof typeof UV_VENV;
      expect(ownerOf(machine, { present: [UV_VENV[p]] }).owner, p).toBe("uv");
    }
  });

  it("names nobody for a `pip install --user` copy, which no offered installer can upgrade", () => {
    // The exact machine in #579: uv is present and answers first, the console
    // script is on disk and reports a version, and neither uv nor pipx has ever
    // heard of it. `installers()` deliberately declines to offer bare pip, so
    // the honest answer is that this deck cannot upgrade it.
    for (const machine of [LINUX, MAC, WIN]) {
      const p = machine.platform as keyof typeof PIP_USER_BIN;
      const { owner } = ownerOf(machine, { bin: PIP_USER_BIN[p], present: [PIP_USER_BIN[p]] });
      expect(owner, p).toBeNull();
    }
  });

  it("names nobody when nothing is installed anywhere it can see", () => {
    for (const machine of [LINUX, MAC, WIN]) {
      expect(ownerOf(machine).owner, machine.platform).toBeNull();
    }
  });

  it("refuses to guess when both installers hold a copy and the path does not say which", () => {
    // Two owners is as unusable an answer as none: upgrading the one that is
    // not on PATH leaves the reported version exactly where it was, which is
    // the failure this whole change exists to stop reporting.
    for (const machine of [LINUX, MAC, WIN]) {
      const p = machine.platform as keyof typeof UV_VENV;
      const { owner } = ownerOf(machine, { present: [UV_VENV[p], PIPX_VENV[p]] });
      expect(owner, p).toBeNull();
    }
  });
});

// ── 2. the resolved executable, where following it is decisive ──────────────

describe("following the executable the deck actually runs", () => {
  it("lets the symlink settle it when both installers hold a copy", () => {
    // On POSIX both installers link `~/.local/bin/cswap` at their own venv, and
    // whichever installed last owns the link. That link is the only thing on the
    // machine that says which copy the deck's `cswap --version` answered from.
    for (const machine of [LINUX, MAC]) {
      const p = machine.platform as keyof typeof UV_VENV;
      const bin = `${machine.home}/.local/bin/cswap`;
      const both = [UV_VENV[p], PIPX_VENV[p]];

      expect(ownerOf(machine, {
        bin, present: both, links: { [bin]: `${PIPX_VENV[p]}/bin/cswap` },
      }).owner, p).toBe("pipx");

      expect(ownerOf(machine, {
        bin, present: both, links: { [bin]: `${UV_VENV[p]}/bin/cswap` },
      }).owner, p).toBe("uv");
    }
  });

  it("still answers from the layout on Windows, where the launcher is a copy rather than a link", () => {
    // uv and modern pipx both COPY an .exe launcher into the bin directory on
    // Windows, so there is no link to follow and the resolved path sits under
    // neither venv. One venv on disk is then the whole of the evidence.
    const bin = "C:\\Users\\dev\\.local\\bin\\cswap.exe";
    expect(ownerOf(WIN, { bin, present: [UV_VENV.win32] }).owner).toBe("uv");
    expect(ownerOf(WIN, { bin, present: [PIPX_VENV.win32] }).owner).toBe("pipx");
    expect(ownerOf(WIN, { bin, present: [UV_VENV.win32, PIPX_VENV.win32] }).owner).toBeNull();
  });

  it("compares Windows paths the way Windows does, and never a POSIX one that way", () => {
    // A drive letter and a directory name differ in case between what the
    // environment holds and what a resolved path reports all the time on
    // Windows, and never mean two directories there. On POSIX they do.
    const shouted = UV_VENV.win32.toUpperCase() + "\\bin\\cswap.exe";
    expect(ownerOf(WIN, { bin: shouted, present: [] }).owner).toBe("uv");

    const linux = `${UV_VENV.linux.toUpperCase()}/bin/cswap`;
    expect(ownerOf(LINUX, { bin: linux, present: [] }).owner).toBeNull();
  });

  it("resolves the installer's directory too, so a symlinked home is still one directory", () => {
    // /var → /private/var on macOS, and a network or container-mounted profile
    // on Linux: the executable resolves through the link and the venv the deck
    // computed does not, so comparing the two raw spellings finds nothing in
    // common and the strongest signal here quietly becomes no signal.
    const bin = "/home/dev/.local/bin/cswap";
    const real = "/mnt/profiles/dev/.local/share/uv/tools/claude-swap";
    expect(ownerOf(LINUX, {
      bin,
      present: [UV_VENV.linux, PIPX_VENV.linux],
      links: { [bin]: `${real}/bin/cswap`, [UV_VENV.linux]: real },
    }).owner).toBe("uv");
  });

  it("treats a bare name as no evidence rather than as a path", () => {
    // `cswapBin()` answers the bare word whenever PATH resolved it, which is the
    // common case. There is nothing to follow, so the layout decides.
    const { owner, asked } = ownerOf(LINUX, { bin: "cswap", present: [UV_VENV.linux] });
    expect(owner).toBe("uv");
    expect(asked).toContain(UV_VENV.linux);
  });
});

// ── 3. the paths themselves, which are the part that cannot be guessed ──────

describe("where each installer keeps its packages", () => {
  it("looks in the directory uv documents for this platform, `data` segment and all", () => {
    for (const machine of [LINUX, MAC, WIN]) {
      const p = machine.platform as keyof typeof UV_VENV;
      expect(ownerOf(machine).asked, p).toContain(UV_VENV[p]);
    }
    // The Windows path is `%APPDATA%\uv\data\tools`, not `%APPDATA%\uv\tools`:
    // uv's persistent data directory has a `data` segment on Windows only, and
    // dropping it would look at a directory that never exists.
    expect(ownerOf(WIN, { present: ["C:\\Users\\dev\\AppData\\Roaming\\uv\\tools\\claude-swap"] }).owner)
      .toBeNull();
  });

  it("looks in the directory pipx documents for this platform, doubled Windows segment and all", () => {
    for (const machine of [LINUX, MAC, WIN]) {
      const p = machine.platform as keyof typeof PIPX_VENV;
      expect(ownerOf(machine).asked, p).toContain(PIPX_VENV[p]);
      expect(ownerOf(machine).asked, p).toContain(PIPX_LEGACY[p]);
    }
    // platformdirs appends the app name twice when it is given no author, and
    // pipx gives it none: `%LOCALAPPDATA%\pipx\pipx`, not `%LOCALAPPDATA%\pipx`.
    expect(ownerOf(WIN, { present: ["C:\\Users\\dev\\AppData\\Local\\pipx\\venvs\\claude-swap"] }).owner)
      .toBeNull();
    // And `~\pipx`, the second Windows-only fallback pipx keeps.
    expect(ownerOf(WIN, { present: ["C:\\Users\\dev\\pipx\\venvs\\claude-swap"] }).owner).toBe("pipx");
  });

  it("follows the environment variables that relocate either one", () => {
    expect(ownerOf(LINUX, {
      env: { UV_TOOL_DIR: "/srv/uvtools" }, present: ["/srv/uvtools/claude-swap"],
    }).owner).toBe("uv");
    expect(ownerOf(LINUX, {
      env: { PIPX_HOME: "/srv/pipx" }, present: ["/srv/pipx/venvs/claude-swap"],
    }).owner).toBe("pipx");
    // XDG moves uv's data directory and modern pipx's home together on Linux.
    const xdg = { XDG_DATA_HOME: "/srv/share" };
    expect(ownerOf(LINUX, { env: xdg, present: ["/srv/share/uv/tools/claude-swap"] }).owner).toBe("uv");
    expect(ownerOf(LINUX, { env: xdg, present: ["/srv/share/pipx/venvs/claude-swap"] }).owner).toBe("pipx");
    // APPDATA and LOCALAPPDATA are separate roots on Windows and a roaming
    // profile moves the first off the home directory.
    expect(ownerOf(WIN, {
      env: { APPDATA: "\\\\srv\\profiles\\dev\\Roaming" },
      present: ["\\\\srv\\profiles\\dev\\Roaming\\uv\\data\\tools\\claude-swap"],
    }).owner).toBe("uv");
    expect(ownerOf(WIN, {
      env: { LOCALAPPDATA: "D:\\Local" }, present: ["D:\\Local\\pipx\\pipx\\venvs\\claude-swap"],
    }).owner).toBe("pipx");
  });

  it("is not a vacuous sweep — an owner is only ever named for a directory that exists", () => {
    // Every assertion above rests on `exists` being consulted at all. If the
    // decision stopped reading the filesystem, a machine with nothing installed
    // would start naming an owner, so pin that it does not.
    for (const machine of [LINUX, MAC, WIN]) {
      const { owner, asked } = ownerOf(machine, { present: [] });
      expect(owner, machine.platform).toBeNull();
      expect(asked.length, machine.platform).toBeGreaterThan(1);
    }
  });
});

// ── 4. and what the daily check does with the answer ────────────────────────

describe("the daily upgrade on a machine with more than one installer", () => {
  it("hands a pipx-installed claude-swap to pipx even though uv answers first", async () => {
    // Both tools are on the machine and both answer their probe; only pipx has
    // the package. Before this, `uv tool upgrade claude-swap` was detached, uv
    // said "`claude-swap` is not installed" into a pipe nobody holds, and the
    // deck printed "upgrading" anyway.
    probeOk.is = cmd => cmd === "uv" || cmd === "pipx";
    mkdirSync(join(PIPX_HOME, "venvs", "claude-swap"), { recursive: true });

    const { state, detached } = await dailyCheck();

    expect(state).toMatchObject({ state: "upgrading", version: "0.25.0", latest: "9.9.9", via: "pipx" });
    expect(detached).toEqual([{ cmd: "pipx", args: ["upgrade", "claude-swap"] }]);
    expect(detached[0].cmd).not.toBe("uv");
  });

  it("says nothing at all about a `pip install --user` copy, rather than saying something false", async () => {
    // uv and pipx are both installed and both answer; neither owns the package.
    // "present" with the version is the whole truth, and the deck prints just
    // the version — an upgrade line here would be printed every day forever
    // while the version never moved.
    probeOk.is = cmd => cmd === "uv" || cmd === "pipx";

    const { state, detached } = await dailyCheck();

    expect(state).toEqual({ state: "present", version: "0.25.0" });
    expect(state).not.toHaveProperty("latest");
    expect(detached).toEqual([]);
  });

  it("still upgrades normally when the one installer present is the one that owns it", async () => {
    // The single-installer machine every earlier case was built on: behaviour
    // is exactly what it was, which is the other half of this change.
    probeOk.is = cmd => cmd === "uv";
    mkdirSync(join(UV_TOOL_DIR, "claude-swap"), { recursive: true });

    const { state, detached } = await dailyCheck();

    expect(state).toMatchObject({ state: "upgrading", via: "uv" });
    expect(detached).toEqual([{ cmd: "uv", args: ["tool", "upgrade", "claude-swap"] }]);
  });

  it("lets the resolved executable settle it when both installers hold a copy", async () => {
    // Both venvs on disk, and the cswap the deck runs is the one inside pipx's.
    // The layout alone cannot answer this; the path can.
    probeOk.is = cmd => cmd === "uv" || cmd === "pipx";
    mkdirSync(join(UV_TOOL_DIR, "claude-swap"), { recursive: true });
    const pipxBin = join(PIPX_HOME, "venvs", "claude-swap", "bin");
    mkdirSync(pipxBin, { recursive: true });
    writeFileSync(join(pipxBin, "cswap"), "");
    process.env.AGENTS_DECK_CSWAP = join(pipxBin, "cswap");

    const { state, detached } = await dailyCheck();

    expect(state).toMatchObject({ state: "upgrading", via: "pipx" });
    expect(detached).toEqual([{ cmd: "pipx", args: ["upgrade", "claude-swap"] }]);
  });

  it("falls back to `python -m pipx` when pipx owns it but has no command of its own", async () => {
    // pipx is very often a module with no `pipx` on PATH — every Debian
    // `apt install pipx`. The owner is still pipx; only the spelling changes,
    // and the probe is what picks it.
    probeOk.is = cmd => cmd === "uv" || cmd === "py" || cmd === "python3";
    mkdirSync(join(PIPX_HOME, "venvs", "claude-swap"), { recursive: true });

    const { state, detached } = await dailyCheck();

    expect(state.via).toMatch(/-m pipx$/);
    expect(detached).toEqual([
      { cmd: state.via.replace(" -m pipx", ""), args: ["-m", "pipx", "upgrade", "claude-swap"] },
    ]);
  });

  it("probes nothing when nobody owns it, rather than probing and then discarding the answer", async () => {
    // The cheap half of the fix: an unowned claude-swap costs zero subprocesses
    // on every boot after the first, where it used to cost one 8s-budget probe
    // and a detached command that could only fail.
    const probed: string[] = [];
    probeOk.is = cmd => { probed.push(cmd); return cmd === "uv" || cmd === "pipx"; };

    const { state, detached } = await dailyCheck();

    expect(state).toEqual({ state: "present", version: "0.25.0" });
    expect(detached).toEqual([]);
    expect(probed).toEqual([]);
  });
});
