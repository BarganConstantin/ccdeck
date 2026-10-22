// The account picker `ccdeck switch` opens when no account was named (#2183).
//
// Only on a terminal at both ends — a pipe, a script or `--json` is told to
// name the account instead, since a prompt nobody can answer is a hang. The
// rows are the roster's own lines (cli-lines.mjs accountLines), so the picker
// shows each account's room the way `ccdeck accounts` does, and choosing is a
// question of which account has space rather than which slot number it was.
//
// Raw mode, so the arrows arrive as keys and Ctrl+C as a key too — it cancels
// the pick rather than signalling the process, and the cursor and the
// terminal's mode are put back on every way out.
import { emitKeypressEvents } from "node:readline";
import { accountLines, clip, oneLine, textWidth } from "../../src/server/cli-lines.mjs";
import { CURSOR_HIDE, CURSOR_SHOW } from "../../src/server/term.mjs";

/**
 * Let the person choose one of `accounts`, resolving to the row or to null when
 * they cancel. `initial` is the index the cursor starts on.
 */
export function pickAccount(accounts, {
  initial = 0, tone, g, unicode = true, columns = 80, now = Date.now(),
  input = process.stdin, output = process.stdout, title = "Switch Claude account",
} = {}) {
  const rows = accounts.slice();
  let at = Math.min(Math.max(0, initial), rows.length - 1);
  let drawn = 0;
  let width = columns;
  const pointer = unicode ? "›" : ">";

  const draw = () => {
    const lines = accountLines(rows, { tone, g, unicode, columns: width - 2, now })
      .map((line, i) => (i === at ? `${tone.accent}${tone.bold}${pointer}${tone.reset}${line.slice(1)}` : line));
    const keys = `${tone.muted}${unicode ? "↑↓" : "up/down"} move ${g.bullet} enter switch ${g.bullet} esc cancel${tone.reset}`;
    // Every line inside the width, the header's too, and the keys are what
    // gives way: a line that wrapped is a line the move back up below does not
    // count, and every keypress would leave one more stray copy behind.
    const head = `  ${tone.bold}${clip(oneLine(title), Math.max(8, width - 3), g.ellipsis)}${tone.reset}`;
    const header = textWidth(head) + 2 + textWidth(keys) < width ? `${head}  ${keys}` : head;
    const frame = [header, "", ...lines];
    // Back to the top of the last frame and clear below it, so a shorter frame
    // cannot leave the tail of a longer one behind.
    if (drawn) output.write(`\x1b[${drawn}A\x1b[J`);
    for (const line of frame) output.write(`\x1b[2K${line}\n`);
    drawn = frame.length;
  };
  const onResize = () => {
    if (Number.isInteger(output.columns) && output.columns > 0) width = output.columns;
    draw();
  };

  return new Promise(resolve => {
    const wasRaw = input.isRaw === true;
    const restore = () => {
      input.off("keypress", onKey);
      output.off?.("resize", onResize);
      try { input.setRawMode?.(wasRaw); } catch { /* the terminal went away */ }
      input.pause();
      output.write(CURSOR_SHOW);
      process.off("exit", restoreOnExit);
    };
    // A process ended under the picker — a signal from outside — must still
    // hand the terminal back with a cursor in it.
    const restoreOnExit = () => { try { output.write(CURSOR_SHOW); input.setRawMode?.(false); } catch { /* gone */ } };
    const finish = (row) => { restore(); resolve(row); };
    function onKey(str, key = {}) {
      if (key.ctrl && key.name === "c") return finish(null);
      if (key.name === "escape" || str === "q") return finish(null);
      if (key.name === "return" || key.name === "enter") return finish(rows[at]);
      if (key.name === "up" || str === "k") at = (at - 1 + rows.length) % rows.length;
      else if (key.name === "down" || str === "j" || key.name === "tab") at = (at + 1) % rows.length;
      else if (/^\d$/.test(str ?? "")) {
        const hit = rows.findIndex(a => a.num === Number(str));
        if (hit !== -1) at = hit;
      } else return;
      draw();
    }
    emitKeypressEvents(input);
    try { input.setRawMode?.(true); } catch { /* not a terminal after all: the keys still arrive */ }
    input.resume();
    input.on("keypress", onKey);
    output.on?.("resize", onResize);
    process.on("exit", restoreOnExit);
    output.write(CURSOR_HIDE);
    draw();
  });
}
