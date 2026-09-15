// The deck installs claude-swap, upgrades it unattended once a day, and then
// hands it `cswap export -`, `add`, `switch` and `import` — the commands that
// carry Claude OAuth refresh tokens. What it asked PyPI for was the bare name:
//
//     uv tool install claude-swap
//     pipx install claude-swap
//
// which is "whatever that project publishes next, forever", resolved on a
// machine the author will never see. Forty lines away in uv-bootstrap.mjs the
// same deck refuses to execute a 35 MB uv it cannot hash. The package holding
// the credentials had no floor, no ceiling and no check of any kind, on the
// install or on the upgrade, and `cswap --version` was read afterwards only to
// confirm that SOMETHING answered — never that it was the something asked for.
//
// What this file pins is the whole of that trade:
//
//   1. the install command line names a version bound, and names one exact
//      version whenever the registry could be reached;
//   2. "newest" means newest INSIDE that bound, so the daily check can never
//      chase a release the install specifier forbids — the 9.9.9 shape a
//      takeover takes, a pre-release, a yanked one;
//   3. a version that comes back other than the one asked for is refused
//      rather than driven;
//   4. the upgrade is written down instead of being fired into the dark;
//   5. the fallback advice is not a pipe into a shell.
//
// Nothing here touches the network, pip, uv, or any claude-swap on the machine
// running the suite: `fetch` is stubbed, `run` answers from a table, and HOME
// (plus USERPROFILE, which is what homedir() reads on Windows) points at a temp
// directory BEFORE the module under test loads, so the marker and the upgrade
// record are written there and nowhere else. The registry body used below is
// the real shape of https://pypi.org/pypi/claude-swap/json, trimmed.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── the machine, as data ────────────────────────────────────────────────────

const { probeOk, calls, pypi, machine } = vi.hoisted(() => ({
  // Which command names answer a `--version` probe on this machine.
  probeOk: { is: (_cmd: string) => false },
  // Every argv the deck tried to run, in order.
  calls: [] as { cmd: string; args: string[] }[],
  // What pypi.org answers, or whether it answers at all.
  pypi: { body: null as unknown, reachable: true },
  // `has` is the claude-swap already on the machine; `lands` is what answers
  // once the deck has run something that replaces it. Keeping the two apart is
  // the whole point — the interesting cases are the ones where they differ from
  // what was requested.
  machine: { has: null as string | null, lands: null as string | null, changed: false },
}));

const ok = (stdout: string) => ({ ok: true, code: 0, killed: false, stdout, stderr: "" });
const fail = () => ({ ok: false, code: "ENOENT", killed: false, stdout: "", stderr: "" });

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    calls.push({ cmd, args });
    if (/cswap(\.exe)?$/.test(cmd) && args[0] === "--version") {
      const v = machine.changed ? machine.lands : machine.has;
      return v ? ok(`claude-swap ${v}`) : fail();
    }
    // An install or an upgrade, whichever tool it was aimed at. Recorded and
    // answered, never run: the tool it names is not on the machine running this
    // suite and must not be.
    if ((args.includes("install") || args.includes("upgrade")) && probeOk.is(cmd)) {
      machine.changed = true;
      return ok("");
    }
    // safePythons: the same answer on all three platforms, so the shape of the
    // installer list does not depend on which CI leg is running.
    if (cmd === "xcode-select") return ok("/Library/Developer/CommandLineTools");
    if (cmd === "py" && args[0] === "-0") return ok(" -V:3.12 *");
    if (cmd === "where") return fail();
    return probeOk.is(cmd) ? ok("1.0.0") : fail();
  },
}));

// No uv was ever fetched into ~/.agents-deck, and none can be: this file is
// about the specifier on the command line, not about acquiring the tool.
vi.mock("../../server/uv-bootstrap.mjs", () => ({
  existingBootstrappedUv: () => null,
  bootstrapUv: async () => ({ ok: false, reason: "test" }),
}));

vi.stubGlobal("fetch", async () => {
  // A registry that cannot be reached throws, which is how an offline laptop
  // and a DNS failure both arrive in this code.
  if (!pypi.reachable) throw new Error("getaddrinfo ENOTFOUND pypi.org");
  return { ok: true, json: async () => pypi.body };
});

/** A PyPI JSON body naming these versions; `yanked` names the withdrawn ones. */
function registry(versions: string[], yanked: string[] = []) {
  const releases: Record<string, { yanked: boolean }[]> = {};
  for (const v of versions) releases[v] = [{ yanked: yanked.includes(v) }];
  // `info.version` is PyPI's own idea of latest and is deliberately set to the
  // highest string here rather than to the highest acceptable one — reading it
  // instead of deciding for itself is exactly what the deck stopped doing.
  return { info: { version: versions[versions.length - 1] }, releases };
}

const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-cswap-bound-"));
const UV_TOOL_DIR = join(FAKE_HOME, "uv-tools");
const RECORD = join(FAKE_HOME, ".agents-deck", "cswap-upgrade.json");
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  NO_INSTALL: process.env.AGENTS_DECK_NO_INSTALL,
  CSWAP: process.env.AGENTS_DECK_CSWAP,
  UV_TOOL_DIR: process.env.UV_TOOL_DIR,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.UV_TOOL_DIR = UV_TOOL_DIR;
delete process.env.AGENTS_DECK_NO_INSTALL;
delete process.env.AGENTS_DECK_CSWAP;

afterAll(() => {
  for (const [key, was] of [["HOME", prev.HOME], ["USERPROFILE", prev.USERPROFILE],
    ["AGENTS_DECK_NO_INSTALL", prev.NO_INSTALL], ["AGENTS_DECK_CSWAP", prev.CSWAP],
    ["UV_TOOL_DIR", prev.UV_TOOL_DIR]] as const) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(FAKE_HOME);
});

beforeEach(() => {
  calls.length = 0;
  machine.has = null;
  machine.lands = null;
  machine.changed = false;
  pypi.reachable = true;
  pypi.body = registry(["0.25.0", "0.26.0"]);
  // uv is the tool on this machine, for every case that has one at all.
  probeOk.is = (cmd: string) => cmd === "uv";
  // The marker throttles the daily check, and the module memoizes the resolved
  // binary and the python list — every case gets a clean home and a fresh
  // module instance.
  rmTempDir(join(FAKE_HOME, ".agents-deck"));
  rmTempDir(UV_TOOL_DIR);
});

/**
 * One whole `ensureCswap`, on the machine the case has just described.
 *
 * `owned` lays down the uv tool directory the daily upgrade reads to decide who
 * installed the package — only the upgrade path looks at it, so install cases
 * leave it out and get a machine with nothing on it.
 */
async function boot({ owned = false } = {}) {
  if (owned) mkdirSync(join(UV_TOOL_DIR, "claude-swap"), { recursive: true });
  vi.resetModules();
  // @ts-expect-error — .mjs server module, no types
  const mod = await import("../../server/cswap-install.mjs");
  const state = await mod.ensureCswap();
  // ensureCswap returns before the upgrade finishes, deliberately — the boot
  // does not wait for it. The test does, so nothing is still writing under the
  // temp home after teardown has deleted it.
  const upgrade = await mod.upgradeSettled();
  return { state, upgrade, calls: [...calls] };
}

/** The install command line the deck actually issued, or undefined. */
function installArgv(issued: { cmd: string; args: string[] }[]) {
  return issued.find(c => c.args.includes("install"));
}

// ── 1. what the install asks for ────────────────────────────────────────────

describe("the claude-swap install command line", () => {
  it("names one exact version when the registry could be asked", async () => {
    machine.lands = "0.26.0";

    const { state, calls } = await boot();

    // Not `claude-swap`. The version is decided before the install runs
    // precisely so that what comes back can be compared against it.
    expect(installArgv(calls)).toEqual({ cmd: "uv", args: ["tool", "install", "claude-swap==0.26.0"] });
    expect(state).toEqual({ state: "installed", via: "uv", version: "0.26.0" });
  });

  it("falls back to a bounded range rather than to the bare name when PyPI cannot be reached", async () => {
    pypi.reachable = false;
    machine.lands = "0.26.0";

    const { state, calls } = await boot();

    // A laptop on a train still gets a bound. This is the line that used to be
    // `["tool", "install", "claude-swap"]` unconditionally.
    expect(installArgv(calls)).toEqual({ cmd: "uv", args: ["tool", "install", "claude-swap~=0.26"] });
    expect(state).toMatchObject({ state: "installed", version: "0.26.0" });
  });

  it("carries no character cmd.exe reads as redirection", async () => {
    pypi.reachable = false;

    const { calls } = await boot();
    const spec = installArgv(calls)!.args.at(-1)!;

    // `~=0.26` is PEP 440's compatible-release operator and expands to
    // `>= 0.26, == 0.*` — the same set as `>=0.26,<1`, spelled without the two
    // characters cmd.exe treats as syntax outside quotes. run() spawns with
    // shell:false, but the Windows leg routes a `.cmd`/`.bat` shim through
    // cmd.exe (exec.mjs viaCmd), and an argument that never needs that quoting
    // cannot be broken by a change to it.
    expect(spec).toBe("claude-swap~=0.26");
    expect(spec).not.toMatch(/[<>]/);
  });

  it("gives pipx and `python -m pipx` the same bound uv gets", async () => {
    // One bound, stated once, on every spelling of the install — the version
    // the deck accepts cannot depend on which Python tool the user happens to
    // have. `python -m pipx` is here because it is the entry that has been
    // wrong on its own before (#579).
    for (const [available, want] of [
      ["pipx", { cmd: "pipx", args: ["install", "claude-swap==0.26.0"] }],
      ["python3", { cmd: "python3", args: ["-m", "pipx", "install", "claude-swap==0.26.0"] }],
      ["py", { cmd: "py", args: ["-m", "pipx", "install", "claude-swap==0.26.0"] }],
    ] as const) {
      calls.length = 0;
      machine.changed = false;
      probeOk.is = (cmd: string) => cmd === available;
      const { calls: issued } = await boot();
      // `py` exists only on Windows and `python3` only off it, so exactly one of
      // the last two runs on any given CI leg; the pipx case runs everywhere.
      const argv = installArgv(issued);
      if (argv) expect(argv).toEqual(want);
      else expect(available).not.toBe("pipx");
    }
  });
});

// ── 2. what "newest" is allowed to mean ─────────────────────────────────────

describe("the version the daily check will chase", () => {
  it("ignores a release above the ceiling, which is the shape a takeover takes", async () => {
    // A hijacked PyPI project publishes a number chosen to win every
    // resolution. `info.version` would then say 9.9.9, every deck on earth
    // would run `uv tool upgrade claude-swap` within 24 hours, and the
    // replacement console script is handed `export -` on the next panel open.
    machine.has = "0.26.0";
    pypi.body = registry(["0.26.0", "9.9.9"]);

    const { state } = await boot({ owned: true });

    expect(state).toEqual({ state: "present", version: "0.26.0" });
    // And, just as important, no daily sentence about an upgrade that is not
    // happening: there is nothing acceptable that is newer, so there is nothing
    // to say. This file's neighbours were both bitten by the opposite (#579).
    expect(state).not.toHaveProperty("latest");
  });

  it("ignores a pre-release", async () => {
    machine.has = "0.26.0";
    pypi.body = registry(["0.26.0", "0.27.0b1"]);

    const { state } = await boot({ owned: true });

    // claude-swap really does publish these — 0.21.0b1, 0.20.0b1, 0.14.0b1 are
    // all on the index — and an unattended upgrade is not where a beta belongs.
    expect(state).toEqual({ state: "present", version: "0.26.0" });
  });

  it("ignores a release whose every file has been yanked", async () => {
    machine.has = "0.26.0";
    pypi.body = registry(["0.26.0", "0.27.0"], ["0.27.0"]);

    const { state } = await boot({ owned: true });

    // A yank is the author withdrawing a release. Installers skip it, so
    // chasing it would produce an upgrade that resolves back to the version
    // already installed, every day, forever.
    expect(state).toEqual({ state: "present", version: "0.26.0" });
  });

  it("takes the newest acceptable release and not the newest one listed", async () => {
    machine.has = "0.25.0";
    pypi.body = registry(["0.25.0", "0.26.0", "0.27.0b1", "9.9.9"]);

    const { state } = await boot({ owned: true });

    expect(state).toMatchObject({ state: "upgrading", version: "0.25.0", latest: "0.26.0" });
  });
});

// ── 3. and whether what arrived is what was asked for ───────────────────────

describe("a claude-swap the deck did not ask for", () => {
  it("is refused rather than driven, when an exact version was named", async () => {
    // The deck ran `uv tool install claude-swap==0.26.0` and 9.9.9 answered.
    // Only something other than that specifier can have chosen it — a local
    // index on PIP_INDEX_URL, a `cswap` shadowing it earlier on PATH, a
    // resolver that did not honour the bound. The next thing this binary would
    // be handed is `cswap export -`, which prints a refresh token to stdout.
    machine.lands = "9.9.9";

    const { state } = await boot();

    expect(state).toEqual({
      state: "unavailable", reason: "unexpected_version",
      version: "9.9.9", want: "0.26.0", via: "uv",
    });
  });

  it("is refused when it falls outside the range the offline install asked for", async () => {
    pypi.reachable = false;
    machine.lands = "0.9.0";

    const { state } = await boot();

    // Below the floor is not merely old: the panel's command surface is written
    // against 0.26, and claude-swap's flags have moved inside 0.x before.
    expect(state).toEqual({
      state: "unavailable", reason: "unexpected_version",
      version: "0.9.0", want: "claude-swap~=0.26", via: "uv",
    });
  });

  it("is accepted when it is the version that was named", async () => {
    machine.lands = "0.26.0";

    const { state } = await boot();

    expect(state).toEqual({ state: "installed", via: "uv", version: "0.26.0" });
  });

  it("is not refused merely for printing a version this deck cannot parse", async () => {
    // `versionIn` answers the literal "installed" for a `--version` with no
    // three-part number in it, and this file's own module already treats that
    // as an ordinary outcome elsewhere. It is an absence of evidence, not
    // evidence of a bad version — refusing it would trade a supply-chain risk
    // for a certain dark panel the day `cswap --version` changes how it prints.
    machine.lands = "from source";

    const { state } = await boot();

    expect(state).toEqual({ state: "installed", via: "uv", version: "installed" });
  });
});

// ── 4. and what the upgrade leaves behind ───────────────────────────────────

describe("the background upgrade", () => {
  it("writes down what landed instead of running where nothing can see it", async () => {
    // It used to be `runDetached`: stdio "ignore", no exit listener, no
    // listener of any kind. The deck replaced the binary that holds Claude
    // refresh tokens and had no way, ever, to say whether the command ran, what
    // it exited with, or which version came back — while ensureCswap returned
    // "upgrading" and the only announcement was a boot row naming the version
    // being LEFT.
    machine.has = "0.25.0";
    machine.lands = "0.26.0";
    pypi.body = registry(["0.25.0", "0.26.0"]);

    const { state, upgrade } = await boot({ owned: true });

    expect(state).toMatchObject({ state: "upgrading", version: "0.25.0", latest: "0.26.0" });
    expect(upgrade).toMatchObject({ from: "0.25.0", want: "0.26.0", to: "0.26.0", ok: true, via: "uv" });
    expect(JSON.parse(readFileSync(RECORD, "utf8"))).toMatchObject({
      from: "0.25.0", want: "0.26.0", to: "0.26.0", ok: true,
    });
  });

  it("says so when the version that arrived is outside the bound", async () => {
    // Reachable only on an install that predates this bound — uv and pipx both
    // re-resolve an upgrade against the requirement recorded at install time,
    // so a receipt written with a specifier keeps it. That is exactly the
    // population this matters for: every deck that installed claude-swap before
    // there was a bound to record.
    machine.has = "0.25.0";
    machine.lands = "9.9.9";

    const { upgrade } = await boot({ owned: true });

    expect(upgrade).toMatchObject({ from: "0.25.0", to: "9.9.9", ok: false, reason: "unexpected_version" });
  });
});

// ── 5. and what the panel tells someone who has to do it themselves ─────────

describe("the install hint", () => {
  it("is never a pipe into a shell", async () => {
    // This string is not scrollback: it reaches the browser as `hint` on the
    // `no_cswap` roster reply and renders in the accounts panel as the command
    // to run. It used to end in `curl -LsSf https://astral.sh/uv/install.sh | sh`
    // — the exact command uv-bootstrap.mjs opens by naming and declining,
    // because it executes whatever that URL happens to serve with the user's
    // privileges. The machines that see this hint are disproportionately the
    // ones that set AGENTS_DECK_NO_DOWNLOAD=1, i.e. the ones that asked the
    // deck not to fetch unverified binaries in the first place.
    probeOk.is = () => false;   // no python either, so this is the uv branch
    vi.resetModules();
    // @ts-expect-error — .mjs server module, no types
    const { installHint } = await import("../../server/cswap-install.mjs");
    const hint = await installHint();

    expect(hint).not.toMatch(/\|\s*(sh|bash|iex)\b/);
    expect(hint).not.toMatch(/curl|irm|Invoke-RestMethod/i);
    // And whatever it does recommend still carries the bound, so a user who
    // follows it by hand ends up where the deck would have put them.
    expect(hint).toContain('uv tool install "claude-swap~=0.26"');
  });

  it("carries the bound on the pipx route as well", async () => {
    // The branch taken when the machine already has a usable Python: `py` on
    // Windows, `python3` elsewhere.
    probeOk.is = (cmd: string) => cmd === "python3" || cmd === "py";
    vi.resetModules();
    // @ts-expect-error — .mjs server module, no types
    const { installHint } = await import("../../server/cswap-install.mjs");
    const hint = await installHint();

    expect(hint).toContain('pipx install "claude-swap~=0.26"');
  });
});
