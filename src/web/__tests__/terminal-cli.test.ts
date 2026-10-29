// The ccdeck a terminal starts, when it is older than the deck: found on every
// platform without running it, replaced by the deck where npm put it and this
// user can write, said in About, and said by every newer copy in the terminal
// (src/server/terminal-cli.mjs, terminal-cli-update.mjs).
import { describe, expect, it, vi, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { terminalCli } from "../../server/terminal-cli.mjs";
import {
  resetTerminalCliUpdate, takeInstallLock, terminalCliState, terminalUpdateBlockedReason, terminalUpdateDue, updateTerminalCli,
} from "../../server/terminal-cli-update.mjs";
import { catchUpNote } from "../../server/running-deck.mjs";
import TerminalCliNotice from "../components/TerminalCliNotice";
import { rmTempDir } from "./rm-temp-dir";

const winRoot = "C:\\Users\\tester\\AppData\\Roaming\\npm";
const shim = win32.join(winRoot, "ccdeck.ps1");
const winManifest = win32.join(winRoot, "node_modules", "ccdeck", "package.json");

function onWindows({ path = winRoot, manifestData = { name: "ccdeck", version: "3.26.1" }, files = [shim] }: {
  path?: string; manifestData?: unknown; files?: string[];
} = {}) {
  const exists = vi.fn((name: string) => files.includes(name));
  const read = vi.fn((name: string) => {
    if (name !== winManifest) throw new Error("missing package manifest");
    return JSON.stringify(manifestData);
  });
  return terminalCli({ platform: "win32", env: { Path: path }, exists, read })?.version ?? null;
}

describe("on Windows, only a verified npm shim is read", () => {
  it("reads the first npm shim on PATH, without executing it", () => {
    expect(onWindows()).toBe("3.26.1");
    expect(terminalCli({
      platform: "win32", env: { Path: winRoot }, exists: (f: string) => f === shim, read: () => JSON.stringify({ name: "ccdeck", version: "3.26.1" }),
    })?.prefix).toBe(winRoot);
    expect(onWindows({ files: [win32.join(winRoot, "ccdeck.cmd")] })).toBe("3.26.1");
    expect(onWindows({ path: `"${winRoot}";C:\\other` })).toBe("3.26.1");
  });

  it("does not report a shadowed or unidentified CLI", () => {
    expect(onWindows({ files: [] })).toBeNull();
    expect(onWindows({ files: [win32.join(winRoot, "ccdeck.exe"), shim] })).toBeNull();
    expect(onWindows({ manifestData: { name: "other-cli", version: "1.0.0" } })).toBeNull();
    expect(onWindows({ manifestData: { name: "ccdeck", version: "invalid" } })).toBeNull();
    expect(onWindows({ path: `C:\\custom;${winRoot}`, files: [win32.join("C:\\custom", "ccdeck.cmd"), shim] })).toBeNull();
    expect(terminalCli({ platform: "win32", env: {} })).toBeNull();
  });
});

describe("on Linux and macOS, the first ccdeck on PATH is followed to its package", () => {
  const files = new Map<string, string>([
    ["/usr/lib/node_modules/ccdeck/package.json", JSON.stringify({ name: "ccdeck", version: "3.42.0" })],
    ["/opt/tool/package.json", JSON.stringify({ name: "some-wrapper", version: "1.0.0" })],
    ["/home/me/.local/share/pnpm/global/5/node_modules/ccdeck/package.json", JSON.stringify({ name: "ccdeck", version: "3.42.0" })],
    ["/work/lib/node_modules/ccdeck/package.json", JSON.stringify({ name: "ccdeck", version: "3.42.0" })],
    ["/work/lib/package.json", JSON.stringify({ name: "a-project-called-lib", version: "1.0.0" })],
  ]);
  const links: Record<string, string> = {
    "/usr/bin/ccdeck": "/usr/lib/node_modules/ccdeck/bin/agent-dag.js",
    "/opt/tool/bin/ccdeck": "/opt/tool/bin/ccdeck",
    "/home/me/bin/ccdeck": "/home/me/bin/ccdeck",
    "/home/me/.local/share/pnpm/ccdeck": "/home/me/.local/share/pnpm/global/5/node_modules/ccdeck/bin/agent-dag.js",
    "/work/lib/node_modules/.bin/ccdeck": "/work/lib/node_modules/ccdeck/bin/agent-dag.js",
  };
  const find = (PATH: string) => terminalCli({
    platform: "linux",
    env: { PATH },
    exists: (p: string) => p in links,
    read: (p: string) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p)!; },
    realpath: (p: string) => links[p],
  });

  it("reads the version npm installed behind the symlink, and the prefix npm installed it into", () => {
    expect(find("/usr/local/bin:/usr/bin")).toEqual({ root: "/usr/lib/node_modules/ccdeck", version: "3.42.0", prefix: "/usr" });
  });

  it("names no npm prefix for pnpm's globals or a project's own node_modules", () => {
    expect(find("/home/me/.local/share/pnpm")).toMatchObject({ version: "3.42.0", prefix: null });
    expect(find("/work/lib/node_modules/.bin")).toMatchObject({ version: "3.42.0", prefix: null });
  });

  it("stops at the first ccdeck, and says nothing for one it cannot identify", () => {
    // A wrapper owned by another package, ahead of the npm install.
    expect(find("/opt/tool/bin:/usr/bin")).toBeNull();
    // A script with no package around it at all.
    expect(find("/home/me/bin:/usr/bin")).toBeNull();
    expect(find("")).toBeNull();
    expect(terminalCli({ platform: "linux", env: {} })).toBeNull();
    expect(terminalCli({
      platform: "darwin", env: { PATH: "/usr/bin" }, exists: () => true, realpath: () => { throw new Error("EACCES"); },
    })).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("an npm prefix on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccdeck-terminal-cli-"));
  afterAll(() => rmTempDir(dir));
  const pkg = join(dir, "lib", "node_modules", "ccdeck");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "ccdeck", version: "3.42.0" }));
  writeFileSync(join(pkg, "bin", "agent-dag.js"), "");
  symlinkSync("../lib/node_modules/ccdeck/bin/agent-dag.js", join(dir, "bin", "ccdeck"));
  const env = { PATH: join(dir, "bin") };

  it("tells a deck newer than the terminal's ccdeck how to update it", () => {
    expect(terminalCliState({ running: "3.49.1", env, enabled: false })).toEqual(
      { version: "3.42.0", command: "npm i -g ccdeck@latest", auto: null, error: null });
  });

  it("says nothing to a deck that is not newer", () => {
    expect(terminalCliState({ running: "3.42.0", env })).toBeNull();
    expect(terminalCliState({ running: "3.41.0", env })).toBeNull();
    expect(terminalCliState({ running: "3.49.1", env: { PATH: join(dir, "nowhere") } })).toBeNull();
  });
});

describe("one install lock per global node_modules, across decks", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccdeck-terminal-lock-"));
  afterAll(() => rmTempDir(dir));

  it("is held by one deck at a time, given back, and taken over once stale", () => {
    const release = takeInstallLock(dir, 1_000);
    expect(release).toBeTypeOf("function");
    expect(takeInstallLock(dir, 2_000)).toBeNull();
    release!();
    const again = takeInstallLock(dir, 3_000);
    expect(again).toBeTypeOf("function");
    // A deck that died holding it: older than an install can last.
    expect(takeInstallLock(dir, 3_000 + 6 * 60_000)).toBeTypeOf("function");
  });

  it("is no refusal where it cannot be written", () => {
    expect(takeInstallLock(join(dir, "missing", "deeper"), 0)).toBeTypeOf("function");
  });
});

describe("/api/version carries it", () => {
  it("attaches the notice for this deck's version, with what the deck is doing about it", () => {
    const server = readFileSync(new URL("../../server/lifecycle.mjs", import.meta.url), "utf8");
    expect(server).toContain('import { terminalCliState, updateTerminalCli } from "./terminal-cli-update.mjs";');
    expect(server).toContain("terminalCli: terminalCliState(terminalCliAsk()),");
    // The same switch as the deck's own unattended update, and the boot grace before npm runs.
    expect(server).toContain("enabled: heldPrefs.current()?.autoUpdate !== false };");
    expect(server).toContain("if (Date.now() - _bootedAt < AWAY_BOOT_GRACE_MS) return false;");
  });

  it("is no longer a desktop-only bridge", () => {
    const preload = readFileSync(new URL("../../../desktop/preload.cjs", import.meta.url), "utf8");
    expect(preload).not.toContain("ccdeckTerminalCli");
  });
});

describe("the app says it only in About", () => {
  const cli = { version: "3.42.0", command: "npm i -g ccdeck@latest" };

  it("in About, on every platform", () => {
    const html = renderToStaticMarkup(createElement(TerminalCliNotice, { cli, running: "3.49.1" }));
    expect(html).toContain("The ccdeck your terminal starts is v3.42.0; this deck is v3.49.1.");
    expect(html).toContain("<code>npm i -g ccdeck@latest</code>");
    expect(html).toContain("Update needed");
  });

  it("and never in the strip under the topbar: the terminal is where it is said out loud (owner, 2026-10-28)", () => {
    const strip = readFileSync(new URL("../components/DeckBanner.tsx", import.meta.url), "utf8");
    expect(strip).not.toMatch(/terminalCli/i);
  });
});

describe("a newer copy says it in the terminal", () => {
  it("under the attach note, when the deck kept is the newer one", () => {
    expect(catchUpNote("3.49.1", "3.42.0", "npm i -g ccdeck@latest")).toBe("to use v3.49.1 in this terminal: `npm i -g ccdeck@latest`");
    expect(catchUpNote("3.42.0", "3.49.1", "npm i -g ccdeck@latest")).toBe("");
    expect(catchUpNote("3.49.1", "3.49.1", "npm i -g ccdeck@latest")).toBe("");
    expect(catchUpNote("", "3.42.0", "npm i -g ccdeck@latest")).toBe("");
  });

  it("for a word that may be a newer copy's command, and not for a typo", async () => {
    const { unknownCommandText } = await import("../../../bin/cli/commands.js");
    const newer = { version: "9.0.0", command: "npm i -g ccdeck@latest" };
    const text = unknownCommandText("frobnicate", newer).join("\n");
    expect(text).toMatch(/unknown command "frobnicate" .+ v9\.0\.0 may have it/);
    expect(text).toContain("`npm i -g ccdeck@latest` updates it");
    const typo = unknownCommandText("acounts", newer).join("\n");
    expect(typo).toContain("did you mean `ccdeck accounts`?");
    expect(typo).not.toContain("9.0.0");
    expect(unknownCommandText("frobnicate").join("\n")).not.toContain("updates it");
  });
});

describe("the deck updates the terminal's copy itself, where npm put it", () => {
  // An npm global install in /usr, as terminalCli sees it: no disk, no npm.
  const fs = {
    platform: "linux",
    env: { PATH: "/usr/bin" },
    exists: (p: string) => p === "/usr/bin/ccdeck",
    read: (p: string) => {
      if (p !== "/usr/lib/node_modules/ccdeck/package.json") throw new Error("ENOENT");
      return JSON.stringify({ name: "ccdeck", version: "3.42.0" });
    },
    realpath: () => "/usr/lib/node_modules/ccdeck/bin/agent-dag.js",
  };
  const ask = { ...fs, running: "3.49.1", pkgRoot: "/opt/ccdeck-app/deck", enabled: true, block: () => null, lock: () => () => {} };
  type Report = (state: string, error?: string | null) => void;
  const npm = () => {
    const calls: { plain: string[]; report: Report }[] = [];
    const install = vi.fn((spec: { plain: string[] }, report: Report) => { calls.push({ plain: spec.plain, report }); return true; });
    return { calls, install };
  };
  beforeEach(() => resetTerminalCliUpdate());

  it("runs Update now's install against that copy's own prefix, and says so meanwhile", () => {
    expect(terminalCliState({ ...ask, now: 0 })).toEqual({ version: "3.42.0", command: "npm i -g ccdeck@latest", auto: "pending", error: null });
    const { calls, install } = npm();
    expect(updateTerminalCli({ ...ask, now: 0, install })).toBe(true);
    expect(calls[0].plain).toEqual(["install", "-g", "--prefix", "/usr", "ccdeck@latest", "--no-audit", "--no-fund", "--loglevel", "error"]);
    expect(terminalCliState({ ...ask, now: 1 })?.auto).toBe("running");
    // One at a time.
    expect(updateTerminalCli({ ...ask, now: 1, install })).toBe(false);
  });

  it("says why it failed, and tries again only after half an hour", () => {
    const { calls, install } = npm();
    updateTerminalCli({ ...ask, now: 0, install });
    calls[0].report("failed", "EACCES: permission denied, rename '/usr/lib/node_modules/ccdeck'");
    expect(terminalCliState({ ...ask, now: 1 })).toMatchObject({ auto: "failed", error: expect.stringContaining("EACCES") });
    const failedAt = Date.now();
    expect(updateTerminalCli({ ...ask, now: failedAt + 60_000, install })).toBe(false);
    expect(updateTerminalCli({ ...ask, now: failedAt + 31 * 60_000, install })).toBe(true);
  });

  it("does not repeat a finished install that left the copy older — npm had nothing newer", () => {
    const { calls, install } = npm();
    updateTerminalCli({ ...ask, now: 0, install });
    calls[0].report("done", null);
    expect(terminalCliState({ ...ask, now: 1 })?.auto).toBeNull();
    expect(updateTerminalCli({ ...ask, now: Date.now() + 86_400_000, install })).toBe(false);
    // A newer deck is a new attempt.
    expect(updateTerminalCli({ ...ask, running: "3.50.0", now: Date.now(), install })).toBe(true);
  });

  it("leaves the copy to the person whenever the command they would type is not this", () => {
    const { install } = npm();
    const left = (over: object) => {
      resetTerminalCliUpdate();
      const state = terminalCliState({ ...ask, now: 0, ...over });
      return { auto: state?.auto, started: updateTerminalCli({ ...ask, now: 0, install, ...over }) };
    };
    expect(left({ enabled: false })).toEqual({ auto: null, started: false });
    expect(left({ block: () => "not_writable" })).toEqual({ auto: null, started: false });
    expect(left({ pkgRoot: "/usr/lib/node_modules/ccdeck" })).toEqual({ auto: null, started: false });
    vi.stubEnv("AGENTS_DECK_NO_INSTALL", "1");
    try { expect(left({})).toEqual({ auto: null, started: false }); } finally { vi.unstubAllEnvs(); }
    expect(install).not.toHaveBeenCalled();
    // Nothing older, nothing said and nothing run.
    expect(terminalCliState({ ...ask, running: "3.42.0", now: 0 })).toBeNull();
    expect(updateTerminalCli({ ...ask, running: "3.42.0", now: 0, install })).toBe(false);
  });

  it("refuses in that order, before the filesystem is asked", () => {
    const base = { optedOut: false, enabled: true, prefix: "/usr", name: "ccdeck", own: false };
    expect(terminalUpdateBlockedReason(base)).toBeNull();
    expect(terminalUpdateBlockedReason({ ...base, optedOut: true, enabled: false })).toBe("opted_out");
    expect(terminalUpdateBlockedReason({ ...base, enabled: false })).toBe("off");
    expect(terminalUpdateBlockedReason({ ...base, prefix: null })).toBe("not_npm");
    expect(terminalUpdateBlockedReason({ ...base, name: "agents-deck" })).toBe("retired_name");
    expect(terminalUpdateBlockedReason({ ...base, own: true })).toBe("own_copy");
  });

  it("leaves the tick alone while another deck installs it, and gives the lock back when npm ends", () => {
    const { calls, install } = npm();
    expect(updateTerminalCli({ ...ask, now: 0, install, lock: () => null })).toBe(false);
    expect(install).not.toHaveBeenCalled();
    const release = vi.fn();
    const lock = vi.fn(() => release);
    updateTerminalCli({ ...ask, now: 0, install, lock });
    expect(lock).toHaveBeenCalledWith("/usr/lib/node_modules", 0);
    expect(release).not.toHaveBeenCalled();
    calls[0].report("failed", "ETIMEDOUT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("counts a clock that went back as time passed", () => {
    const last = { key: "k", state: "failed", at: 10_000 };
    expect(terminalUpdateDue({ key: "k", last, now: 5_000 })).toBe(true);
    expect(terminalUpdateDue({ key: "other", last: { ...last, state: "running" }, now: 10_001 })).toBe(true);
  });

  it("About says what the deck is doing instead of asking", () => {
    const cli = { version: "3.42.0", command: "npm i -g ccdeck@latest" };
    const html = (auto: object) => renderToStaticMarkup(createElement(TerminalCliNotice, { cli: { ...cli, ...auto }, running: "3.49.1" }));
    expect(html({ auto: "pending" })).toContain("The deck updates it within a few minutes. To do it now, run <code>npm i -g ccdeck@latest</code>.");
    expect(html({ auto: "pending" })).not.toContain("does not update it");
    expect(html({ auto: "running" })).toContain("The deck is updating it now.");
    expect(html({ auto: "failed", error: "EACCES" })).toContain("The deck could not update it (EACCES). Run <code>npm i -g ccdeck@latest</code>, then open a new terminal.");
    expect(html({ auto: null })).toContain("Updating the app or the deck does not update it.");
  });
});
