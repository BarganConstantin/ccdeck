// #553. `claudeCliCandidates` in claude-dir.mjs is one list of every place the
// `claude` CLI is known to live, and it has two readers. `claudeCliOnDisk`,
// behind `hasClaudeInstalled()`, reads it properly: a full path gets a stat, a
// bare name gets a PATH walk. `quotaClaudeBin` in quota.mjs read it with
//
//     .find(c => !c.includes(sep) || exists(c)) ?? "claude"
//
// which says "a bare name always answers, a full path only when it is there".
// On Windows that is harmless, because the bare name is LAST in the list. On
// POSIX the bare name is FIRST, so `||` short-circuited on candidate one and
// `exists` was never called even once — `~/.local/bin/claude`,
// `/usr/local/bin/claude` and `/opt/homebrew/bin/claude` sat in a list that
// nothing on macOS or Linux ever read.
//
// The user this broke is the one claude-dir.mjs names out loud. Claude Code
// installed with the official installer puts the binary at `~/.local/bin/claude`
// and adds that directory to PATH from a shell rc. Start the deck from anything
// that never sourced one — a LaunchAgent, a systemd user unit, pm2, a desktop
// shortcut — and PATH has no claude in it while the disk plainly does.
// `hasClaudeInstalled()` stats the absolute path, says yes, installs the hooks
// and turns the whole Claude surface on; then every `claude --print /usage`
// spawn is a bare-name ENOENT, logged once a poll as `quota: claude CLI failed`.
// On macOS there is no `.credentials.json` to fall back to — the OAuth token
// lives in the Keychain (#360) — so source 2 is unavailable by design and the
// quota panel just stays dark forever on a machine that has Claude Code. The
// identical install on Windows worked the whole time.
//
// So the two readers of one list have to agree, and that is what the last
// describe here pins directly: there must be no injected disk on which the deck
// says "Claude Code is installed" and then cannot name a binary to run.
//
// WHY THE ORDER IS WHAT IT IS. The list's own order still decides, unchanged on
// both platforms, because getRunner in ccusage.mjs already argued this exact
// question: preferring a different copy silently changes which binary runs on
// every machine that has two, and a deck that works today must not start
// running a `claude` it has never run. Someone with a current claude on PATH
// from nvm/mise/volta and a stale one left in `~/.local/bin` keeps getting the
// one their own shell gives them. All that changed is that the bare name is now
// only answered with when PATH actually holds it.
//
// WHY THE TESTS ARE SHAPED LIKE THIS. Every case passes `platform` explicitly
// and injects both the PATH string and the existence check, so nothing here
// reads the disk or the environment of the machine running the suite. That is
// not tidiness: the previous round of tests asserted "the file is there but PATH
// does not have it" for `win32` only, and gave the POSIX branch an `exists` that
// answered false to everything — which is the one disk on which the bug is
// invisible. A POSIX case with a real binary somewhere is the whole point, and
// it has to run on all three CI legs.
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { quotaClaudeBin } from "../../server/quota.mjs";
// @ts-expect-error — .mjs server module, no types
import { hasClaudeInstalled } from "../../server/claude-dir.mjs";

const HOME_NIX = "/home/dorin";
const HOME_WIN = "C:\\Users\\dorin";

/** A disk on which exactly these paths exist and nothing else does. */
const disk = (...files: string[]) => (p: string) => files.includes(String(p));

/** A disk that also records every path it was asked about, so a test can say
 *  what the lookup did and not merely what it answered. */
function countingDisk(...files: string[]) {
  const asked: string[] = [];
  const exists = (p: string) => { asked.push(String(p)); return files.includes(String(p)); };
  return { exists, asked };
}

describe("choosing which claude to run for the quota poll", () => {
  describe("when the machine has claude on PATH, which is nearly every machine", () => {
    it("still answers with the bare name, exactly as it did before", () => {
      // Unchanged behaviour, and deliberately so: spawn's own resolution stays
      // in charge of the PATH case. Answering with the absolute path pathLookup
      // found would let a PATH entry that merely LOOKS like a hit — a directory
      // named `claude` — become the answer, which a real execvp would step over.
      expect(quotaClaudeBin("linux", { PATH: "/usr/local/bin:/usr/bin" }, HOME_NIX,
        disk("/usr/local/bin/claude"))).toBe("claude");
      expect(quotaClaudeBin("darwin", { PATH: "/opt/homebrew/bin:/usr/bin" }, HOME_NIX,
        disk("/opt/homebrew/bin/claude"))).toBe("claude");
    });

    it("pays one stat for the answer, not a walk of every install directory", () => {
      // The common case must not be made to fund the uncommon one. PATH is
      // walked until it hits and then the loop is over, so the three absolute
      // candidates are never reached at all.
      const { exists, asked } = countingDisk("/usr/local/bin/claude");
      expect(quotaClaudeBin("linux", { PATH: "/usr/local/bin:/usr/bin:/bin" }, HOME_NIX, exists))
        .toBe("claude");
      expect(asked).toEqual(["/usr/local/bin/claude"]);
      expect(asked).not.toContain(`${HOME_NIX}/.local/bin/claude`);
    });

    it("lets PATH beat a stale copy left in ~/.local/bin, the way ccusage's runner order does", () => {
      // A current claude under nvm and last year's installer copy still sitting
      // in ~/.local/bin. Preferring the absolute candidate would silently change
      // which binary a working deck runs, which is precisely what getRunner in
      // ccusage.mjs refuses to do to somebody.
      const nvm = `${HOME_NIX}/.nvm/versions/node/v22/bin`;
      const { exists, asked } = countingDisk(`${nvm}/claude`, `${HOME_NIX}/.local/bin/claude`);
      expect(quotaClaudeBin("darwin", { PATH: `${nvm}:/usr/bin` }, HOME_NIX, exists)).toBe("claude");
      expect(asked).not.toContain(`${HOME_NIX}/.local/bin/claude`);
    });
  });

  describe("when PATH has nothing but the binary is on disk — the #553 machine", () => {
    // A LaunchAgent, a systemd user unit, pm2 or a desktop shortcut: a launcher
    // whose PATH never sourced the user's shell rc. Before the fix every one of
    // these answered the bare name and the spawn was an ENOENT.
    const NO_PATH = { PATH: "/usr/bin:/bin" };

    it("finds the official installer's binary in ~/.local/bin on macOS", () => {
      const installed = `${HOME_NIX}/.local/bin/claude`;
      expect(quotaClaudeBin("darwin", NO_PATH, HOME_NIX, disk(installed))).toBe(installed);
    });

    it("finds the official installer's binary in ~/.local/bin on Linux", () => {
      const installed = `${HOME_NIX}/.local/bin/claude`;
      expect(quotaClaudeBin("linux", NO_PATH, HOME_NIX, disk(installed))).toBe(installed);
    });

    it("finds a copy in /usr/local/bin", () => {
      expect(quotaClaudeBin("linux", NO_PATH, HOME_NIX, disk("/usr/local/bin/claude")))
        .toBe("/usr/local/bin/claude");
    });

    it("finds Homebrew's copy in /opt/homebrew/bin", () => {
      expect(quotaClaudeBin("darwin", NO_PATH, HOME_NIX, disk("/opt/homebrew/bin/claude")))
        .toBe("/opt/homebrew/bin/claude");
    });

    it("actually stats the absolute candidates rather than short-circuiting past them", () => {
      // The bug stated as the syscall it failed to make. `exists` used never to
      // be called once on POSIX, so a test could inject any disk it liked and
      // the answer would not move.
      const { exists, asked } = countingDisk("/opt/homebrew/bin/claude");
      quotaClaudeBin("darwin", NO_PATH, HOME_NIX, exists);
      expect(asked).toContain(`${HOME_NIX}/.local/bin/claude`);
      expect(asked).toContain("/usr/local/bin/claude");
      expect(asked).toContain("/opt/homebrew/bin/claude");
    });
  });

  describe("when there is no claude anywhere this deck knows to look", () => {
    it("hands back the bare name on POSIX, whose ENOENT is what the log reports", () => {
      // Not an error and not null: POSIX execvp deserves its turn at a layout no
      // list here knows — mise, volta, a corporate wrapper. What comes back is
      // the name that was looked for, and `quota: claude CLI failed` in
      // quota.mjs is the sentence the operator sees when it is not there.
      expect(quotaClaudeBin("darwin", { PATH: "/usr/bin:/bin" }, HOME_NIX, () => false)).toBe("claude");
      expect(quotaClaudeBin("linux", { PATH: "/usr/bin:/bin" }, HOME_NIX, () => false)).toBe("claude");
    });

    it("hands back the bare name on Windows too, for cmd.exe's own PATH search", () => {
      expect(quotaClaudeBin("win32", { Path: "C:\\Windows" }, HOME_WIN, () => false)).toBe("claude");
    });

    it("answers the same way when PATH is missing from the environment entirely", () => {
      // A service manager can hand a process an environment with no PATH at all.
      // pathLookup must read that as "nothing on PATH" and not throw.
      expect(quotaClaudeBin("linux", {}, HOME_NIX, () => false)).toBe("claude");
      expect(quotaClaudeBin("win32", {}, HOME_WIN, () => false)).toBe("claude");
    });
  });

  describe("the Windows answers, which must be exactly what they already were", () => {
    it("names the native installer's claude.exe by its full path", () => {
      // The native installer ships a bare claude.exe and no .cmd shim, and this
      // is the branch that has always worked. It must not move.
      const exe = `${HOME_WIN}\\.local\\bin\\claude.exe`;
      expect(quotaClaudeBin("win32", { Path: "C:\\Windows" }, HOME_WIN, disk(exe))).toBe(exe);
    });

    it("names npm's claude.cmd shim by its full path, which is what #456 turns on", () => {
      // A .cmd resolves `%~dp0` against the token cmd.exe was handed, so a bare
      // `claude.cmd` sends the shim looking for its payload under the deck's
      // working directory. The full path is not a nicety here.
      const shim = `${HOME_WIN}\\AppData\\Roaming\\npm\\claude.cmd`;
      expect(quotaClaudeBin("win32", { Path: "C:\\Windows" }, HOME_WIN, disk(shim))).toBe(shim);
      expect(quotaClaudeBin("win32", { Path: "C:\\Windows" }, HOME_WIN, disk(shim)))
        .not.toBe("claude.cmd");
    });

    it("follows a roaming profile's APPDATA off onto its network share", () => {
      const roaming = "\\\\server\\profiles\\dorin\\AppData\\Roaming";
      const shim = `${roaming}\\npm\\claude.cmd`;
      expect(quotaClaudeBin("win32", { APPDATA: roaming, Path: "C:\\Windows" }, HOME_WIN, disk(shim)))
        .toBe(shim);
    });

    it("keeps the two install directories ahead of PATH, as it always has", () => {
      // The Windows ordering is the half of this list that was already right,
      // and reordering it would be the same silent substitution the POSIX side
      // is careful not to make — in the other direction.
      const exe = `${HOME_WIN}\\.local\\bin\\claude.exe`;
      expect(quotaClaudeBin("win32", { Path: "C:\\tools" }, HOME_WIN, disk(exe, "C:\\tools\\claude.exe")))
        .toBe(exe);
    });

    it("recognises a claude that is only on PATH, spelled the way PATHEXT spells it", () => {
      // `claude` on Windows is `claude.exe` or `claude.cmd` and never the bare
      // word, so a PATH check that looked for the bare word would find nothing
      // on nvm-windows, volta, a moved npm prefix or a corporate wrapper — and
      // the bare name would then be reached as a last resort anyway. The answer
      // is the same either way; what matters is that it is reached deliberately.
      expect(quotaClaudeBin("win32", { Path: "C:\\tools" }, HOME_WIN, disk("C:\\tools\\claude.cmd")))
        .toBe("claude");
      expect(quotaClaudeBin("win32", { Path: "C:\\tools" }, HOME_WIN, disk("C:\\tools\\claude.exe")))
        .toBe("claude");
    });

    it("passes a home directory full of shell metacharacters through untouched", () => {
      // Nothing parses this string any more — it goes into an argument vector —
      // and the guarantee is worth restating from the reader that now walks it.
      const home = "C:\\Users\\a$(id)`id`b";
      const exe = `${home}\\.local\\bin\\claude.exe`;
      expect(quotaClaudeBin("win32", {}, home, disk(exe))).toBe(exe);
    });
  });

  describe("the two readers of the candidate list, which must never disagree", () => {
    // The bug in one sentence: hasClaudeInstalled() said yes and quotaClaudeBin
    // could not name the binary it had just found. Anywhere the first says the
    // CLI is here, the second has to hand back something other than a bare name
    // that PATH cannot resolve.
    const claimsInstalled = (platform: string, env: Record<string, string>, home: string, exists: (p: string) => boolean) =>
      hasClaudeInstalled({ platform, env, home, configDir: `${home}/.claude`, exists });

    it("agrees on every POSIX install directory the list knows", () => {
      const env = { PATH: "/usr/bin:/bin" };
      for (const installed of [
        `${HOME_NIX}/.local/bin/claude`,
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
      ]) {
        const on = disk(installed);
        expect(claimsInstalled("darwin", env, HOME_NIX, on)).toBe(true);
        expect(quotaClaudeBin("darwin", env, HOME_NIX, on)).toBe(installed);
      }
    });

    it("agrees on the Windows install directories too", () => {
      const env = { Path: "C:\\Windows" };
      for (const installed of [
        `${HOME_WIN}\\.local\\bin\\claude.exe`,
        `${HOME_WIN}\\AppData\\Roaming\\npm\\claude.cmd`,
      ]) {
        const on = disk(installed);
        expect(claimsInstalled("win32", env, HOME_WIN, on)).toBe(true);
        expect(quotaClaudeBin("win32", env, HOME_WIN, on)).toBe(installed);
      }
    });
  });
});
