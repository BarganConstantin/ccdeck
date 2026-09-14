// One machine showed up twice on a colleague's Local network list: same name,
// same address, two fingerprints. Two decks on one computer share a key, and
// they tell a copied ~/.claude on ANOTHER computer from a twin on this one by a
// machine id hashed from the hostname — which macOS reports as
// `Petrus-MacBook-Pro.local` at one moment and `Petrus-MacBook-Pro` at another.
// Two decks started either side of that change read each other as an id-clash,
// and one took a new key.
//
// And the second half of how two decks came to run at all: a login item runs in
// the service manager's environment, not the shell's, so a user who exports
// CLAUDE_CONFIG_DIR got one deck per registry — one from the terminal and one at
// login, neither able to see the other.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error — .mjs server module, no types
const lan = await import("../../server/lan-sync.mjs");
const { hostId, machineName } = lan as {
  hostId: (o?: { hostname?: string; home?: string }) => string;
  machineName: (hostname: string) => string;
};
// @ts-expect-error — .mjs server module, no types
const svc = await import("../../server/login-service.mjs");
const { scopeEnv, plistFor, unitFor, SCOPE_VARS } = svc as {
  scopeEnv: (env: Record<string, string | undefined>) => Record<string, string>;
  plistFor: (o: Record<string, unknown>) => string;
  unitFor: (o: Record<string, unknown>) => string;
  SCOPE_VARS: readonly string[];
};

const DECK = readFileSync(fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");

describe("one machine keeps one machine id", () => {
  it("does not care whether the hostname came with a network on the end", () => {
    const home = "/Users/petru";
    const id = hostId({ hostname: "Petrus-MacBook-Pro", home });
    for (const hostname of ["Petrus-MacBook-Pro.local", "petrus-macbook-pro", "Petrus-MacBook-Pro.lan", "Petrus-MacBook-Pro.fritz.box", "Petrus-MacBook-Pro."]) {
      expect(hostId({ hostname, home }), hostname).toBe(id);
    }
    expect(machineName("Petrus-MacBook-Pro.local")).toBe("petrus-macbook-pro");
  });

  it("still tells two machines apart, and two users on one machine", () => {
    expect(hostId({ hostname: "iMac.local", home: "/Users/c" })).not.toBe(hostId({ hostname: "MacBook.local", home: "/Users/c" }));
    expect(hostId({ hostname: "iMac", home: "/Users/c" })).not.toBe(hostId({ hostname: "iMac", home: "/Users/d" }));
  });

  it("keeps an address used as a hostname whole, rather than its first octet", () => {
    expect(machineName("192.168.1.153")).toBe("192.168.1.153");
    expect(hostId({ hostname: "192.168.1.153", home: "/h" })).not.toBe(hostId({ hostname: "192.168.1.154", home: "/h" }));
  });
});

describe("the deck started at login is the deck started from the shell", () => {
  it("carries exactly the directories that decide which deck this is, when set", () => {
    expect([...SCOPE_VARS].sort()).toEqual(["CCDECK_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]);
    expect(scopeEnv({ CLAUDE_CONFIG_DIR: "/c", CCDECK_HOME: "", CODEX_HOME: "  ", PATH: "/bin", HOME: "/h" }))
      .toEqual({ CLAUDE_CONFIG_DIR: "/c" });
    expect(scopeEnv({})).toEqual({});
  });

  it("writes them into the launchd job and the systemd unit", () => {
    const job = { execPath: "/usr/bin/node", script: "/opt/ccdeck/bin/agent-dag.js", logPath: "/l/deck.log", args: ["--no-open"] };
    const env = scopeEnv({ CLAUDE_CONFIG_DIR: "/Users/p/.claude-work" });
    const plist = plistFor({ ...job, env });
    expect(plist).toContain("<key>CLAUDE_CONFIG_DIR</key>");
    expect(plist).toContain("<string>/Users/p/.claude-work</string>");
    expect(plist).toContain("<key>AGENTS_DECK_DETACHED</key>");
    expect(unitFor({ ...job, env })).toContain("Environment=CLAUDE_CONFIG_DIR=/Users/p/.claude-work");
  });

  it("is what the first start hands the installer", () => {
    expect(DECK).toMatch(/svc\.installService\(\{[\s\S]{0,400}serviceEnv: svc\.scopeEnv\(process\.env\),/);
  });
});
