function trimTrailing(path: string): string {
  if (/^[A-Za-z]:[\\/]$/.test(path)) return path;
  return path.replace(/[\\/]+$/, "");
}

function normalizeForCompare(path: string): string {
  const clean = trimTrailing(path).replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(clean) ? clean.toLowerCase() : clean;
}

export function homeRelativePath(path: string, home?: string): string {
  if (!path) return path;
  const cleanPath = trimTrailing(path);
  const cleanHome = home ? trimTrailing(home) : "";
  if (cleanHome) {
    const pathCmp = normalizeForCompare(cleanPath);
    const homeCmp = normalizeForCompare(cleanHome);
    if (pathCmp === homeCmp) return "~";
    if (pathCmp.startsWith(`${homeCmp}/`)) {
      const rest = cleanPath.replace(/\\/g, "/").slice(cleanHome.replace(/\\/g, "/").length);
      return `~${rest}`;
    }
  }

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
