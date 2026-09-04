// A path with an apostrophe made the retirement delete notify.mjs.
//
// The entries this module recognises were written by `shellQuoteArg`, whose
// POSIX branch single-quotes the argument and rewrites every `'` as `'\''`. The
// matcher compared the RAW absolute path against that quoted command, so on a
// config dir like `/mnt/Bob's SSD/claude` it was false — on macOS and Linux,
// for an ordinary directory name.
//
// What followed was not recoverable by the user. A mark-less `Stop` entry — the
// case this module exists for — was not recognised as ours and was kept; and
// `anythingStillNamesOurScripts`, which has no mark to fall back on, said no
// too, so the sweep deleted `notify.mjs`. Claude Code then throws
// `Cannot find module` at the end of every turn, forever, on a machine where
// the deck has already been uninstalled.
//
// Windows had the other half: a case-sensitive comparison against a
// case-insensitive filesystem. `exec.mjs`'s own `sameCommand` lowercases
// "because Windows paths are"; this one did not.
import { describe, it, expect } from "vitest";

// @ts-expect-error — .mjs server module, no types
const { namesOurScript } = await import("../../server/retire-sound-hook.mjs");

describe("recognising a command that runs our notify script", () => {
  it("sees through POSIX shell quoting of an apostrophe", () => {
    // Exactly what shellQuoteArg produces for /mnt/Bob's SSD/claude.
    const cmd = "node '/mnt/Bob'\\''s SSD/claude/agent-dag/notify.mjs'";
    expect(cmd).toContain("'\\''");           // the fixture really is quoted
    expect(namesOurScript(cmd, "linux")).toBe(true);
  });

  it("sees a quoted path with spaces, which is the common case", () => {
    expect(namesOurScript("node '/Users/Jane Doe/.claude/agent-dag/notify.mjs'", "darwin")).toBe(true);
    expect(namesOurScript('node "C:\\Users\\Jane Doe\\.claude\\agent-dag\\notify.mjs"', "win32")).toBe(true);
  });

  it("folds case where the filesystem folds it", () => {
    expect(namesOurScript(String.raw`node "C:\Users\CB\.CLAUDE\Agent-Dag\Notify.MJS"`, "win32")).toBe(true);
    expect(namesOurScript("node /Users/X/.Claude/Agent-Dag/Notify.mjs", "darwin")).toBe(true);
    // And not on Linux, where two files really can differ only in case.
    expect(namesOurScript("node /home/x/.claude/Agent-Dag/notify.mjs", "linux")).toBe(false);
  });

  it("accepts both separators on Windows and neither invention on POSIX", () => {
    expect(namesOurScript("node C:/Users/cb/.claude/agent-dag/notify.mjs", "win32")).toBe(true);
    // A backslash is an ordinary filename character on POSIX, so rewriting it
    // there would invent a match the filesystem does not have.
    expect(namesOurScript(String.raw`node /home/x/weird\agent-dag\notify.mjs`, "linux")).toBe(false);
  });

  it("still knows the legacy .js spelling", () => {
    // #577's predecessor. A machine that never upgraded past it is exactly the
    // kind of machine retirement runs on.
    expect(namesOurScript("node /home/x/.claude/agent-dag/notify.js", "linux")).toBe(true);
  });

  it("does not claim somebody else's hook", () => {
    for (const cmd of [
      "afplay /System/Library/Sounds/Glass.aiff",
      "node /home/x/.claude/hooks/notify.mjs",
      "node /home/x/.claude/agent-dag-other/notify.mjs",
      "powershell -c [console]::beep(800,200)",
      "", "   ",
    ]) expect(namesOurScript(cmd, "linux"), cmd).toBe(false);
  });

  it("survives a command that is not a string at all", () => {
    for (const junk of [undefined, null, 42, {}, []]) {
      expect(namesOurScript(junk as never, "linux")).toBe(false);
    }
  });
});
