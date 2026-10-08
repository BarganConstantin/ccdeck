# Phase 0 — what the two spikes answered

Measured 2026-10-08 on Linux (Ubuntu, kernel 7.0), tmux 3.6, Claude Code 2.1.294,
Codex 0.155.0, `@xterm/headless` 5.5 with the Unicode 11 addon. Plan:
`ccdeck-internal/plans/cli-terminal/`. Epic ccdeck-internal#9.

**Verdict: the architecture holds and phase 1 may start** — with four corrections
to the plan, listed at the end. Everything in this folder is throwaway and must
be deleted before the branch merges; `spikes/` is not in `files`, so none of it
can reach the tarball meanwhile.

## #10 — session → process → pane: answered, and easier than the plan feared

The plan expected to guess a session's pid by matching `claude` processes on cwd.
No guessing is needed for Claude:

- **Claude writes `~/.claude/sessions/<pid>.json` for every live session**,
  interactive and background, with `sessionId`, `cwd`, `kind`, `status` and
  `procStart`. `procStart` is field 22 of `/proc/<pid>/stat`, so a recycled pid
  is caught even while alive. The `.key` files beside them are secrets and are
  never read.
- **`claude agents --json`** answers the same without a TTY, plus `state`
  (`blocked` / `working`) — which is the waiting signal, from Claude itself.
- **Hooks inherit `CLAUDE_PID` and `CLAUDE_CODE_SESSION_ID`** (checked on a live
  hook process). So the hook can carry the pid on every event, on every platform
  including macOS, without the deck reading `/proc` at all. It stays a one-way
  forwarder; it gains a field.
- **The pane**: `TMUX_PANE` in `/proc/<pid>/environ` is exact for a process
  started inside tmux; ancestry against `list-panes -a #{pane_pid}` confirms it
  and catches a process moved in later; `pane_tty` is the last resort.

`session-pid.mjs` classified real interactive Claude sessions correctly in all
three planned cases: **A** (deck-named tmux session), **B** (any other tmux
session, found via `TMUX_PANE`), **C** (a plain pty).

### A fourth case the plan does not have — D, Claude's own background sessions

`claude --bg` runs each session on a pty held by a `claude bg-pty-host` process,
behind a unix socket, and that host **outlives the daemon** that started it:
three of the five sessions measured had been reparented to systemd after a
daemon restart and were still listed and attachable. Its only door is
`claude attach <id>`.

**All five live sessions on this machine today were case D.** On the owner's own
machine the commonest session is one the plan has no answer for. Anthropic built
the "pty in a long-lived host process" the plan considered and rejected — for
Claude sessions, persistence already exists and the deck need not own it.

### Codex: open

Codex keeps no per-pid file, and an idle Codex holds no rollout open (one appears
after the first message). The route is the hook's own parent chain. Not verified:
it needs a session that has been sent a message.

### macOS and Windows

macOS (nothing measured): the session files, `claude agents --json` and
`CLAUDE_PID` in hooks are platform-free; ancestry needs `ps -o ppid=` instead of
`/proc`; another process's `TMUX_PANE` is readable through `ps eww` for the same
user at best — so on macOS the pane is found by `pane_pid` ancestry, not by env.
Windows: no tmux, out of scope, as planned.

## #11 — control mode vs the TUI: yes, and lossless on the wire

The ttyd control was replaced by a stricter one: **tmux's own screen**.
`capture-pane` reads back what tmux's emulator holds, so after each scenario
`control-mode.mjs` compares an xterm fed only by `%output` against it — text row
by row, every attribute cell by cell, and the cursor.

| TUI | Scenarios identical to tmux's screen |
|---|---|
| Claude Code 2.1.294 | **11 / 11** — `/` menu, arrow navigation, filtering, CJK and emoji typed through `send-keys -H`, 60 single-byte writes, resizes to 100×30, 80×24 and back |
| Codex 0.155.0 | **11 / 11** — the same battery |

**The decisive measurement is byte-level.** A synthetic TUI (`stress-tui.py`)
tees everything it writes. Across bursts and resizes, the 519,400 bytes that
arrived as `%output` were a **byte-identical suffix** of what the program wrote.
Control mode carries exactly what a pty would; the `node-pty` fallback is not
needed, and the zero-dependency property survives. tmux runs as a child with
three pipes — no pty, no native module, anywhere.

The stress TUI (alternate screen, scroll regions, insert/delete line, truecolor
and 256-colour, every SGR attribute, CJK, emoji, combining marks, synchronized
output, ~60 fps, ~85 KB/s) leaves differences against tmux's screen — background
on erased cells, a half-overwritten wide glyph, a glyph in the last column. **The
same differences appear when its raw bytes go into xterm with no tmux at all.**
They are tmux's emulator and xterm's disagreeing on the same bytes, not loss.
They matter at one moment only — the seed — and see point 1 below.

**Attaching mid-burst**: drop `%output` that arrives before the `capture-pane`
reply, apply what follows. Text was identical on every row and the wire was still
an exact suffix (628,114 of 752,988 bytes). tmux orders pane output and command
replies on one stream, which is what makes that rule hold.

### What the dock has to do that the plan did not say

1. **Seed, then make the TUI repaint.** Seed from `capture-pane -p -e -N`
   (add `-S` for history: Codex is inline, so its conversation lives in normal
   scrollback), place the cursor from `display-message`, then send the dock's own
   size. The resize makes the TUI redraw itself, which heals any seed
   disagreement within one frame.
2. **Modes set before the attach never pass through `%output`.** Claude Code now
   runs on the **alternate screen with SGR any-event mouse on**; an xterm that
   does not know that sends no mouse events. tmux 3.6 exposes `alternate_on`, the
   cursor, keypad and mouse flags and the scroll region — and **no** flag for
   bracketed paste, focus events or extended keys. So input goes to tmux as key
   names (`send-keys Up`, `S-Enter`), letting tmux encode them for whatever the
   pane asked for, rather than as raw bytes encoded under xterm's guess; and
   paste goes through `set-buffer` + `paste-buffer -p`, which brackets it only if
   the pane asked.
3. **Resize the emulator at tmux's reply** to `refresh-client -C`, not when the
   dock asks: output before the reply was drawn at the old size.
4. **Flow control** (`refresh-client -f pause-after=N`, `%pause` → capture again)
   is untested under a slow consumer. Phase 1 has to.

Minimum **tmux 3.2**: `refresh-client -f` (`ignore-size`, `pause-after`,
`read-only`) arrived there. Ubuntu 22.04 ships 3.2a.

## #21, measured early because the plan's fix for it was suspect

Default `window-size` is `latest`. With an ordinary client attached at 200×49:

| The dock attaches as | The host's window |
|---|---|
| a control client on the same session, 120×40 | **shrinks to 120×40**; restored on detach |
| a control client on a grouped session (`new-session -t`), 120×40 | **shrinks to 120×40** |
| a control client with `refresh-client -f ignore-size` | stays 200×49 |

**The grouped session does not help**: grouped sessions share their windows and a
window has one size. `ignore-size` is the fix, at a price the UX has to state:
in case B the dock draws at the pane's size, not its own. In case A, with no
other client, the dock sizes the window.

## Corrections to the plan

1. **Add case D** — Claude background sessions, likely the commonest. The dock
   reaches one by running `claude attach <id>` in a deck-owned tmux pane: the
   same dock path as case A, and no private protocol spoken.
2. **Case B attaches with `ignore-size`**, not through a grouped session.
3. **Mapping comes from Claude**: `sessions/<pid>.json` or `claude agents --json`,
   and `CLAUDE_PID` on hook events. Codex stays open.
4. **tmux ≥ 3.2** is the stated dependency, not just "tmux".

## Not done

- No browser rendering: the comparison with tmux's screen replaced the eyeball test.
- No real Claude reply streamed (it would have sent a prompt); the stress TUI is
  heavier than one.
- Nothing measured on macOS; slow-consumer flow control untested.

## Rerun

tmux was not installed, so it was unpacked from the Ubuntu archive into a scratch
folder (`apt-get download tmux libevent-core-2.1-7t64 libjemalloc2`, `dpkg-deb -x`,
`LD_LIBRARY_PATH`) — nothing installed system-wide. Then, with `$T` that tmux and
`$XT` a folder holding `@xterm/headless@5.5.0` and `@xterm/addon-unicode11@0.8.0`:

```sh
node spikes/terminal/session-pid.mjs --all --tmux "$T" -L ccdeck-spike
"$T" -L ccdeck-spike new-session -d -s ccdeck-a -x 120 -y 40 claude
node spikes/terminal/control-mode.mjs --tmux "$T" -L ccdeck-spike -t ccdeck-a --xterm "$XT"
"$T" -L ccdeck-spike new-session -d -s ccdeck-stress -x 120 -y 40 python3 spikes/terminal/stress-tui.py
node spikes/terminal/control-mode.mjs --tmux "$T" -L ccdeck-spike -t ccdeck-stress --xterm "$XT" --scenario stress
```
