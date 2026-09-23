// A deck started by the desktop app (#1160), and the app's side of starting it.
//
// Inside the app three things the deck does for itself belong to the app —
// updates, start at login, and the program the Claude Code hook runs with —
// and doing them anyway goes wrong in ways a terminal deck never sees: an
// `npm i -g` of a copy the app never runs, a login item that starts a deck with
// no app around it, and a hook command that opens the app instead of running a
// script. What is pinned here is each one handed over, and the launcher the
// hook runs through.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inApp, hookRuntime, APP_ENV, HOOK_RUNTIME_ENV } from "../../server/app-host.mjs";
import { hookCommand } from "../../server/installer.mjs";
import { shouldOfferService } from "../../server/login-service.mjs";
// @ts-expect-error — plain .mjs, no types
import { claudeConfigDir } from "../../server/claude-dir.mjs";
// @ts-expect-error — plain .mjs, no types
import { claudeDir, launcherScript, shellPath, writeLauncher } from "../../../desktop/deck-host.mjs";
import { rmTempDir } from "./rm-temp-dir";

describe("knowing the app is the host", () => {
  it("is told by the environment the supervisor and the worker both inherit", () => {
    expect(inApp({ [APP_ENV]: "1" })).toBe(true);
    expect(inApp({})).toBe(false);
    expect(inApp({ [APP_ENV]: "yes" })).toBe(false);
  });

  it("runs the hook through the app's launcher, and through its own Node otherwise", () => {
    expect(hookRuntime({ [HOOK_RUNTIME_ENV]: "/u/.claude/agent-dag/ccdeck-node" }, "/app/ccdeck")).toBe("/u/.claude/agent-dag/ccdeck-node");
    expect(hookRuntime({}, "/usr/local/bin/node")).toBe("/usr/local/bin/node");
    expect(hookRuntime({ [HOOK_RUNTIME_ENV]: "  " }, "/usr/local/bin/node")).toBe("/usr/local/bin/node");
  });

  it("writes that launcher into the hook command, quoted like any path", () => {
    expect(hookCommand("/u/.claude/agent-dag/hook.js", "claude", "/u/.claude/agent-dag/ccdeck-node", "darwin"))
      .toBe("'/u/.claude/agent-dag/ccdeck-node' '/u/.claude/agent-dag/hook.js' --provider 'claude'");
  });

  it("never offers its own login item — the app owns that switch", () => {
    expect(shouldOfferService({ env: { [APP_ENV]: "1" } })).toBe(false);
    expect(shouldOfferService({ env: {} })).toBe(true);
  });
});

describe("the hook launcher", () => {
  it("prefers the system node, and falls back to the app's binary as Node", () => {
    const sh = launcherScript("/Applications/ccdeck.app/Contents/MacOS/ccdeck", "darwin");
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).toContain('if command -v node >/dev/null 2>&1; then exec node "$@"; fi');
    expect(sh).toContain("ELECTRON_RUN_AS_NODE=1 exec '/Applications/ccdeck.app/Contents/MacOS/ccdeck' \"$@\"");
  });

  it("keeps a path with a quote in it as one argument", () => {
    const sh = launcherScript("/Users/o'neil/Apps/ccdeck.app/Contents/MacOS/ccdeck", "darwin");
    expect(sh).toContain(`'/Users/o'\\''neil/Apps/ccdeck.app/Contents/MacOS/ccdeck'`);
  });

  it("is a cmd script on Windows", () => {
    const cmd = launcherScript("C:\\Program Files\\ccdeck\\ccdeck.exe", "win32");
    expect(cmd.split("\r\n")[0]).toBe("@echo off");
    expect(cmd).toContain("where node >nul 2>nul && (node %* & exit /b)");
    expect(cmd).toContain('"C:\\Program Files\\ccdeck\\ccdeck.exe" %*');
  });

  it("lives in the Claude config directory, and reads CLAUDE_CONFIG_DIR exactly as the deck does", () => {
    // TWO READERS OF ONE VARIABLE. claudeDir says in its own comment that it
    // restates src/server/claude-dir.mjs, because it runs before any deck
    // module is loaded — and a restatement that drifts is worse than a second
    // rule, since nothing anywhere says the two disagree. It read the variable
    // raw: neither trimmed nor resolved, where claudeConfigDir does both.
    //
    // What that difference costs is not abstract. The launcher's path goes into
    // settings.json, and Claude Code resolves a relative command against EACH
    // SESSION'S OWN cwd — so `CLAUDE_CONFIG_DIR=rel/dir` wrote a hook command
    // that works in one directory and is "not found" in every other, while the
    // deck installed the hook.js it points at somewhere else entirely. A value
    // with spaces around it (a .env file, a shell export with a trailing space)
    // split the two the same way.
    //
    // So the case is parity rather than a second copy of the rule: whatever
    // claudeConfigDir answers, this answers.
    for (const given of ["  /x/claude  ", "rel/dir", "   ", "/x/claude"]) {
      expect(claudeDir({ CLAUDE_CONFIG_DIR: given }, "/home/u"), `CLAUDE_CONFIG_DIR=${JSON.stringify(given)}`)
        .toBe(claudeConfigDir({ CLAUDE_CONFIG_DIR: given }, "/home/u"));
    }
    expect(claudeDir({}, "/home/u")).toBe(claudeConfigDir({}, "/home/u"));
    expect(claudeDir({}, "/home/u")).toMatch(/[\\/]home[\\/]u[\\/]\.claude$/);
  });
});

// ── the launcher as a file, and as a program ────────────────────────────────
//
// Everything above reads `launcherScript`'s TEXT. Nothing called writeLauncher,
// and nothing ran what it writes — so the file name, the exec bit and the
// argument pass-through were all unasserted, and each of them is total when it
// goes: Claude Code runs this script on every tool call in every session, and a
// launcher that cannot be executed or swallows its arguments gives exit 126 or
// 127, `<event> hook error` in front of the user, and a deck that receives
// nothing at all. It is the desktop app's only path to the hook.
//
// NOTHING BELOW IS GATED ON THE PLATFORM. The launcher is a different program on
// Windows and its caller is a different shell, so each case runs the launcher of
// the leg it is on, through that leg's shell — the same choice
// no-shell-hook-commands.test.ts makes, and for the same reason: a case that
// runs on one runner is a case nobody notices going quiet (#585).
const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-launcher-"));
afterAll(() => rmTempDir(ROOT));

const WIN = process.platform === "win32";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// hook.js is CommonJS inside a "type": "module" package, so it only loads as
// itself outside that tree. The copy also hands back the hook's own challenge
// derivation, so the deck below can answer without importing the server.
const HOOK = join(ROOT, "hook.cjs");
copyFileSync(join(REPO, "hook", "hook.js"), HOOK);
const { challengeProof } = createRequire(import.meta.url)(HOOK) as {
  challengeProof: (token: string, nonce: string) => string;
};

/** A listener that proves itself the way a deck does, and records what it was told. */
async function honestDeck() {
  const token = randomBytes(32).toString("hex");
  const seen: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/hook-challenge") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ proof: challengeProof(token, url.searchParams.get("nonce") ?? "") }));
    }
    seen.push(url.pathname);
    req.resume();
    req.on("end", () => res.writeHead(200).end());
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return {
    seen, token,
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(done => {
      server.closeAllConnections?.();
      server.close(() => done());
    }),
  };
}

/**
 * Write a launcher for this platform, register an honest deck beside it, and
 * run the hook through it exactly as Claude Code would — the command string out
 * of `hookCommand`, handed to this platform's shell.
 *
 * `onPath` decides which of the launcher's two branches is taken: with a node
 * on PATH it execs that, and with none it falls back to the app binary with
 * ELECTRON_RUN_AS_NODE=1. The stand-in app records that variable and then
 * becomes a real Node, so the fallback can be told from the other branch by
 * evidence rather than by timing.
 */
async function throughLauncher({ onPath }: { onPath: boolean }) {
  const dir = mkdtempSync(join(ROOT, onPath ? "sysnode-" : "appnode-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const witness = join(dir, "ran-as-node");

  const app = join(dir, WIN ? "stub-app.cmd" : "stub-app");
  writeFileSync(app, WIN
    ? ["@echo off", `>"${witness}" echo %ELECTRON_RUN_AS_NODE%`, `"${process.execPath}" %*`, ""].join("\r\n")
    : ["#!/bin/sh", `printf '%s' "$ELECTRON_RUN_AS_NODE" > '${witness}'`,
       `exec '${process.execPath}' "$@"`, ""].join("\n"));
  if (!WIN) chmodSync(app, 0o755);

  if (onPath) {
    if (WIN) writeFileSync(join(binDir, "node.cmd"), ["@echo off", `"${process.execPath}" %*`, ""].join("\r\n"));
    else symlinkSync(process.execPath, join(binDir, "node"));
  }
  // Windows keeps `where` in System32, and the launcher asks it the question —
  // so the directory stays on PATH and only `node` is taken off it. On POSIX
  // `command -v` is the shell's own builtin and needs nothing.
  const path = WIN ? `${binDir};${join(process.env.SystemRoot ?? "C:\\Windows", "System32")}` : binDir;

  const launcher = writeLauncher(app, { env: { CLAUDE_CONFIG_DIR: dir }, platform: process.platform });
  const deck = await honestDeck();
  // Our own pid, so the liveness check keeps the record; an empty workspace
  // matches any cwd.
  writeFileSync(join(dir, "agent-dag", `${process.pid}.json`), JSON.stringify({
    pid: process.pid, port: deck.port, workspace: "", token: deck.token,
    startedAt: new Date().toISOString(),
  }), "utf8");

  const command = hookCommand(HOOK, "claude", launcher, process.platform);
  const comspec = process.env.comspec || process.env.ComSpec || "cmd.exe";
  const child = spawn(
    WIN ? comspec : "/bin/sh",
    WIN ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command],
    {
      // Verbatim on Windows, or Node quotes the already-quoted line a second
      // time — the same reason windows-command-line.ts sets it.
      windowsVerbatimArguments: WIN,
      cwd: dir,
      env: {
        ...process.env,
        PATH: path, Path: path,
        CLAUDE_CONFIG_DIR: dir, HOME: dir, USERPROFILE: dir,
      } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", c => { stdout += c; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", c => { stderr += c; });
  child.stdin.end(JSON.stringify({ cwd: dir, hook_event_name: "SessionStart", session_id: "s1" }));
  try {
    const code = await new Promise<number | null>((done, fail) => {
      child.on("error", fail);
      child.on("exit", c => done(c));
    });
    return {
      code, stdout, stderr, launcher,
      seen: deck.seen,
      ranAsNode: existsSync(witness) ? readFileSync(witness, "utf8").trim() : null,
    };
  } finally {
    // A listener left behind by a spawn that failed outright keeps the test
    // worker from ever ending.
    await deck.close();
  }
}

describe("the launcher the desktop app writes", () => {
  it("goes into the deck's own directory, under a name that cannot move", () => {
    // THE PATH IS PERSISTED, which is why the name is worth an assertion of its
    // own. It is written into settings.json as part of the hook command and
    // stays there until the next install — so an app version that writes its
    // launcher somewhere else leaves every already-installed session running a
    // command that names a file nobody writes any more. The execution cases
    // below cannot see that: they run the path writeLauncher just handed back.
    //
    // Both platforms' shapes from one leg — the name differs, and on Windows a
    // cmd script has to be CRLF throughout or cmd.exe reads the last token of
    // each line with a stray character stuck to it. Content equality carries
    // that: launcherScript joins the Windows lines with \r\n.
    for (const platform of ["darwin", "win32"] as const) {
      const dir = mkdtempSync(join(ROOT, `written-${platform}-`));
      const app = platform === "win32"
        ? "C:\\Program Files\\ccdeck\\ccdeck.exe"
        : "/Applications/ccdeck.app/Contents/MacOS/ccdeck";
      const written = writeLauncher(app, { env: { CLAUDE_CONFIG_DIR: dir }, platform });
      expect(written).toBe(join(dir, "agent-dag", platform === "win32" ? "ccdeck-node.cmd" : "ccdeck-node"));
      expect(readFileSync(written, "utf8")).toBe(launcherScript(app, platform));
    }
  });

  it("is executable, because Claude Code runs it and does not source it", () => {
    // The chmod, which nothing else in the suite would miss: a launcher without
    // it is exit 126 and `permission denied` on every tool call of every
    // session. Windows has no such bit and decides by extension, which the name
    // above is the assertion for.
    const dir = mkdtempSync(join(ROOT, "mode-"));
    const written = writeLauncher("/Applications/ccdeck.app/Contents/MacOS/ccdeck", {
      env: { CLAUDE_CONFIG_DIR: dir }, platform: process.platform,
    });
    if (!WIN) expect(statSync(written).mode & 0o111, "no execute bit on the launcher").not.toBe(0);
    expect(existsSync(written)).toBe(true);
  });

  it("runs the hook with a node from PATH, arguments and all, and the deck gets the event", async () => {
    const r = await throughLauncher({ onPath: true });
    expect(r.stderr, "the launcher put something in the host CLI's transcript").toBe("");
    expect(r.code, "exit 126 is the missing chmod; 127 is the wrong name").toBe(0);
    expect(r.stdout).toBe("");
    expect(r.ranAsNode, "the app was woken up although PATH had a node").toBe(null);
    // The event arriving is the whole chain: the launcher was found, was
    // executable, passed `<hook.js> --provider claude` through, and the hook
    // read its own arguments out of it.
    expect(r.seen).toEqual(["/api/event"]);
  }, 30_000);

  it("falls back to the app's own binary as Node when PATH has none", async () => {
    // The branch an app started from the Dock is most likely to take: launchd
    // hands GUI apps a PATH with no node on it, which is the whole reason this
    // launcher exists.
    const r = await throughLauncher({ onPath: false });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.ranAsNode, "the app binary was not told to behave as Node").toBe("1");
    expect(r.seen).toEqual(["/api/event"]);
  }, 30_000);
});

describe("the PATH an app started from the Dock is given", () => {
  it("reads the login shell's, ignoring whatever a profile prints", () => {
    const run = () => "Welcome back!\n__CCDECK_PATH__/opt/homebrew/bin:/usr/bin";
    expect(shellPath({ env: { SHELL: "/bin/zsh", PATH: "/usr/bin" }, platform: "darwin", run })).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("keeps the current one when the shell cannot be asked", () => {
    const run = () => { throw new Error("timed out"); };
    expect(shellPath({ env: { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" }, platform: "darwin", run })).toBe("/usr/bin:/bin");
  });

  it("does not ask on Windows, where GUI apps get the full PATH", () => {
    expect(shellPath({ env: { PATH: "C:\\a" }, platform: "win32", run: () => { throw new Error("not called"); } })).toBe("C:\\a");
  });
});
