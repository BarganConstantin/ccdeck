#!/usr/bin/env node
// The programs tmux-control-tmux.test.ts runs INSIDE a tmux pane.
//
// They are .mjs and plain Node for the reason skip-gates.mjs is: they run under
// `node` directly, in a pane, with no transpiler in the path. And they are Node
// rather than the throwaway spike's Python, because the suite already has Node
// on every leg and python3 is promised to nobody.
//
//   stress         A TUI that is harder on a terminal than Claude Code is, so
//                  that "the panel drew what tmux drew" means something:
//                  alternate screen, scroll regions, insert/delete line,
//                  truecolor and 256-colour, every SGR attribute, CJK, emoji,
//                  combining marks, synchronized output, ~60 frames a second.
//                  Deterministic (fixed seed). Keys: s = a burst of 60 frames,
//                  r = burst until q, q = stop, x = leave and exit.
//                  It is the spike's STRESS_SAFE mode and only that: the two
//                  things tmux's emulator and xterm.js draw differently from the
//                  SAME bytes (an erase under a live background, a glyph in the
//                  last column) are left out, so a difference that remains is
//                  the wire's, not the emulators'.
//   stress pre-3.6 The same frames, but for one thing a tmux older than 3.6
//                  draws wrong, left out there too: a run of ASCII written from
//                  column 2 over the right half of a wide glyph in column 1.
//                  Before 3.6 tmux keeps the wide glyph and puts the run after
//                  it (screen_write_collect_end walks back to find the glyph and
//                  stops before column 0; upstream 9c07903a "Correctly remove
//                  overwritten wide characters at column 1", first in 3.6);
//                  xterm.js and tmux 3.6 on blank it. Such a run starts in
//                  column 1 instead, over the whole glyph. Every random draw is
//                  made as before, so without the option the bytes are the same.
//   half           Writes 界 in column 1 and then Z in column 2, over its right
//                  half, then the title "half", and waits: that disagreement
//                  alone, for tmux-control-tmux.test.ts to check which tmux has it.
//   record FILE [bracketed]
//                  Raw mode; every byte the pane receives is appended to FILE.
//                  With `bracketed` it first asks for bracketed paste. Writes
//                  FILE.ready once raw mode is on.
//   alt            Enters the alternate screen with mouse and keypad modes on,
//                  draws, and on q leaves it again and exits — the shape of an
//                  agent TUI started from a shell.
import { appendFileSync, writeFileSync } from "node:fs";

const [mode, file, flag] = process.argv.slice(2);
const out = (s) => process.stdout.write(s);
const size = () => [Math.max(process.stdout.columns || 80, 10), Math.max(process.stdout.rows || 24, 5)];

if (mode === "record") {
  process.stdin.setRawMode(true);
  if (flag === "bracketed") out("\x1b[?2004h");
  out("recording\r\n");
  process.stdin.on("data", (d) => appendFileSync(file, d));
  writeFileSync(`${file}.ready`, "");
} else if (mode === "alt") {
  process.stdin.setRawMode(true);
  out("\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?1h\x1b=\x1b[2J");
  out("\x1b[1;1H\x1b[1;38;5;208mon the alternate screen\x1b[0m");
  out("\x1b[3;5H\x1b[44m blue band \x1b[0m\x1b[5;1Hpress q");
  out("\x1b[5;8H");
  process.stdin.on("data", (d) => {
    if (!d.includes(0x71)) return;
    out("\x1b[?1003l\x1b[?1006l\x1b[?1l\x1b>\x1b[?1049l");
    process.stdin.setRawMode(false);
    process.exit(0);
  });
} else if (mode === "half") {
  // The title last: once tmux shows it, it has drawn every byte before it.
  out("\x1b[2J\x1b[1;1H界\x1b[1;2HZ\x1b]2;half\x07");
  setInterval(() => {}, 60_000);
} else {
  stress();
}

function stress() {
  // mulberry32: any fixed sequence will do; this one is four lines.
  let seed = 1137;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const range = (a, b) => a + Math.floor(rnd() * (b - a));   // [a, b)
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const GLYPHS = ["a", "Z", "0", "#", "─", "│", "┼", "█", "░", "世", "界", "✻", "🚀", "é", "é", "ﬁ", "→", "·", " "];
  const ATTRS = ["1", "2", "3", "4", "7", "9", "22", "23", "24", "27", "29"];
  const sgr = () => {
    const k = rnd();
    if (k < 0.4) return `\x1b[38;2;${range(0, 256)};${range(0, 256)};${range(0, 256)}m`;
    if (k < 0.6) return `\x1b[48;5;${range(0, 256)}m`;
    if (k < 0.8) return `\x1b[${pick(ATTRS)}m`;
    return "\x1b[0m";
  };
  let frames = 0;
  let left = 0;
  let forever = false;
  const pre36 = process.argv[3] === "pre-3.6";

  const frame = () => {
    const [cols, rows] = size();
    let s = "\x1b[?2026h";
    const top = 3, bot = rows - 2;
    s += `\x1b[${top};${bot}r`;
    for (let i = 0; i < 40; i++) {
      // Drawn in the order they always were: row, column, pen, length, glyphs.
      const row = range(1, rows + 1);
      let col = range(1, cols - 26 + 1);
      const pen = sgr();
      const n = range(1, 12);
      let run = "";
      for (let j = 0; j < n; j++) run += pick(GLYPHS);
      if (pre36 && col === 2 && run.charCodeAt(0) < 0x80) col = 1;
      s += `\x1b[${row};${col}H${pen}${run}`;
    }
    const op = rnd();
    s += `\x1b[${range(top, bot + 1)};1H\x1b[0m`;
    if (op < 0.25) s += "\x1b[L";
    else if (op < 0.5) s += "\x1b[M";
    else if (op >= 0.65 && op < 0.75) s += `\x1b[${bot};1H\n`;
    s += "\x1b[r\x1b[0m";
    s += `\x1b[1;1H\x1b[2K\x1b[1;7m stress ${cols}x${rows} frame ${frames} \x1b[0m`;
    s += "\x1b[?2026l";
    out(s);
    frames++;
  };

  const redraw = () => {
    const [cols, rows] = size();
    let s = "\x1b[0m\x1b[2J";
    for (let y = 1; y <= rows; y++) {
      const cell = `row ${String(y).padStart(2, "0")} `;
      s += `\x1b[${y};1H\x1b[38;5;${(y * 7) % 256}m${cell.repeat(Math.floor((cols - 1) / cell.length))}`;
    }
    out(`${s}\x1b[0m`);
  };

  process.stdin.setRawMode(true);
  out("\x1b[?1049h\x1b[?25l");
  redraw();
  process.stdout.on("resize", redraw);
  process.stdin.on("data", (d) => {
    const k = d.toString("latin1");
    if (k.includes("s")) left = 60;
    if (k.includes("r")) forever = true;
    if (k.includes("q")) { forever = false; left = 0; }
    if (k.includes("x")) {
      out("\x1b[?25h\x1b[?1049l");
      process.stdin.setRawMode(false);
      process.exit(0);
    }
  });
  setInterval(() => {
    if (!forever && left <= 0) return;
    frame();
    left = Math.max(0, left - 1);
  }, 16);
}
