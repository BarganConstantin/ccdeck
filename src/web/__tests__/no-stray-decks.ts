// The suite is not allowed to leave a deck running (#702).
//
// This is a globalSetup rather than a hook in a file, because the failure it
// catches is precisely the one no file notices. Several suites here start a real
// deck out of a temp install; each of them believes it stops what it started;
// one of them was wrong for months, and the only symptom was a machine getting
// slower. 310 orphaned decks were alive when this was found, the oldest a day
// and four hours old, each holding a bound port, a temp directory and 40–60 MB
// of RSS — and every single test run had been green.
//
// LOUD, NOT TIDY. The teardown does both: it kills what this run leaked and
// then fails the run for having leaked it. Killing alone is the version of this
// that stops working silently — a suite that quietly reaps its own mess is a
// suite in which a reaper that breaks looks identical to a suite with nothing to
// reap. Failing alone leaves the strays on the machine that just told you about
// them, which is a poor way to treat someone who ran `vitest` once. So: reap so
// the machine is clean, and throw so the next person reads about it rather than
// discovers it in `ps` a day later.
//
// WHAT COUNTS AS A STRAY, and why it can never be the user's own deck. A process
// whose argv names `bin/deck.js` or `bin/agent-dag.js` UNDER THE OS TEMP
// DIRECTORY. Nothing installs a deck there: a real one lives in a global npm
// prefix, an npx cache or a checkout. Matching on `deck.js` alone would have
// killed the deck the person running the suite is looking at — including, on the
// machine that reported this, one on port 4317 that had nothing to do with any
// of it.
//
// PRE-EXISTING STRAYS ARE NOT THIS RUN'S FAULT. Setup snapshots the pids that
// were already there and says so; teardown fails only over pids that appeared
// while the suite ran. A developer with yesterday's orphans still around gets a
// warning naming them and a run that can still pass.
//
// AND NEITHER IS A DECK SOMEBODY ELSE IS STILL USING. This machine runs several
// agents at once, each with its own worktree and its own `vitest`, and the first
// version of this file proved it the hard way: it flagged three decks that were
// perfectly healthy children of another run in progress, and would have killed
// them mid-suite. So a candidate has to be an ORPHAN as well as new — its parent
// gone, which is what re-parenting to pid 1 means and what every one of the 310
// had happened to it. A deck whose ancestor is a live test runner belongs to that
// runner and is left strictly alone. Deck ancestors are stepped over on the way
// up, because the worker's parent is the supervisor and the supervisor is the
// process that went missing.
//
// That check errs towards saying nothing: on a Linux configured with a
// subreaper, an orphan is re-parented to the subreaper rather than to init and
// this will not call it a stray. Under-reporting is the direction to be wrong
// in. The other one kills a colleague's running deck.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

export type Proc = { pid: number; ppid: number; cmd: string };

/** One spelling of a path: separators forward, case folded on Windows only,
 *  no trailing separator. Windows paths are case-insensitive and POSIX ones are
 *  not, and folding both would let `/tmp/CCDeck` pass for `/tmp/ccdeck`. */
export function norm(path: string, platform: NodeJS.Platform = process.platform): string {
  const slashed = String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
}

/** Every spelling of the OS temp directory a command line can show.
 *
 *  macOS is the reason this is a list. `tmpdir()` answers
 *  `/var/folders/…/T`, `ps` prints the executable's path through
 *  `/private/var/folders/…/T`, and the `--history` argument beside it is back to
 *  `/var/…`: one directory, two spellings, in one command line. The realpath is
 *  taken as well for the symlinked `/tmp` that some Linux distributions and
 *  every Windows user profile have. */
export function tempRoots(dir: string = tmpdir(), platform: NodeJS.Platform = process.platform): string[] {
  const out = new Set<string>();
  out.add(norm(dir, platform));
  try { out.add(norm(realpathSync(dir), platform)); } catch { /* gone, or not readable */ }
  for (const p of [...out]) {
    if (p.startsWith("/private/")) out.add(p.slice("/private".length));
    else if (p.startsWith("/")) out.add(`/private${p}`);
  }
  return [...out].filter(Boolean);
}

// The two files that ARE a deck. A stub worker written by a fixture is not one
// of these and does not hold a port; these do.
const DECK_FILES = ["/bin/deck.js", "/bin/agent-dag.js"];

/**
 * Is this command line a deck running out of a temp install?
 *
 * Token by token, because a command line is an argv joined by spaces and the
 * question is about one argument: the path the interpreter was pointed at. A
 * `--history` value under the same temp directory is not enough on its own, and
 * a `deck.js` outside it never counts however it is spelled.
 */
export function isStrayDeck(commandLine: string, roots: string[], platform: NodeJS.Platform = process.platform): boolean {
  for (const token of String(commandLine ?? "").split(/\s+/)) {
    const t = norm(token, platform);
    if (!DECK_FILES.some(f => t.endsWith(f))) continue;
    if (roots.some(r => r && t.startsWith(`${r}/`))) return true;
  }
  return false;
}

/** `<pid> <ppid> <command line>` per line, which is what both listings below
 *  emit. A line whose command is empty is dropped: a process that will not name
 *  itself cannot be matched, and every kernel thread on Linux is one. */
export function parseListing(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
  }
  return out;
}

/**
 * Has this process outlived whoever started it?
 *
 * Walks up, stepping over ancestors that are themselves temp-installed decks —
 * an orphaned supervisor with a worker under it is one leak, not two, and the
 * worker's parent being present says nothing about whether anybody still owns
 * the pair. The answer is yes when the walk runs out: a parent of 0 or 1 (init
 * adopted it) or a parent that is not in the listing at all (Windows, which does
 * not re-parent, so the pid simply names nothing).
 *
 * `seen` bounds the walk. A pid table read a line at a time is not a snapshot
 * and can contain a cycle; without this that would be an infinite loop inside a
 * teardown, which is a worse failure than the one being looked for.
 */
export function isOrphan(proc: Proc, byPid: Map<number, Proc>, roots: string[], platform: NodeJS.Platform = process.platform): boolean {
  const seen = new Set<number>([proc.pid]);
  let at = proc;
  for (;;) {
    if (at.ppid <= 1) return true;
    const parent = byPid.get(at.ppid);
    if (!parent) return true;
    if (!isStrayDeck(parent.cmd, roots, platform)) return false;
    if (seen.has(parent.pid)) return false;
    seen.add(parent.pid);
    at = parent;
  }
}

/**
 * Every process on the machine, or null when the machine will not say.
 *
 * Null rather than an empty list, and the difference is the point: a guard that
 * cannot see the process table must not report "nothing leaked". It says it
 * could not look, and the run carries on — a missing `ps` is not a reason to
 * fail somebody's test suite.
 *
 * Windows has no `ps`. `Get-CimInstance Win32_Process` is the answer that works
 * on every Windows a Node 18 runs on, and it is the only one offered here:
 * `wmic`, the obvious second try, is deprecated and removed outright in current
 * builds, so a fallback onto it would be a fallback onto nothing.
 */
export function listProcesses(platform: NodeJS.Platform = process.platform): Proc[] | null {
  // Bounded, because this runs inside a teardown and a listing that hangs would
  // hang the run it is supposed to be reporting on. A timeout arrives here as a
  // throw, which is the same "could not look" as a missing `ps`.
  const run = (file: string, args: string[]) =>
    execFileSync(file, args, {
      encoding: "utf8", maxBuffer: 32 << 20, timeout: 20_000,
      windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
  if (platform === "win32") {
    try {
      return parseListing(run("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)\" }",
      ]));
    } catch { return null; }
  }
  // `-A -o` rather than `-eo`: both spellings work on Linux, only this one is
  // in macOS's ps as well.
  try { return parseListing(run("ps", ["-A", "-o", "pid=,ppid=,args="])); } catch { return null; }
}

/** The decks running out of a temp install with nobody left to stop them, or
 *  null when the process table could not be read. A deck still owned by a live
 *  run — this one, or another agent's beside it — is not in here. */
export function strayDecks(): Proc[] | null {
  const all = listProcesses();
  if (!all) return null;
  const roots = tempRoots();
  const byPid = new Map(all.map(p => [p.pid, p]));
  return all.filter(p => p.pid !== process.pid
    && isStrayDeck(p.cmd, roots)
    && isOrphan(p, byPid, roots));
}

/** The message the run fails with. Built here so a test can read it without
 *  leaking a deck to produce one. */
export function strayMessage(leaked: Proc[]): string {
  return [
    `this run left ${leaked.length} deck${leaked.length === 1 ? "" : "s"} running.`,
    "Each one holds a bound port, a temp directory and 40-60 MB of RSS, and nothing",
    "will ever stop it. They have been killed so this machine is clean; the failure is",
    "here so the suite that started them gets fixed. A deck is two processes — the",
    "supervisor and the worker beside it — so a teardown that SIGKILLs the supervisor",
    "reaps neither. See #702, and stopSupervised in restart-boot-window.test.ts.",
    "(On a machine running several suites at once, one of them left these. They are",
    "orphans with no parent left either way, which is why they are named here.)",
    "",
    ...leaked.map(p => `  ${p.pid}  ${p.cmd}`),
  ].join("\n");
}

/** Pids that were already running when the suite started; not this run's doing
 *  and not this run's failure. */
let before = new Set<number>();

export function setup(): void {
  const found = strayDecks();
  if (found === null) {
    console.warn("[stray-deck guard] the process table could not be read here; the suite is unguarded this run.");
    return;
  }
  before = new Set(found.map(p => p.pid));
  if (found.length) {
    console.warn(
      `[stray-deck guard] ${found.length} deck(s) from an earlier run are still alive and will be ignored:\n`
      + found.map(p => `  ${p.pid}  ${p.cmd}`).join("\n"),
    );
  }
}

export function teardown(): void {
  const found = strayDecks();
  if (found === null) return;
  const leaked = found.filter(p => !before.has(p.pid));
  if (!leaked.length) return;
  for (const p of leaked) {
    // SIGTERM, so a worker still gets to unregister its discovery file and let
    // its port go. Windows has no signals and Node turns this into a plain
    // terminate, which is the only thing available there and is enough.
    try { process.kill(p.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  throw new Error(strayMessage(leaked));
}
