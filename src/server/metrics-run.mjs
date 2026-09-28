// How the Machine panel's readers run a command: no shell, a forced number
// format, stdout or null, and a deadline that kills the child rather than
// waiting on it.
//
// Moved out of system-metrics.mjs unchanged, so that a reader lifted out of the
// sampler can share the one runner without importing the sampler back — which
// would be a cycle in src/server, the thing boot-module-graph.test.ts exists to
// refuse. It is not exec.mjs's `run` and should not become it: that one is for
// the tools the deck manages, resolves Windows shims and PATHEXT, and answers a
// result object; this one only ever runs a system binary and answers its stdout,
// or null, which is all a sampler can use.
import { spawn } from "node:child_process";

/**
 * The locale every child of this module runs in — and only the part of it that
 * had to be forced.
 *
 * Not a preference. Every command spawned here has its output read by a regex
 * and every one of those regexes reads a number with a `.` in it. `ps` and
 * `sysctl` honour LC_NUMERIC, so on a machine set to de_DE, fr_FR, ru_RU or
 * pt_BR — comma is the decimal separator for most of Europe and Latin America —
 * the same commands print:
 *
 *     ps      1   0,2  0,0 /sbin/launchd
 *     sysctl  total = 8192,00M  used = 7189,75M  free = 1002,25M
 *
 * and the parsers matched nothing at all. Not partially: `parsePsProcesses`
 * `continue`s on every row, so the process panel was permanently empty, and
 * `swapFromSysctl` returned null, so the macOS swap meter was permanently
 * blank. Silently, on a machine where everything else worked.
 *
 * THIS USED TO FORCE THE WHOLE LOCALE, and forcing the whole locale also forces
 * the CHARACTER SET. Under `LC_ALL=C`, `ps` escapes every byte it cannot render
 * as ASCII, so an application named in Cyrillic came back as
 *
 *     M-PM-/M-PM-=M-PM-4M-PM-5M-PM-:M-QM^A M-PM^\M-QM^CM-PM-7M-QM^KM-PM-:M-PM-0
 *
 * where the name is `Яндекс Музыка`. The panel truncates at 164px so it read as
 * noise; the process list added in #738 has room for all ninety-one characters
 * of it, which is how it was found. Every reader with a non-Latin application
 * on their machine was being shown that.
 *
 * So only the numeric is forced now, and the character set is inherited. All
 * four measured on this machine:
 *
 *     LC_ALL=C                        name mangled,  0.7
 *     LC_ALL="" LC_NUMERIC=C          Яндекс Музыка, 0.7
 *     LANG=de_DE + our override       Яндекс Музыка, 0.7   ← the comma case
 *     LC_ALL=de_DE + our empty LC_ALL                0.7   ← a hostile env
 *
 * The empty `LC_ALL` is doing real work in the last of those: POSIX ignores an
 * empty LC_ALL, so clearing it is what stops a user's own LC_ALL from
 * outranking the LC_NUMERIC below. Setting LC_NUMERIC alone would not survive
 * it.
 *
 * A reader whose own locale is C still sees the escaped form — but so does
 * their terminal, so that is their machine being consistent rather than this
 * module choosing for them.
 *
 * Meaningless on Windows, where the readers' branches are PowerShell piped
 * through ConvertTo-Json and already culture-invariant — and harmless there for
 * the same reason. The comma tolerance in their parsers stays as defence in
 * depth for a sandbox that strips the environment, not as the primary answer.
 */
const C_LOCALE = { LC_ALL: "", LC_NUMERIC: "C" };

/** Run a command and resolve its stdout, or null. Never rejects, never inherits
 *  a shell, never inherits a locale, and is killed rather than allowed to hang
 *  the sampler. */
export function run(file, args, timeoutMs = 2_000) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(file, args, {
        windowsHide: true,
        env: { ...process.env, ...C_LOCALE },
        // stderr is PIPED AND NEVER READ, which is a deadlock waiting for a
        // chatty child: a pipe nobody drains fills at 64 KB and the writer
        // blocks there until this function's own deadline kills it. Nothing
        // here has ever looked at it — `run` resolves on stdout or null — so
        // the honest arrangement is not to open it.
        stdio: ["ignore", "pipe", "ignore"],
      });
    }
    catch { return resolve(null); }
    let out = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, timeoutMs);
    // DECODE THE STREAM, NOT EACH CHUNK. `out += d` on a Buffer calls toString()
    // per chunk, and a chunk boundary falls wherever the pipe happened to break
    // — measured on `ps` output as three chunks of 8192/8192/5718 — so a
    // multi-byte character split across two of them became two replacement
    // characters. An application called `Яндекс Музыка` in the process list
    // rendered as `Ян��екс Музыка`. setEncoding carries the partial sequence
    // across the boundary, which is the whole reason it exists.
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", d => { out += d; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", code => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
}
