// A Linux machine with browsers running on it, held entirely in memory, for the
// suites that drive the Linux half of the quit reaction and the presence probe.
//
// Since #1752 that half acts on the process holding a profile's lock — the
// `SingletonLock` symlink every Chromium browser keeps in its user-data root,
// which names `<host>-<pid>` — after checking that process in /proc. So a case
// needs a home with locks in it and a /proc with processes in it, and neither
// may be the real one: the machine running this suite has its owner's browsers
// open, and a lock read from their profile would hand the reaction a real pid.
//
// Nothing here is on disk. `readlink` and `readFile` answer from two maps under
// a root that does not exist, and throw ENOENT for anything else, so a path the
// code builds wrongly — or a real one it reaches for by default — reads as
// "nothing there" and never as somebody's browser. The paths are POSIX on every
// host because `browserRoots("linux", …)` spells them that way.
//
// The browser survey reads the same machine (#1825): which user-data roots are
// on disk, and what `dig`, `pgrep` and `lsof` print. So a root can be installed
// here too, and a command can be given the output it prints.
import { posix } from "node:path";

const ROOT = "/nonexistent-ccdeck-fixture";
export const HOME = `${ROOT}/home/dorin`;
export const PROC = `${ROOT}/proc`;
export const HOST = "fixture-host";

type Call = { cmd: string; args: string[] };
type Reply = { ok: boolean; stdout: string; stderr: string };

export function linuxMachine() {
  const links = new Map<string, string>();
  const files = new Map<string, string>();
  const calls: Call[] = [];
  const roots = new Set<string>();
  const replies = new Map<string, Reply>();
  const missing = (path: string) => Object.assign(new Error(`ENOENT: no such file, '${path}'`), { code: "ENOENT" });

  /** A process in /proc: its `comm` and the argv it was started with. */
  const started = (pid: number, argv: string[], comm = posix.basename(argv[0])) => {
    files.set(posix.join(PROC, String(pid), "comm"), `${comm}\n`);
    files.set(posix.join(PROC, String(pid), "cmdline"), argv.join("\0") + "\0");
  };

  return {
    calls,
    started,
    /** The browser whose user-data root is `root` (relative to the home) is
     *  held by `pid`, on `host`. */
    lock(root: string, pid: number, host = HOST) {
      links.set(posix.join(HOME, root, "SingletonLock"), `${host}-${pid}`);
    },
    /** The user-data root `root` (relative to the home) is on disk, so the
     *  survey reads that browser as installed. It holds no profile folders. */
    install(root: string) {
      roots.add(posix.join(HOME, root));
    },
    /** What `cmd` prints. A command given nothing succeeds and prints nothing. */
    answer(cmd: string, reply: Reply) {
      replies.set(cmd, reply);
    },
    /** Every command the code asked to run. None of them runs: this answers
     *  success for every one, and a signal is a line in `calls`. */
    signals: () => calls.filter(c => c.cmd === "kill" || c.cmd === "pkill" || c.cmd === "killall"),
    deps: {
      home: HOME,
      env: {},
      procRoot: PROC,
      hostname: () => HOST,
      readlink: async (path: string) => {
        const to = links.get(path);
        if (to === undefined) throw missing(path);
        return to;
      },
      readFile: async (path: string) => {
        const text = files.get(path);
        if (text === undefined) throw missing(path);
        return text;
      },
      run: async (cmd: string, args: string[] = []) => {
        calls.push({ cmd, args });
        return replies.get(cmd) ?? { ok: true, stdout: "", stderr: "" };
      },
      existsSync: (path: string) => roots.has(path),
      // What the survey lists inside a root and inside a profile: nothing.
      fs: {
        readdirSync: (path: string) => { throw missing(path); },
        statSync: (path: string) => { throw missing(path); },
        existsSync: () => false,
      },
    },
  };
}
