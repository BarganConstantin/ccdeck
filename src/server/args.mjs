// The command line, parsed: everything the deck recognises, and everything it
// does not.
//
// Its own module rather than a function inside bin/deck.js, for one reason —
// importing bin/deck.js RUNS a deck. That file installs hooks, binds a port and
// opens a browser at module scope, so there was no way to ask what `--prot`
// parses to without starting a server to find out. Nothing here does any of
// that: strings in, a plain object out, no I/O, no process, no terminal.
//
// bin/deck.js is the only caller. The parser is the whole of the module's
// surface; the tables it matches against stay inside it.

/**
 * Is this token a flag rather than somebody's value?
 *
 * A leading `-` and nothing else, because the alternatives are worse. Matching
 * the known flag list would refuse `--workspace --prot` — a typo eating the next
 * token is the same accident as a real flag eating it, and the one shape that
 * must be caught is the one nobody spelled right. Refusing every value that
 * begins with `-` would refuse `--port -1`, which is a number the user meant and
 * which deserves the port error below rather than a "missing value" one.
 *
 * So: a leading `-`, except a plain negative number. The negative-number carve
 * is the only exception, and it is small on purpose.
 *
 * WHAT THIS DOES ON EACH PLATFORM. Nothing, is the intent, to any real path.
 * POSIX absolute (`/srv/proj`), POSIX relative (`./sub`, `sub`), `~/proj`, a
 * Windows drive letter (`C:\Users\u\proj`, `c:/users/u/proj`), a UNC share
 * (`\\srv\share\proj`), a Windows long path (`\\?\C:\proj`) and a bare
 * `events.jsonl` all begin with something other than `-`, so all of them are
 * values. A drive letter is not a flag on any platform and is never read as one:
 * `C:` starts with `C`. What IS refused is a directory whose name really begins
 * with a dash, which the user can still pass as `./-weird` — a two-character
 * price for catching `--workspace $UNSET --no-persist`.
 */
export function looksLikeFlag(token) {
  return typeof token === "string" && token.startsWith("-") && !/^-\d+(?:\.\d+)?$/.test(token);
}

/**
 * Is this a port the deck could bind? Digits only, inside the range Node's
 * `listen` accepts.
 *
 * `Number()` alone is far too willing: it takes `" 4500 "`, `0x10e4`, `1e3` and
 * `Infinity`, and turns everything else into the `NaN` that used to reach
 * `listen` and die there. The whole point of asking here is to answer BEFORE the
 * deck has installed hooks and probed for tools, and to answer about the string
 * the user actually typed. See bin/deck.js, which prints the flag and the value
 * back at them.
 */
export function isPortValue(raw) {
  if (typeof raw !== "string" && typeof raw !== "number") return false;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return false;
  const n = Number(s);
  return n >= 0 && n <= 65535;
}

/**
 * Parse `process.argv.slice(2)`.
 *
 * Returns the flags that were set, plus two lists that are always present and
 * always arrays:
 *
 *   `unknown`     — every token the loop did not recognise, in the order it met
 *                   them. That list is the point of this module: the loop used
 *                   to have no `else`, so `ccdeck --prot 4500` booted on 4317 and
 *                   said nothing, and a typo was indistinguishable from a flag
 *                   that worked.
 *   `incomplete`  — every value-taking flag that was given no value it could
 *                   use, as `{ flag, expects }`, `flag` spelled the way the user
 *                   spelled it. bin/deck.js prints one row per entry.
 *
 * THE THREE FLAGS THAT TAKE A VALUE (`--port`/`-p`, `--workspace`, `--history`)
 * used to consume the next token with `args[++i]` whatever it was. That is right
 * for `--port 4500` — the value must never be re-examined as a token of its own,
 * or every correct command line would report its own port as an unknown option,
 * and a warning that fires on correct input is a warning everybody learns to
 * ignore. It was wrong for a value that is itself a flag (#697): `ccdeck
 * --workspace $PROJ --no-persist` with `PROJ` unset is, after word splitting,
 * `ccdeck --workspace --no-persist`. The deck scoped itself to a directory
 * called `--no-persist`, wrote to the shared events log anyway, and reported
 * neither — `unknown` stayed empty, because the token that would have gone in it
 * had been eaten.
 *
 * So the consume is conditional now, and it refuses three shapes:
 *
 *   * the next token looks like a flag — NOT consumed, so the loop meets it on
 *     the next pass and it is parsed as the flag it is, or reported as unknown.
 *     That is also what fixes the supervisor case in bin/agent-dag.js: a
 *     respawn appends `--port <bound>` to the user's argv, and an argv ending in
 *     a bare `--workspace` used to eat the `--port` and drop the deck back on
 *     4317, out from under the tab the user was looking at.
 *   * there is no next token at all — the trailing `--workspace`, which used to
 *     set `undefined` and mean "the default", silently.
 *   * the next token is empty or blank — consumed (it was quoted, so it was
 *     meant as the value) but not used. `--workspace ""` is a variable that did
 *     not expand, not a request for machine-wide capture, and answering it with
 *     the widest possible scope is the one answer that cannot be recovered from.
 *
 * In all three the flag is left UNSET, so the deck falls back to its documented
 * default, and the flag is named in `incomplete` so the fallback is said out
 * loud rather than discovered later.
 *
 * A bare word is `unknown` too, and deliberately: the deck takes no positional
 * arguments at all, so `ccdeck ~/proj` is the same mistake as `ccdeck --workpace
 * ~/proj` — something the deck read and then did nothing with. It is also how
 * an unquoted path with a space in it becomes visible, which is a failure this
 * repo already knew about and could not previously report: `--workspace
 * C:\Users\John Smith\proj` reaches the parser as two arguments, and the second
 * one used to be dropped in silence (see launchNpx in bin/agent-dag.js).
 */
export function parseArgs(args) {
  const out = { unknown: [], incomplete: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // The value of the flag just matched, or `undefined` when there is nothing
    // usable there. Closes over `i` so it can decline to advance it: not
    // consuming is what hands the token back to the loop.
    const value = (expects) => {
      const next = args[i + 1];
      if (next === undefined || looksLikeFlag(next)) {
        out.incomplete.push({ flag: a, expects });
        return undefined;
      }
      i++;
      if (String(next).trim() === "") {
        out.incomplete.push({ flag: a, expects });
        return undefined;
      }
      return next;
    };
    // Assigned only when there is a value, so an unusable one leaves the key
    // absent and the deck on its default — see the doc comment.
    const set = (key, expects) => {
      const v = value(expects);
      if (v !== undefined) out[key] = v;
    };
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-v" || a === "--version") out.version = true;
    else if (a === "-p" || a === "--port") set("port", "a port number");
    else if (a === "--no-open") out.noOpen = true;
    else if (a === "--uninstall") out.uninstall = true;
    else if (a === "--workspace") set("workspace", "a path");
    else if (a === "--scope") out.scope = true;
    else if (a === "--all") out.all = true; // legacy no-op (now default)
    else if (a === "--no-persist") out.noPersist = true;
    else if (a === "--history") set("history", "a path");
    else if (a === "--codex") out.codex = true;
    else if (a === "--no-codex") out.noCodex = true;
    else if (a === "--claude") out.claude = true;
    else if (a === "--no-claude") out.noClaude = true;
    else out.unknown.push(a);
  }
  return out;
}
