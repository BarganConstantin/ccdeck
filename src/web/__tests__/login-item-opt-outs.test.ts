// The login item has to carry the opt-outs of the shell that installed it.
//
// A login item runs in the environment launchd or systemd --user builds, not
// the shell's. The scope directories were carried into the job for that reason
// (scopeEnv, #1777) and nothing else was, so `AGENTS_DECK_NO_REPORTS=1 ccdeck`
// — or the same variable exported in ~/.zshrc — installed an item on the first
// start whose deck, at the next login, ran with no veto: a fresh install event
// with the device fingerprint, then a daily "active", and with
// AGENTS_DECK_NO_LAN lost the same way, the beacon on the local network. A
// terminal that exported the variable afterwards then attached to that deck
// rather than starting its own. README says the variable "keeps them off from
// the first start".
//
// NOTHING HERE REGISTERS A LOGIN ITEM: installService is handed an `fs` that
// records what it would write and a `run` that records the service-manager
// command instead of executing it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error — plain .mjs module, no types
const { installService, SCOPE_VARS, SETTING_VARS } = await import("../../server/login-service.mjs");

const README = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");

/** What installService would write on `platform` for a shell with `env`, with nothing done. */
function jobBody(platform: "darwin" | "linux", env: Record<string, string>) {
  const home = platform === "darwin" ? "/Users/u" : "/home/u";
  let body = "";
  const calls: string[] = [];
  const out = installService({
    platform, home,
    env: { HOME: home, PATH: "/usr/bin:/bin", ...env },
    execPath: "/usr/bin/node", script: "/s/agent-dag.js", logPath: `${home}/logs/deck.log`,
    systemd: () => true,
    fs: { mkdirSync() {}, writeFileSync: (_p: string, b: string) => { body = String(b); } },
    run: (file: string) => { calls.push(file); return { status: 0 }; },
  });
  expect(out.ok).toBe(true);
  expect(calls).toHaveLength(1); // recorded, never run
  return body;
}

/** Every variable the job sets, read back out of the plist or the unit. */
function jobVars(platform: "darwin" | "linux", body: string): Record<string, string> {
  if (platform === "darwin") {
    const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(body)?.[1] ?? "";
    return Object.fromEntries([...dict.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)].map(m => [m[1], m[2]]));
  }
  return Object.fromEntries([...body.matchAll(/^Environment="([^=]+)=(.*)"$/gm)].map(m => [m[1], m[2]]));
}

const SHELL = {
  AGENTS_DECK_NO_REPORTS: "1",
  AGENTS_DECK_NO_LAN: "1",
  AGENTS_DECK_NO_NOTIFY: "1",
  AGENTS_DECK_CLAUDE: "/opt/tools/claude",
  CLAUDE_CONFIG_DIR: "/home/u/.claude-work",
  // What a shell holds and a login item has no business inheriting.
  AWS_SECRET_ACCESS_KEY: "do-not-copy",
  EDITOR: "vim",
};

describe("the login item a deck installs", () => {
  for (const platform of ["darwin", "linux"] as const) {
    it(`keeps the installing shell's opt-outs, on ${platform}`, () => {
      const vars = jobVars(platform, jobBody(platform, SHELL));
      expect(vars.AGENTS_DECK_NO_REPORTS, "the deck at login would send reports").toBe("1");
      expect(vars.AGENTS_DECK_NO_LAN, "the deck at login would announce itself on the LAN").toBe("1");
      expect(vars.AGENTS_DECK_NO_NOTIFY).toBe("1");
      expect(vars.AGENTS_DECK_CLAUDE).toBe("/opt/tools/claude");
      // Beside what was carried already, not instead of it.
      expect(vars.CLAUDE_CONFIG_DIR).toBe("/home/u/.claude-work");
      expect(vars.AGENTS_DECK_DETACHED).toBe("1");
    });

    it(`takes the documented variables by name and nothing else, on ${platform}`, () => {
      const vars = jobVars(platform, jobBody(platform, { ...SHELL, AGENTS_DECK_NO_STATUS: "", AGENTS_DECK_NO_FRESHEN: "  " }));
      expect(vars).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
      expect(vars).not.toHaveProperty("EDITOR");
      // An unset variable written as "" would be a different setting, not the
      // same absent one.
      expect(vars).not.toHaveProperty("AGENTS_DECK_NO_STATUS");
      expect(vars).not.toHaveProperty("AGENTS_DECK_NO_FRESHEN");
    });
  }

  it("carries every variable README's environment table documents", () => {
    // The table is the promise, and a variable added to it later without being
    // added here would be lost at login exactly as these were.
    const table = README.slice(README.indexOf("\nEnvironment:\n"));
    const rows = table.slice(0, table.indexOf("\n\n", table.indexOf("|---|")));
    const documented = [...rows.matchAll(/^\| `([A-Z_]+)(?:=1)?` \|/gm)].map(m => m[1]);
    expect(documented.length).toBeGreaterThan(10);
    expect([...SCOPE_VARS, ...SETTING_VARS].sort()).toEqual([...documented].sort());
  });
});
