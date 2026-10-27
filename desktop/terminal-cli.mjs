// A Windows desktop install and a global npm CLI update independently. Check
// the first command shim on PATH without running it or changing an install.
import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

/** Return the version of the npm shim PowerShell can find, or null if unsure. */
export function windowsNpmCliVersion({ env = process.env, exists = existsSync, read = readFileSync } = {}) {
  // Windows environment names are case-insensitive, but injected maps are not.
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path");
  const folders = typeof env[pathKey] === "string" ? env[pathKey].split(";") : [];
  for (const segment of folders) {
    const folder = segment.trim().replace(/^"(.*)"$/, "$1");
    if (!folder) continue;
    // A different executable earlier on PATH cannot safely be identified as
    // the npm CLI. Stop here rather than report a later, shadowed npm install.
    if (exists(win32.join(folder, "ccdeck.exe"))) return null;
    if (!exists(win32.join(folder, "ccdeck.ps1")) && !exists(win32.join(folder, "ccdeck.cmd"))) continue;
    const manifest = win32.join(folder, "node_modules", "ccdeck", "package.json");
    try {
      const pkg = JSON.parse(read(manifest, "utf8"));
      return pkg?.name === "ccdeck" && typeof pkg.version === "string"
        && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pkg.version) ? pkg.version : null;
    } catch {
      return null;
    }
  }
  return null;
}
