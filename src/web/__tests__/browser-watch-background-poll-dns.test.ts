// Browser Watch's background poll asked the network for the relay's address.
//
// With the watch on — the default — the badge's five-minute `live=0` poll ran
// the whole browser survey, and the survey's first step is `dig +short
// bridge.claudeusercontent.com`: a DNS query to whatever resolver the machine
// uses (a router, an ISP, a company's DNS), on a deck whose README said of
// Browser Watch that nothing leaves the machine. The poll does not even use
// what the survey finds — the badge reads the episodes and the switch — so it
// no longer surveys at all. The panel still does, because somebody opened it,
// and the README says so now.
//
// Run against the in-memory machine of linux-browser-fixture.ts, whose `run`
// writes down every command the code asks for and runs none of them.
import { describe, it, expect, vi } from "vitest";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { guardThisMachine } from "./browser-watch-guard";
import { linuxMachine } from "./linux-browser-fixture";

vi.mock("node:child_process", async (real) =>
  (await import("./browser-watch-guard")).trappedChildProcess(await real()));
const { home: DIR } = guardThisMachine();
vi.stubEnv("CODEX_HOME", join(DIR, "codex"));
if (!resolve(String(process.env.CLAUDE_CONFIG_DIR)).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — .mjs server module, no types
const { browserWatchSnapshot, invalidateBrowserWatchCache } = await import("../../server/browser-watch.mjs");

/** The fixture's machine on every host: its paths are Linux paths, under its
 *  own home rather than the XDG directory the guard points at a temp dir. */
const LINUX = { platform: "linux", env: {} };

/** A snapshot with the watch switched as given, on a machine with Brave
 *  installed and running. */
function harness(enabled: boolean) {
  const machine = linuxMachine();
  machine.install(".config/BraveSoftware/Brave-Browser");
  return {
    machine,
    commands: () => machine.calls.map(c => c.cmd),
    deps: {
      ...machine.deps,
      readStore: async () => ({
        settings: { v: 1, enabled, reaction: "notify", quietMinutes: 15, gapMinutes: 15 },
        episodes: [], dismissed: [], migrated: false,
      }),
      writeStore: async () => {},
      updateStore: async () => {},
      appendLog: async () => {},
      react: async () => [],
      discoverProfiles: () => [],
      readFileSync: () => { throw new Error("ENOENT"); },
    },
  };
}

describe("the badge's background poll, with the watch on", () => {
  it("sends no DNS query for the relay", async () => {
    invalidateBrowserWatchCache();
    const h = harness(true);
    const snap = await browserWatchSnapshot({ ...LINUX, readBrowsers: false, deps: h.deps });
    expect(snap.ok).toBe(true);
    expect(h.commands(), "the background poll looked the relay up").not.toContain("dig");
  });

  it("runs none of the survey's programs, which it has no use for", async () => {
    invalidateBrowserWatchCache();
    const h = harness(true);
    await browserWatchSnapshot({ ...LINUX, readBrowsers: false, deps: h.deps });
    expect(h.commands()).toEqual([]);
  });

  it("still answers with the episodes and the switch, which are all the badge reads", async () => {
    invalidateBrowserWatchCache();
    const h = harness(true);
    const snap = await browserWatchSnapshot({ ...LINUX, readBrowsers: false, deps: h.deps });
    expect(snap.settings.enabled).toBe(true);
    expect(Array.isArray(snap.episodes)).toBe(true);
  });
});

describe("the panel's own read", () => {
  it("looks the relay up, because somebody opened the panel to see it", async () => {
    invalidateBrowserWatchCache();
    const h = harness(true);
    const snap = await browserWatchSnapshot({ ...LINUX, deps: h.deps });
    expect(h.commands()).toContain("dig");
    expect(snap.browsers.map((b: { key: string }) => b.key)).toContain("brave");
  });

  it("is not answered with an empty survey a background poll left behind", async () => {
    invalidateBrowserWatchCache();
    const h = harness(true);
    await browserWatchSnapshot({ ...LINUX, readBrowsers: false, deps: h.deps });
    const snap = await browserWatchSnapshot({ ...LINUX, deps: h.deps });
    expect(snap.browsers.find((b: { key: string }) => b.key === "brave")?.installed).toBe(true);
  });
});

describe("what the README says goes out", () => {
  const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");

  it("no longer says nothing leaves the machine for Browser Watch, and names the lookup", () => {
    expect(readme).not.toMatch(/deletes the copy\. Nothing leaves the machine/);
    expect(readme).toMatch(/bridge\.claudeusercontent\.com/);
  });

  it("lists the machine panel's round trip to api.anthropic.com", () => {
    // The README's own spelling of the panel is lower case.
    expect(readme).toMatch(/machine panel[^\n]*api\.anthropic\.com/i);
  });
});
