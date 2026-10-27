// The ccdeck a terminal starts, when it is older than the deck: found on every
// platform without running it, said by the deck in the app, and said by every
// newer copy in the terminal (src/server/terminal-cli.mjs).
import { describe, expect, it, vi, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { terminalCli, terminalCliNotice } from "../../server/terminal-cli.mjs";
import { catchUpNote } from "../../server/running-deck.mjs";
import TerminalCliNotice from "../components/TerminalCliNotice";
import TerminalCliBanner from "../components/TerminalCliBanner";
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
  ]);
  const links: Record<string, string> = {
    "/usr/bin/ccdeck": "/usr/lib/node_modules/ccdeck/bin/agent-dag.js",
    "/opt/tool/bin/ccdeck": "/opt/tool/bin/ccdeck",
    "/home/me/bin/ccdeck": "/home/me/bin/ccdeck",
  };
  const find = (PATH: string) => terminalCli({
    platform: "linux",
    env: { PATH },
    exists: (p: string) => p in links,
    read: (p: string) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p)!; },
    realpath: (p: string) => links[p],
  });

  it("reads the version npm installed behind the symlink", () => {
    expect(find("/usr/local/bin:/usr/bin")).toEqual({ root: "/usr/lib/node_modules/ccdeck", version: "3.42.0" });
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
    expect(terminalCliNotice({ running: "3.49.1", env })).toEqual({ version: "3.42.0", command: "npm i -g ccdeck@latest" });
  });

  it("says nothing to a deck that is not newer", () => {
    expect(terminalCliNotice({ running: "3.42.0", env })).toBeNull();
    expect(terminalCliNotice({ running: "3.41.0", env })).toBeNull();
    expect(terminalCliNotice({ running: "3.49.1", env: { PATH: join(dir, "nowhere") } })).toBeNull();
  });
});

describe("/api/version carries it", () => {
  it("attaches the notice for this deck's version", () => {
    const server = readFileSync(new URL("../../server/lifecycle.mjs", import.meta.url), "utf8");
    expect(server).toContain('import { terminalCliNotice } from "./terminal-cli.mjs";');
    expect(server).toContain("terminalCli: terminalCliNotice({ running: RUNNING_VERSION }),");
  });

  it("is no longer a desktop-only bridge", () => {
    const preload = readFileSync(new URL("../../../desktop/preload.cjs", import.meta.url), "utf8");
    expect(preload).not.toContain("ccdeckTerminalCli");
  });
});

describe("the app says what to run", () => {
  const cli = { version: "3.42.0", command: "npm i -g ccdeck@latest" };

  it("in About, on every platform", () => {
    const html = renderToStaticMarkup(createElement(TerminalCliNotice, { cli, running: "3.49.1" }));
    expect(html).toContain("The ccdeck your terminal starts is v3.42.0; this deck is v3.49.1.");
    expect(html).toContain("<code>npm i -g ccdeck@latest</code>");
    expect(html).toContain("Update needed");
  });

  it("in the strip under the topbar, with the command to copy and a way to dismiss it", () => {
    const notice = { dismissTerminalCli: () => {}, copyTerminalCli: () => {}, terminalCliCopied: false };
    const html = renderToStaticMarkup(createElement(TerminalCliBanner, { cli, notice }));
    expect(html).toContain("Your terminal&#x27;s ccdeck is out of date (v3.42.0).");
    expect(html).toContain("<code>npm i -g ccdeck@latest</code>");
    expect(html).toContain('aria-label="Dismiss"');
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
