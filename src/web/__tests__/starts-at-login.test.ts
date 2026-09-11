// Detaching answers "the terminal closed". It does not answer "the machine
// rebooted", and between those two the deck is exactly as absent: the hooks
// post into a refused connection, the LAN beacon goes quiet, and paired
// colleagues watch this machine time out. The first `ccdeck` typed after a
// reboot brings it back, and everything before that is lost.
//
// Three platforms, three native shapes, and the thing that differs is where the
// deck's console output can go — see the header of login-service.mjs. What none
// of the three has is a restart policy: KeepAlive, Restart=always and "restart
// on failure" all exist and are all deliberately absent, because the ceiling
// that decides when a crashed deck stops coming back lives in ONE place and two
// policies over one process is how `--stop` becomes a suggestion the machine
// overrules a second later.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error — plain .mjs module, no types
const svc = await import("../../server/login-service.mjs");
// @ts-expect-error — plain .mjs module, no types
const globalInstall = await import("../../server/global-install.mjs");
const {
  SERVICE_LABEL, SERVICE_RECORD, installService, plistFor, readServiceRecord, registerCommand,
  servicePath, shouldOfferService, taskXmlFor, unitFor, unregisterCommand, xmlEscape,
} = svc as Record<string, any>;

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const DECK = read("../../../bin/deck.js");
const SRC = read("../../server/login-service.mjs");

const JOB = {
  execPath: "/usr/bin/node",
  script: "/opt/ccdeck/bin/agent-dag.js",
  logPath: "/Users/x/Library/Logs/ccdeck/deck.log",
  args: ["--no-open"],
};

describe("no service manager is given a restart policy", () => {
  it("leaves the ceiling in the one place that has one", () => {
    // crashPolicy in supervisor.mjs: five in ten minutes, waits doubling,
    // identical on every platform, tested. A KeepAlive beside it would put the
    // deck back one second after `ccdeck --stop`, and the off switch would be a
    // suggestion.
    const plist = plistFor(JOB);
    expect(plist).not.toContain("KeepAlive");
    expect(unitFor(JOB)).not.toContain("Restart=");
    const xml = taskXmlFor(JOB);
    expect(xml).not.toContain("RestartOnFailure");
    expect(xml).not.toContain("<RestartCount>");
  });

  it("starts at login and at nothing else", () => {
    expect(plistFor(JOB)).toContain("<key>RunAtLoad</key>");
    expect(plistFor(JOB)).not.toContain("StartInterval");
    expect(unitFor(JOB)).toContain("WantedBy=default.target");
    expect(taskXmlFor(JOB)).toContain("<LogonTrigger>");
  });

  it("does not open a browser at login", () => {
    // A login is not somebody asking to look at the deck. The auto-install and
    // the explicit command both pass this.
    expect(plistFor(JOB)).toContain("<string>--no-open</string>");
    expect(DECK).toMatch(/installService\(\{[\s\S]{0,200}script: join\(PKG_ROOT/);
  });
});

describe("the macOS job", () => {
  it("runs the deck in the foreground of launchd, not away from it", () => {
    // Handing a process to a supervisor and then detaching out of its job is
    // the one thing that makes the supervisor useless. The marker is what keeps
    // the launcher from doing it.
    expect(plistFor(JOB)).toContain("<key>AGENTS_DECK_DETACHED</key>");
    expect(plistFor(JOB)).toMatch(/<key>AGENTS_DECK_DETACHED<\/key>\s*\n\s*<string>1<\/string>/);
  });

  it("does not ask to be throttled, which is what Background does", () => {
    // MEASURED. With `ProcessType Background` the job is put in PRIO_DARWIN_BG,
    // where disk I/O is throttled hard enough that a boot taking 0.8s from a
    // shell had still printed nothing after thirty seconds under launchd —
    // running, never finishing. This is the server behind a browser tab, not
    // background work.
    expect(plistFor(JOB)).not.toContain("ProcessType");
    expect(SRC).toContain("PRIO_DARWIN_BG");
  });

  it("sends both streams to the file --logs reads", () => {
    const plist = plistFor(JOB);
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("<key>StandardErrorPath</key>");
    expect(plist.match(/Library\/Logs\/ccdeck\/deck\.log/g)?.length).toBe(2);
  });

  it("escapes what a path is allowed to contain", () => {
    // A plist with a bare `&` in it does not parse, and launchd reports that as
    // a job which simply never runs.
    expect(xmlEscape("a&b<c>'d\"")).toBe("a&amp;b&lt;c&gt;&apos;d&quot;");
    expect(plistFor({ ...JOB, script: "/opt/a&b/agent-dag.js" })).toContain("/opt/a&amp;b/agent-dag.js");
  });
});

describe("the systemd unit", () => {
  it("lets systemd hold the real process", () => {
    // Type=simple with the marker, rather than Type=forking and a guess at
    // which child is the deck.
    const unit = unitFor(JOB);
    expect(unit).toContain("Type=simple");
    expect(unit).toContain("Environment=AGENTS_DECK_DETACHED=1");
    expect(unit).not.toContain("Type=forking");
  });

  it("quotes a path with a space in it", () => {
    expect(unitFor({ ...JOB, script: "/opt/cc deck/bin/agent-dag.js" }))
      .toContain('ExecStart=/usr/bin/node "/opt/cc deck/bin/agent-dag.js" --no-open');
  });

  it("appends rather than truncating, since deck.log is shared", () => {
    expect(unitFor(JOB)).toContain("StandardOutput=append:");
    expect(unitFor(JOB)).toContain("StandardError=append:");
  });
});

describe("the Windows task", () => {
  it("is XML, because /TR is a quoting coin flip", () => {
    // /TR takes the whole command line as ONE string, and the two things it has
    // to hold — `C:\Program Files\nodejs\node.exe` and a path under the user's
    // profile — both contain spaces. The XML form has a field for the program
    // and a field for its arguments and no parsing between them.
    expect(registerCommand("win32", "C:\\x\\task.xml")).toEqual({
      file: "schtasks", args: ["/Create", "/TN", SERVICE_LABEL, "/XML", "C:\\x\\task.xml", "/F"],
    });
    const xml = taskXmlFor(JOB);
    expect(xml).toContain("<Command>/usr/bin/node</Command>");
    expect(xml).toContain("<Arguments>/opt/ccdeck/bin/agent-dag.js --no-open</Arguments>");
  });

  it("is written as UTF-16, which is the only encoding schtasks accepts", () => {
    // UTF-8 is rejected with an unhelpful error, so the BOM and the encoding
    // are both load-bearing.
    expect(SRC).toContain('"\\uFEFF" + taskXmlFor(');
    expect(SRC).toContain('"utf16le"');
  });

  it("names no user, because every way of naming one is a guess", () => {
    // schtasks fills in the account running it, which is the one whose login
    // this task is about. A <UserId> would break on a renamed account, a domain
    // user, or a machine in another locale.
    expect(taskXmlFor(JOB)).not.toContain("<UserId>");
    expect(taskXmlFor(JOB)).toContain("<LogonType>InteractiveToken</LogonType>");
  });

  it("does not stop the deck for a laptop on battery", () => {
    expect(taskXmlFor(JOB)).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(taskXmlFor(JOB)).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  });
});

describe("removing one that is not there", () => {
  const { uninstallService } = svc as { uninstallService: (o?: Record<string, unknown>) => Record<string, unknown> };

  it("is not a failure, on any of the three", () => {
    // THE THREE PLATFORMS DISAGREED, and Windows was the one that said it out
    // loud: `rmSync` with `force` succeeds on a missing file, so macOS and Linux
    // reported "removed" either way, while `schtasks /Delete` on a task that is
    // not there exits non-zero — so `ccdeck --uninstall-service` on a machine
    // that never had one answered `could not remove it — ERROR: The system
    // cannot find the file specified` and exited 1.
    const posix = uninstallService({
      platform: "darwin", home: "/Users/x",
      fs: { existsSync: () => false, rmSync: () => {} },
      run: () => ({ status: 0 }),
    });
    expect(posix).toMatchObject({ ok: true, existed: false });

    const win = uninstallService({
      platform: "win32", home: "C:\\Users\\x",
      run: (_f: string, args: string[]) => ({ status: args[0] === "/Query" ? 1 : 0 }),
    });
    expect(win).toMatchObject({ ok: true, existed: false });
  });

  it("asks whether the task is there rather than reading the refusal", () => {
    // schtasks exits 1 for a missing task and for a permission it does not
    // have, and the two are told apart only by an English sentence that is not
    // English on a localised Windows — the trap looksMissing already documents.
    const calls: string[][] = [];
    uninstallService({
      platform: "win32", home: "C:\\Users\\x",
      run: (_f: string, args: string[]) => { calls.push(args); return { status: args[0] === "/Query" ? 1 : 0 }; },
    });
    expect(calls.map(c => c[0])).toEqual(["/Query"]);
    // And no /Delete at all when there was nothing to delete.
    expect(calls.some(c => c[0] === "/Delete")).toBe(false);
  });

  it("still reports a real refusal as one", () => {
    const win = uninstallService({
      platform: "win32", home: "C:\\Users\\x",
      run: (_f: string, args: string[]) => args[0] === "/Query"
        ? { status: 0 }
        : { status: 1, stderr: "ERROR: Access is denied.\nsecond line" },
    });
    expect(win).toMatchObject({ ok: false, existed: true, reason: "ERROR: Access is denied." });
  });

  it("does not unregister a unit that was never registered", () => {
    // `launchctl unload` and `systemctl --user disable` on something that was
    // never there are noise, and on some systemd versions an error.
    const calls: string[][] = [];
    uninstallService({
      platform: "linux", home: "/home/x",
      fs: { existsSync: () => false, rmSync: () => {} },
      run: (_f: string, args: string[]) => { calls.push(args); return { status: 0 }; },
    });
    expect(calls).toEqual([]);
  });
});

describe("whether a systemd session survives logging out", () => {
  // The one place the three platforms genuinely differ in what "starts at
  // login" buys you. Without lingering, the user's systemd instance is torn
  // down at logout and the deck goes with it — fine on a laptop somebody stays
  // logged into, wrong on a box they ssh out of.
  const { lingerState } = svc as { lingerState: (o?: Record<string, unknown>) => string };

  it("reads the two states loginctl can report", () => {
    // MEASURED on real systemd in a container: `Linger=yes` for an enabled
    // user. The `no` spelling is the same property and is pinned here, because
    // it is only reachable for a user who is LOGGED IN without lingering — which
    // is the ordinary desktop case and the one a container has no way to make.
    const answers = (out: string) => lingerState({
      platform: "linux", user: "1000", run: () => ({ status: 0, stdout: out }),
    });
    expect(answers("Linger=yes\n")).toBe("on");
    expect(answers("Linger=no\n")).toBe("off");
  });

  it("says `unknown` rather than guessing, when loginctl cannot answer", () => {
    // MEASURED: `loginctl show-user 0 --property=Linger` on a user with neither
    // a session nor lingering answers "User ID 0 is not logged in or lingering"
    // and exits non-zero. Reading that as "off" would print a warning about
    // logging out to somebody who is not logged in.
    expect(lingerState({ platform: "linux", user: "0", run: () => ({ status: 1, stdout: "" }) })).toBe("unknown");
    expect(lingerState({ platform: "linux", user: "0", run: () => { throw new Error("no loginctl"); } })).toBe("unknown");
  });

  it("asks about a uid, not about $USER", () => {
    // FOUND IN A CONTAINER. `$USER` is unset in every environment that is not an
    // interactive login shell — the cron job, the systemd unit, `docker exec` —
    // and `loginctl show-user ""` answers "Failed to look up user : No such
    // process", which this read as "unknown" and said nothing about. A uid is
    // always there on the platform this runs on.
    //
    // ASSERTED THROUGH THE PURE HELPER, because the first version of this read
    // `process.getuid` — which does not exist on Windows — and so went red on
    // the runner rather than on the platform the rule is about. The preference
    // between two values is the rule; where the values come from is not.
    const { preferredUser } = svc as { preferredUser: (o?: { uid?: number; user?: string }) => string };
    expect(preferredUser({ uid: 1000, user: "deck" })).toBe("1000");
    expect(preferredUser({ uid: 0, user: "deck" })).toBe("0");
    expect(preferredUser({ uid: undefined, user: "deck" })).toBe("deck");
    expect(preferredUser({ uid: undefined, user: undefined })).toBe("");
    // And an empty answer never becomes a loginctl call.
    let called = false;
    expect(lingerState({ platform: "linux", user: "", run: () => { called = true; return { status: 0, stdout: "" }; } }))
      .toBe("unknown");
    expect(called).toBe(false);
  });

  it("is not a question on macOS or Windows", () => {
    expect(lingerState({ platform: "darwin" })).toBe("n/a");
    expect(lingerState({ platform: "win32" })).toBe("n/a");
    // And the warning is only printed for a definite "off".
    expect(DECK).toContain('svc.lingerState() === "off"');
  });
});

describe("where each platform keeps it", () => {
  it("answers for the platform ASKED ABOUT, not the one running the test", () => {
    // CAUGHT RED IN CI, on the first push. `node:path`'s `join` is bound to the
    // HOST: a bare one answers `\\Users\\x\\Library\\LaunchAgents\\...` when a
    // Windows runner is asked where a macOS login item lives. The only way a
    // Windows answer stays right is if it can be checked from a Mac — which is
    // exactly what this assertion does, on every runner, in both directions.
    // Third time this class of bug has been caught in this repo.
    expect(servicePath("darwin", "/Users/x")).not.toMatch(/\\/);
    expect(servicePath("linux", "/home/x", {})).not.toMatch(/\\/);
    expect(servicePath("darwin", "/Users/x").split("/")).toContain("LaunchAgents");
    expect(servicePath("linux", "/home/x", {}).split("/")).toContain("systemd");
  });

  it("uses the per-user location, never a machine-wide one", () => {
    // A LaunchDaemon, a system unit or a task under SYSTEM would all need root
    // and would start a deck for an account that may not be logged in.
    expect(servicePath("darwin", "/Users/x")).toBe("/Users/x/Library/LaunchAgents/ccdeck.plist");
    expect(servicePath("linux", "/home/x", {})).toBe("/home/x/.config/systemd/user/ccdeck.service");
    expect(servicePath("linux", "/home/x", { XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/systemd/user/ccdeck.service");
  });

  it("registers and unregisters with the tool that owns the file", () => {
    expect(registerCommand("darwin", "/p").file).toBe("launchctl");
    expect(unregisterCommand("darwin", "/p").args).toEqual(["unload", "-w", "/p"]);
    expect(registerCommand("linux", "/p").args).toEqual(["--user", "enable", "--now", "ccdeck.service"]);
    expect(unregisterCommand("win32", "/p").args).toEqual(["/Delete", "/TN", SERVICE_LABEL, "/F"]);
  });
});

describe("offering it exactly once", () => {
  it("does not put back what the user just took away", () => {
    // Without the record an uninstall is undone by the next start, which is not
    // an uninstall — it is a tool arguing with its user.
    expect(shouldOfferService({ record: null })).toBe(true);
    expect(shouldOfferService({ record: { installed: "3.19.0" } })).toBe(false);
    expect(shouldOfferService({ record: { removed: "2026-01-01" } })).toBe(false);
    // Even a failed attempt counts: trying again on every boot forever is the
    // same noise as succeeding on every boot forever.
    expect(shouldOfferService({ record: { failed: "EPERM" } })).toBe(false);
  });

  it("never offers from a checkout, which is somebody's working tree", () => {
    // FOUND BY RUNNING IT. A test boot from the repo on the author's own machine
    // wrote a LaunchAgent naming ~/Desktop/agents-deck/bin/agent-dag.js. That
    // directory gets renamed, moved, branch-switched and deleted, and none of
    // those are events a login item survives — and nobody working in a checkout
    // asked to be given one.
    expect(shouldOfferService({ record: null, checkout: true })).toBe(false);
    expect(shouldOfferService({ record: null, checkout: false })).toBe(true);
    // The explicit command still writes one — someone may genuinely want it —
    // but says what it is about to name first.
    expect(DECK).toContain("this is a checkout, so the login item would name");
  });

  it("never offers from an npx run", () => {
    // The item would name a path inside ~/.npm/_npx/<hash>/, which npm deletes
    // whenever it feels like it: a login item pointing at nothing, forever, on
    // a machine where nothing was ever installed.
    expect(shouldOfferService({ record: null, npx: true })).toBe(false);
    expect(DECK).toContain("an npx run cannot start at login");
  });

  it("honours the variable every other install here honours", () => {
    // A CI runner that quietly acquires login items is a CI runner nobody can
    // explain.
    expect(shouldOfferService({ record: null, env: { AGENTS_DECK_NO_INSTALL: "1" } })).toBe(false);
  });

  it("reads a missing or corrupt record as 'never touched'", () => {
    expect(readServiceRecord("/nope/not/a/dir")).toBeNull();
    expect(readServiceRecord("/x", { fs: { readFileSync: () => "{ not json" } })).toBeNull();
    expect(readServiceRecord("/x", { fs: { readFileSync: () => "null" } })).toBeNull();
    expect(readServiceRecord("/x", { fs: { readFileSync: () => '{"installed":"1"}' } }))
      .toEqual({ installed: "1" });
    expect(SERVICE_RECORD).toBe("service.json");
  });
});

describe("installing it, and saying so", () => {
  it("makes the log directory before the service manager is told anything", () => {
    // MEASURED, and silent when it is wrong: launchd opens StandardOutPath when
    // it starts the job and systemd opens `append:` when it starts the unit.
    // Neither creates a missing directory and both answer one by failing the
    // job with nothing in any log. On the machine `--install-service` is first
    // typed on, that directory has never existed.
    const made: string[] = [];
    installService({
      platform: "darwin", home: "/Users/x", ...JOB,
      fs: { mkdirSync: (p: string) => made.push(p), writeFileSync: () => {} },
      run: () => ({ status: 0 }),
    });
    expect(made).toContain("/Users/x/Library/Logs/ccdeck");
  });

  it("still counts as installed when the registration is refused", () => {
    // The file is on disk and both launchd and systemd read their directories
    // at the next login, so it works from then on. Said rather than hidden:
    // "it will work tomorrow" is a different promise from "it works now".
    const out = installService({
      platform: "linux", home: "/home/x", ...JOB,
      fs: { mkdirSync: () => {}, writeFileSync: () => {} },
      run: () => ({ status: 1, stderr: "Failed to connect to bus\nsecond line" }),
    });
    expect(out).toMatchObject({ ok: true, how: "file-only", reason: "Failed to connect to bus" });
    expect(DECK).toContain("It will come up at your next login.");
  });

  it("is a verdict, never a throw, because a deck is already running", () => {
    const out = installService({
      platform: "darwin", home: "/Users/x", ...JOB,
      fs: { mkdirSync: () => { throw Object.assign(new Error("no"), { code: "EROFS" }); }, writeFileSync: () => {} },
      run: () => ({ status: 0 }),
    });
    expect(out).toMatchObject({ ok: false, reason: "EROFS" });
  });

  it("says it once, on the run that does it, and never again", () => {
    // A tool that adds itself to your login items and does not mention it is a
    // tool you find later, in a settings pane, and stop trusting.
    expect(DECK).toContain("will now start when you log in");
    // The backtick is escaped in the source: the line lives inside a template
    // literal, and the flag is quoted for the shell in the message itself.
    expect(DECK).toContain("--uninstall-service\\` undoes it");
    // After the boot, not during it: a deck that could not come up has no
    // business teaching the machine to start it at every login. By the time
    // this runs the port is bound, the hooks are registered and the browser is
    // open — and it is still ABOVE the pulse, because a one-time notice printed
    // under a line that repaints itself every 800ms is a notice nobody reads.
    const registered = DECK.indexOf("discovery = keepDiscovery({");
    const browser = DECK.indexOf("openUrl(url);");
    const offer = DECK.indexOf("shouldOfferService({");
    const pulse = DECK.indexOf("// ── Pulse indicator ");
    expect(offer).toBeGreaterThan(registered);
    expect(offer).toBeGreaterThan(browser);
    expect(offer).toBeLessThan(pulse);
  });

  it("goes away with --uninstall, which is the one place its narrowness bends", () => {
    // "Hook entries only" is right for the event log and the port registry,
    // which are data somebody may still want. A login item left behind is not
    // data — it is a machine that keeps starting a deck whose hooks were just
    // removed.
    const at = DECK.indexOf("flags.uninstall");
    const gone = DECK.indexOf("svc.uninstallService()", at);
    const retire = DECK.indexOf("retireSoundHook", at);
    expect(gone).toBeGreaterThan(at);
    expect(gone).toBeLessThan(retire);
  });
});

describe("putting the deck on PATH, when somebody asks in words", () => {
  // The one thing an npx run cannot have. A login item must name a path that
  // will still be there tomorrow, and npx runs out of ~/.npm/_npx/<hash>/,
  // which npm deletes whenever it likes — so an npx deck runs in the background
  // and cannot come back after a reboot.
  const gi = globalInstall as {
    globalScript: (root: string, pkg: string, platform?: string) => string | null;
    readGlobalRoot: (out: unknown) => string | null;
    installFailure: (out: unknown, o?: { pkg?: string }) => string;
    INSTALL_TIMEOUT_MS: number;
  };

  it("builds the script path for the platform asked about", () => {
    // The joiner comes from the TARGET platform, not the host. Three times red
    // on windows-latest for exactly this.
    expect(gi.globalScript("/usr/local/lib/node_modules", "ccdeck", "darwin"))
      .toBe("/usr/local/lib/node_modules/ccdeck/bin/agent-dag.js");
    // Built rather than written out: a Windows path in a TS literal needs its
    // backslashes doubled, and doubling them twice is how the first version of
    // this asserted something no machine would ever produce.
    const winRoot = ["C:", "Users", "x", "AppData", "Roaming", "npm", "node_modules"].join("\\");
    expect(gi.globalScript(winRoot, "ccdeck", "win32"))
      .toBe([winRoot, "ccdeck", "bin", "agent-dag.js"].join("\\"));
    expect(gi.globalScript("/usr/lib/node_modules", "ccdeck", "linux")).not.toMatch(/\\\\/);
    expect(gi.globalScript("", "ccdeck", "linux")).toBeNull();
    expect(gi.globalScript("/x", "", "linux")).toBeNull();
  });

  it("takes npm's answer only when it is one", () => {
    // `npm root -g` prints one line on success. A warning npm decided to print
    // first is not a path, and guessing would put the login item where nothing
    // lives.
    expect(gi.readGlobalRoot({ ok: true, stdout: "/usr/local/lib/node_modules\n" }))
      .toBe("/usr/local/lib/node_modules");
    expect(gi.readGlobalRoot({ ok: true, stdout: "npm warn something\n/usr/lib/node_modules\n" }))
      .toBe("/usr/lib/node_modules");
    expect(gi.readGlobalRoot({ ok: true, stdout: "npm warn only\n" })).toBeNull();
    expect(gi.readGlobalRoot({ ok: true, stdout: "" })).toBeNull();
    expect(gi.readGlobalRoot({ ok: false, stdout: "/usr/lib" })).toBeNull();
  });

  it("names the remedy for the failure people actually hit", () => {
    // A root-owned global prefix. "Permission denied" alone sends people to
    // sudo when a prefix of their own is the better answer.
    const eacces = gi.installFailure({ ok: false, stderr: "npm ERR! Error: EACCES: permission denied" }, { pkg: "ccdeck" });
    expect(eacces).toMatch(/sudo npm i -g ccdeck/);
    expect(eacces).toMatch(/npm config set prefix/);
    expect(gi.installFailure({ ok: false, code: "ENOENT" })).toMatch(/npm is not on PATH/);
    expect(gi.installFailure({ ok: false, timedOut: true })).toMatch(/took too long/);
    expect(gi.installFailure({ ok: false, status: 1, stderr: "npm ERR! boom\nmore" })).toBe("npm ERR! boom");
  });

  it("installs the name that was typed, not ours", () => {
    // Three packages publish this deck. Installing `ccdeck` for somebody who
    // ran `npx agent-dag` hands them a command they did not ask for and leaves
    // the one they used pointing at a cache directory.
    expect(DECK).toContain("const pkg = installedName(PKG_ROOT, PRODUCT);");
    expect(DECK).toContain('run("npm", ["i", "-g", pkg]');
  });

  it("points the login item at the global install, not at the cache", () => {
    const at = DECK.indexOf("if (flags.install) {");
    const block = DECK.slice(at, DECK.indexOf("--install-service / --uninstall-service", at));
    expect(block).toContain("gi.globalScript(root, pkg)");
    expect(block).toContain("svc.installService({ script,");
    // And it asks npm where that is rather than assuming a prefix.
    expect(block).toContain('run("npm", ["root", "-g"]');
  });

  it("still reports an install that worked with a login item that did not", () => {
    // Two different outcomes, and collapsing them would tell somebody their
    // deck starts at login when it does not.
    const at = DECK.indexOf("if (flags.install) {");
    const block = DECK.slice(at, DECK.indexOf("--install-service / --uninstall-service", at));
    expect(block).toContain("installed, but it will not start at login");
    expect(block).toContain("installed, but npm did not say where");
  });
});
