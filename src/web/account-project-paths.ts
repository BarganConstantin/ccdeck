function trimTrailing(path: string): string {
  if (/^[A-Za-z]:[\\/]$/.test(path)) return path;
  return path.replace(/[\\/]+$/, "");
}

function normalizeForCompare(path: string): string {
  const clean = trimTrailing(path).replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(clean) ? clean.toLowerCase() : clean;
}

/**
 * A project's location as the report DISPLAYS it: the home directory folded to
 * `~`, so a row reads `~/work/ccdeck` rather than repeating `/home/<you>/` on
 * every line.
 *
 * It is a shortening for the eye and nothing more. The browser is not told
 * where home is, so the fold is by shape — `/Users/<anyone>`, `/home/<anyone>`,
 * `C:\Users\<anyone>` — and a path under somebody else's home folds too. That
 * is why no caller copies this: Copy puts the absolute path on the clipboard,
 * so a pasted location is always the real one. There used to be a `home`
 * parameter for an exact fold; no caller had a home to pass, so it went.
 */
export function homeRelativePath(path: string): string {
  if (!path) return path;
  const cleanPath = trimTrailing(path);

  const unix = cleanPath.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  if (unix) return `~${unix[1] ?? ""}`;

  const win = cleanPath.replace(/\\/g, "/").match(/^[A-Za-z]:\/Users\/[^/]+(\/.*)?$/i);
  if (win) return `~${win[1] ?? ""}`;

  return cleanPath.replace(/\\/g, "/");
}

export function projectParentLabel(path: string, projects: Array<{ path: string; label: string }>): string | undefined {
  const target = normalizeForCompare(path);
  let best: { path: string; label: string } | undefined;
  for (const candidate of projects) {
    const parent = normalizeForCompare(candidate.path);
    if (!parent || parent === target || !target.startsWith(`${parent}/`)) continue;
    if (!best || normalizeForCompare(best.path).length < parent.length) best = candidate;
  }
  return best?.label;
}
