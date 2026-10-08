#!/usr/bin/env python3
# SPIKE — ccdeck-internal#11. Throwaway.
#
# A TUI that is harder on a terminal than Claude Code is, so that "control mode
# carried it" means something. Deterministic (fixed seed), so a diff points at
# the wire rather than at the content. Keys: s = one burst of 180 frames at ~60 fps,
# r = burst until q, q = stop. Never exits on its own.
import os, random, select, signal, struct, sys, termios, tty, fcntl, time

class Tee:
    # STRESS_TEE=<file>: every byte written to the terminal is also appended
    # there, so the wire can be compared with what the program actually wrote.
    def __init__(self, inner, path):
        self.inner, self.f = inner, open(path, "ab") if path else None
    def write(self, b):
        if self.f: self.f.write(b); self.f.flush()
        return self.inner.write(b)
    def flush(self): self.inner.flush()
out = Tee(sys.stdout.buffer, os.environ.get("STRESS_TEE"))
rng = random.Random(1137)
GLYPHS = ["a", "Z", "0", "#", "─", "│", "┼", "█", "░", "世", "界", "✻", "🚀", "é", "é", "ﬁ", "→", "·", " "]
ATTRS = ["1", "2", "3", "4", "7", "9", "22", "23", "24", "27", "29"]
frames = 0
dirty = True
# STRESS_SAFE=1 leaves out the two places tmux's emulator and xterm's disagree on
# the same bytes (an erase under live attributes, and a glyph landing in the last
# column), so that a difference left over in a race test belongs to the wire.
SAFE = os.environ.get("STRESS_SAFE") == "1"

def size():
    try:
        rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(1, termios.TIOCGWINSZ, b"\0" * 8))
        return max(cols, 10), max(rows, 5)
    except OSError:
        return 80, 24

def sgr():
    k = rng.random()
    if k < 0.4:
        return f"\x1b[38;2;{rng.randrange(256)};{rng.randrange(256)};{rng.randrange(256)}m"
    if k < 0.6:
        return f"\x1b[48;5;{rng.randrange(256)}m"
    if k < 0.8:
        return f"\x1b[{rng.choice(ATTRS)}m"
    return "\x1b[0m"

def frame():
    global frames
    cols, rows = size()
    s = ["\x1b[?2026h"]                      # synchronized output, the way modern TUIs batch a repaint
    top, bot = 3, rows - 2
    s.append(f"\x1b[{top};{bot}r")            # scroll region
    for _ in range(40):
        y, x = rng.randrange(1, rows + 1), rng.randrange(1, (cols - 26 if SAFE else cols) + 1)
        s.append(f"\x1b[{y};{x}H{sgr()}")
        s.append("".join(rng.choice(GLYPHS) for _ in range(rng.randrange(1, 12))))
    op = rng.random()
    s.append(f"\x1b[{rng.randrange(top, bot + 1)};1H" + ("\x1b[0m" if SAFE else ""))
    if op < 0.25: s.append("\x1b[L")          # insert line inside the region
    elif op < 0.5: s.append("\x1b[M")         # delete line
    elif op < 0.65 and not SAFE: s.append("\x1b[K")  # erase to end of line
    elif op < 0.75: s.append(f"\x1b[{bot};1H\n")  # scroll the region by a newline at its foot
    s.append("\x1b[r\x1b[0m")
    s.append(f"\x1b[1;1H\x1b[2K\x1b[1;7m stress {cols}x{rows} frame {frames} \x1b[0m")
    s.append("\x1b[?2026l")
    out.write("".join(s).encode())
    out.flush()
    frames += 1

def redraw():
    cols, rows = size()
    out.write(b"\x1b[0m\x1b[2J")
    for y in range(1, rows + 1):
        out.write(f"\x1b[{y};1H\x1b[38;5;{(y * 7) % 256}m{('row %02d ' % y) * (cols // 7)}".encode())
    out.write(b"\x1b[0m")
    out.flush()

def on_winch(*_):
    global dirty
    dirty = True

signal.signal(signal.SIGWINCH, on_winch)
old = termios.tcgetattr(0)
tty.setraw(0)
out.write(b"\x1b[?1049h\x1b[?25l")            # alternate screen, cursor hidden
burst_left = 0
forever = False
try:
    while True:
        if dirty:
            dirty = False
            redraw()
        now = time.time()
        busy = forever or burst_left > 0
        r, _, _ = select.select([0], [], [], 1 / 60 if busy else 0.2)
        if r:
            ch = os.read(0, 64)
            if b"s" in ch: burst_left = 180
            if b"r" in ch: forever = True
            if b"q" in ch: forever = False; burst_left = 0
        if busy:
            frame()
            burst_left = max(0, burst_left - 1)
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, old)
