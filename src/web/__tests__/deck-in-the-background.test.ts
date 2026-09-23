// The deck was a daemon in everything but its lifecycle.
//
// It holds the hooks Claude Code posts every event to, it answers the LAN
// beacon that lets paired machines repair each other's expired logins, and it
// watches the quota auto-switch trips on — and all three stopped the moment a
// terminal window closed. That is the wrong unit. Those things should be true
// for as long as the machine is awake, not for as long as somebody keeps a tab
// of a terminal open.
//
// Node has no fork(2), so "run in the background" is always a detached CHILD
// plus a parent that leaves. These pin the three ways that goes wrong: a parent
// that leaves too early (the boot report cut off), a parent that takes the child
// with it (the leash, and the pipe that dies with it), and a parent that detaches
// something which was never a start at all (`ccdeck --version` printing its
// answer into a log file).
import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const detach = await import("../../server/detach.mjs");
const { DECK_LOG, DETACHED_ENV, detachAndWatch, detachEnv, logMode, stopCommand, tailFile } = detach as {
  DECK_LOG: string;
  DETACHED_ENV: string;
  detachAndWatch: (o: Record<string, unknown>) => Promise<{ ok: false; reason: string }>;
  detachEnv: (o?: { isTTY?: boolean; profile?: string; columns?: number }) => Record<string, string>;
  logMode: (n: number) => string;
  stopCommand: (o?: { npx?: boolean; invokedAs?: string | null; product?: string }) => string;
  tailFile: (p: string, out: { write: (b: Buffer) => void }, o?: { from?: number; everyMs?: number })
    => { pump: () => void; stop: () => void };
};
// @ts-expect-error — plain .mjs module, no types
const { ONE_SHOT, isOneShot, parseArgs } = await import("../../server/args.mjs");
// @ts-expect-error — plain .mjs module, no types
const { termColumns } = await import("../../server/term.mjs");

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const SUPERVISOR = read("../../../bin/agent-dag.js");
const DECK = read("../../../bin/deck.js");
const SRC = read("../../server/detach.mjs");

describe("the child's output is a file, never a pipe", () => {
  it("hands the child a file descriptor for both streams", () => {
    // A pipe dies with the launcher: the moment it exits, the read end closes
    // and every later write in the deck is an EPIPE on an unhandled 'error',
    // which ends the deck we just detached — minutes or hours later, for no
    // reason a user could ever trace.
    expect(SRC).toContain('stdio: ["ignore", fd, fd, "ipc"]');
    expect(SRC).not.toMatch(/stdio: \[[^\]]*"pipe"/);
    // And the terminal is fed by tailing that file, so there is one sink and no
    // handover to get wrong.
    expect(SRC).toContain("tailFile(path, out,");
  });

  it("truncates the log only when it can be nobody's", () => {
    // A registered deck is holding an open descriptor at some offset into this
    // very file. Truncating under it does not make it start again at zero — it
    // makes its next write land past the end and leave a hole.
    expect(logMode(0)).toBe("w");
    expect(logMode(1)).toBe("a");
    expect(logMode(3)).toBe("a");
  });

  it("reads an appended log from its old end, not from the top", () => {
    // Otherwise the attach, which is the case that reaches here with a deck
    // already up, would replay that deck's whole boot into the terminal before
    // saying its own six lines.
    expect(SRC).toContain('const from = mode === "a" ?');
    expect(SRC).toContain("statSync(path).size");
  });

  it("keeps the deck out of the terminal's process group", () => {
    // This is the whole mechanism. A closing terminal sends SIGHUP to its
    // FOREGROUND process group; a detached child is in its own, so the signal
    // never reaches it. Measured on a real start: ppid 1, pgid its own.
    expect(SRC).toContain("detached: true");
  });
});

describe("the deck from before this version that is still running", () => {
  it("is replaced on upgrade day, and says so, instead of being started beside", () => {
    // UPGRADE DAY used to be a mystery and then a warning: a deck older than
    // the attach publishes no `claude` and no `version`, so the first `ccdeck`
    // after an upgrade started a SECOND deck beside it and named the old one
    // ("2 decks from an older ccdeck are still running on 4317, 4363"). A start
    // keeps one deck now, so the older one is stopped and this one takes its
    // place — the line that says so names the version it replaced.
    expect(DECK).not.toContain("too old to be recognised");
    expect(DECK).toMatch(/olderVersion\(d\.version, PKG_VERSION\)[\s\S]{0,120}it was v\$\{d\.version\}/);
  });
});

describe("what the launcher waits for", () => {
  it("waits for `booted`, not for `listening`", () => {
    // The port is bound well before the report is finished: the server-ready
    // row, the log row and the browser line are all written after it. Leaving
    // on `listening` would cut the last three lines off every boot and leave
    // them in a file nobody is looking at.
    expect(SRC).toContain('m.type !== "booted"');
    expect(SRC).not.toMatch(/m\.type === "listening"/);
    // Sent by the worker at the end of its own boot, forwarded by the
    // supervisor to whoever detached it.
    expect(DECK).toContain('process.send?.({ type: "booted" })');
    expect(SUPERVISOR).toContain('m.type === "booted"');
  });

  it("sends it after everything is printed, not beside it", () => {
    const ready = DECK.indexOf("markDeckReady();");
    const said = DECK.indexOf('{ type: "booted" }');
    const browser = DECK.indexOf("openUrl(url);");
    expect(said).toBeGreaterThan(ready);
    expect(said).toBeGreaterThan(browser);
  });

  it("ends a start that was interrupted, rather than leaving it running", () => {
    // The child is in its own process group, so the terminal's Ctrl+C did NOT
    // reach it. Without this the interrupted start carries on in the background
    // and the user has interrupted nothing at all. Measured: exit 130, no deck.
    expect(SRC).toMatch(/for \(const sig of \["SIGINT", "SIGTERM", "SIGHUP"\]\)/);
    expect(SRC).toContain('child.kill("SIGTERM")');
    expect(SRC).toContain("finish(130)");
  });
});

describe("the leash, which must not be attached to the launcher", () => {
  it("does not arm dieWithParent in the detached copy", () => {
    // The launcher disconnects and exits the moment the deck is up, by design.
    // Armed, that would have every successful start kill itself a second later.
    expect(SUPERVISOR).toContain("if (!DETACHED) dieWithParent(() => {");
  });

  it("marks the child so it cannot detach again", () => {
    // A fork bomb is the only way this can fail catastrophically, so the guard
    // is one variable with one spelling, read in exactly one place.
    expect(DETACHED_ENV).toBe("AGENTS_DECK_DETACHED");
    expect(detachEnv()[DETACHED_ENV]).toBe("1");
    expect(SUPERVISOR).toContain("const DETACHED = process.env[DETACHED_ENV] === \"1\";");
    expect(SUPERVISOR).toContain("if (!DETACHED && !LEASHED && FLAGS.foreground !== true && !isOneShot(FLAGS))");
  });

  it("stays put when somebody is already holding its lifecycle", () => {
    // `process.send` exists only when we were spawned with an IPC channel, and
    // that parent has armed dieWithParent and is waiting on our exit code.
    // Running away from it into our own process group is precisely the wrong
    // answer to being supervised — and it is how the suite's own spawnSupervised
    // starts a deck it means to hold.
    expect(SUPERVISOR).toContain('const LEASHED = typeof process.send === "function";');
  });
});

describe("a command line that is not a start", () => {
  it("never detaches, or its answer goes into a log file", () => {
    // `ccdeck --version` detaching itself is the shape of the bug: the number
    // lands in deck.log and the terminal comes back empty.
    // `purge` is on the list for a sharper version of the same reason (#959):
    // it is the flag that PRINTS WHERE SOMEBODY'S PRIVATE KEY IS, and a
    // detached one would put that line in deck.log and hand the terminal back
    // with nothing on it.
    expect([...ONE_SHOT].sort()).toEqual([
      "help", "install", "installService", "logs", "purge", "status", "stop", "uninstall",
      "uninstallService", "version",
    ]);
    for (const flag of ONE_SHOT) expect(isOneShot({ [flag]: true }), flag).toBe(true);
    // And each of those really is what the parser produces for the flag.
    for (const [argv, key] of [
      [["--version"], "version"], [["-v"], "version"], [["-h"], "help"], [["--help"], "help"],
      [["--uninstall"], "uninstall"], [["--stop"], "stop"], [["--status"], "status"],
      [["--logs"], "logs"], [["--install"], "install"],
      [["--install-service"], "installService"],
      [["--uninstall-service"], "uninstallService"],
      [["--purge"], "purge"],
    ] as [string[], string][]) {
      expect(isOneShot(parseArgs(argv)), argv.join(" ")).toBe(true);
      expect(parseArgs(argv)[key]).toBe(true);
    }
  });

  it("treats an ordinary start as a start", () => {
    for (const argv of [[], ["--no-open"], ["--port", "4500"], ["--new"], ["--workspace", "/x"]]) {
      expect(isOneShot(parseArgs(argv)), argv.join(" ") || "(bare)").toBe(false);
    }
  });

  it("leaves the old behaviour reachable, by a flag rather than a marker", () => {
    // Every version before this one held the terminal, and something out there
    // depends on it: a wrapper script, a CI step, a supervisor of somebody
    // else's that starts `ccdeck` and waits on it. Handing all of those an
    // immediate exit with no way to say otherwise is a breaking change with no
    // escape hatch — and AGENTS_DECK_DETACHED is an internal marker, not
    // something to tell a user to export.
    expect(parseArgs(["--foreground"]).foreground).toBe(true);
    // A start, not a one-shot: it still boots a deck, it just does not leave.
    expect(isOneShot(parseArgs(["--foreground"]))).toBe(false);
    expect(SUPERVISOR).toContain("FLAGS.foreground !== true");
    expect(DECK).toContain("--foreground");
  });
});

describe("what the child is told about the terminal it cannot see", () => {
  it("passes the colour tier down, in FORCE_COLOR's own grammar", () => {
    // Writing to a file makes isTTY false in the child, which switches off both
    // colour and motion. Only the colour is wanted back: the pulse line writing
    // \r frames into a log file is the artefact this repo has a rule against.
    expect(detachEnv({ isTTY: true, profile: "truecolor", columns: 120 }))
      .toMatchObject({ FORCE_COLOR: "3", COLUMNS: "120" });
    expect(detachEnv({ isTTY: true, profile: "ansi256" })).toMatchObject({ FORCE_COLOR: "2" });
    expect(detachEnv({ isTTY: true, profile: "ansi16" })).toMatchObject({ FORCE_COLOR: "1" });
  });

  it("passes nothing at all when nobody is watching", () => {
    // A piped or CI start gets a plain log file, which is what a log file
    // should be when it is not a mirror of somebody's terminal.
    expect(detachEnv({ isTTY: false, profile: "truecolor", columns: 120 }))
      .toEqual({ [DETACHED_ENV]: "1" });
    expect(detachEnv({ isTTY: true, profile: "none", columns: 120 }))
      .toEqual({ [DETACHED_ENV]: "1" });
  });

  it("gives termColumns the env fallback a detached deck depends on", () => {
    // Its stdout is the log file, so the stream knows nothing about a width.
    // Without this every backgrounded boot is laid out for 80 columns whatever
    // the terminal reading it happens to be.
    expect(termColumns({ columns: 120 }, { COLUMNS: "40" })).toBe(120);
    expect(termColumns({}, { COLUMNS: "40" })).toBe(40);
    expect(termColumns({}, { COLUMNS: "not a number" })).toBe(80);
    expect(termColumns({}, {})).toBe(80);
  });
});

describe("the command that ends it", () => {
  it("names the package for an npx run, which has no ccdeck on PATH", () => {
    // Telling an npx user to run `ccdeck --stop` is telling them to run
    // something that does not exist on their machine — which is the entire
    // point of having run it through npx.
    expect(stopCommand({ npx: true, invokedAs: "ccdeck" })).toBe("npx ccdeck --stop");
    expect(stopCommand({ npx: true, invokedAs: "agents-deck" })).toBe("npx agents-deck --stop");
    expect(stopCommand({ npx: false, invokedAs: "ccdeck" })).toBe("ccdeck --stop");
  });

  it("falls back to the product name when the typed one cannot be proven", () => {
    // invokedAs is null for a Windows global install and for a git checkout,
    // and a guess there would be worse than the name on the tin.
    expect(stopCommand({ npx: false, invokedAs: null, product: "ccdeck" })).toBe("ccdeck --stop");
  });

  it("is what the launcher actually prints", () => {
    expect(SUPERVISOR).toContain("running in the background");
    expect(SUPERVISOR).toContain("stopCommand({");
  });
});

describe("tailing a file that is still being written", () => {
  it("copies only what is new, from where it was told to start", async () => {
    const { mkdtempSync, writeFileSync, appendFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { rmTempDir } = await import("./rm-temp-dir");
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-tail-"));
    const path = join(dir, DECK_LOG);
    writeFileSync(path, "old\n");
    const chunks: string[] = [];
    const t = tailFile(path, { write: (b) => { chunks.push(String(b)); } }, { from: 4, everyMs: 5 });
    appendFileSync(path, "new\n");
    t.pump();
    // The last read happens on stop, always: the deck's final lines are usually
    // written in the same tick as the message saying it is up.
    appendFileSync(path, "last\n");
    t.stop();
    expect(chunks.join("")).toBe("new\nlast\n");
    rmTempDir(dir);
  });

  it("says nothing about a file that is not there yet", () => {
    const t = tailFile("/nope/not/a/file.log", { write: () => { throw new Error("wrote"); } }, { everyMs: 5 });
    expect(() => { t.pump(); t.stop(); }).not.toThrow();
  });
});

describe("what an npx run is told it is missing", () => {
  const SRC_SUP = SUPERVISOR;

  it("offers the install rather than performing it", () => {
    // `npx` means "run without installing". A tool that installs itself anyway
    // is the tool people uninstall — and the global prefix is root-owned on
    // plenty of machines, so it would be a sudo prompt out of a command that
    // was only supposed to start a deck.
    // The backtick is escaped in the source: the line lives inside a template
    // literal and the flag is quoted for the shell in the message itself.
    expect(SRC_SUP).toContain("--install\\` also starts it at login");
    expect(SRC_SUP).toContain('const npx = isNpxInstall(PKG_ROOT);');
    // Offered only where it is true: a global install already starts at login
    // on its first run, so the line would be noise there.
    expect(SRC_SUP).toMatch(/const offer = npx\s*\n?\s*\?/);
  });

  it("says nothing extra when the deck was installed normally", () => {
    const at = SRC_SUP.indexOf("const offer = npx");
    expect(SRC_SUP.slice(at, at + 400)).toContain(': "";');
  });
});

// ── the launcher itself, driven ──────────────────────────────────────────────
//
// Everything above pins detachAndWatch as source text, and the only run of it
// in the suite is tarball-install-smoke's happy path. The exits are the part a
// caller depends on: `ccdeck --port banana; echo $?` and `ccdeck && open …`
// read the launcher's code as the deck's, so an exit path that answered 0 for
// a deck that never started — or never answered at all — is a script told the
// deck is up when it is not, or a terminal that hangs. So the launcher is run
// here with a fake spawn: a child that is an EventEmitter the case speaks for,
// a terminal that is an array, and an exit that is a spy.
describe("the launcher, driven with a child it can be told anything by", () => {
  type FakeChild = EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  type SpawnOpts = { detached?: boolean; stdio: unknown[]; env: Record<string, string>; windowsHide?: boolean };

  const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const dirs: string[] = [];
  const before = new Map<string, Function[]>();

  afterEach(() => {
    // The launcher installs its Ctrl+C handlers on the real `process`, and in
    // production the process exits right after. Here it does not, so each case
    // takes back whatever it added — otherwise a later SIGINT to the vitest
    // worker would run every one of them.
    for (const sig of SIGNALS) {
      const had = before.get(sig) ?? [];
      for (const fn of process.listeners(sig)) {
        if (!had.includes(fn)) process.removeListener(sig, fn as (...a: unknown[]) => void);
      }
    }
    before.clear();
    for (const d of dirs.splice(0)) rmTempDir(d);
  });

  /** One launch. Not awaited on the paths that work: detachAndWatch never
   *  returns on those, by design — every way out of it is an exit. */
  function launch(opts: {
    liveCount?: number;
    isTTY?: boolean;
    profile?: string;
    logDir?: string;
    onSpawn?: (o: SpawnOpts) => void;
  } = {}) {
    for (const sig of SIGNALS) before.set(sig, process.listeners(sig).slice());
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-launcher-"));
    dirs.push(dir);
    const logDir = opts.logDir ?? join(dir, "logs");
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(), disconnect: vi.fn(), unref: vi.fn(),
    }) as FakeChild;
    const written: string[] = [];
    const exit = vi.fn();
    const spawnFn = vi.fn((_file: string, _args: string[], o: SpawnOpts) => {
      opts.onSpawn?.(o);
      return child;
    });
    const outcome = detachAndWatch({
      file: "/pkg/bin/agent-dag.js",
      argv: ["--no-open"],
      logDir,
      liveCount: opts.liveCount ?? 0,
      env: { PATH: "/usr/bin" },
      out: { write: (b: Buffer | string) => { written.push(String(b)); return true; } },
      isTTY: opts.isTTY ?? false,
      profile: opts.profile ?? "none",
      execPath: "/usr/bin/node",
      spawnFn,
      backgroundLine: "  -  running in the background\n",
      exit,
    });
    const signalled = (sig: NodeJS.Signals) => {
      const had = before.get(sig) ?? [];
      return process.listeners(sig).filter(fn => !had.includes(fn));
    };
    return { child, exit, spawnFn, written, outcome, logDir, signalled, text: () => written.join("") };
  }

  it("leaves on `booted`, and not a moment earlier on `listening`", () => {
    const run = launch();
    run.child.emit("message", { type: "listening", port: 4317 });
    // The port is bound before the report is finished; leaving here would cut
    // the last rows of the boot off the terminal.
    expect(run.exit).not.toHaveBeenCalled();
    expect(run.child.disconnect).not.toHaveBeenCalled();

    run.child.emit("message", { type: "booted" });
    expect(run.text().endsWith("  -  running in the background\n")).toBe(true);
    // Disconnected and unref'd, so the deck is not left holding a channel to a
    // process that has gone, and the launcher's event loop is not held by it.
    expect(run.child.disconnect).toHaveBeenCalledTimes(1);
    expect(run.child.unref).toHaveBeenCalledTimes(1);
    expect(run.exit).toHaveBeenCalledTimes(1);
    expect(run.exit).toHaveBeenCalledWith(0);

    // The deck's own exit, hours later, is not the launcher's to report twice.
    run.child.emit("exit", 1, null);
    expect(run.exit).toHaveBeenCalledTimes(1);
  });

  it("exits with the child's code when the child ends first", () => {
    // `ccdeck --port banana; echo $?` — the refusal is the worker's, and the
    // launcher is the only process the shell can see.
    const failed = launch();
    failed.child.emit("exit", 1, null);
    expect(failed.exit.mock.calls).toEqual([[1]]);

    // Killed rather than exiting has no code to forward, and it is still not
    // a deck that started.
    const killed = launch();
    killed.child.emit("exit", null, "SIGTERM");
    expect(killed.exit.mock.calls).toEqual([[1]]);

    // And a child that says its piece and leaves 0 is the attach: another deck
    // was already up, the six lines are on screen, and nothing failed.
    const attached = launch();
    attached.child.emit("exit", 0, null);
    expect(attached.exit.mock.calls).toEqual([[0]]);
  });

  it("exits 1 when the child cannot be started at all", () => {
    const run = launch();
    run.child.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
    expect(run.exit.mock.calls).toEqual([[1]]);
  });

  it("spawns a detached copy whose only output is one file and whose only voice is IPC", () => {
    let seen: SpawnOpts | null = null;
    launch({ isTTY: true, profile: "truecolor", onSpawn: (o) => { seen = o; } });
    const o = seen as unknown as SpawnOpts;
    expect(o.detached).toBe(true);
    expect(o.stdio[0]).toBe("ignore");
    // One descriptor for both streams — a FILE, never a pipe that would die
    // with this process and EPIPE the deck hours later.
    expect(typeof o.stdio[1]).toBe("number");
    expect(o.stdio[2]).toBe(o.stdio[1]);
    expect(o.stdio[3]).toBe("ipc");
    // Marked so the copy cannot do this again, with the caller's environment
    // kept and the terminal's colour tier handed down.
    expect(o.env[DETACHED_ENV]).toBe("1");
    expect(o.env.PATH).toBe("/usr/bin");
    expect(o.env.FORCE_COLOR).toBe("3");
  });

  it("hands back a reason instead of starting, when the log cannot be opened", async () => {
    // A read-only or full home. A deck that refuses to start over its LOG is a
    // worse answer than one that stays in the terminal, so the caller is told
    // why and bin/agent-dag.js carries on in the foreground.
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-launcher-file-"));
    dirs.push(dir);
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    const run = launch({ logDir: join(file, "logs") });
    const got = await run.outcome;
    expect(got.ok).toBe(false);
    expect(typeof got.reason).toBe("string");
    expect(got.reason.length).toBeGreaterThan(0);
    expect(run.spawnFn).not.toHaveBeenCalled();
    expect(run.exit).not.toHaveBeenCalled();
  });

  it("shows an attach only its own lines, and leaves the running deck's log alone", () => {
    // A registered deck holds a descriptor into this file. The attach appends
    // rather than truncating under it, and tails from the old end, so its six
    // lines are not preceded by a replay of that deck's whole log.
    const onSpawn = (o: SpawnOpts) => { writeSync(o.stdio[1] as number, "NEW\n"); };
    const probe = mkdtempSync(join(tmpdir(), "ccdeck-launcher-log-"));
    dirs.push(probe);
    writeFileSync(join(probe, DECK_LOG), "OLD\n");

    const attach = launch({ liveCount: 1, logDir: probe, onSpawn });
    attach.child.emit("message", { type: "booted" });
    expect(attach.text()).toContain("NEW");
    expect(attach.text()).not.toContain("OLD");
    expect(readFileSync(join(probe, DECK_LOG), "utf8")).toBe("OLD\nNEW\n");
  });

  it("starts the log afresh when no deck is registered to own it", () => {
    const onSpawn = (o: SpawnOpts) => { writeSync(o.stdio[1] as number, "NEW\n"); };
    const probe = mkdtempSync(join(tmpdir(), "ccdeck-launcher-log-"));
    dirs.push(probe);
    writeFileSync(join(probe, DECK_LOG), "OLD\n");

    const start = launch({ liveCount: 0, logDir: probe, onSpawn });
    start.child.emit("message", { type: "booted" });
    expect(start.text()).toContain("NEW");
    expect(readFileSync(join(probe, DECK_LOG), "utf8")).toBe("NEW\n");
  });

  it("ends an interrupted start instead of leaving it running behind the user", () => {
    // The child is in its own process group, so the terminal's Ctrl+C never
    // reached it. Called through the handler the launcher installed rather than
    // by raising SIGINT at the vitest worker, which has handlers of its own.
    const run = launch();
    const handlers = run.signalled("SIGINT");
    expect(handlers).toHaveLength(1);
    (handlers[0] as () => void)();
    expect(run.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(run.exit.mock.calls).toEqual([[130]]);
    // SIGTERM and SIGHUP are answered the same way, by one handler each.
    expect(run.signalled("SIGTERM")).toHaveLength(1);
    expect(run.signalled("SIGHUP")).toHaveLength(1);
  });
});
