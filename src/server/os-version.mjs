// Which release of its operating system a machine runs, read off the kernel
// version Node reports.
//
// Node says `darwin 25.5.0` and `win32 10.0.26100`, and nobody calls their
// laptop Darwin 25. The translation is shared by the two places that say it:
// a paired deck's card (lan-about.mjs), which words it for a person ("macOS
// 26.5", "Windows 11"), and the usage reports (reports.mjs), which send it as a
// short token ("macos-26", "windows-11"). Pure: every input is a parameter, so
// all three platforms are tested on any one of them, and nothing here reads the
// machine or throws.

/**
 * The OS release a kernel version stands for, as `{ family, major, minor }`, or
 * null when it cannot be told: `{ family: "macos", major: 26, minor: 5 }` for
 * darwin 25.5.0, `{ family: "windows", major: 11, minor: null }` for win32
 * 10.0.26100. `minor` is null when the release does not say one. Only macOS and
 * Windows: a Linux kernel's version says nothing about the distribution on it.
 */
export function osVersionOf({ platform, release = "" } = {}) {
  const [major, minor, build] = String(release).split(".").map(n => Number.parseInt(n, 10));
  if (platform === "darwin") {
    if (!Number.isInteger(major)) return null;
    const dot = Number.isInteger(minor) ? minor : null;
    // Darwin 20 was macOS 11 and every major after it was one more — until 25,
    // which Apple shipped as macOS 26 to match the year.
    if (major >= 25) return { family: "macos", major: major + 1, minor: dot };
    if (major >= 20) return { family: "macos", major: major - 9, minor: dot };
    // The 10.x years, where the kernel's major minus four is the second number.
    return major >= 5 ? { family: "macos", major: 10, minor: major - 4 } : null;
  }
  if (platform === "win32") {
    // Windows 11 kept the version 10.0 and moved only the build, and 22000 is
    // the first one. From here it is the only way to tell the two apart.
    if (major === 10 && Number.isInteger(build)) return { family: "windows", major: build >= 22_000 ? 11 : 10, minor: null };
    return null;
  }
  return null;
}

/**
 * The fields of an os-release file (os-release(5)): `KEY=value` lines, the
 * value bare or in single or double quotes, a double-quoted one with its
 * backslash escapes undone. Comments, blank lines and anything else are
 * skipped. Never throws.
 */
export function osReleaseFields(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[1] === '"' ? quoted[2].replace(/\\([\\"$`])/g, "$1") : quoted[2];
    out[m[1]] = value;
  }
  return out;
}
