// What a command that failed said about it, short enough to keep.
//
// claude-accounts.mjs, cswap-install.mjs and cswap-auto.mjs read a failed
// `run` the same way — stderr when the tool wrote any, stdout otherwise,
// trimmed, and cut to a length a panel can print — and each wrote that out in
// full, seven times over. One rule spelled seven times is seven places to fix
// the day a tool starts putting its reason somewhere else.
//
// A module of its own rather than a line in exec.mjs, which owns `run`: more
// than a dozen suites replace exec.mjs with a mock that carries `run` and
// nothing else, and a helper exported from there would be missing from every
// module those suites load.

/**
 * What a failed command said, trimmed and cut to `max` characters: its stderr
 * when it wrote any, its stdout otherwise, because tools differ on which one a
 * failure goes to. `r` is exec.mjs's `run` answer.
 */
export function failureDetail(r, max) {
  return (r.stderr || r.stdout).trim().slice(0, max);
}
