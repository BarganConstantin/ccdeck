// What a recorded spawn actually ran, in one shape on every platform.
//
// NOT A TEST FILE. It carries no describe/it and vitest's include pattern only
// collects `*.test.ts`, so it is loaded by the six files that import it and by
// nothing else. It lives here rather than beside the server modules because it
// is test scaffolding: nothing the deck ships needs to take a command line back
// apart.
//
// ── why ──────────────────────────────────────────────────────────────────────
//
// The deck spawns npm and npx one way on POSIX and another on Windows, and the
// difference is deliberate — see spawnSpec and viaCmd in src/server/exec.mjs.
// On POSIX the argument vector goes to spawn untouched:
//
//     spawn("npm", ["install", "ccusage@latest", "--prefix", "/home/me/…"])
//
// On Windows `npm` is a .cmd shim, which spawn cannot launch without cmd.exe,
// so the same call arrives with every argument quoted into ONE string:
//
//     spawn("cmd.exe", ["/d", "/s", "/c",
//       '""C:\\Program Files\\nodejs\\npm.cmd" "install" "ccusage@latest" …"'])
//
// Six test files ask questions like "did an install run?" and wrote them as
// `call.args.includes("install")`. That reads the POSIX shape and only the
// POSIX shape: on Windows the word `install` is a substring of args[3] and not
// an element of args, so the predicate answers false for a spawn that plainly
// did install something. Four of those tests failed on Windows for that reason
// and three MORE passed for it — `expect(…includes("install")).toBe(false)` is
// satisfied by a predicate that can never be true, so those three asserted
// nothing at all there.
//
// None of the six files are about how a platform spells a command line. They
// are about what the deck ran. So the wrapping is undone once, here, and they
// all ask their question of the same list.
//
// The one thing this does not attempt: an argument containing a literal `"`.
// viaCmd doubles those (`""`), and unpicking that needs a real parser rather
// than the token sweep below. No command line the deck builds has one, and the
// two files that already had a private copy of `cmdTokens` had the same limit.

/**
 * The quoted tokens of a `cmd.exe /d /s /c "…"` command line.
 *
 * The whole line is itself wrapped in one pair of quotes, the way `cmd /c`
 * wants it, so that pair comes off before the per-argument ones are read.
 */
export function cmdTokens(line: string): string[] {
  const inner = line.replace(/^"/, "").replace(/"$/, "");
  return [...inner.matchAll(/"([^"]*)"/g)].map(m => m[1]);
}

/** A recorded spawn. The suite's mocks name the program `file` in some files
 *  and `cmd` in others; both are read so no caller has to rename its records. */
export type SpawnCall = { file?: string; cmd?: string; args?: string[] };

/** True when this call is a batch file routed through cmd.exe by viaCmd. */
function isViaCmd({ file, cmd, args = [] }: SpawnCall): boolean {
  const program = String(file ?? cmd ?? "");
  return /(^|[\\/])cmd(\.exe)?$/i.test(program)
    && args.length === 4
    && args[0] === "/d" && args[1] === "/s" && args[2] === "/c"
    && typeof args[3] === "string";
}

/**
 * `[program, ...arguments]` as the spawned process really received them —
 * the array as given off Windows, and the cmd.exe line taken back apart on it.
 */
export function spawnedArgv(call: SpawnCall): string[] {
  const args = call.args ?? [];
  if (isViaCmd(call)) return cmdTokens(args[3] as string);
  return [String(call.file ?? call.cmd ?? ""), ...args];
}

/** Whether a spawn carried `word` as one of its arguments, either shape. */
export const spawnCarried = (call: SpawnCall, word: string): boolean =>
  spawnedArgv(call).includes(word);
