// Handing a spawned child its input, the one way the suite does it.
//
// A hook is allowed to end before it has read everything it was given: one that
// finds no deck to post to, one past its budget, one that answers from a record
// and never needs the body. That leaves this end of the pipe with nobody
// reading, and the write fails with EPIPE. The failure is not the test's to
// report. Every case asserts on the exit code and the output, and those say
// whether the child did what it should.
//
// Left unhandled, though, a stream's 'error' is an uncaught exception, and
// vitest fails the whole run for it however every test went. hook-read-only
// took down a macOS job that way with all 9,832 tests passing. Two files had
// already learned this and swallowed it in place; the rest had not.
import type { ChildProcess } from "node:child_process";

/** Write `input` to the child's stdin and close it, with EPIPE allowed. */
export function endStdin(child: ChildProcess, input: string): void {
  child.stdin!.on("error", () => {});
  child.stdin!.end(input);
}
