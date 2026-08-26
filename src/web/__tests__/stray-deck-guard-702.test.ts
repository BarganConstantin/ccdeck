// The guard that stops the suite leaking decks, and the leash that stops a deck
// outliving the process that started it (#702).
//
// Both halves are here because neither is enough alone, and both are the kind of
// code that can stop working without anybody noticing — the guard by quietly
// matching nothing, the leash by quietly arming nothing. The first three
// describes are the guard's predicate, checked against the exact command lines
// that were found alive on the reporting machine and against the ones that must
// never be touched. The last is the leash, driven through two real processes.
//
// No sandboxing is needed for the predicate: nothing here spawns anything, reads
// a config directory or looks at a home. The last describe does spawn, and gives
// its children a temp HOME of their own.
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOrphan, isStrayDeck, norm, parseListing, strayMessage, tempRoots, type Proc } from "./no-stray-decks";
import { dieWithParent } from "../../server/supervisor.mjs";

// The command line off the reporting machine, verbatim. macOS spells the
// executable through /private and the argument beside it without: one directory,
// two spellings, in one line, which is the case tempRoots exists for.
const LEAKED =
  "/Users/x/.nvm/versions/node/v22.14.0/bin/node "
  + "/private/var/folders/wl/62nt10wn1zv836q4f5kvn56w0000gn/T/ccdeck-boot-window-F6DSaH/pkg/bin/deck.js "
  + "--port 0 --no-open --no-claude --no-codex "
  + "--history /var/folders/wl/62nt10wn1zv836q4f5kvn56w0000gn/T/ccdeck-boot-window-F6DSaH/deck-events.jsonl "
  + "--port 54269";

const MAC_TMP = "/var/folders/wl/62nt10wn1zv836q4f5kvn56w0000gn/T";

describe("which processes the guard is willing to call a stray", () => {
  it("recognises the shape that was found alive 310 times", () => {
    expect(isStrayDeck(LEAKED, tempRoots(MAC_TMP, "darwin"), "darwin")).toBe(true);
  });

  it("recognises the supervisor as well as the worker", () => {
    const line = `node ${MAC_TMP}/ccdeck-boot-window-aa/pkg/bin/agent-dag.js --port 0`;
    expect(isStrayDeck(line, tempRoots(MAC_TMP, "darwin"), "darwin")).toBe(true);
  });

  it("never touches the deck the person running the suite is looking at", () => {
    // The live deck on the reporting machine, which survived the cleanup only
    // because it was matched by hand. It must survive by rule now.
    const live = "/Users/x/.nvm/versions/node/v22.14.0/bin/node "
      + "/Users/x/.npm/_npx/98268bf1081b6437/node_modules/ccdeck/bin/deck.js --port 4317 --no-open";
    expect(isStrayDeck(live, tempRoots(MAC_TMP, "darwin"), "darwin")).toBe(false);
  });

  it("leaves a deck run out of a checkout alone, however it was spelled", () => {
    for (const line of [
      "node bin/deck.js --no-open --port 4405",
      "node /Users/x/src/agents-deck/bin/deck.js --port 4406",
      "/usr/local/bin/node /opt/homebrew/lib/node_modules/ccdeck/bin/agent-dag.js",
    ]) {
      expect(isStrayDeck(line, tempRoots(MAC_TMP, "darwin"), "darwin")).toBe(false);
    }
  });

  it("is not fooled by a temp path that merely appears in an argument", () => {
    // A vitest worker whose --history points into the temp directory is not a
    // deck, and killing one would take the run down with it.
    const line = `node /Users/x/src/agents-deck/bin/other.js --history ${MAC_TMP}/ccdeck-x/events.jsonl`;
    expect(isStrayDeck(line, tempRoots(MAC_TMP, "darwin"), "darwin")).toBe(false);
  });

  it("reads a Windows install out of a Windows temp directory", () => {
    const roots = tempRoots("C:\\Users\\John\\AppData\\Local\\Temp", "win32");
    const line = "\"C:\\Program Files\\nodejs\\node.exe\" "
      + "C:\\Users\\John\\AppData\\Local\\TEMP\\ccdeck-boot-window-a1\\pkg\\bin\\deck.js --port 0";
    // Case-folded, because Windows paths are — and NOT folded on POSIX, where
    // two directories really can differ only in case.
    expect(isStrayDeck(line, roots, "win32")).toBe(true);
    expect(norm("/tmp/CCDeck-A", "linux")).toBe("/tmp/CCDeck-A");
    expect(norm("C:\\Temp\\CCDeck-A", "win32")).toBe("c:/temp/ccdeck-a");
  });

  it("knows both spellings macOS gives one temp directory", () => {
    const roots = tempRoots(MAC_TMP, "darwin");
    expect(roots).toContain(MAC_TMP);
    expect(roots).toContain(`/private${MAC_TMP}`);
  });
});

describe("the listing the guard reads", () => {
  it("takes a pid, a parent and the whole command line after them", () => {
    expect(parseListing(" 4341 4300 node /tmp/ccdeck-a/pkg/bin/deck.js --port 0\n\n bad line\n")).toEqual([
      { pid: 4341, ppid: 4300, cmd: "node /tmp/ccdeck-a/pkg/bin/deck.js --port 0" },
    ]);
  });
});

describe("whether anybody is still left to stop this deck", () => {
  // This machine runs several agents at once. The first version of this guard
  // flagged three decks that were healthy children of another agent's run and
  // would have killed them mid-suite; these are the cases that stops.
  const roots = tempRoots(MAC_TMP, "darwin");
  const table = (procs: Proc[]) => new Map(procs.map(p => [p.pid, p]));
  const deck = (pid: number, ppid: number, name = "deck.js") =>
    ({ pid, ppid, cmd: `node ${MAC_TMP}/ccdeck-boot-window-a/pkg/bin/${name}` });

  it("says yes to the shape all 310 of them had: a worker whose supervisor was killed", () => {
    const worker = deck(9917, 1);
    expect(isOrphan(worker, table([worker]), roots, "darwin")).toBe(true);
  });

  it("says no while a live test runner is still above it", () => {
    const runner = { pid: 500, ppid: 400, cmd: "node /repo/node_modules/vitest/dist/worker.js" };
    const supervisor = deck(600, 500, "agent-dag.js");
    const worker = deck(700, 600);
    const all = table([runner, supervisor, worker]);
    expect(isOrphan(worker, all, roots, "darwin")).toBe(false);
    expect(isOrphan(supervisor, all, roots, "darwin")).toBe(false);
  });

  it("steps over a deck ancestor, so an orphaned pair is not mistaken for a live one", () => {
    // The worker's parent is present and looks fine; it is the SUPERVISOR that
    // was orphaned, and the pair is one leak rather than none.
    const supervisor = deck(600, 1, "agent-dag.js");
    const worker = deck(700, 600);
    expect(isOrphan(worker, table([supervisor, worker]), roots, "darwin")).toBe(true);
  });

  it("treats a parent that is not in the table as gone, which is Windows", () => {
    // Windows does not re-parent: the pid stays and stops naming anything.
    const worker = deck(700, 4242);
    expect(isOrphan(worker, table([worker]), roots, "darwin")).toBe(true);
  });

  it("cannot be walked forever by a table that contradicts itself", () => {
    const a = deck(700, 800);
    const b = deck(800, 700);
    expect(isOrphan(a, table([a, b]), roots, "darwin")).toBe(false);
  });
});

describe("what the run is told when it leaks one", () => {
  it("names the processes and says where to look", () => {
    const said = strayMessage([{ pid: 4341, cmd: "node /tmp/ccdeck-a/pkg/bin/deck.js" }]);
    expect(said).toContain("left 1 deck running");
    expect(said).toContain("4341");
    expect(said).toContain("#702");
    // Killed AND reported: a guard that only tidied up would look the same as a
    // guard that had stopped working.
    expect(said).toContain("killed");
  });
});

describe("a child that is told to die with its parent", () => {
  const DIR = mkdtempSync(join(tmpdir(), "ccdeck-702-leash-"));
  const CHILD = join(DIR, "child.mjs");
  const MIDDLE = join(DIR, "middle.mjs");
  const LEASH = new URL("../../server/supervisor.mjs", import.meta.url).href;
  const started: ChildProcess[] = [];

  // This file is the one that fails the run when a suite leaves a process
  // behind, so it had better not.
  afterAll(() => {
    for (const p of started) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
    rmSync(DIR, { recursive: true, force: true });
  });

  /** Does this pid still exist? Signal 0 asks without delivering anything, and
   *  Node implements it on Windows too. */
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  const until = async (ok: () => boolean, ms: number, what: string) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (ok()) return;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`timed out after ${ms}ms waiting for ${what}`);
  };

  it("arms only when there is a parent holding a channel", () => {
    // The hand-started deck: no channel, nothing to die with, so nothing is
    // armed and the process is left alone.
    expect(dieWithParent(() => {}, { once: () => {} } as any)).toBe(false);
    const handlers: Record<string, () => void> = {};
    const fake = {
      send: () => true,
      once: (name: string, fn: () => void) => { handlers[name] = fn; },
    };
    expect(dieWithParent(() => {}, fake as any)).toBe(true);
    expect(typeof handlers.disconnect).toBe("function");
  });

  it("runs the stop exactly once, even if disconnect is delivered twice", () => {
    const handlers: Record<string, () => void> = {};
    let stops = 0;
    dieWithParent(() => { stops++; }, {
      send: () => true,
      once: (name: string, fn: () => void) => { handlers[name] = fn; },
    } as any);
    handlers.disconnect();
    handlers.disconnect();
    expect(stops).toBe(1);
  });

  it("exits when its parent is killed with the signal no parent can handle", async () => {
    // The whole of #702, in the three processes it happened in. This case is the
    // middle one — a supervisor — and it is killed with SIGKILL, which is the
    // one thing it cannot answer and therefore the one thing it can never clean
    // up after. Before the leash the grandchild simply carried on; the whole
    // assertion is that it no longer does.
    writeFileSync(CHILD, [
      `import { dieWithParent } from ${JSON.stringify(LEASH)};`,
      // Something ref'd, so the process would otherwise sit here for a day —
      // which is precisely what the 310 orphaned decks were doing.
      `const held = setInterval(() => {}, 1000);`,
      `dieWithParent(() => { clearInterval(held); process.exit(7); });`,
      `process.send({ ready: true });`,
    ].join("\n"));
    writeFileSync(MIDDLE, [
      `import { spawn } from "node:child_process";`,
      `const kid = spawn(process.execPath, [${JSON.stringify(CHILD)}], {`,
      `  stdio: ["ignore", "ignore", "ignore", "ipc"],`,
      `});`,
      `kid.once("message", () => { process.stdout.write("KID " + kid.pid + "\\n"); });`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"));

    const middle = spawn(process.execPath, [MIDDLE], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, HOME: DIR, USERPROFILE: DIR },
    });
    started.push(middle);
    let said = "";
    middle.stdout!.on("data", d => { said += String(d); });
    await until(() => /KID (\d+)/.test(said), 15_000, "the grandchild to report itself");
    const kid = Number(/KID (\d+)/.exec(said)![1]);
    expect(alive(kid)).toBe(true);

    middle.kill("SIGKILL");
    // Not the grandchild — nothing ever signals it. Its channel closes because
    // the process holding the other end stopped existing, and that is the only
    // notice it gets. Same event on Linux, macOS and Windows: a socketpair and a
    // named pipe both end when the process that owned them does.
    await until(() => !alive(kid), 15_000, "the grandchild to notice and leave");
    expect(alive(kid)).toBe(false);
  }, 40_000);
});
