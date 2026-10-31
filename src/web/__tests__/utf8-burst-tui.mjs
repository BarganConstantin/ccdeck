// A program for a tmux pane in terminal-utf8-tmux.test.ts. Started as
// `node utf8-burst-tui.mjs <token> <lines>`, it waits for a key, then writes:
//
//   1. each character below cut at every byte offset, the two halves in two
//      writes 30 ms apart — tmux reads them separately, so its %output line
//      ends inside the character, the way a busy pane's lines sometimes do;
//   2. <lines> numbered lines of punctuation-heavy text in ONE write, which
//      tmux cuts wherever its reads of the pane happen to end;
//   3. the token on a line of its own, so the test knows it has everything.
//
// Then it waits for "q". Raw mode, so the key that starts it is not echoed.
// Nothing here talks to anything but its own terminal.
const [token = "utf8-done", lines = "8000"] = process.argv.slice(2);

const CUTS = ["—", "…", "’", "”", "€", "é", "世", "🚀", "🀀", "é"];
const LINE = "agent output — with a dash … and an ellipsis — again, then words ’quoted’ ”done”";

const out = (bytes) => process.stdout.write(bytes);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  for (const [i, ch] of CUTS.entries()) {
    const bytes = Buffer.from(ch, "utf8");
    for (let k = 1; k < bytes.length; k++) {
      out(Buffer.concat([Buffer.from(`cut ${String(i).padStart(2, "0")}.${k}: A`), bytes.subarray(0, k)]));
      await sleep(30);
      out(Buffer.concat([bytes.subarray(k), Buffer.from("B\r\n")]));
    }
  }
  let burst = "";
  for (let n = 0; n < Number(lines); n++) burst += `${String(n).padStart(5, "0")} ${LINE}\r\n`;
  out(burst);
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
