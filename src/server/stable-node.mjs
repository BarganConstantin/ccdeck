// The spelling of the running node that outlives an upgrade of the same install.
//
// Two things this deck writes name a node and are read long after it wrote
// them: the Claude Code hook command in settings.json, run on every tool call
// of every session, and the login item, run at every login. Both used
// `process.execPath`, and Node resolves symbolic links in it — on Linux it is
// /proc/self/exe, on macOS the realpath of the executable — so the path written
// is the one an upgrade deletes:
//
//   Homebrew  /opt/homebrew/Cellar/node/24.1.0/bin/node   (`brew upgrade` removes the old keg)
//   tarball   ~/.local/share/node/node-v24.21.0-linux-x64/bin/node   (behind ~/.local/bin/node)
//
// After that `sh -c` exits 127 on all ten hook events, Claude Code shows
// `<Event> hook error` on every tool call and the deck receives nothing — and
// the login item, naming the same binary, cannot start the deck whose next boot
// would have rewritten the entry.
//
// So the path is asked for the way the user reaches node: the first PATH entry
// whose real path IS this binary (/opt/homebrew/bin/node, ~/.local/bin/node,
// nodejs\ under nvm-windows), and failing that Homebrew's own stable link for a
// keg, <prefix>/opt/<formula>/bin/node. Only a spelling that resolves to this
// very file is taken — a different node earlier on PATH is a different
// program, with its own version and its own globals. Nothing found, and the
// running binary is the answer, as it always was: nvm, fnm and Volta have no
// such link, and a machine with nothing better loses nothing.
import { realpathSync } from "node:fs";
import { posix as posixPath, win32 as winPath } from "node:path";

/** Homebrew's keg path, mapped to the link it keeps pointing at the current
 *  keg of the same formula. Both separators, so the rule reads the same on any
 *  leg of the suite; null for anything that is not a keg. */
function brewOptPath(real) {
  const m = /^(.*)([\\/])Cellar\2([^\\/]+)\2[^\\/]+\2bin\2node$/.exec(String(real));
  return m ? [m[1], "opt", m[3], "bin", "node"].join(m[2]) : null;
}

export function stableNodePath({
  execPath = process.execPath,
  env = process.env,
  platform = process.platform,
  realpath = realpathSync,
} = {}) {
  const win = platform === "win32";
  // Windows paths compare without case; everywhere else a byte is a byte.
  const key = (p) => (win ? p.toLowerCase() : p);
  const resolved = (p) => { try { return key(realpath(p)); } catch { return null; } };
  let own;
  try { own = realpath(execPath); } catch { return execPath; }
  const real = key(own);
  const path = win ? winPath : posixPath;
  const pathVar = env?.PATH ?? env?.Path ?? "";
  for (const dir of String(pathVar).split(win ? ";" : ":")) {
    // A relative entry would be resolved by Claude Code against each session's
    // own cwd, and found in one directory and not in the next.
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, win ? "node.exe" : "node");
    // The versioned directory itself on PATH is no more stable than execPath;
    // a link later on PATH may still be.
    if (key(candidate) !== real && resolved(candidate) === real) return candidate;
  }
  // From the path as given when it is a keg itself, so the prefix keeps the
  // spelling it came with (/var rather than /private/var on a Mac).
  const opt = brewOptPath(execPath) ?? brewOptPath(own);
  if (opt && resolved(opt) === real) return opt;
  return execPath;
}
