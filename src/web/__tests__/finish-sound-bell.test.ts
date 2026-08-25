// The last resort of the finish sound was a bell that could not ring (#548).
//
// `hook/notify.mjs` walks a list of players and takes the first one that starts.
// The end of the Linux/BSD list was `["printf", ["\a"]]`, spawned like every
// other candidate — which means with `stdio: "ignore"`. So the BEL byte the
// whole entry exists to produce was written to /dev/null, and the comment above
// it said the entry "works over SSH where no audio device exists". It worked
// nowhere.
//
// Silent would have been survivable. Silent AND load-bearing was not: on a
// headless Linux or SSH box with no canberra-gtk-play and no
// /usr/share/sounds/freedesktop files, `players()` returns exactly one
// candidate, `printf` is a real program there, so the spawn SUCCEEDS — no
// `error` event, no further fallback, no sound — and the Stop hook is inert
// forever in a way that is indistinguishable from the hook not being installed.
// The same entry could never have run on Windows at all, where `printf` is a
// shell builtin rather than a program on PATH.
//
// Inheriting stdio was not the fix either. This process is a Stop hook, so its
// stdout is Claude Code's pipe and not the user's terminal: a BEL written there
// is a stray byte in a log file, and specifically a stray byte in the channel
// Claude Code reads a hook's answer from. So the bell became a write of one
// byte to our own stdout, guarded on that stdout being a terminal, and stopped
// being a spawn at all — a child process to emit one byte is the wrong
// mechanism whichever way it is pointed.
//
// The shape of the test follows from what the bug was. The bell is only reached
// when every player has failed, so each case runs the SHIPPED hook/notify.mjs in
// a child whose PATH is an empty directory — the headless box from the report,
// reproducible on a developer laptop — and reads the child's stdout back as
// bytes. The platform is forced in the same child, so all three candidate lists
// are exercised on whichever operating system is running the suite; that is the
// half a Windows-only or Linux-only assertion would have missed, and this
// repo's launcher bugs live on the platform the author was not sitting at.
//
// PLAIN NODE. Nothing here renders anything, and no sound is ever played: with
// no PATH there is no player to start, which is the entire premise.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NOTIFY = fileURLToPath(new URL("../../../hook/notify.mjs", import.meta.url));

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-bell-"));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

/** A PATH with nothing on it. An existing but empty directory rather than the
 *  empty string, because node.exe still has to load its own system libraries on
 *  Windows and a machine with a broken environment is not what is under test —
 *  a machine with no sound player is. */
const NO_PLAYERS = join(SANDBOX, "empty-path");
mkdirSync(NO_PLAYERS, { recursive: true });

/**
 * The parent environment with PATH replaced, in this platform's own spelling.
 *
 * Windows writes it `Path`, and a copy of `process.env` that kept that key
 * while this test added `PATH` would hand the child both — the real one among
 * them — and every candidate would resolve after all. Every case variant is
 * dropped first so exactly one survives.
 */
function withoutPath(dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^path$/i.test(key) || value === undefined) continue;
    env[key] = value;
  }
  env.PATH = dir;
  return env;
}

// Sets up the two conditions notify.mjs reads — which platform's list to build,
// and whether stdout is a terminal — and then imports the shipped hook, which
// does its work on import. `isTTY` is a plain property on the stream, so a pipe
// can be made to answer like a console and the byte still arrives here where it
// can be counted; a real pty would be the only alternative and there is none on
// a CI runner.
const DRIVER = join(SANDBOX, "driver.mjs");
writeFileSync(DRIVER, [
  `Object.defineProperty(process, "platform", { value: process.env.BELL_PLATFORM });`,
  `process.stdout.isTTY = process.env.BELL_TTY === "1";`,
  `await import(${JSON.stringify(pathToFileURL(NOTIFY).href)});`,
].join("\n"));

/** Everything the hook wrote to stdout for one (platform, terminal) pair.
 *  execFileSync throws on a non-zero exit, so a hook that crashed on the way to
 *  its own last resort fails the case rather than reading as silence. */
function ring(platform: string, tty: boolean): string {
  return execFileSync(process.execPath, [DRIVER], {
    env: { ...withoutPath(NO_PLAYERS), BELL_PLATFORM: platform, BELL_TTY: tty ? "1" : "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
}

/** The source with its prose gone, so a search for retired wording reads code
 *  only — the explanation above `bell()` quotes the entry it replaced, exactly
 *  as this repo's comments are supposed to. */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(line => !/^\s*\/\//.test(line))
    .join("\n");
}

const BEL = "\u0007";
const code = codeOf(readFileSync(NOTIFY, "utf8"));

describe("a turn that finishes on a machine with no sound player", () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    it(`rings the terminal bell on ${platform}, where the players all failed`, () => {
      // Exactly one byte, and it is the bell. Exact equality is what makes this
      // a count as well as a value: the bell is the end of the chain rather
      // than a member of it, so three candidates failing must still produce one
      // BEL, and the old spawn produced none at all.
      expect(ring(platform, true)).toBe(BEL);
    });

    it(`writes nothing on ${platform} when its stdout is a pipe`, () => {
      // What Claude Code actually hands a Stop hook. A bell written into this
      // pipe would not reach a terminal — it would land in the channel the
      // hook's own answer is read from, and in a log file for anyone capturing
      // it. Silence is the correct behaviour, and it is chosen here rather
      // than being what happened by accident.
      expect(ring(platform, false)).toBe("");
    });
  }
});

describe("the bell mechanism itself", () => {
  it("writes the byte instead of spawning a program to print it", () => {
    // The whole of the bug in one expression: the BEL reaches our own stdout,
    // and only when that stdout is a terminal. One line carries both halves,
    // and nothing else in the file may carry a bell.
    const bells = code.split("\n").filter(l => l.includes("\\u0007"));
    expect(bells).toHaveLength(1);
    expect(bells[0]).toContain("process.stdout.isTTY");
    expect(bells[0]).toContain("process.stdout.write");
  });

  it("no longer names printf, which was never a program on Windows", () => {
    // The candidate list is spawned with `shell: false`, so a shell builtin is
    // not something it can reach — the one entry that claimed to be the
    // universal fallback was the one entry a third of the platforms could not
    // have run even if its output had gone somewhere.
    expect(code).not.toContain("printf");
  });
});
