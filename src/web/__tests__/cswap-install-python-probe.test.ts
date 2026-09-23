// The Windows Python probe, and why it is not `run("python", …)` (#1169).
//
// `python` and `python3` are on PATH on every Windows install whether or not
// Python is there: they are App Execution Aliases under WindowsApps —
// zero-length reparse points whose only behaviour is to open the Microsoft
// Store. Presence proves nothing and RUNNING one opens a shop. So safePythons
// asks `py -0` first (the launcher, which exists only where Python really does
// and is never an alias), then `where` — which reports paths without executing
// anything — and drops every path under \WindowsApps\ before calling what is
// left by absolute path.
//
// This runs unprompted at startup for an optional panel, which is what makes it
// worth a test: the user never asked for anything, and a regression opens the
// Store on their screen, or hands the claude-swap install a reparse point and
// reports `install_failed`.
//
// Until this file the branch had never run. The three tests that mention
// safePythons answer `where` with a failure, deliberately, so their answer is
// the same on all three platforms — which means even the Windows CI leg never
// reached the alias filter. `WindowsApps` appeared in no test at all.
//
// `installHint` is the entry: it is exported, it is what a machine with no
// claude-swap actually prints, and it walks safePythons' answer in order. Every
// `run` is answered from a table, `process.platform` is stubbed per case, and
// the module is reloaded each time because safePythons memoises its answer for
// the life of the process.
import { afterEach, describe, expect, it, vi } from "vitest";

const ALIAS = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe";
const REAL_PY = "C:\\Python312\\python.exe";

type Answer = false | true | string;

// Nothing is executed: `run` records what it was asked and answers from
// `reply`. A regression that reaches for an alias shows up as a recorded cmd
// rather than as a Store window on the machine running the suite.
const { proc } = vi.hoisted(() => ({
  proc: {
    calls: [] as { cmd: string; args: string[] }[],
    reply: (() => false) as (cmd: string, args: string[]) => Answer,
  },
}));

vi.mock("../../server/exec.mjs", () => ({
  run: async (cmd: string, args: string[] = []) => {
    proc.calls.push({ cmd, args });
    const answer = proc.reply(cmd, args);
    if (answer === false) return { ok: false, code: "ENOENT", killed: false, timedOut: false, stdout: "", stderr: "" };
    return { ok: true, code: 0, killed: false, timedOut: false, stdout: answer === true ? "" : answer, stderr: "" };
  },
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

/** One machine: its platform, and how it answers each command. */
async function probeOn(os: string, reply: (cmd: string, args: string[]) => Answer): Promise<string> {
  Object.defineProperty(process, "platform", { value: os, configurable: true });
  proc.calls.length = 0;
  proc.reply = reply;
  vi.resetModules();
  // @ts-expect-error — plain .mjs server module, no types
  const { installHint } = await import("../../server/cswap-install.mjs");
  return installHint();
}

/** Which interpreters were actually started, in order. `where`, `py -0` and
 *  `xcode-select` are probes of the environment, not of an interpreter. */
const interpreters = () => proc.calls
  .filter(c => c.args[0] === "-c" || c.args[0] === "-m")
  .map(c => c.cmd);

afterEach(() => { Object.defineProperty(process, "platform", platform); });

describe("Windows, where `python` on PATH may be a Store alias", () => {
  it("runs the real interpreter `where` found and never the alias beside it", async () => {
    // `where python` prints every match, best-effort, in PATH order — and the
    // alias comes first on a stock profile, because WindowsApps is ahead of
    // C:\Python312 in the user PATH the installer writes. CRLF, since this is
    // cmd's own output.
    const hint = await probeOn("win32", (cmd, args) => {
      if (cmd === "where" && args[0] === "python") return `${ALIAS}\r\n${REAL_PY}\r\n`;
      return false;   // no py launcher, no python3, and the interpreter answers nothing
    });

    expect(interpreters()).toEqual([REAL_PY]);
    // The claim in full, and the one a reader of the panel cares about: no
    // child of any kind was ever aimed at WindowsApps.
    for (const c of proc.calls) expect(c.cmd).not.toContain("WindowsApps");
    // The interpreter answered nothing, so the hint falls through to uv —
    // which is the right answer for a machine with no usable python, and is
    // here to show the probe is what decided it.
    expect(hint).toContain("winget install");
  });

  it("offers the pip route when that interpreter does answer, quoting its path", async () => {
    const hint = await probeOn("win32", (cmd, args) => {
      if (cmd === "where" && args[0] === "python") return `${ALIAS}\r\n${REAL_PY}\r\n`;
      if (cmd === REAL_PY) return true;
      return false;
    });
    expect(hint).toContain(`${REAL_PY} -m pip install --user pipx`);
    expect(hint).not.toContain("WindowsApps");
  });

  it("probes nothing at all when every python on PATH is an alias", async () => {
    // The shape of a Windows box that has never had Python: both names resolve,
    // both are reparse points, and the honest answer is "there is no python
    // here" rather than two Store windows.
    await probeOn("win32", (cmd) => (cmd === "where" ? `${ALIAS}\r\n` : false));
    expect(interpreters()).toEqual([]);
  });

  it("prefers the launcher to anything `where` reports", async () => {
    // `py` exists only where Python was really installed, so it is both safe
    // and the better answer — and asking it first is what keeps a machine with
    // a working launcher from depending on PATH order at all.
    await probeOn("win32", (cmd, args) => {
      if (cmd === "py" && args[0] === "-0") return " -V:3.12 *";
      if (cmd === "where" && args[0] === "python") return `${REAL_PY}\r\n`;
      if (cmd === "py") return true;
      return false;
    });
    expect(interpreters()[0]).toBe("py");
  });

  it("keeps one interpreter per name rather than every path that matched", async () => {
    // `where` on a machine with several Pythons prints all of them; probing
    // each in turn is a pile of subprocesses at startup for an answer the first
    // one already gave.
    await probeOn("win32", (cmd, args) => {
      if (cmd === "where" && args[0] === "python") return `${ALIAS}\r\nC:\\Python313\\python.exe\r\n${REAL_PY}\r\n`;
      if (cmd === "where" && args[0] === "python3") return "C:\\Python313\\python3.exe\r\n";
      return false;
    });
    expect(interpreters()).toEqual(["C:\\Python313\\python.exe", "C:\\Python313\\python3.exe"]);
  });
});

describe("the other two platforms, where a bare name is just a name", () => {
  it("uses the names on PATH on Linux, python3 first", async () => {
    await probeOn("linux", () => false);
    expect(interpreters()).toEqual(["python3", "python"]);
    // And asks nothing about aliases or launchers, neither of which exists here.
    expect(proc.calls.map(c => c.cmd)).toEqual(["python3", "python"]);
  });

  it("runs no python on a Mac whose command line tools are not installed", async () => {
    // `python3` on such a Mac is Apple's stub, and running it pops the "install
    // the developer tools" dialog — the macOS spelling of the Store window.
    // `xcode-select -p` answers whether the real thing is behind the name, and
    // is itself only a path lookup.
    await probeOn("darwin", () => false);
    expect(interpreters()).toEqual([]);
    expect(proc.calls.map(c => c.cmd)).toEqual(["xcode-select"]);
  });

  it("uses them on a Mac that does have them", async () => {
    await probeOn("darwin", cmd => (cmd === "xcode-select" ? "/Library/Developer/CommandLineTools" : false));
    expect(interpreters()).toEqual(["python3", "python"]);
  });
});
