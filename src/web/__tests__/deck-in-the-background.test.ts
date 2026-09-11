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
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error — plain .mjs module, no types
const detach = await import("../../server/detach.mjs");
const { DECK_LOG, DETACHED_ENV, detachEnv, logMode, stopCommand, tailFile } = detach as {
  DECK_LOG: string;
  DETACHED_ENV: string;
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
    expect(SUPERVISOR).toContain("if (!DETACHED && !LEASHED && !isOneShot(");
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
    expect([...ONE_SHOT].sort()).toEqual([
      "help", "installService", "logs", "status", "stop", "uninstall", "uninstallService", "version",
    ]);
    for (const flag of ONE_SHOT) expect(isOneShot({ [flag]: true }), flag).toBe(true);
    // And each of those really is what the parser produces for the flag.
    for (const [argv, key] of [
      [["--version"], "version"], [["-v"], "version"], [["-h"], "help"], [["--help"], "help"],
      [["--uninstall"], "uninstall"], [["--stop"], "stop"], [["--status"], "status"],
      [["--logs"], "logs"], [["--install-service"], "installService"],
      [["--uninstall-service"], "uninstallService"],
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
