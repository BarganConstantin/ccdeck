// On Windows, spawning a bare name searches the working directory first.
//
// libuv's PATH search calls `NeedCurrentDirectoryForExePathW("")`, which is
// true unless `NoDefaultCurrentDirectoryInExePath` is set in the environment of
// the process doing the spawning. The deck's working directory is wherever
// `npx ccdeck` was run — normally the user's project — so `spawn("cswap", …)`
// tried `.\cswap.exe` before anything on PATH.
//
// That matters here more than it would in most programs: `cswapBin()` probes
// the bare name BEFORE any known install path and memoises whatever answered,
// so the answer receives every later `cswap switch` and `cswap export -` — the
// commands that carry account credentials. `py.exe`, `where.exe`, `claude.exe`
// and `powershell.exe` are reached the same way.
//
// The variable is read by the PARENT, which is why one assignment at import
// covers every child the deck starts, including spawns outside exec.mjs.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../../server/exec.mjs", import.meta.url)), "utf8");

describe("the current directory is out of the executable search", () => {
  it("is turned off at import, on Windows and only there", async () => {
    const before = process.env.NoDefaultCurrentDirectoryInExePath;
    await import("../../server/exec.mjs");
    if (process.platform === "win32") {
      expect(process.env.NoDefaultCurrentDirectoryInExePath).toBe("1");
    } else {
      // POSIX execvp never searches `.` unless PATH says so, so writing the
      // variable there would be noise in every child's environment.
      expect(process.env.NoDefaultCurrentDirectoryInExePath).toBe(before);
    }
  });

  it("leaves an explicit value alone", () => {
    // Somebody who set it meant it, including setting it to the empty string —
    // which is why the guard asks whether the key is present rather than
    // whether it is truthy.
    expect(src).toContain('!("NoDefaultCurrentDirectoryInExePath" in process.env)');
  });

  it("is set on the process rather than per spawn", () => {
    // Per-spawn would have covered this module's own children and missed every
    // spawn elsewhere in the deck — ccusage.mjs builds its own options, and the
    // search is the parent's either way.
    const guard = src.slice(src.indexOf("NoDefaultCurrentDirectoryInExePath"));
    expect(guard).toMatch(/process\.env\.NoDefaultCurrentDirectoryInExePath = "1";/);
    expect(src).not.toMatch(/env:\s*\{[^}]*NoDefaultCurrentDirectoryInExePath/);
  });
});
