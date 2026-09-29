// How a failed ccusage read is told, to the two audiences it has.
//
// The usage-history modal gets a `reason`, the `stage` that failed and, when it
// is a file of the user's, the `bin` — so it can say which path went wrong in
// its own words and keep the raw text one hover away. The terminal gets one
// line. Every module that runs or installs ccusage says what went wrong
// through these four, so the words stay the same whichever of them it was.
import { oneLine, termColumns } from "./term.mjs";
import { PRODUCT } from "./brand.mjs";

// A run can end four ways that mean four different things to whoever opened the
// modal — installs are forbidden, the deadline expired, the output was not usage
// data, the CLI exited on its own — and all four used to arrive as one `error`
// string, leaving the modal nothing to say but whatever `err.message` happened
// to be. The code rides on the error and comes back out as `reason`; `error`
// keeps the raw text, which the modal shows only on hover.
export function tagged(reason, message) {
  return Object.assign(new Error(message), { reason });
}

// Everything the ccusage modules say out loud goes through here, and it says one
// line.
//
// Both failures it reports, a failed install and a failed run, carry a
// subprocess's entire stderr as their `message`, and on a machine whose npm
// shim is broken that is a fifteen-line Node stack trace. Handed to
// console.error whole, it landed across the deck's own status rows and its
// `\r`-repainted pulse line — and because primeCcusage runs at boot, it was
// the first thing such a machine ever showed (#432). The evidence
// is not lost by shortening this: a failed RUN carries its full text back to
// the browser in `error`, which the usage-history modal keeps on the status
// line's title, one hover away — the same division of labour admin-failure.ts
// states for claude-swap's output. What this line is for is the operator
// watching the terminal, who needs to know which of the two things failed and
// why, not to read a stack.
//
// The width is read per call: a terminal can be resized while the deck runs,
// and this can fire hours in.
export function note(what, err) {
  const head = `${PRODUCT} ccusage: ${what}: `;
  console.error(head + oneLine(err?.message ?? err, termColumns(process.stderr) - head.length));
}

/** Which of ccusage's three paths a failure came from, in the deck's own words.
 *  `stage` travels to the browser; the modal leads with it rather than making
 *  the reader guess from a stack trace which path they are looking at. */
const STAGE = { node: "managed", path: "path", npx: "npx" };

/** Mark a failure with the path that produced it, and with the managed
 *  install's own account when that is why this path was taken at all. Set once:
 *  runCcusage's retry re-stamps with the runner that actually failed, and an
 *  error that already knows where it came from is not overwritten. */
export function stamp(err, runner) {
  if (err && typeof err === "object") {
    if (!err.stage) err.stage = STAGE[runner?.kind] ?? "npx";
    // Which file, when the answer is a file the deck did not put there. The
    // stage alone says "your own copy failed" and leaves the reader to work out
    // WHICH copy, and on a machine with an override, a PATH entry and a managed
    // install that is exactly the question they cannot answer from here.
    if (runner?.kind === "path" && err.bin === undefined) err.bin = runner.file;
    if (runner?.installError && err.install === undefined) err.install = runner.installError;
  }
  return err;
}
