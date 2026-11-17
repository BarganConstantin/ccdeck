// A file or folder path as a narrow place shows it.
//
// Inside the session's folder it reads from there ("src/web/app.ts"); under a
// home folder it starts at "~"; anything else is printed as it is. Cut short at
// its end, every row under one long folder read the same and the file's name,
// the part that tells them apart, was the part that went. So the cut is in the
// middle: components/PathText.tsx draws the head and the last segment as two
// spans, and only the head gives way. The whole path stays in the hover.
//
// The home fold is by shape, as account-project-paths.ts explains: the browser
// is not told where home is. A Windows path keeps its backslashes, and its
// drive and case are compared the way Windows compares them.

/** A drive letter or a UNC share: a path whose case does not matter and whose
 *  separator may be either slash. */
const WINDOWS = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** The home folders, by shape: /home/<you>, /Users/<you>, /root, C:\Users\<you>. */
const HOMES = [/^\/(?:home|Users)\/[^\\/]+/, /^\/root/, /^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i];

/** The path with "/" for every separator, in lower case where the file system
 *  ignores it. Always as long as the path, so an index into one is an index
 *  into the other: a letter whose lower case is longer is kept as it is. */
function comparable(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  if (!WINDOWS.test(path)) return slashed;
  return Array.from(slashed, ch => { const low = ch.toLowerCase(); return low.length === ch.length ? low : ch; }).join("");
}

/** What follows `folder` in `path`, or null when the path is not inside it. A
 *  root ("/", "C:\") holds every path, and read from there a path says less. */
export function insideFolder(path: string, folder: string): string | null {
  const base = comparable(folder).replace(/\/+$/, "");
  if (!base || /^[a-z]:$/i.test(base)) return null;
  const whole = comparable(path);
  if (!whole.startsWith(base) || whole.charAt(base.length) !== "/") return null;
  const rest = path.slice(base.length).replace(/^[\\/]+/, "");
  return rest || null;
}

/** The path with the home folder at its start written "~", or null when it starts in none. */
export function homeFolded(path: string): string | null {
  for (const home of HOMES) {
    const m = home.exec(path);
    if (m && (path.length === m[0].length || /[\\/]/.test(path.charAt(m[0].length)))) return `~${path.slice(m[0].length)}`;
  }
  return null;
}

/** The path as a narrow place prints it: relative to `cwd` when it is inside,
 *  else from "~" when it is under a home folder, else as it is. */
export function displayPath(path: string, cwd?: string): string {
  return (cwd ? insideFolder(path, cwd) : null) ?? homeFolded(path) ?? path;
}

/** The printed path as its two spans: the head, which may be cut, and the last
 *  segment with the separator before it, which is kept. A trailing separator
 *  belongs to the last segment ("src/web/" ends in "/web/"); a path of one
 *  segment is all tail. `keep` keeps more than one, for a list whose files all
 *  share one name, where the folder above it is what tells them apart. */
export function splitPath(shown: string, keep = 1): { head: string; tail: string } {
  let cut = shown.replace(/[\\/]+$/, "").length;
  for (let n = 0; n < keep && cut > 0; n++) {
    cut = Math.max(shown.lastIndexOf("/", cut - 1), shown.lastIndexOf("\\", cut - 1));
  }
  if (cut <= 0) return { head: "", tail: shown };
  return { head: shown.slice(0, cut), tail: shown.slice(cut) };
}
