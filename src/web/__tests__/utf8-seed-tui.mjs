// A program for a tmux pane in terminal-utf8-tmux.test.ts. Started as
// `node utf8-seed-tui.mjs <token> <shift> <lines>`, it writes:
//
//   1. <lines> lines of coloured history, nearly all of it "—" with a "…"
//      and a four-byte character at the end — fewer lines than a seed's two
//      thousand, so the seed holds all of them, and 200 to 400 KB in it:
//      longer than xterm.js decodes in one piece. In the first line <shift>
//      of the "—" are "é", as wide and one byte shorter, which moves every
//      byte after it, and so where the seed's piece edges fall in the text.
//      Not a longer line: the seed's capture pads each row with spaces to the
//      cells tmux has room for, so a few more letters change nothing after
//      them;
//   2. `<token>-ready` on a line of its own, then waits for a key;
//   3. each character below cut at every byte offset, the two halves in two
//      writes 30 ms apart, as utf8-burst-tui.mjs does, so that output after
//      the seed has frames that end inside a character too;
//   4. <token> on a line of its own, so the test knows it has everything.
//
// Then it waits for "q". Raw mode, so the key that starts it is not echoed.
// Nothing here talks to anything but its own terminal.
const [token = "utf8-seed", shift = "0", lines = "1800"] = process.argv.slice(2);

const CUTS = ["—", "…", "’", "”", "€", "é", "世", "🚀", "🀀", "é"];

const out = (bytes) => process.stdout.write(bytes);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let history = "";
for (let n = 0; n < Number(lines); n++) {
  const shorter = n === 0 ? Math.min(Number(shift), 48) : 0;
  history += `\x1b[3${1 + (n % 7)}m${String(n).padStart(4, "0")} ${"é".repeat(shorter)}${"—".repeat(48 - shorter)}…🀀\x1b[0m\r\n`;
}
out(history);
out(`${token}-ready\r\n`);

async function run() {
  for (const [i, ch] of CUTS.entries()) {
    const bytes = Buffer.from(ch, "utf8");
    for (let k = 1; k < bytes.length; k++) {
      out(Buffer.concat([Buffer.from(`cut ${String(i).padStart(2, "0")}.${k}: A`), bytes.subarray(0, k)]));
      await sleep(30);
      out(Buffer.concat([bytes.subarray(k), Buffer.from("B\r\n")]));
    }
  }
  out(`${token}\r\n`);
}

let started = false;
process.stdin.setRawMode?.(true);
process.stdin.on("data", (d) => {
  if (d.includes(0x71)) process.exit(0);
  if (started) return;
  started = true;
  run();
});
