// A deck this account cannot signal is alive, not dead.
//
// Every place in this repo that asks "is that pid still running" sends signal
// 0 and reads the errno. POSIX `kill(2)` answers EPERM for a process the caller
// may not signal; on Windows `uv_kill` calls `OpenProcess`, a denial is
// ERROR_ACCESS_DENIED, and libuv maps that to EACCES. Only EPERM was accepted,
// so on Windows a deck started from an elevated terminal — or under another
// account — read as dead everywhere.
//
// The consequence was silent, which is why it is worth a file of its own:
// `hook.js` unlinks the discovery file of a deck it believes is gone, and
// `keepDiscovery` writes it back within five seconds. The deck goes on saying
// it is connected while almost every event goes to a file nobody is reading.
//
// Source assertions, plus the shared probe itself run against every answer it
// can be given. EACCES cannot be produced for real on the machine running this
// suite — that is the whole difficulty of the bug — so the sweep pins that no
// site is left asking the POSIX question alone, and the probe that
// registeredDecks, the boot lock and `--stop` all decide by is handed each errno
// through a spy on process.kill.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// `deck-probe.mjs` in place of `index.mjs`: the probe moved there whole, comment
// included, when `ccdeck --stop` needed to ask this question without importing
// the entire server. index.mjs re-exports it and no longer spells it, so
// sweeping index.mjs would now be sweeping a file with nothing in it to find —
// which this file's whole `toBeGreaterThan(0)` guard exists to catch, and did.
const SITES: Array<[string, string]> = [
  ["hook/hook.js", "../../../hook/hook.js"],
  ["src/server/deck-probe.mjs", "../../server/deck-probe.mjs"],
  ["src/server/self-update.mjs", "../../server/self-update.mjs"],
  ["src/server/browser-watch.mjs", "../../server/browser-watch.mjs"],
];

describe("every liveness probe accepts both spellings of 'not allowed'", () => {
  for (const [name, rel] of SITES) {
    it(`${name} does not ask the POSIX question alone`, () => {
      const src = read(rel);
      // The probe itself, not the file: several of these modules mention EACCES
      // elsewhere — the listen fallback, the rename ladder — and a whole-file
      // count would pass on those while the probe stayed POSIX-only.
      const probes = [...src.matchAll(/process\.kill\([^)]*, 0\)/g)];
      expect(probes.length, `${name} no longer probes with signal 0`).toBeGreaterThan(0);
      for (const m of probes) {
        // Everything from the probe to the end of the statement that reads the
        // errno back. Both spellings have to be in there.
        const after = src.slice(m.index!, m.index! + 400);
        const readsErrno = /catch/.test(after);
        if (!readsErrno) continue;
        expect(after, `${name}: a signal-0 probe that reads only EPERM`).toMatch(/EACCES/);
      }
    });
  }

  it("browser-watch asks through a named predicate rather than a bare catch", () => {
    // Two `try { process.kill(d.pid, 0); } catch { continue; }` sites used to
    // swallow BOTH errnos, so an elevated deck was invisible to the writer
    // election — and two elected writers is duplicate log lines, duplicate
    // reactions, and two writers racing one rename.
    const src = read("../../server/browser-watch.mjs");
    expect(src).toContain("function pidAlive(pid)");
    expect(src).toContain("if (!pidAlive(d.pid)) continue;");
    expect(src).not.toMatch(/try \{ process\.kill\(d\.pid, 0\); \} catch \{ continue; \}/);
  });
});

describe("what the probe answers for pids it can actually see", () => {
  // THE REAL ONE. This case used to define its own `alive` closure and test
  // that, so the probe every caller shares — deck-probe.mjs, which
  // registeredDecks, the boot lock's stale check and stopDeck's wait all decide
  // by — never ran once on a pid that was gone. Its catch could have answered
  // true for everything, and the suite would have stayed green while every
  // `ccdeck --stop` climbed all three rungs and reported "stuck".
  it("says yes for this process and no for one that is gone", async () => {
    // @ts-expect-error — .mjs server module, no types
    const { isProcessAlive } = await import("../../server/deck-probe.mjs");
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const code = await new Promise<number>(r => child.on("close", c => r(c ?? 0)));
    expect(code).toBe(0);

    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(child.pid!)).toBe(false);
  }, 15_000);
});

describe("what the probe answers for pids it is not allowed to signal", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /** process.kill failing with `code`, the way libuv reports it. */
  const refusing = (code: string) => vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error(`kill ${code}`), { code });
  });

  it("reads 'not allowed' as alive, in both platforms' spellings", async () => {
    // @ts-expect-error — .mjs server module, no types
    const { isProcessAlive } = await import("../../server/deck-probe.mjs");
    // POSIX: another account's deck. Windows: an elevated one, or another
    // account's — OpenProcess is denied and libuv says EACCES. Read as dead,
    // the next start launches a second deck beside it, `--stop` says nothing
    // is running, and hooks unlink its discovery file.
    refusing("EPERM");
    expect(isProcessAlive(4242)).toBe(true);
    vi.restoreAllMocks();
    refusing("EACCES");
    expect(isProcessAlive(4242)).toBe(true);
  });

  it("reads 'no such process' as gone, and nothing else as alive by accident", async () => {
    // @ts-expect-error — .mjs server module, no types
    const { isProcessAlive } = await import("../../server/deck-probe.mjs");
    const kill = refusing("ESRCH");
    expect(isProcessAlive(4242)).toBe(false);
    // Signal 0, which delivers nothing: the probe must never be the thing that
    // ends the process it is asking about.
    expect(kill).toHaveBeenCalledWith(4242, 0);
  });
});
