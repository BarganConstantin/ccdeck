// The Claude Code hook keeps running when the node it was written with is gone.
//
// nvm, fnm and Volta keep every node in a versioned directory and put no link
// on PATH whose real path is that binary — nvm puts the versioned bin itself on
// PATH, fnm a per-shell link that is cleared with the shell, Volta a shim that
// is a different program — so stable-node.mjs finds nothing better and the
// command names ~/.nvm/versions/node/v22.1.0/bin/node. `nvm uninstall 22.1.0`
// and every tool call of every session shows `<Event> hook error`, until the
// deck is started again by hand.
//
// The hook runs with Claude Code's own environment, whose PATH reaches the node
// the user has now. So the command runs the recorded node while it is there,
// the node on PATH once it is not, and nothing at all — quietly, exit 0 — when
// the machine has no node left, because a hook error on every tool call is a
// worse answer than a deck that hears nothing from a machine it cannot run on.
//
// Run through a real /bin/sh with a PATH this file builds, so nothing on the
// machine running the suite can answer for it.
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain JS module, no types
import { hookCommand } from "../../server/installer.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-hook-fallback-"));
afterAll(() => rmTempDir(ROOT));

const HOOK = join(ROOT, "it's $HOME", ".claude", "agent-dag", "hook.js");

/** A directory holding only `sh`, so a PATH made of it has a shell and no node. */
function shellOnly(): string {
  const dir = mkdtempSync(join(ROOT, "sh-"));
  symlinkSync("/bin/sh", join(dir, "sh"));
  return dir;
}

/** A stand-in node that writes down who it is and what it was handed. */
function fakeNode(dir: string, who: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "node");
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' ${who} "$@" > "$CCDECK_FALLBACK_OUT"\n`);
  chmodSync(file, 0o755);
  return file;
}

/** The command, through the shell Claude Code hands it to. */
function fire(command: string, path: string) {
  const out = join(mkdtempSync(join(ROOT, "out-")), "argv");
  const run = spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    env: { PATH: path, HOME: "SUBSTITUTED", CCDECK_FALLBACK_OUT: out },
  });
  return {
    status: run.status,
    stderr: run.stderr,
    argv: existsSync(out) ? readFileSync(out, "utf8").split("\n").slice(0, -1) : null,
  };
}

describe.skipIf(process.platform === "win32")("the hook command when the recorded node is gone", () => {
  it("runs the recorded node while it is there", () => {
    const pinned = fakeNode(join(ROOT, "pinned", "bin"), "pinned");
    const onPath = join(ROOT, "path-a");
    fakeNode(onPath, "on-path");
    const ran = fire(hookCommand(HOOK, "claude", pinned, "linux"), [onPath, shellOnly()].join(":"));
    expect(ran.stderr).toBe("");
    expect(ran.argv).toEqual(["pinned", HOOK, "--provider", "claude"]);
  });

  it("falls back to the node on PATH once an nvm uninstall has taken it", () => {
    const gone = join(ROOT, ".nvm", "versions", "node", "v22.1.0", "bin", "node");
    const onPath = join(ROOT, "path-b");
    fakeNode(onPath, "on-path");
    const ran = fire(hookCommand(HOOK, "claude", gone, "linux"), [shellOnly(), onPath].join(":"));
    expect(ran.status).toBe(0);
    expect(ran.stderr).toBe("");
    expect(ran.argv).toEqual(["on-path", HOOK, "--provider", "claude"]);
  });

  it("ends quietly when the machine has no node left at all", () => {
    const gone = join(ROOT, ".volta", "tools", "image", "node", "20.0.0", "bin", "node");
    const ran = fire(hookCommand(HOOK, "claude", gone, "linux"), shellOnly());
    // Claude Code shows a hook error for any non-zero exit and for stderr.
    expect(ran.status).toBe(0);
    expect(ran.stderr).toBe("");
    expect(ran.argv).toBeNull();
  });
});
