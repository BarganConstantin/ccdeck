// "Quit browser" on Windows force-killed every Chrome on the machine (#1028).
//
// ── what was observed ────────────────────────────────────────────────────────
//
// Read from Linux, from the code rather than from a Windows machine — which is
// stated here because the whole of this file's subject is a platform nobody in
// this session could run. Two facts, both in the source:
//
//   browser-presence.mjs: four browser keys map to one Windows image name.
//     chrome, chrome-beta, chrome-canary and chromium are all `chrome`.
//
//   browser-react.mjs:  exec("taskkill", ["/IM", `${proc}.exe`, "/F"])
//
// `/F` is TerminateProcess. Nothing gets to refuse it — no beforeunload, no
// session write, no "restore pages?" on the next launch — and `/IM chrome.exe`
// names all four channels at once, plus every renderer each of them started.
// So a user who armed this reaction for a finding in Canary lost stable Chrome,
// Beta, Canary and Chromium together, forcibly, with every unsaved form in
// every window of all four going with them.
//
// The same reaction on the same finding quits Canary ALONE on macOS:
// `tell application (item 1 of argv) to quit` with the name out of the darwin
// table, which distinguishes "Google Chrome" from "Google Chrome Canary". Linux
// sends SIGTERM through `pkill -x`. Windows was the one leg of the one reaction
// that "takes the session back" where taking the session back also meant taking
// the user's work.
//
// ── why the rules below are written the way they are ─────────────────────────
//
// A feature that closes somebody's browser has exactly one safety property
// worth pinning, and it is a NEGATIVE one: what it must never do. So the
// sharpest cases here assert an absence — no `/F` reaches taskkill on any path
// through the function, and a Canary that is not running produces no taskkill
// at all rather than one aimed at the stable Chrome next to it. A positive
// assertion that Canary's pid was targeted would still pass on the day the
// function also targeted three other browsers.
//
// NOTHING HERE RUNS A REAL taskkill, pkill OR osascript. Every case passes its
// own `deps.run`, which is the injection point quitBrowser and react already
// take, so `exec.mjs`'s `run` is never reached and no process on the machine
// running this suite is ever signalled.
//
// The one claim this file CANNOT settle is where Windows installs each Chrome
// channel. `installMarker`'s table is documented installer layout, not a
// measurement — so what is pinned here is the property that matters whichever
// way that table is right or wrong: the separators make the fragments mutually
// exclusive, and a path the deck cannot attribute is dropped rather than
// claimed.
import { describe, it, expect } from "vitest";
import {
  pickInstallPids, quitBrowser, react, windowedProcessesPs,
} from "../../server/browser-react.mjs";
import { installMarker, processName, sharesProcessName } from "../../server/browser-presence.mjs";

type Call = { cmd: string; args: string[] };

/**
 * A `run` that answers per command, and records everything it was asked.
 *
 * `windows` is the JSON a `Get-Process … | Select-Object Id,Path` would print.
 * `null` there makes the PowerShell call fail, which is the "this machine has
 * no usable PowerShell" branch.
 */
function fakeRun(windows: unknown[] | null) {
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[] = []) => {
    calls.push({ cmd, args });
    if (cmd.toLowerCase().includes("powershell")) {
      return windows === null
        ? { ok: false, stdout: "", stderr: "not recognized" }
        : { ok: true, stdout: JSON.stringify(windows), stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  return { calls, run, taskkills: () => calls.filter(c => c.cmd === "taskkill") };
}

/** Executable paths in the layout each Chrome channel's installer uses. */
const PATHS = {
  chrome: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  beta: "C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe",
  canary: "C:\\Users\\dorin\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe",
  chromium: "C:\\Users\\dorin\\AppData\\Local\\Chromium\\Application\\chrome.exe",
};

/** All four channels windowed at once, which is the situation the bug needed. */
const FOUR_CHANNELS = [
  { Id: 100, Path: PATHS.chrome },
  { Id: 200, Path: PATHS.beta },
  { Id: 300, Path: PATHS.canary },
  { Id: 400, Path: PATHS.chromium },
];

describe("the reaction never forces, on any path through it", () => {
  it("passes no /F to taskkill, whichever branch the machine takes", async () => {
    // THE DESTRUCTIVE HALF, as a rule rather than as one case. `/F` is the flag
    // that costs the user their tabs, and there are three ways out of this
    // function on Windows — a targeted close, the fallback when PowerShell
    // could not answer, and the close of a browser whose channels cannot be
    // told apart. Asserting on each of them separately is how one of them keeps
    // the flag through a later edit.
    for (const listing of [FOUR_CHANNELS, [], null]) {
      for (const key of ["chrome", "chrome-canary", "chromium", "edge", "brave"]) {
        const f = fakeRun(listing);
        await quitBrowser(key, "win32", { run: f.run });
        for (const call of f.taskkills()) {
          expect(call.args, `${key} with listing ${JSON.stringify(listing)}`).not.toContain("/F");
          expect(call.args).not.toContain("/f");
        }
      }
    }
  });

  it("still sends the polite signal on the two platforms that always did", async () => {
    // A guard on the legs that were already right. The Windows repair moved the
    // shape of this function around and these two are what it must not disturb.
    const mac = fakeRun(null);
    expect(await quitBrowser("chrome-canary", "darwin", { run: mac.run }))
      .toEqual({ ok: true, reason: "quit" });
    expect(mac.calls[0].cmd).toBe("osascript");
    expect(mac.calls[0].args.at(-1)).toBe("Google Chrome Canary");

    const linux = fakeRun(null);
    expect(await quitBrowser("chrome-canary", "linux", { run: linux.run }))
      .toEqual({ ok: true, reason: "quit" });
    // SIGTERM, which is pkill's default and the reason the Linux leg never had
    // this bug even though its table has the same collision.
    expect(linux.calls[0]).toEqual({ cmd: "pkill", args: ["-x", "chrome"] });
  });
});

describe("arming it for one Chrome channel leaves the others alone", () => {
  it("aims at the pids of the install the finding came from, not at the image name", async () => {
    const f = fakeRun(FOUR_CHANNELS);
    const out = await quitBrowser("chrome-canary", "win32", { run: f.run });
    expect(out).toEqual({ ok: true, reason: "quit" });

    const [kill] = f.taskkills();
    expect(kill.args).toEqual(["/PID", "300"]);
    // Said the other way round as well, because "contains Canary's pid" would
    // pass on a call that also carried the other three.
    for (const pid of ["100", "200", "400"]) expect(kill.args).not.toContain(pid);
    // And not by image name at all, which is the spelling that cannot be
    // narrowed: four browsers answer to `chrome.exe`.
    expect(kill.args).not.toContain("/IM");
  });

  it("closes NOTHING when the armed channel has no window, rather than the neighbour that does", async () => {
    // The case that used to cost the most and looked like success. Canary was
    // quit by hand between the visit and the poll; stable Chrome is still open
    // with the user's work in it. `taskkill /IM chrome.exe /F` would have found
    // that Chrome, matched it, and destroyed it — reporting `quit`.
    const f = fakeRun([{ Id: 100, Path: PATHS.chrome }]);
    const out = await quitBrowser("chrome-canary", "win32", { run: f.run });

    expect(out).toEqual({ ok: false, reason: "no_window" });
    expect(f.taskkills()).toHaveLength(0);
  });

  it("asks only for the windows, so no renderer is ever a target", async () => {
    // Every renderer, GPU process and utility process a Chromium browser starts
    // carries the same image name as the browser. None of them has a window, so
    // none of them can be asked to close — only forced. Selecting on the window
    // handle in the query is what keeps them out of the list entirely.
    expect(windowedProcessesPs("chrome")).toContain("MainWindowHandle -ne 0");
    expect(windowedProcessesPs("chrome")).toContain("Get-Process -Name chrome");
    // No double quote anywhere in it: this travels as a single `-Command`
    // argument on a Windows command line, and PowerShell documents that
    // everything after `-Command` is appended to the command TEXT. A script
    // with nothing for the command-line construction to escape is the one shape
    // that cannot be broken by it.
    expect(windowedProcessesPs("chrome")).not.toContain('"');
  });
});

describe("what it does when it cannot tell the installs apart", () => {
  it("falls back to asking the whole family, never to forcing it", async () => {
    // PowerShell missing, blocked by policy, or refusing. The old code's reach
    // is kept — the alternative is a reaction that silently does nothing, which
    // this module's header calls worse than one that was never offered — but
    // the FORCE is not, so the worst case now is strictly gentler than the best
    // case was before.
    const f = fakeRun(null);
    const out = await quitBrowser("chrome-canary", "win32", { run: f.run });

    expect(out).toEqual({ ok: true, reason: "quit_family" });
    expect(f.taskkills()[0].args).toEqual(["/IM", "chrome.exe"]);
  });

  it("says so in the log, because three extra browsers closing is not 'quit the browser'", async () => {
    // A `could not` line would be wrong — it did close the browser — and the
    // ordinary success line would be a lie of omission. The log is the only
    // place a reader would ever find out that the reaction was broader than
    // what they armed.
    const f = fakeRun(null);
    const done = await react("quit-browser", { host: "x.example", count: 1, browser: "chrome-canary" },
      { platform: "win32", deps: { run: f.run } });

    expect(done.some(l => l.includes("cannot tell its channels apart"))).toBe(true);
    expect(done).not.toContain("quit the browser");
  });

  it("does not reach for the fallback when the name already names one browser", async () => {
    // `msedge`, `brave` and `vivaldi` are one browser each, so there is nothing
    // to disambiguate and the install table is not consulted. The pid path is
    // still taken, because that is what keeps the windowless processes out.
    const f = fakeRun([{ Id: 77, Path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" }]);
    const out = await quitBrowser("edge", "win32", { run: f.run });

    expect(out).toEqual({ ok: true, reason: "quit" });
    expect(f.taskkills()[0].args).toEqual(["/PID", "77"]);
    expect(sharesProcessName("edge", "win32")).toEqual([]);
  });
});

describe("pickInstallPids, which is where a mis-aimed close would come from", () => {
  it("does not let one channel's fragment match another's directory", () => {
    // THE WHOLE OF THE DISCRIMINATION, and the reason the fragments carry a
    // separator at both ends. A bare `Chrome` occurs in all three of
    // `\Google\Chrome\`, `\Google\Chrome Beta\` and `\Google\Chrome SxS\`;
    // `\Google\Chrome\` occurs in exactly one of them. Get this wrong and the
    // reaction is back to closing browsers nobody armed it for, with the
    // targeting code still in place to make it look deliberate.
    const pidsFor = (key: string) =>
      pickInstallPids(JSON.stringify(FOUR_CHANNELS), installMarker(key, "win32"));

    expect(pidsFor("chrome")).toEqual([100]);
    expect(pidsFor("chrome-beta")).toEqual([200]);
    expect(pidsFor("chrome-canary")).toEqual([300]);
    expect(pidsFor("chromium")).toEqual([400]);
  });

  it("matches a per-user install of the same channel as readily as a per-machine one", () => {
    // Chrome installs under %ProgramFiles% for the machine and under
    // %LOCALAPPDATA% for one user, and the deck sees whichever the user has. A
    // fragment rather than a full path is what covers both; anchoring on either
    // root would miss half the installs and send the reaction to its fallback.
    const perUser = [{ Id: 9, Path: "C:\\Users\\dorin\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe" }];
    expect(pickInstallPids(JSON.stringify(perUser), installMarker("chrome", "win32"))).toEqual([9]);
  });

  it("drops a process whose path it could not read rather than claiming it", () => {
    // `Get-Process` cannot read `.Path` for a process this session may not open,
    // and the row arrives with a null. Keeping it would put exactly the
    // unattributable processes back into a set whose entire purpose is to
    // exclude what is not this browser — so it goes, and the cost of being
    // wrong is a reaction that closed too little.
    const rows = [{ Id: 1, Path: null }, { Id: 2 }, { Id: 3, Path: PATHS.canary }];
    expect(pickInstallPids(JSON.stringify(rows), installMarker("chrome-canary", "win32"))).toEqual([3]);
  });

  it("takes every windowed pid when there is no install to distinguish", () => {
    const rows = [{ Id: 4, Path: null }, { Id: 5, Path: "C:\\x\\brave.exe" }];
    expect(pickInstallPids(JSON.stringify(rows), null)).toEqual([4, 5]);
  });

  it("reads one row as readily as a list, since ConvertTo-Json collapses a single", () => {
    // One browser window is the common case, and PowerShell emits a bare object
    // rather than a one-element array for it. A parser that only handled the
    // list would send the ordinary case to the fallback.
    expect(pickInstallPids(JSON.stringify({ Id: 300, Path: PATHS.canary }), installMarker("chrome-canary", "win32")))
      .toEqual([300]);
  });

  it("answers nothing for every shape of nothing", () => {
    for (const junk of ["", "not json", "null", "[]", undefined, null]) {
      expect(pickInstallPids(junk as string, "\\Google\\Chrome\\")).toEqual([]);
    }
  });
});

describe("the tables the reaction asks before it acts", () => {
  it("names the collision Windows has and macOS does not", () => {
    // macOS distinguishes all four by display name, which is why the bug was
    // invisible from the platform this repo is developed on.
    expect(sharesProcessName("chrome-canary", "win32").sort())
      .toEqual(["chrome", "chrome-beta", "chromium"]);
    expect(sharesProcessName("chrome-canary", "darwin")).toEqual([]);
    // Linux collides too — three keys on `chrome` — and does not lose data for
    // it, because `pkill -x` is a SIGTERM. Named here so a future edit that
    // borrows the Windows targeting for Linux knows the collision is real.
    expect(sharesProcessName("chrome-canary", "linux").sort()).toEqual(["chrome", "chrome-beta"]);
  });

  it("has an install fragment for every key whose Windows name is shared", () => {
    // The invariant the fallback exists for, said as a check: a key that is
    // ambiguous and has no fragment can only be closed by image name. That is
    // allowed — it is the `quit_family` path — but it should be a deliberate
    // gap rather than one that appeared when somebody added a browser.
    const winKeys = ["chrome", "chrome-beta", "chrome-canary", "chromium", "brave", "edge", "vivaldi"];
    for (const key of winKeys) {
      if (!processName(key, "win32")) continue;
      if (!sharesProcessName(key, "win32").length) continue;
      expect(installMarker(key, "win32"), `${key} is ambiguous with no install fragment`).toBeTruthy();
    }
  });

  it("makes no install claim on a platform where the name is the install", () => {
    expect(installMarker("chrome-canary", "darwin")).toBeNull();
    expect(installMarker("chrome-canary", "linux")).toBeNull();
  });
});
