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
// Source assertions plus one behavioural check. The errno cannot be produced on
// the machine running this suite — that is the whole difficulty of the bug —
// so what is pinned is that no site is left asking the POSIX question alone.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const SITES: Array<[string, string]> = [
  ["hook/hook.js", "../../../hook/hook.js"],
  ["src/server/index.mjs", "../../server/index.mjs"],
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
  it("says yes for this process and no for one that is gone", async () => {
    // The half that can be measured here: the predicate still answers the two
    // ordinary cases correctly after gaining the second errno.
    // @ts-expect-error — .mjs server module, no types
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const code = await new Promise<number>(r => child.on("close", c => r(c ?? 0)));
    expect(code).toBe(0);

    const alive = (pid: number) => {
      try { process.kill(pid, 0); return true; }
      catch (e) { const err = e as NodeJS.ErrnoException; return err.code === "EPERM" || err.code === "EACCES"; }
    };
    expect(alive(process.pid)).toBe(true);
    expect(alive(child.pid!)).toBe(false);
  }, 15_000);
});
