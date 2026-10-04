// The deck the desktop app starts has to see the variables a terminal deck sees.
//
// An app opened from the Dock, Launchpad, an applications menu or its own
// start-at-login gets the service manager's environment, not the login
// shell's. The app read PATH back out of the login shell and nothing else, so a
// user with `export AGENTS_DECK_NO_REPORTS=1` in ~/.zshrc — the way README's
// environment table says to set it — had an app-hosted deck that sent reports,
// announced itself on the LAN despite AGENTS_DECK_NO_LAN, and installed
// claude-swap despite AGENTS_DECK_NO_INSTALL. With CLAUDE_CONFIG_DIR exported,
// the app's deck put its hook in ~/.claude/settings.json, which Claude Code
// never reads, and the app looked for decks in the registry beside it.
//
// The variables come over BY NAME — README's table — and nothing else does: a
// shell holds tokens and keys the deck has no business inheriting.
import { describe, it, expect, afterAll } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { SHELL_VARS, shellEnv, startDeck, withShellSettings, writeLauncher } from "../../../desktop/deck-host.mjs";
// @ts-expect-error — plain .mjs, no types
import { SCOPE_VARS, SETTING_VARS } from "../../server/login-service.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-shell-env-"));
afterAll(() => rmTempDir(ROOT));

const MAIN = readFileSync(fileURLToPath(new URL("../../../desktop/main.mjs", import.meta.url)), "utf8");

/**
 * A login shell whose profile exports `vars` and prints a greeting, standing in
 * for the user's $SHELL. It runs the app's own command line, in a clean
 * environment, so whatever the developer running the suite has exported cannot
 * leak into the answer.
 */
function loginShell(vars: Record<string, string>): string {
  const dir = mkdtempSync(join(ROOT, "shell-"));
  const file = join(dir, "fake-login-shell");
  const assigns = Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join(" ");
  writeFileSync(file, [
    "#!/bin/sh",
    // $1 is -ilc, $2 the app's command.
    `exec env -i ${assigns} /bin/sh -c 'echo "Welcome back!"; eval "$1"' sh "$2"`,
    "",
  ].join("\n"));
  chmodSync(file, 0o755);
  return file;
}

// The login shell is never asked on Windows, where an app gets the user's own
// persistent environment — the un-gated case below pins that — so this block,
// which runs a real /bin/sh, is registered in skip-gates.mjs.
describe.skipIf(process.platform === "win32")("what the app reads from the login shell", () => {
  const cfg = join(ROOT, "cfg", "claude");
  const profile = {
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    AGENTS_DECK_NO_REPORTS: "1",
    AGENTS_DECK_NO_LAN: "1",
    AGENTS_DECK_NO_INSTALL: "1",
    CLAUDE_CONFIG_DIR: cfg,
    CODEX_HOME: "/Users/u/cfg/codex",
    AWS_SECRET_ACCESS_KEY: "do-not-copy",
    EDITOR: "vim",
  };

  it("is PATH and the documented variables the profile set, and nothing else", () => {
    const shell = shellEnv({ env: { SHELL: loginShell(profile), PATH: "/usr/bin:/bin" }, platform: "darwin" });
    expect(shell).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      AGENTS_DECK_NO_REPORTS: "1",
      AGENTS_DECK_NO_LAN: "1",
      AGENTS_DECK_NO_INSTALL: "1",
      CLAUDE_CONFIG_DIR: cfg,
      CODEX_HOME: "/Users/u/cfg/codex",
    });
  });

  it("reaches the deck the app starts, beside what the app always gives it", async () => {
    const shell = shellEnv({ env: { SHELL: loginShell(profile), PATH: "/usr/bin:/bin" }, platform: "darwin" });
    // launchd's environment for a GUI app: no shell exports at all.
    const env = withShellSettings({ HOME: "/Users/u", PATH: "/usr/bin:/bin" }, shell);

    const deckRoot = mkdtempSync(join(ROOT, "deck-"));
    const out = join(deckRoot, "seen.json");
    mkdirSync(join(deckRoot, "bin"));
    writeFileSync(join(deckRoot, "bin", "agent-dag.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));`);
    // Asserted before anything is written: writeLauncher falls back to the
    // real ~/.claude when the variable is missing.
    expect(env.CLAUDE_CONFIG_DIR, "the shell's CLAUDE_CONFIG_DIR did not reach the app").toBe(cfg);
    const launcher = writeLauncher(process.execPath, { env, platform: process.platform });
    const child = startDeck({ deckRoot, appBinary: process.execPath, logFile: join(deckRoot, "deck.log"), path: shell.PATH, launcher, env });
    await new Promise(done => child.on("exit", done));
    const seen = JSON.parse(readFileSync(out, "utf8"));

    expect(seen.AGENTS_DECK_NO_REPORTS, "the app's deck would send reports").toBe("1");
    expect(seen.AGENTS_DECK_NO_LAN, "the app's deck would announce itself on the LAN").toBe("1");
    expect(seen.AGENTS_DECK_NO_INSTALL).toBe("1");
    expect(seen.CLAUDE_CONFIG_DIR).toBe(cfg);
    expect(seen.CODEX_HOME).toBe("/Users/u/cfg/codex");
    expect(seen).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(seen).not.toHaveProperty("EDITOR");
    // The app's own contract with its deck is untouched.
    expect(seen.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(seen.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(seen.CCDECK_APP).toBe("1");
    expect(seen.AGENTS_DECK_DETACHED).toBe("1");
    expect(seen.CCDECK_HOOK_RUNTIME).toBe(launcher);
    expect(seen.HOME).toBe("/Users/u");
    // And the hook's launcher sits in the Claude directory the shell named,
    // which is the one Claude Code reads.
    expect(launcher).toBe(join(cfg, "agent-dag", "ccdeck-node"));
  });
});

describe("taking the shell's answer", () => {
  it("never takes a name the app did not ask for, whatever a profile prints", () => {
    const run = () => [
      "Last login: today",
      "__CCDECK_ENV__AWS_SECRET_ACCESS_KEY=do-not-copy",
      "__CCDECK_ENV__PATH=/opt/homebrew/bin:/usr/bin",
      "__CCDECK_ENV__AGENTS_DECK_NO_REPORTS=1",
      "__CCDECK_ENV__AGENTS_DECK_NO_LAN=",
      "logout",
    ].join("\n");
    expect(shellEnv({ env: { SHELL: "/bin/zsh", PATH: "/usr/bin" }, platform: "darwin", run }))
      .toEqual({ PATH: "/opt/homebrew/bin:/usr/bin", AGENTS_DECK_NO_REPORTS: "1" });
  });

  it("asks for each variable by its own name, in one shell", () => {
    const asked: string[][] = [];
    shellEnv({ env: { SHELL: "/bin/zsh" }, platform: "darwin", run: (_f: string, args: string[]) => { asked.push(args); return ""; } });
    expect(asked).toHaveLength(1);
    expect(asked[0][0]).toBe("-ilc");
    for (const k of ["PATH", ...SHELL_VARS]) expect(asked[0][1]).toContain(`"${k}=$${k}"`);
  });

  it("keeps a variable the app was started with over the profile's", () => {
    // Started from a terminal, the app already has that terminal's settings,
    // which are the more specific of the two.
    const env = withShellSettings(
      { CLAUDE_CONFIG_DIR: "/from/terminal", AGENTS_DECK_NO_LAN: " " },
      { PATH: "/bin", CLAUDE_CONFIG_DIR: "/from/profile", AGENTS_DECK_NO_LAN: "1", AWS_SECRET_ACCESS_KEY: "x" },
    );
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: "/from/terminal", AGENTS_DECK_NO_LAN: "1" });
  });

  it("is the current PATH and nothing more when the shell cannot be asked", () => {
    const run = () => { throw new Error("timed out"); };
    expect(shellEnv({ env: { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin", AGENTS_DECK_NO_LAN: "1" }, platform: "darwin", run }))
      .toEqual({ PATH: "/usr/bin:/bin" });
  });

  it("does not ask on Windows, where GUI apps get the user's own environment", () => {
    expect(shellEnv({ env: { PATH: "C:\\a" }, platform: "win32", run: () => { throw new Error("not called"); } }))
      .toEqual({ PATH: "C:\\a" });
  });

  it("asks for README's environment table, the same list the login item carries", () => {
    expect([...SHELL_VARS].sort()).toEqual([...SCOPE_VARS, ...SETTING_VARS].sort());
  });
});

describe("the app's own process", () => {
  it("takes the shell's settings before it looks for a deck, and hands its deck the shell's PATH", () => {
    // findDecks reads the registry CLAUDE_CONFIG_DIR names, and writeLauncher
    // writes beside it: both run in the app's process, so the settings go onto
    // that process's environment, before the first look.
    const discover = MAIN.indexOf("async function discover(");
    const firstLook = MAIN.indexOf("await findDecks(", discover);
    const adopt = MAIN.indexOf("fromLoginShell()", discover);
    expect(adopt, "discover no longer reads the login shell first").toBeGreaterThan(discover);
    expect(adopt).toBeLessThan(firstLook);
    expect(MAIN).toMatch(/withShellSettings\(process\.env, loginShell\)/);
    expect(MAIN).toMatch(/path: fromLoginShell\(\)\.PATH,/);
  });
});
