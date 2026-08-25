#!/usr/bin/env node
// Plays a short sound when Claude Code finishes a turn. Installed by
// agents-deck as a Stop hook and toggled from the deck's topbar.
//
// The `.mjs` is load-bearing and this file must not be renamed back. It is
// copied to <claude config dir>/agent-dag/, where no package.json sits above it
// to declare a format, so a `.js` there is CommonJS and the `import` below is a
// SyntaxError on every Node that does not detect module syntax by default —
// which is every Node before v20.19.0 and v22.7.0, well inside the package's own
// `engines: ">=18"`. See the note above NOTIFY_NAME in src/server/sound-hook.mjs.
// Its neighbour hook.js is CommonJS for the same reason read the other way.
//
// The platform check happens HERE, at run time, rather than in the settings
// entry that invokes it. Hand-written sound hooks are almost always a single
// OS-specific command — `afplay` on a Mac, a PowerShell one-liner on Windows —
// which does nothing on any other machine, and typically ends in `|| true`, so
// the failure is silent. One script that picks its own player means the same
// settings.json works on every machine the user syncs it to.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// First entry whose file exists wins. Each is a [command, args] pair.
function players() {
  if (process.platform === "darwin") {
    const sound = ["/System/Library/Sounds/Glass.aiff", "/System/Library/Sounds/Ping.aiff"]
      .find(existsSync);
    return sound ? [["afplay", [sound]]] : [];
  }

  if (process.platform === "win32") {
    // PlaySync inside the hook process keeps the sound from being cut off when
    // the shell exits, which is what a bare Media.SoundPlayer call would do.
    const ps = "(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\tada.wav').PlaySync()";
    return [["powershell.exe", ["-NoProfile", "-Command", ps]]];
  }

  // Linux and the BSDs: no single player is guaranteed, so try the common ones
  // in order of how likely they are to be present on a desktop install. The
  // freedesktop sound theme ships with most of them.
  const wav = [
    "/usr/share/sounds/freedesktop/stereo/complete.oga",
    "/usr/share/sounds/freedesktop/stereo/bell.oga",
  ].find(existsSync);
  return [
    ["canberra-gtk-play", ["--id", "complete"]],
    ...(wav ? [["paplay", [wav]], ["aplay", [wav]]] : []),
  ];
}

/**
 * The last resort, and the reason it is not in the list above: a terminal bell
 * is one byte, and a byte is not something to spawn a process for.
 *
 * It used to be `["printf", ["\a"]]`, spawned like every other candidate — with
 * `stdio: "ignore"`. So the BEL went to /dev/null, which is the one place a
 * bell cannot ring. Worse than useless: `printf` exists on a headless Linux or
 * SSH box, so the spawn SUCCEEDED, no `error` event fired, and on the exact
 * machine the comment claimed it was for — no canberra-gtk-play, no freedesktop
 * sounds, so a candidate list of one — the hook was silently inert, and a
 * working install looked identical to no install at all. It could not run on
 * Windows either: `printf` is a shell builtin there, not a program.
 *
 * Inheriting stdio would not have fixed it. This process is a Stop hook, so its
 * stdout is Claude Code's pipe rather than the user's terminal, and a BEL
 * written into a pipe is a stray byte in a log file — into THIS pipe it is a
 * stray byte in the channel Claude Code reads a hook's answer from. So the bell
 * is written only when our own stdout is a terminal, which is precisely when it
 * IS the terminal the user is looking at: the hook run by hand, or by any
 * runner that hands it the tty. Everywhere else the sound is simply the players
 * above, and this function does nothing rather than claiming a capability this
 * process does not have.
 *
 * Not tied to a platform, unlike the candidate it replaces: a console beeps on
 * all three, and the branch that reaches here is whichever list ran out.
 */
function bell() {
  try {
    // U+0007 BEL. One write, no child, nothing to fall back to after it.
    if (process.stdout.isTTY) process.stdout.write("\u0007");
  } catch { /* a closed stdout is not worth an exception at the end of a turn */ }
}

// Try each candidate until one starts without ENOENT. Detached and unref'd so
// the hook returns immediately — Claude Code waits on hook processes, and a
// two-second sound should not be two seconds of latency at the end of a turn.
//
// Running out of candidates is where the bell belongs, rather than being one:
// it is reached on every platform whose players are missing — a Mac with no
// system sounds, a Windows without PowerShell, the headless Linux box the old
// `printf` entry was written for — instead of only at the end of the one list
// it used to sit in.
function play(candidates, i = 0) {
  if (i >= candidates.length) { bell(); return; }
  const [cmd, args] = candidates[i];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false });
    child.on("error", () => play(candidates, i + 1));   // not installed — next
    child.unref();
  } catch {
    play(candidates, i + 1);
  }
}

play(players());
