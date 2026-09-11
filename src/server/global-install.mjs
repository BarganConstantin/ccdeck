// Putting this package on the user's PATH, when they ask for it in words.
//
// `npx ccdeck` runs the deck and leaves nothing behind, which is the whole
// contract of that command and is not something to quietly break: a tool that
// installs itself globally because it decided that was better is the tool people
// uninstall. So this exists behind `--install`, where somebody typed it.
//
// WHAT IT BUYS is the one thing an npx run cannot have. A login item must name a
// path that will still be there tomorrow, and npx runs out of
// ~/.npm/_npx/<hash>/, which npm deletes whenever it likes — so an npx deck can
// run in the background and cannot start at login. A global install is a stable
// path, and the service points at that.
//
// THE NAME IS THE ONE THEY TYPED. Three packages publish this deck — ccdeck,
// agents-deck and agent-dag — and installing `ccdeck` for somebody who ran
// `npx agent-dag` would hand them a command they did not ask for and leave the
// one they did use pointing at a cache directory.
import { posix as posixPath, win32 as winPath } from "node:path";

/** Long enough for a cold registry fetch on a slow line, short enough that a
 *  hung npm does not own the terminal for the afternoon. */
export const INSTALL_TIMEOUT_MS = 180_000;

/**
 * Where `npm i -g` puts a package's own directory.
 *
 * The joiner comes from the TARGET platform, not the host — `node:path`'s is
 * bound to the machine running it, and this repo has gone red on that three
 * times. See the note in deck-home.mjs.
 */
export function globalScript(root, pkg, platform = process.platform) {
  if (typeof root !== "string" || root === "" || typeof pkg !== "string" || pkg === "") return null;
  const { join } = platform === "win32" ? winPath : posixPath;
  return join(root.trim(), pkg, "bin", "agent-dag.js");
}

/**
 * What npm answered, as a path or null.
 *
 * `npm root -g` prints one line and nothing else on success. Anything else —
 * a warning npm decided to print first, an empty answer, a non-zero exit — is
 * not a path, and guessing one would put the login item somewhere nothing lives.
 */
export function readGlobalRoot(out) {
  if (!out?.ok) return null;
  const line = String(out.stdout ?? "").split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
  return line && !line.startsWith("npm ") ? line : null;
}

/**
 * The sentence to show for a failed install.
 *
 * EACCES is the one worth naming, because it is the common one and the remedy
 * is not obvious: a global prefix owned by root needs either sudo or a prefix
 * of the user's own, and "permission denied" alone sends people to sudo when
 * the second is the better answer.
 */
export function installFailure(out, { pkg = "ccdeck" } = {}) {
  const said = `${out?.stderr ?? ""}\n${out?.stdout ?? ""}`;
  if (out?.code === "ENOENT") return "npm is not on PATH, so there is nothing to install with";
  if (out?.timedOut) return "npm took too long — the registry may be unreachable";
  if (/EACCES|permission denied/i.test(said)) {
    return `npm cannot write to the global prefix. Either \`sudo npm i -g ${pkg}\`, or point npm at a prefix you own (\`npm config set prefix ~/.npm-global\`) and add its \`bin\` to PATH`;
  }
  const first = said.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
  return first || `npm exited ${out?.status ?? "non-zero"}`;
}
