// #570. The account-admin flow resolved the `claude` CLI by bare name only:
//
//     async function claudeBin() {
//       return process.env.AGENTS_DECK_CLAUDE ?? "claude";
//     }
//
// That was the whole of it, and it feeds every child the accounts panel starts —
// `claude auth status --json` behind `currentIdentity`, and the `claude auth
// login` whose output the sign-in dialog reads a link out of. So on the machine
// #553 names out loud, the one whose `claude` the official installer put at
// `~/.local/bin/claude` and whose deck was launched from something that never
// sourced a shell rc (a LaunchAgent, a systemd user unit, pm2, a desktop
// shortcut), signing an account in was simply impossible: the spawn is a
// bare-name ENOENT, the child is dead within milliseconds, the flow reports
// `no_url`, and the dialog says "the claude CLI could not be run: not on PATH.
// Set AGENTS_DECK_CLAUDE to its full path."
//
// That sentence is a genuine remedy, which is why this was the smaller half of
// #553 rather than the same size. It is still a request to spell out a path the
// deck had already found for itself twice over — `hasClaudeInstalled()` stat'ed
// that exact file at boot to decide this was a Claude machine at all, which is
// what turned this panel on, and since #553 the quota panel beside it runs the
// same binary without being told anything.
//
// WHY THE TESTS ARE SHAPED LIKE THIS, and it is the same reason as in
// claude-cli-candidates.test.ts: every case passes `platform` explicitly and
// injects both the PATH string and the existence check, so nothing here reads
// the disk or the environment of the machine running the suite. Gating a case on
// `process.platform` would mean it only ever ran on one of the three CI legs —
// and the POSIX case with a real binary somewhere is precisely the disk on which
// this bug is visible, so it is the one that must run everywhere.
//
// The four properties under test, in the order the resolver applies them:
//
//   1. AGENTS_DECK_CLAUDE wins outright and skips the list entirely. It is
//      documented, it is what the failure message tells people to set, and
//      someone who set it has closed this question already.
//   2. A machine with claude on PATH is unchanged — the bare name, answered
//      without stat'ing a single install directory.
//   3. A machine with nothing on PATH and a real binary at one of the absolute
//      candidates gets that path. This is the bug.
//   4. A machine with neither still gets the bare name, whose ENOENT is what
//      failureText turns into the AGENTS_DECK_CLAUDE sentence.
//
// Plus the Windows branch, whose `claude.exe` and `claude.cmd` are the two
// spellings the word `claude` never has there.
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { adminClaudeBin } from "../../server/cswap-admin.mjs";
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

// A launcher's environment: a PATH with no claude anywhere in it.
const NO_PATH = { PATH: "/usr/bin:/bin" };

describe("choosing which claude the account panel signs somebody in with", () => {
  describe("when AGENTS_DECK_CLAUDE is set, which is the escape hatch this flow documents", () => {
    it("uses it and never looks at the list at all", () => {
      // The failure message this module prints says "Set AGENTS_DECK_CLAUDE to
      // its full path". A user who did that has been through this once; finding
      // a different binary for them afterwards would answer a closed question.
      const chosen = "/opt/wrappers/claude-stable";
      const { exists, asked } = countingDisk(`${HOME_NIX}/.local/bin/claude`, "/usr/local/bin/claude");
      expect(adminClaudeBin("linux", { ...NO_PATH, AGENTS_DECK_CLAUDE: chosen }, HOME_NIX, exists))
        .toBe(chosen);
      expect(asked).toEqual([]);
    });

    it("uses it even when it points at nothing, so the failure names what was asked for", () => {
      // Not stat'ed on purpose. A configured path that is not there has to fail
      // as itself — the ENOENT names the file the user chose, which is the only
      // way they find their own typo. Silently falling through to some other
      // copy would run a binary they did not ask for and call it success.
      const missing = `${HOME_NIX}/typo/claude`;
      expect(adminClaudeBin("darwin", { ...NO_PATH, AGENTS_DECK_CLAUDE: missing }, HOME_NIX, () => false))
        .toBe(missing);
      expect(adminClaudeBin("darwin", { ...NO_PATH, AGENTS_DECK_CLAUDE: missing }, HOME_NIX,
        disk(`${HOME_NIX}/.local/bin/claude`))).toBe(missing);
    });

    it("wins on Windows too, where it is the setting most people reach for", () => {
      // The .cmd shim cmd.exe could not resolve is what sent Windows users to
      // this variable in the first place (#456), so it has to outrank the two
      // install directories the list would otherwise prefer there.
      const chosen = "D:\\tools\\claude\\claude.cmd";
      expect(adminClaudeBin("win32", { Path: "C:\\Windows", AGENTS_DECK_CLAUDE: chosen }, HOME_WIN,
        disk(`${HOME_WIN}\\.local\\bin\\claude.exe`))).toBe(chosen);
    });

    it("reads an empty value as unset rather than as a command name", () => {
      // `?? "claude"` used to hand an empty string straight to spawn, because
      // `??` only catches null and undefined. An exported-but-empty variable is
      // a shell's ordinary way of saying nothing, and it is how cswapBin reads
      // AGENTS_DECK_CSWAP; spawning "" is not a thing to do to somebody.
      expect(adminClaudeBin("linux", { ...NO_PATH, AGENTS_DECK_CLAUDE: "" }, HOME_NIX,
        disk(`${HOME_NIX}/.local/bin/claude`))).toBe(`${HOME_NIX}/.local/bin/claude`);
    });
  });

  describe("when the machine has claude on PATH, which is nearly every machine", () => {
    it("still answers with the bare name, exactly as it did before", () => {
      // Unchanged behaviour, deliberately: spawn's own resolution stays in
      // charge of the PATH case. Answering with the absolute path pathLookup
      // found would let a PATH entry that merely LOOKS like a hit — a directory
      // named `claude` — become the name a sign-in is spawned under.
      expect(adminClaudeBin("linux", { PATH: "/usr/local/bin:/usr/bin" }, HOME_NIX,
        disk("/usr/local/bin/claude"))).toBe("claude");
      expect(adminClaudeBin("darwin", { PATH: "/opt/homebrew/bin:/usr/bin" }, HOME_NIX,
        disk("/opt/homebrew/bin/claude"))).toBe("claude");
    });

    it("pays one stat for the answer, not a walk of every install directory", () => {
      // The common case must not be made to fund the uncommon one. PATH is
      // walked until it hits and the loop is then over, so the three absolute
      // candidates are never reached at all.
      const { exists, asked } = countingDisk("/usr/local/bin/claude");
      expect(adminClaudeBin("linux", { PATH: "/usr/local/bin:/usr/bin:/bin" }, HOME_NIX, exists))
        .toBe("claude");
      expect(asked).toEqual(["/usr/local/bin/claude"]);
      expect(asked).not.toContain(`${HOME_NIX}/.local/bin/claude`);
    });

    it("lets PATH beat a stale copy left in ~/.local/bin", () => {
      // A current claude under nvm and last year's installer copy still sitting
      // in ~/.local/bin. Preferring the absolute candidate would silently change
      // which binary runs `claude auth login` on every machine that has two, and
      // a sign-in is a credential path — not a place to substitute a binary.
      const nvm = `${HOME_NIX}/.nvm/versions/node/v22/bin`;
      const { exists, asked } = countingDisk(`${nvm}/claude`, `${HOME_NIX}/.local/bin/claude`);
      expect(adminClaudeBin("darwin", { PATH: `${nvm}:/usr/bin` }, HOME_NIX, exists)).toBe("claude");
      expect(asked).not.toContain(`${HOME_NIX}/.local/bin/claude`);
    });
  });

  describe("when PATH has nothing but the binary is on disk — the #570 machine", () => {
    it("finds the official installer's binary in ~/.local/bin on macOS", () => {
      const installed = `${HOME_NIX}/.local/bin/claude`;
      expect(adminClaudeBin("darwin", NO_PATH, HOME_NIX, disk(installed))).toBe(installed);
    });

    it("finds the official installer's binary in ~/.local/bin on Linux", () => {
      const installed = `${HOME_NIX}/.local/bin/claude`;
      expect(adminClaudeBin("linux", NO_PATH, HOME_NIX, disk(installed))).toBe(installed);
    });

    it("finds a copy in /usr/local/bin", () => {
      expect(adminClaudeBin("linux", NO_PATH, HOME_NIX, disk("/usr/local/bin/claude")))
        .toBe("/usr/local/bin/claude");
    });

    it("finds Homebrew's copy in /opt/homebrew/bin", () => {
      expect(adminClaudeBin("darwin", NO_PATH, HOME_NIX, disk("/opt/homebrew/bin/claude")))
        .toBe("/opt/homebrew/bin/claude");
    });

    it("actually stats the absolute candidates rather than answering from the environment", () => {
      // The bug stated as the syscall it failed to make. The old resolution
      // never called `exists` even once, so a test could inject any disk it
      // liked and the answer would not move off the bare word.
      const { exists, asked } = countingDisk("/opt/homebrew/bin/claude");
      adminClaudeBin("darwin", NO_PATH, HOME_NIX, exists);
      expect(asked).toContain(`${HOME_NIX}/.local/bin/claude`);
      expect(asked).toContain("/usr/local/bin/claude");
      expect(asked).toContain("/opt/homebrew/bin/claude");
    });

    it("passes a home directory full of shell metacharacters through untouched", () => {
      // Nothing parses this string any more — it goes into an argument vector —
      // and the guarantee is worth restating from a reader that now builds paths
      // out of it and hands one of them to runInteractive.
      const home = "/home/a$(id)`id`b";
      const installed = `${home}/.local/bin/claude`;
      expect(adminClaudeBin("linux", NO_PATH, home, disk(installed))).toBe(installed);
    });
  });

  describe("when there is no claude anywhere this deck knows to look", () => {
    it("hands back the bare name on POSIX, whose ENOENT is what the dialog explains", () => {
      // Not an error and not null: POSIX execvp deserves its turn at a layout no
      // list here knows — mise, volta, a corporate wrapper — and the ENOENT it
      // produces is what failureText turns into "the claude CLI could not be
      // run: not on PATH. Set AGENTS_DECK_CLAUDE to its full path."
      expect(adminClaudeBin("darwin", NO_PATH, HOME_NIX, () => false)).toBe("claude");
      expect(adminClaudeBin("linux", NO_PATH, HOME_NIX, () => false)).toBe("claude");
    });

    it("hands back the bare name on Windows too, for cmd.exe's own PATH search", () => {
      expect(adminClaudeBin("win32", { Path: "C:\\Windows" }, HOME_WIN, () => false)).toBe("claude");
    });

    it("answers the same way when PATH is missing from the environment entirely", () => {
      // A service manager can hand a process an environment with no PATH at all,
      // which is half of how this bug's machine gets made. It must read as
      // "nothing on PATH" and not throw.
      expect(adminClaudeBin("linux", {}, HOME_NIX, () => false)).toBe("claude");
      expect(adminClaudeBin("win32", {}, HOME_WIN, () => false)).toBe("claude");
    });
  });

  describe("the Windows answers, which are the branch that already worked", () => {
    it("names the native installer's claude.exe by its full path", () => {
      // The native installer ships a bare claude.exe and no .cmd shim.
      const exe = `${HOME_WIN}\\.local\\bin\\claude.exe`;
      expect(adminClaudeBin("win32", { Path: "C:\\Windows" }, HOME_WIN, disk(exe))).toBe(exe);
    });

    it("names npm's claude.cmd shim by its full path, which is what #456 turns on", () => {
      // A .cmd resolves `%~dp0` against the token cmd.exe was handed, so a bare
      // `claude.cmd` sends the shim looking for its payload under the deck's
      // working directory. The full path is not a nicety here.
      const shim = `${HOME_WIN}\\AppData\\Roaming\\npm\\claude.cmd`;
      expect(adminClaudeBin("win32", { Path: "C:\\Windows" }, HOME_WIN, disk(shim))).toBe(shim);
      expect(adminClaudeBin("win32", { Path: "C:\\Windows" }, HOME_WIN, disk(shim)))
        .not.toBe("claude.cmd");
    });

    it("follows a roaming profile's APPDATA off onto its network share", () => {
      const roaming = "\\\\server\\profiles\\dorin\\AppData\\Roaming";
      const shim = `${roaming}\\npm\\claude.cmd`;
      expect(adminClaudeBin("win32", { APPDATA: roaming, Path: "C:\\Windows" }, HOME_WIN, disk(shim)))
        .toBe(shim);
    });

    it("keeps the two install directories ahead of PATH, as the list always has", () => {
      const exe = `${HOME_WIN}\\.local\\bin\\claude.exe`;
      expect(adminClaudeBin("win32", { Path: "C:\\tools" }, HOME_WIN, disk(exe, "C:\\tools\\claude.exe")))
        .toBe(exe);
    });

    it("recognises a claude that is only on PATH, spelled the way PATHEXT spells it", () => {
      // `claude` on Windows is `claude.exe` or `claude.cmd` and never the bare
      // word, so a PATH check looking for the bare word would find nothing on
      // nvm-windows, volta, a moved npm prefix or a corporate wrapper. The
      // answer is the bare name either way; what matters is that it is reached
      // because PATH was asked, not because nobody looked.
      expect(adminClaudeBin("win32", { Path: "C:\\tools" }, HOME_WIN, disk("C:\\tools\\claude.cmd")))
        .toBe("claude");
      expect(adminClaudeBin("win32", { Path: "C:\\tools" }, HOME_WIN, disk("C:\\tools\\claude.exe")))
        .toBe("claude");
    });
  });

  describe("the boot question and the sign-in, which must never disagree", () => {
    // The bug in one sentence: hasClaudeInstalled() said yes — which is the only
    // reason this panel is on screen at all — and then the sign-in it enabled
    // could not name the binary that answer had just found. Anywhere the first
    // says the CLI is here, the second has to hand back something other than a
    // bare name PATH cannot resolve.
    const claimsInstalled = (platform: string, env: Record<string, string>, home: string, exists: (p: string) => boolean) =>
      hasClaudeInstalled({ platform, env, home, configDir: `${home}/.claude`, exists });

    it("agrees on every POSIX install directory the list knows", () => {
      for (const installed of [
        `${HOME_NIX}/.local/bin/claude`,
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
      ]) {
        const on = disk(installed);
        expect(claimsInstalled("darwin", NO_PATH, HOME_NIX, on)).toBe(true);
        expect(adminClaudeBin("darwin", NO_PATH, HOME_NIX, on)).toBe(installed);
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
        expect(adminClaudeBin("win32", env, HOME_WIN, on)).toBe(installed);
      }
    });
  });
});
